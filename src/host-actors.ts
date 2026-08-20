/**
 * Session-scoped host-event actors (V2-P12) — cross-run watchdog / advisor /
 * spec / supervisor patterns wired to the PUBLIC pi extension events.
 *
 * The pi host (0.83.0) exposes four event families the extension can observe:
 * `before_agent_start` (after the user submits a prompt, before the agent
 * loop — can return a message / systemPrompt replacement), `context` (before
 * each LLM call — the assembled message list), `session_compact` (after
 * context compaction), and `session_start`. supervisedRun is run-scoped and
 * dies with the run; spec-conformance is one-shot. This module turns those
 * session events into a persistent, deterministic ACTOR layer:
 *
 *   - **watchdog** — goal-drift detector: Jaccard token similarity between the
 *     declared goal and each user prompt; a drop below the threshold flags
 *     drift (message injection) and re-affirms the goal after compaction.
 *   - **advisor** — quiet decision-point reviewer: a configured trigger match
 *     injects the configured review text as a session message (no forced turn).
 *   - **spec** — acceptance ledger: extracts criterion lines from prompts into
 *     a content-addressed, persisted ledger with an open → verified lifecycle;
 *     optionally reminds open criteria after compaction.
 *   - **supervisor** — directive response mode: a trigger match injects a
 *     directive message with `triggerTurn: true` — the ONLY profile allowed to
 *     force a turn (stop-the-world gate).
 *
 * SESSION-scoped by design: the manager lives in the extension generation, so
 * actors survive across workflow runs within a pi session; defs and ledger
 * state persist under `getAgentDir()/workflows/actors/`, so a new extension
 * generation reloads the same actors. TRUE cross-process residency (an actor
 * alive after the host exits) is explicitly OUT OF SCOPE v1 and documented as
 * a gap — it would require an RpcClient-spawned pi child
 * (dist/modes/rpc/rpc-client.d.ts); pi 0.83.0 has no resident-actor API
 * (supervisor.ts:25-27 precedent: "Documented, not implemented").
 *
 * ── Actor side-input contract (V2 note, roadmap-v2.md V2-P12) ──────────────────
 * Every delivery this module produces is a SESSION-side input:
 *
 *   - `before_agent_start` returns a `BeforeAgentStartEventResult`-shaped
 *     contribution (`message` / `systemPrompt`) that the host merges into the
 *     CURRENT turn's context — it is never part of any workflow run's resume
 *     identity.
 *   - `context` events are OBSERVATIONAL only: the manager reads a bounded,
 *     defensive text view of the messages and never rewrites the LLM context.
 *   - `session_compact` / `session_start` deliveries go through the host's
 *     `sendMessage` channel (custom messages), again session-side.
 *
 * Actors are side effects, NOT steps: the manager keeps no callIndex, no
 * journal identity, and nothing here joins or affects the workflow runtime's
 * hashAgentCall field set (workflow.ts). The workflow runtime is untouched by
 * this module.
 *
 * ── Determinism ────────────────────────────────────────────────────────────────
 * Spec criterion ids are FNV-1a content hashes (replay-idempotent — the same
 * criterion text always yields the same id across sessions); drift detection is
 * a pure function of (goal, prompt); the manager clock is injectable (`now`).
 * Activations are accounted per actor per session (activationBudget) so a
 * runaway actor cannot spam the session indefinitely.
 *
 * The extension entry (extensions/workflow.ts) is the ONLY wiring surface:
 * `hostActors: "on"` (settings, default off) creates the manager with a
 * `sendMessage` delivery hook and registers the before_agent_start / context /
 * session_compact observers; `session_start` boundary dispatch rides the
 * extension's existing session_start handler.
 */

import { join } from "node:path";
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import {
  HOST_ACTORS_ACTIVATION_CAP_DEFAULT,
  HOST_ACTORS_QUEUE_MAX,
  HOST_ACTORS_WATCHDOG_DRIFT_THRESHOLD_DEFAULT,
} from "./config.js";
import {
  ensureDir,
  type PersistenceFsLayer,
  readJsonWithBackupRecovery,
  resolvePersistenceFs,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";

/** The four host event families the actor manager can subscribe to. */
export type HostActorEventType = "before_agent_start" | "context" | "session_compact" | "session_start";

/** All host event types, for config validation and subscription defaults. */
export const HOST_ACTOR_EVENT_TYPES: readonly HostActorEventType[] = [
  "before_agent_start",
  "context",
  "session_compact",
  "session_start",
];

/** Actor profiles. `supervisor` is the only profile allowed `triggerTurn: true`. */
export type HostActorProfile = "watchdog" | "advisor" | "spec" | "supervisor";

/** How an actor's delivery reaches the session. */
export type ActorDeliveryMode = "quiet" | "message" | "directive";

/**
 * Delivery policy for one actor. `triggerTurn: true` is REJECTED for every
 * profile except `supervisor` (stop-the-world gate) — watchdog/advisor/spec
 * are quiet reviewers by construction.
 */
export interface ActorDeliveryPolicy {
  mode: ActorDeliveryMode;
  /** Force a host turn on delivery (sendMessage triggerTurn) — supervisor-only. */
  triggerTurn: boolean;
}

/** Custom-message shape compatible with pi's CustomMessage (text content only). */
export interface HostActorMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

/** Shared config fields for every actor. */
export interface HostActorConfigBase {
  /** Stable actor id — the persisted state key (`state-<id>.json`). */
  id: string;
  profile: HostActorProfile;
  /** Host events this actor subscribes to (default: profile's natural set). */
  subscriptions?: readonly HostActorEventType[];
  /** Delivery policy (partial — defaults per profile). */
  delivery?: Partial<ActorDeliveryPolicy>;
  /** Per-actor delivery budget per session (default HOST_ACTORS_ACTIVATION_CAP_DEFAULT). */
  activationBudget?: number;
}

/** Goal-drift detector: flags prompts that drift from the declared goal. */
export interface WatchdogActorConfig extends HostActorConfigBase {
  profile: "watchdog";
  /** The declared goal the actor guards. */
  goal: string;
  /** Jaccard similarity below this flags drift (default HOST_ACTORS_WATCHDOG_DRIFT_THRESHOLD_DEFAULT). */
  driftThreshold?: number;
  /** Re-inject the goal as a reminder message after context compaction. */
  remindOnCompact?: boolean;
}

/** Quiet decision-point reviewer: injects review text when the trigger matches. */
export interface AdvisorActorConfig extends HostActorConfigBase {
  profile: "advisor";
  /** Review topic (used in the message label). */
  topic: string;
  /** Case-insensitive substring trigger (or /^regex$/ when it starts with "^"). */
  trigger: string;
  /** The review text injected into the session when triggered. */
  advice: string;
}

/** Acceptance ledger: extracts + persists criteria across sessions. */
export interface SpecActorConfig extends HostActorConfigBase {
  profile: "spec";
  /** Line markers that mark a prompt line as an acceptance criterion. */
  acceptanceMarkers?: readonly string[];
  /** Markers that mark an open criterion as verified. */
  doneMarkers?: readonly string[];
  /** Remind open criteria after compaction (delivery policy must not be quiet). */
  remindOnCompact?: boolean;
}

/** Directive steers: the only profile allowed triggerTurn (stop-the-world gate). */
export interface SupervisorActorConfig extends HostActorConfigBase {
  profile: "supervisor";
  topic: string;
  /** Case-insensitive substring trigger (or /^regex$/ when it starts with "^"). */
  trigger: string;
  /** The directive text delivered with triggerTurn when triggered. */
  directive: string;
}

export type HostActorConfig = WatchdogActorConfig | AdvisorActorConfig | SpecActorConfig | SupervisorActorConfig;

/** Normalized payload for `before_agent_start`. */
export interface BeforeAgentStartActorPayload {
  /** The raw user prompt text (after expansion). */
  prompt: string;
  /** The fully assembled system prompt string. */
  systemPrompt: string;
}

/** Normalized payload for `context` (the raw host message list — never rewritten). */
export interface ContextActorPayload {
  /** Raw host AgentMessage[] — the manager builds a bounded, defensive text view. */
  messages: readonly unknown[];
}

/** Normalized payload for `session_compact`. */
export interface SessionCompactActorPayload {
  reason: string;
  fromExtension: boolean;
  willRetry: boolean;
}

/** Normalized payload for `session_start`. */
export interface SessionStartActorPayload {
  reason?: string;
  previousSessionFile?: string;
}

export type HostActorPayload =
  | BeforeAgentStartActorPayload
  | ContextActorPayload
  | SessionCompactActorPayload
  | SessionStartActorPayload;

/** One processed event in an actor's serial-mailbox journal. */
export interface HostActorEventRecord {
  event: HostActorEventType;
  /** Epoch ms from the manager's injectable clock. */
  at: number;
  /** Record kind ("drift", "goal_reminder", "review", "criterion", ...). */
  kind: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

/** One entry in a spec actor's acceptance ledger. */
export interface SpecCriterion {
  /** Deterministic FNV-1a content hash of the normalized criterion text. */
  id: string;
  text: string;
  /** Epoch ms (manager clock) when the criterion was first recorded. */
  addedAt: number;
  status: "open" | "verified";
  /** Epoch ms when the criterion was marked verified. */
  verifiedAt?: number;
}

/** Persisted per-actor state (state-<id>.json). */
export interface HostActorState {
  /** Serial-mailbox journal — bounded FIFO (HOST_ACTORS_QUEUE_MAX). */
  events: HostActorEventRecord[];
  /** Watchdog drift flags. */
  driftFlags: Array<{ at: number; prompt: string; similarity: number }>;
  /** Spec acceptance ledger. */
  criteria: SpecCriterion[];
}

/** A contribution an actor handler returns for the CURRENT host event. */
export interface ActorContribution {
  /** Custom message delivered into the session (before_agent_start result or sendMessage). */
  message?: HostActorMessage;
  /** System-prompt replacement — only meaningful for before_agent_start. */
  systemPrompt?: string;
}

/** Summary view of one actor for inspection (tests, diagnostics). */
export interface HostActorSummary {
  id: string;
  profile: HostActorProfile;
  subscriptions: HostActorEventType[];
  delivery: ActorDeliveryPolicy;
  activationBudget: number;
  events: number;
  sessionDeliveries: number;
  openCriteria: number;
}

/** Manager construction options. */
export interface HostActorManagerOptions {
  /** Persistence root (default `getAgentDir()/workflows/actors`). */
  dir?: string;
  /** Master enable gate (settings, default off). Inert when false. */
  enabled?: boolean;
  /** Actor defs. When provided they are persisted (upsert); otherwise defs load from `dir/actors.json`. */
  actors?: readonly HostActorConfig[];
  /** Delivery hook for non-before_agent_start events (extension wires pi.sendMessage). */
  deliver?: (message: HostActorMessage, options: { triggerTurn: boolean }) => void;
  /** Injectable clock (default Date.now) — keeps records deterministic in tests. */
  now?: () => number;
  /** Injectable fs layer (tests). */
  fs?: PersistenceFsLayer;
  /** Per-actor delivery budget per session (default HOST_ACTORS_ACTIVATION_CAP_DEFAULT). */
  activationCap?: number;
  /** Per-actor journal cap (default HOST_ACTORS_QUEUE_MAX). */
  queueMax?: number;
  /** Bounded view cap for context events (default HOST_ACTORS_CONTEXT_VIEW_MAX_CHARS). */
  contextViewMaxChars?: number;
}

/** Thrown for invalid actor configs (bad delivery policy, missing required fields). */
export class HostActorsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostActorsConfigError";
  }
}

/** Default per-context-event textual view cap (observation only). */
export const HOST_ACTORS_CONTEXT_VIEW_MAX_CHARS = 2000;

/** Default spec acceptance markers (prompt lines containing any marker are criteria). */
export const SPEC_ACCEPTANCE_MARKERS_DEFAULT: readonly string[] = ["acceptance", "criteria", "criterion"];

/** Default done markers (an open criterion is verified when the prompt carries one). */
export const SPEC_DONE_MARKERS_DEFAULT: readonly string[] = ["verified", "completed", "fixed", "done", "passing"];

/** Default spec subscription set. */
export const SPEC_SUBSCRIPTIONS_DEFAULT: readonly HostActorEventType[] = [
  "before_agent_start",
  "session_compact",
  "session_start",
];

/** Default watchdog subscription set. */
export const WATCHDOG_SUBSCRIPTIONS_DEFAULT: readonly HostActorEventType[] = ["before_agent_start", "session_compact"];

/** The default customType tag for actor-delivered messages. */
export const HOST_ACTOR_MESSAGE_CUSTOM_TYPE = "workflow.actor";

// ── Deterministic cores ─────────────────────────────────────────────────────────

/** Lowercased alphanumeric token set of a text (pure). */
export function tokenSet(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens);
}

/**
 * Jaccard similarity between two texts' token sets — the watchdog's drift
 * heuristic. Pure and deterministic: 1 = identical token sets, 0 = disjoint.
 * An empty goal or prompt yields 0 (a prompt with no shared vocabulary cannot
 * be on-goal).
 */
export function goalSimilarity(goal: string, prompt: string): number {
  const goalTokens = tokenSet(goal);
  const promptTokens = tokenSet(prompt);
  if (goalTokens.size === 0 || promptTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of goalTokens) {
    if (promptTokens.has(token)) intersection++;
  }
  const union = goalTokens.size + promptTokens.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Deterministic FNV-1a 32-bit hash (claim-verify.ts precedent) → hex id. */
export function fnv1aHex(payload: string): string {
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Normalize criterion text for content addressing (trim + collapse whitespace). */
export function normalizeCriterionText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** True when a raw text line carries one of the acceptance markers (pure). */
export function isAcceptanceCriterionLine(line: string, markers: readonly string[]): boolean {
  const lowered = line.toLowerCase();
  return markers.some((marker) => lowered.includes(marker.toLowerCase()));
}

/** Extract acceptance-criterion lines from a prompt (pure, line-based). */
export function extractAcceptanceCriteria(prompt: string, markers: readonly string[]): string[] {
  const results: string[] = [];
  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (isAcceptanceCriterionLine(line, markers)) results.push(line);
  }
  return results;
}

/** True when a prompt carries one of the done markers (pure). */
export function promptCarriesDoneMarker(prompt: string, markers: readonly string[]): boolean {
  const lowered = prompt.toLowerCase();
  return markers.some((marker) => lowered.includes(marker.toLowerCase()));
}

/** Generic content words excluded from criterion-mention matching. */
const CRITERION_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "for",
  "in",
  "is",
  "must",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

function contentTokens(text: string): Set<string> {
  const tokens = tokenSet(text);
  for (const stop of CRITERION_STOPWORDS) tokens.delete(stop);
  return tokens;
}

/**
 * True when a prompt substantially mentions a criterion: at least one
 * content token of the criterion appears in the prompt (stopwords excluded).
 * The deterministic companion of promptCarriesDoneMarker — an open criterion
 * is verified only when the done-marked prompt actually references it.
 */
export function criterionMentioned(prompt: string, criterionText: string): boolean {
  const promptTokens = contentTokens(prompt);
  const criterionTokens = contentTokens(criterionText);
  if (criterionTokens.size === 0) return false;
  for (const token of criterionTokens) {
    if (promptTokens.has(token)) return true;
  }
  return false;
}

// ── Config validation ───────────────────────────────────────────────────────────

/** Profile → natural subscription set when the config omits `subscriptions`. */
export function defaultSubscriptionsForProfile(profile: HostActorProfile): readonly HostActorEventType[] {
  switch (profile) {
    case "watchdog":
      return WATCHDOG_SUBSCRIPTIONS_DEFAULT;
    case "advisor":
      return ["before_agent_start"];
    case "spec":
      return SPEC_SUBSCRIPTIONS_DEFAULT;
    case "supervisor":
      return ["before_agent_start", "session_compact"];
  }
}

/** Default delivery policy per profile. */
export function defaultDeliveryForProfile(profile: HostActorProfile): ActorDeliveryPolicy {
  switch (profile) {
    case "supervisor":
      return { mode: "directive", triggerTurn: true };
    default:
      return { mode: "message", triggerTurn: false };
  }
}

/**
 * Normalize + validate a delivery policy against its profile. Enforces the
 * invariant `triggerTurn: true` is ONLY allowed for the supervisor profile
 * (stop-the-world gate); the directive mode implies triggerTurn.
 */
export function normalizeDeliveryPolicy(
  profile: HostActorProfile,
  partial: Partial<ActorDeliveryPolicy> | undefined,
): ActorDeliveryPolicy {
  const base = defaultDeliveryForProfile(profile);
  const mode = partial?.mode ?? base.mode;
  const triggerTurn = partial?.triggerTurn ?? base.triggerTurn;
  if (triggerTurn && profile !== "supervisor") {
    throw new HostActorsConfigError(
      `actor profile "${profile}" may not use triggerTurn: true — only the supervisor profile can force a turn (stop-the-world gate)`,
    );
  }
  if (mode === "directive" && profile !== "supervisor") {
    throw new HostActorsConfigError(
      `actor profile "${profile}" may not use delivery mode "directive" — directive response mode is supervisor-only`,
    );
  }
  return { mode, triggerTurn };
}

/** Validate required fields per profile; throws HostActorsConfigError. */
export function assertValidActorConfig(config: HostActorConfig): void {
  if (typeof config.id !== "string" || config.id.trim().length === 0) {
    throw new HostActorsConfigError("actor id must be a non-empty string");
  }
  switch (config.profile) {
    case "watchdog":
      if (typeof config.goal !== "string" || config.goal.trim().length === 0) {
        throw new HostActorsConfigError(`watchdog actor "${config.id}" requires a non-empty goal`);
      }
      break;
    case "advisor":
      if (typeof config.topic !== "string" || config.topic.trim().length === 0) {
        throw new HostActorsConfigError(`advisor actor "${config.id}" requires a non-empty topic`);
      }
      if (typeof config.trigger !== "string" || config.trigger.trim().length === 0) {
        throw new HostActorsConfigError(`advisor actor "${config.id}" requires a non-empty trigger`);
      }
      if (typeof config.advice !== "string" || config.advice.trim().length === 0) {
        throw new HostActorsConfigError(`advisor actor "${config.id}" requires non-empty advice text`);
      }
      break;
    case "spec":
      break;
    case "supervisor":
      if (typeof config.topic !== "string" || config.topic.trim().length === 0) {
        throw new HostActorsConfigError(`supervisor actor "${config.id}" requires a non-empty topic`);
      }
      if (typeof config.trigger !== "string" || config.trigger.trim().length === 0) {
        throw new HostActorsConfigError(`supervisor actor "${config.id}" requires a non-empty trigger`);
      }
      if (typeof config.directive !== "string" || config.directive.trim().length === 0) {
        throw new HostActorsConfigError(`supervisor actor "${config.id}" requires directive text`);
      }
      break;
  }
}

/**
 * Lenient parse of raw (JSON-file) actor defs: valid entries pass through
 * (after validation), invalid entries are dropped. This is the documented user
 * path for `~/.pi/agent/workflows/actors/actors.json`.
 */
export function parseHostActorConfigs(raw: unknown): HostActorConfig[] {
  if (!Array.isArray(raw)) return [];
  const configs: HostActorConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    const profile = candidate.profile;
    if (profile !== "watchdog" && profile !== "advisor" && profile !== "spec" && profile !== "supervisor") {
      continue;
    }
    const id = typeof candidate.id === "string" ? candidate.id : undefined;
    if (!id) continue;
    const config = { id, profile, ...candidate } as HostActorConfig;
    try {
      assertValidActorConfig(config);
      normalizeDeliveryPolicy(config.profile, config.delivery);
      configs.push(config);
    } catch {
      // Lenient: a malformed entry disables just that actor.
    }
  }
  return configs;
}

// ── Manager internals ───────────────────────────────────────────────────────────

/** Internal actor runtime (config + policy + persisted state + session counts). */
interface ActorRuntime {
  config: HostActorConfig;
  delivery: ActorDeliveryPolicy;
  subscriptions: Set<HostActorEventType>;
  state: HostActorState;
  sessionDeliveries: number;
}

interface ProfileResult {
  kind: string;
  detail?: string;
  meta?: Record<string, unknown>;
  /** Contribution for the CURRENT host event (returned to the host). */
  contribution?: ActorContribution;
}

function isBeforeAgentStartPayload(payload: HostActorPayload): payload is BeforeAgentStartActorPayload {
  return typeof (payload as BeforeAgentStartActorPayload).prompt === "string";
}

/** Bounded, defensive textual view of raw host context messages (observation only). */
export function boundedContextView(
  messages: readonly unknown[],
  capChars: number,
): Array<{ role?: string; text: string }> {
  const view: Array<{ role?: string; text: string }> = [];
  let total = 0;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as { role?: unknown; content?: unknown };
    const role = typeof message.role === "string" ? message.role : undefined;
    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
          const partText = (part as { text?: unknown }).text;
          if (typeof partText === "string") text += partText;
        }
      }
    }
    if (text.length === 0) continue;
    if (total >= capChars) {
      view.push({ role, text: "…" });
      break;
    }
    const slice = text.slice(0, capChars - total);
    view.push({ role, text: slice });
    total += slice.length;
  }
  return view;
}

/** True when a trigger (substring or /^...$/ regex) matches a prompt (pure). */
export function triggerMatches(trigger: string, text: string): boolean {
  const trimmed = trigger.trim();
  if (trimmed.startsWith("^") && trimmed.includes("$")) {
    try {
      return new RegExp(trimmed, "i").test(text);
    } catch {
      return text.toLowerCase().includes(trimmed.toLowerCase());
    }
  }
  return text.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * Session-scoped host-event actor manager (V2-P12).
 *
 * Inert when `enabled: false` (settings default-off): no actors are loaded and
 * every dispatch is a no-op. When enabled, actor defs come from the constructor
 * `actors` option (persisted as `dir/actors.json`) or, when omitted, from the
 * persisted `dir/actors.json` file — the documented user path.
 *
 * Dispatch is synchronous and serial: each host event is processed in actor
 * registration order, and each actor's mailbox (bounded FIFO journal) records
 * the processed event before the next one is handled — no interleaving, no
 * re-entrancy (actor handlers never dispatch).
 */
export class HostActorManager {
  readonly enabled: boolean;
  private readonly dir: string;
  private readonly fs: PersistenceFsLayer;
  private readonly now: () => number;
  private readonly deliver: ((message: HostActorMessage, options: { triggerTurn: boolean }) => void) | undefined;
  private readonly activationCap: number;
  private readonly queueMax: number;
  private readonly contextViewMaxChars: number;
  private readonly actors: ActorRuntime[] = [];

  constructor(options: HostActorManagerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.dir = options.dir ?? join(process.cwd(), ".pi", "workflows", "actors");
    this.fs = resolvePersistenceFs(options.fs);
    this.now = options.now ?? (() => Date.now());
    this.deliver = options.deliver;
    this.activationCap = options.activationCap ?? HOST_ACTORS_ACTIVATION_CAP_DEFAULT;
    this.queueMax = options.queueMax ?? HOST_ACTORS_QUEUE_MAX;
    this.contextViewMaxChars = options.contextViewMaxChars ?? HOST_ACTORS_CONTEXT_VIEW_MAX_CHARS;
    if (!this.enabled) return;
    const defs = this.loadDefs(options.actors);
    for (const config of defs) {
      this.actors.push(this.buildRuntime(config));
    }
  }

  /** Persisted defs path. */
  defsPath(): string {
    return join(this.dir, "actors.json");
  }

  /** Persisted state path for one actor id. */
  statePath(id: string): string {
    return join(this.dir, `state-${id}.json`);
  }

  private loadDefs(explicit: readonly HostActorConfig[] | undefined): HostActorConfig[] {
    if (explicit && explicit.length > 0) {
      // Persist the provided defs (idempotent upsert) so a NEW extension
      // generation on the same machine reconstructs the same actor set.
      const saved = this.persistDefs(explicit);
      return saved;
    }
    const loaded = readJsonWithBackupRecovery<unknown>(this.fs, this.defsPath());
    return parseHostActorConfigs(loaded);
  }

  private persistDefs(configs: readonly HostActorConfig[]): HostActorConfig[] {
    ensureDir(this.fs, this.dir);
    const existing = parseHostActorConfigs(readJsonWithBackupRecovery<unknown>(this.fs, this.defsPath()));
    const merged = new Map<string, HostActorConfig>();
    for (const config of existing) merged.set(config.id, config);
    for (const config of configs) merged.set(config.id, config);
    const list = [...merged.values()];
    writeJsonAtomicWithBackup(this.fs, this.defsPath(), list);
    return list;
  }

  private buildRuntime(config: HostActorConfig): ActorRuntime {
    assertValidActorConfig(config);
    const delivery = normalizeDeliveryPolicy(config.profile, config.delivery);
    const subscriptions = new Set<HostActorEventType>(
      config.subscriptions && config.subscriptions.length > 0
        ? config.subscriptions
        : defaultSubscriptionsForProfile(config.profile),
    );
    const loaded = readJsonWithBackupRecovery<HostActorState>(this.fs, this.statePath(config.id));
    const state: HostActorState = {
      events: Array.isArray(loaded?.events) ? loaded.events.slice(-this.queueMax) : [],
      driftFlags: Array.isArray(loaded?.driftFlags) ? loaded.driftFlags : [],
      criteria: Array.isArray(loaded?.criteria) ? loaded.criteria : [],
    };
    return {
      config,
      delivery,
      subscriptions,
      state,
      sessionDeliveries: 0,
    };
  }

  private persistState(actor: ActorRuntime): void {
    ensureDir(this.fs, this.dir);
    const trimmed: HostActorState = {
      events: actor.state.events.slice(-this.queueMax),
      driftFlags: actor.state.driftFlags.slice(-this.queueMax),
      criteria: actor.state.criteria,
    };
    writeJsonAtomicWithBackup(this.fs, this.statePath(actor.config.id), trimmed);
  }

  private recordEvent(
    actor: ActorRuntime,
    event: HostActorEventType,
    kind: string,
    detail?: string,
    meta?: Record<string, unknown>,
  ): void {
    actor.state.events.push({
      event,
      at: this.now(),
      kind,
      ...(detail !== undefined ? { detail } : {}),
      ...(meta ? { meta } : {}),
    });
  }

  /** Summary of every registered actor (registration order). */
  listActors(): HostActorSummary[] {
    return this.actors.map((actor) => this.summarize(actor));
  }

  /** Summary of one actor, or undefined when not registered. */
  getActor(id: string): HostActorSummary | undefined {
    const actor = this.actors.find((candidate) => candidate.config.id === id);
    return actor ? this.summarize(actor) : undefined;
  }

  /** True when an actor with the given id is registered. */
  hasActor(id: string): boolean {
    return this.actors.some((actor) => actor.config.id === id);
  }

  private summarize(actor: ActorRuntime): HostActorSummary {
    return {
      id: actor.config.id,
      profile: actor.config.profile,
      subscriptions: [...actor.subscriptions],
      delivery: actor.delivery,
      activationBudget: actor.config.activationBudget ?? this.activationCap,
      events: actor.state.events.length,
      sessionDeliveries: actor.sessionDeliveries,
      openCriteria: actor.state.criteria.filter((criterion) => criterion.status === "open").length,
    };
  }

  /**
   * Dispatch a `before_agent_start` host event. Returns the merged
   * BeforeAgentStartEventResult-shaped contribution (message first-wins,
   * systemPrompt last-wins across actors) or undefined.
   */
  onBeforeAgentStart(payload: BeforeAgentStartActorPayload): BeforeAgentStartEventResult | undefined {
    if (!this.enabled) return undefined;
    let message: HostActorMessage | undefined;
    let systemPrompt: string | undefined;
    for (const actor of this.actors) {
      if (!actor.subscriptions.has("before_agent_start")) continue;
      const result = this.handleEvent(actor, "before_agent_start", payload);
      if (result?.contribution) {
        if (result.contribution.message !== undefined && message === undefined) message = result.contribution.message;
        if (result.contribution.systemPrompt !== undefined) systemPrompt = result.contribution.systemPrompt;
      }
    }
    if (message === undefined && systemPrompt === undefined) return undefined;
    return {
      ...(message !== undefined ? { message } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
  }

  /** Dispatch a `context` host event — OBSERVATIONAL only, never returns a rewrite. */
  onContext(payload: ContextActorPayload): undefined {
    if (!this.enabled) return undefined;
    for (const actor of this.actors) {
      if (!actor.subscriptions.has("context")) continue;
      this.handleEvent(actor, "context", { messages: payload.messages });
    }
    return undefined;
  }

  /** Dispatch a `session_compact` host event (deliveries via the sendMessage hook). */
  onSessionCompact(payload: SessionCompactActorPayload): void {
    if (!this.enabled) return;
    for (const actor of this.actors) {
      if (!actor.subscriptions.has("session_compact")) continue;
      this.handleEvent(actor, "session_compact", payload);
    }
  }

  /** Dispatch a `session_start` host event (session boundary for ledgers). */
  onSessionStart(payload: SessionStartActorPayload): void {
    if (!this.enabled) return;
    for (const actor of this.actors) {
      if (!actor.subscriptions.has("session_start")) continue;
      this.handleEvent(actor, "session_start", payload);
    }
  }

  /** Persist every actor's defs + state (idempotent; called automatically on events). */
  flush(): void {
    if (!this.enabled) return;
    ensureDir(this.fs, this.dir);
    if (this.actors.length > 0) {
      writeJsonAtomicWithBackup(
        this.fs,
        this.defsPath(),
        this.actors.map((actor) => actor.config),
      );
    }
    for (const actor of this.actors) this.persistState(actor);
  }

  private handleEvent(
    actor: ActorRuntime,
    event: HostActorEventType,
    payload: HostActorPayload,
  ): ProfileResult | undefined {
    const profileResult = this.runProfile(actor, event, payload);
    if (profileResult) {
      const { kind, detail, meta } = profileResult;
      this.recordEvent(actor, event, kind, detail, meta);
    }
    this.persistState(actor);
    if (!profileResult) return undefined;
    const { kind, detail, meta, contribution } = profileResult;
    if (contribution?.message) {
      if (actor.sessionDeliveries >= (actor.config.activationBudget ?? this.activationCap)) {
        this.recordEvent(
          actor,
          event,
          "delivery_suppressed",
          `activation budget (${actor.config.activationBudget ?? this.activationCap}) exhausted`,
        );
        this.persistState(actor);
        return undefined;
      }
      actor.sessionDeliveries++;
      if (event === "before_agent_start") {
        return { kind, detail, meta, contribution };
      }
      // Non-before_agent_start events deliver through the host's sendMessage
      // channel (session-side custom message).
      this.deliver?.(contribution.message, { triggerTurn: actor.delivery.triggerTurn });
      return { kind, detail, meta };
    }
    return profileResult;
  }

  private runProfile(
    actor: ActorRuntime,
    event: HostActorEventType,
    payload: HostActorPayload,
  ): ProfileResult | undefined {
    switch (actor.config.profile) {
      case "watchdog":
        return this.runWatchdog(actor, event, payload);
      case "advisor":
        return this.runAdvisor(actor, event, payload);
      case "spec":
        return this.runSpec(actor, event, payload);
      case "supervisor":
        return this.runSupervisor(actor, event, payload);
    }
  }

  private actorMessage(actor: ActorRuntime, label: string, content: string, details?: unknown): HostActorMessage {
    return {
      customType: HOST_ACTOR_MESSAGE_CUSTOM_TYPE,
      content: `[${actor.config.profile}] ${label}\n${content}`,
      display: true,
      details: {
        actor: actor.config.id,
        profile: actor.config.profile,
        ...(details ? (details as Record<string, unknown>) : {}),
      },
    };
  }

  private runWatchdog(
    actor: ActorRuntime,
    event: HostActorEventType,
    payload: HostActorPayload,
  ): ProfileResult | undefined {
    const config = actor.config as WatchdogActorConfig;
    const threshold = config.driftThreshold ?? HOST_ACTORS_WATCHDOG_DRIFT_THRESHOLD_DEFAULT;
    if (event === "before_agent_start" && isBeforeAgentStartPayload(payload)) {
      const similarity = goalSimilarity(config.goal, payload.prompt);
      if (similarity < threshold) {
        actor.state.driftFlags.push({ at: this.now(), prompt: payload.prompt, similarity });
        const message = this.actorMessage(
          actor,
          "goal drift",
          `Similarity to the declared goal is ${similarity.toFixed(2)} (threshold ${threshold.toFixed(2)}).\nGoal: ${config.goal}\nPrompt: ${payload.prompt}`,
          { similarity, threshold },
        );
        return {
          kind: "drift",
          detail: `similarity=${similarity.toFixed(2)}`,
          meta: { similarity, threshold },
          contribution: { message },
        };
      }
      return { kind: "on_goal", detail: `similarity=${similarity.toFixed(2)}` };
    }
    if (event === "session_compact") {
      if (config.remindOnCompact === false || actor.delivery.mode === "quiet") {
        return { kind: "compacted", detail: "no reminder (quiet/disabled)" };
      }
      const message = this.actorMessage(
        actor,
        "goal reminder",
        `Context was compacted; the guarded goal is still active:\n${config.goal}`,
      );
      return { kind: "goal_reminder", contribution: { message } };
    }
    return undefined;
  }

  private runAdvisor(
    actor: ActorRuntime,
    event: HostActorEventType,
    payload: HostActorPayload,
  ): ProfileResult | undefined {
    if (event !== "before_agent_start" || !isBeforeAgentStartPayload(payload)) return undefined;
    const config = actor.config as AdvisorActorConfig;
    if (!triggerMatches(config.trigger, payload.prompt)) return undefined;
    const message = this.actorMessage(actor, `review · ${config.topic}`, config.advice, {
      topic: config.topic,
      trigger: config.trigger,
    });
    return { kind: "review", detail: `trigger matched: ${config.trigger}`, contribution: { message } };
  }

  private runSpec(
    actor: ActorRuntime,
    event: HostActorEventType,
    payload: HostActorPayload,
  ): ProfileResult | undefined {
    const config = actor.config as SpecActorConfig;
    const markers = config.acceptanceMarkers ?? SPEC_ACCEPTANCE_MARKERS_DEFAULT;
    if (event === "before_agent_start" && isBeforeAgentStartPayload(payload)) {
      const doneMarkers = config.doneMarkers ?? SPEC_DONE_MARKERS_DEFAULT;
      const done = promptCarriesDoneMarker(payload.prompt, doneMarkers);
      const found: string[] = [];
      if (done) {
        // A done-marked prompt verifies every OPEN criterion it mentions
        // (deterministic token-mention check — never the whole ledger).
        for (const criterion of actor.state.criteria) {
          if (criterion.status !== "open") continue;
          if (criterionMentioned(payload.prompt, criterion.text)) {
            criterion.status = "verified";
            criterion.verifiedAt = this.now();
            found.push(`verified: ${criterion.text}`);
          }
        }
      }
      for (const raw of extractAcceptanceCriteria(payload.prompt, markers)) {
        const text = normalizeCriterionText(raw);
        const id = fnv1aHex(text);
        const existing = actor.state.criteria.find((criterion) => criterion.id === id);
        if (existing) continue;
        // New criteria always start OPEN — verification is an explicit,
        // content-referenced transition on a later prompt.
        actor.state.criteria.push({ id, text, addedAt: this.now(), status: "open" });
        found.push(`added: ${text}`);
      }
      if (found.length === 0) {
        return { kind: done ? "done_prompt" : "no_criteria" };
      }
      return { kind: "criteria", detail: `${found.length} ledger change(s)`, meta: { changes: found } };
    }
    if (event === "session_compact") {
      const open = actor.state.criteria.filter((criterion) => criterion.status === "open");
      if (config.remindOnCompact === true && actor.delivery.mode !== "quiet" && open.length > 0) {
        const message = this.actorMessage(
          actor,
          "open acceptance criteria",
          open.map((criterion) => `- ${criterion.text}`).join("\n"),
          { open: open.length },
        );
        return {
          kind: "criteria_reminder",
          detail: `${open.length} open criterion/criteria`,
          contribution: { message },
        };
      }
      return { kind: "compacted", detail: `${open.length} open criterion/criteria` };
    }
    if (event === "session_start") {
      const open = actor.state.criteria.filter((criterion) => criterion.status === "open").length;
      return { kind: "session", detail: `session start (${open} open criterion/criteria)` };
    }
    return undefined;
  }

  private runSupervisor(
    actor: ActorRuntime,
    event: HostActorEventType,
    payload: HostActorPayload,
  ): ProfileResult | undefined {
    const config = actor.config as SupervisorActorConfig;
    if (event === "before_agent_start" && isBeforeAgentStartPayload(payload)) {
      if (!triggerMatches(config.trigger, payload.prompt)) return undefined;
      const message = this.actorMessage(actor, `directive · ${config.topic}`, config.directive, {
        topic: config.topic,
        trigger: config.trigger,
      });
      return { kind: "directive", detail: `trigger matched: ${config.trigger}`, contribution: { message } };
    }
    if (event === "session_compact") {
      // Re-steer after context loss (sendMessage with the actor's triggerTurn).
      const message = this.actorMessage(actor, `directive · ${config.topic}`, config.directive, {
        topic: config.topic,
        trigger: config.trigger,
        compacted: true,
      });
      return { kind: "directive_restated", contribution: { message } };
    }
    return undefined;
  }
}

/** Create a session-scoped host-event actor manager (V2-P12). */
export function createHostActorManager(options: HostActorManagerOptions = {}): HostActorManager {
  return new HostActorManager(options);
}
