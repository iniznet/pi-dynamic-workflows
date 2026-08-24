/**
 * Wayfinder Decision Mapping Module (Phase 0).
 *
 * Realigned to the Matt Pocock wayfinder spec:
 * - Fog-or-ticket gate driven by STATABLE QUESTIONS, not a 0-100 clarity score.
 * - The map persists as a MARKDOWN index (map.md) with a JSON sidecar (map.json)
 *   for machine reload.
 * - Full ticket lifecycle: claims (what must be true), blocking (parent/child),
 *   frontier-model mapping, one ticket per session, and parallel research
 *   dispatch through the workflow runtime's agent()/parallel() primitives.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowStateManager } from "./state-machine.js";

export enum TicketType {
  /** AFK documentation lookup. */
  RESEARCH = "research",
  /** Human-in-the-loop UI/stub build. */
  PROTOTYPE = "prototype",
  /** Human-in-the-loop interviews that dissolve fog. */
  GRILLING = "grilling",
  /** Concrete prerequisite or implementation work. */
  TASK = "task",
}

export type TicketStatus = "open" | "in-progress" | "resolved" | "blocked";

export type ClaimSource = "grilling" | "research" | "assumption";

/** A concrete statement that must be true for a ticket's resolution to hold. */
export interface TicketClaim {
  statement: string;
  source: ClaimSource;
}

/** A concrete question whose answer dissolves one piece of the fog. */
export interface StatableQuestion {
  id: string;
  question: string;
  /** Which ticket type should pursue the answer. */
  ticketType: TicketType.RESEARCH | TicketType.GRILLING;
  /** Why this question matters — the fog it clears. */
  context: string;
}

/** Result of the statable-question gate: foggy iff questions are needed. */
export interface FogAssessment {
  isFoggy: boolean;
  questions: StatableQuestion[];
}

export interface DecisionTicket {
  id: string;
  type: TicketType;
  title: string;
  description: string;
  status: TicketStatus;
  /** The statable question driving this ticket (grilling/research). */
  question?: string;
  /** What must be true for this ticket to be correctly resolved. */
  claims: TicketClaim[];
  /** Child ticket ids gated by this ticket's resolution. */
  blocks: string[];
  /** Parent ticket ids that gate this ticket. */
  blockedBy: string[];
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionMap {
  tickets: DecisionTicket[];
  rootQuestion: string;
  /** Id of the single ticket reserved for the current session (1/session). */
  activeTicket?: string;
  /** Next actionable ticket id (active session ticket, else first open). */
  nextTicket?: string;
  updatedAt: string;
}

/** Ticket shape produced by a frontier-model mapper; ids may be minted by the mapper. */
export interface FrontierMappedTicket {
  id?: string;
  type: TicketType;
  title: string;
  description: string;
  question?: string;
  claims?: Array<TicketClaim | string>;
  blocks?: string[];
  blockedBy?: string[];
}

/** Full map content produced by a frontier-model mapper. */
export interface FrontierMapping {
  rootQuestion: string;
  tickets: FrontierMappedTicket[];
}

/**
 * The frontier-model seam: production wiring points the frontier model tier at
 * this callback to map fog -> tickets. The default is a deterministic stub that
 * derives statable questions from the prompt text (no model call).
 */
export type FrontierMapper = (prompt: string) => FrontierMapping | Promise<FrontierMapping>;

/**
 * Structural subset of the workflow runtime's agent()/parallel() primitives
 * (workflow.ts:730 / workflow.ts:1136) — a workflow that owns the live runtime
 * can pass its real functions straight in; otherwise the seam stays a stub.
 */
export interface WayfinderRuntime {
  agent: (prompt: string, options?: { label?: string; tier?: string; model?: string }) => Promise<unknown>;
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
}

export type ResearchDispatch =
  | { dispatched: true; ticketId: string; findings: unknown[] }
  | { dispatched: false; ticketId: string; reason: "no-runtime" };

export interface CreateDecisionMapOptions {
  /** Frontier-model mapper; defaults to the deterministic statable-question stub. */
  mapper?: FrontierMapper;
}

const MAP_FILE_NAME = "map.md";
const SIDECAR_FILE_NAME = "map.json";

const STATUS_BADGES: Record<TicketStatus, string> = {
  open: "⏳ open",
  "in-progress": "🔨 in-progress",
  resolved: "✅ resolved",
  blocked: "🔒 blocked",
};

/** Hedge language that cannot be stated as a concrete requirement -> grilling. */
const HEDGE_QUESTIONS: ReadonlyArray<readonly [term: string, question: string]> = [
  ["somehow", "What exact mechanism or approach should accomplish this?"],
  ["maybe", "Is that a firm requirement or an option?"],
  ["might", "Is that a firm requirement or an option?"],
  ["could be", "What is the definitive behavior — what must hold?"],
  ["perhaps", "Is that a firm requirement or an option?"],
  ["not sure", "What is the concrete decision here?"],
  ["kind of", "What must be true exactly — what does this mean concretely?"],
  ["sort of", "What must be true exactly — what does this mean concretely?"],
  ["whatever", "What specific choice replaces \u201cwhatever\u201d?"],
  ["something like", "What specific option does \u201csomething like\u201d refer to?"],
  ["i think", "What is the confirmed requirement, not a guess?"],
  ["etc", "What are all the items — list them concretely."],
  ["and so on", "What are all the items — list them concretely."],
  ["stuff like that", "What specific items are included?"],
  ["whatever else", "What specific items are included?"],
  ["whether", "Which branch of the decision is required?"],
  ["such as", "What exact set of options is required?"],
  ["something", "What specific thing is being referred to?"],
];

/** Documentation-lookup language -> research tickets (AFK doc reading). */
const RESEARCH_PATTERNS: ReadonlyArray<readonly [pattern: RegExp, question: string]> = [
  [/\bdocumentation\b|\bdocs\b/i, "What do the documentation and current references say about this?"],
  [/\bhow\s+to\b/i, "What is the documented way to do this?"],
  [/\b(specification|spec)\b/i, "What does the specification require?"],
  [/\bguide\b/i, "What does the relevant guide specify?"],
  [/\b(sdk|library)\b/i, "What does the current SDK/library documentation say?"],
  [/\b(latest|current)\s+(version|release)\b/i, "What is the current version and its behavior?"],
  [/\bmigrat(e|ion)\b/i, "What does the migration path require?"],
  [/\bdeprecat(ed|ion)\b/i, "What is deprecated and what replaces it?"],
  [/\bbrowser\s+support\b/i, "Which browsers and versions must be supported?"],
];

const SHORT_PROMPT_WORDS = 10;

/**
 * Statable-question gate: decides whether a request is foggy by producing the
 * concrete questions that must be answered before it can be mapped to work.
 * Replaces the old numeric keyword-penalty clarity score.
 */
export function assessPrompt(prompt: string): FogAssessment {
  const text = prompt.trim();
  const questions: StatableQuestion[] = [];
  const seen = new Set<string>();
  const lower = text.toLowerCase();

  const push = (question: string, ticketType: StatableQuestion["ticketType"], context: string) => {
    if (seen.has(question)) return;
    seen.add(question);
    questions.push({ id: randomUUID(), question, ticketType, context });
  };

  if (!text) {
    push("What is the task?", TicketType.GRILLING, "No task was stated.");
    return { isFoggy: true, questions };
  }

  // Explicit questions in the prompt must be answered before work starts.
  const explicitParts = text.split(/[?？]/);
  for (const raw of explicitParts.slice(0, -1)) {
    const sentence = raw.trim();
    if (sentence) push(`${sentence}?`, TicketType.GRILLING, "The prompt asks this explicitly.");
  }

  for (const [term, question] of HEDGE_QUESTIONS) {
    if (lower.includes(term)) push(question, TicketType.GRILLING, `The prompt hedges with \u201c${term}\u201d.`);
  }

  for (const [pattern, question] of RESEARCH_PATTERNS) {
    if (pattern.test(text)) {
      push(
        question,
        TicketType.RESEARCH,
        `The prompt asks for information found in \u201c${pattern.source}\u201d context.`,
      );
    }
  }

  // Underspecified: too short to state any concrete requirement.
  if (questions.length === 0 && text.split(/\s+/).length < SHORT_PROMPT_WORDS) {
    push(
      `What concrete outcome should \u201c${truncate(text, 60)}\u201d produce?`,
      TicketType.GRILLING,
      "The prompt is too short to state a concrete requirement.",
    );
  }

  return { isFoggy: questions.length > 0, questions };
}

/**
 * Create (or re-map) a decision map. Uses the frontier-model mapper seam when
 * supplied; otherwise the deterministic statable-question stub.
 */
export async function createDecisionMap(prompt: string, options: CreateDecisionMapOptions = {}): Promise<DecisionMap> {
  const mapping = options.mapper ? await options.mapper(prompt) : stubMapping(prompt);
  return materializeMap(mapping);
}

/** Deterministic default mapper: fog -> question tickets + a gated task child. */
function stubMapping(prompt: string): FrontierMapping {
  const assessment = assessPrompt(prompt);

  if (!assessment.isFoggy) {
    return {
      rootQuestion: prompt,
      tickets: [
        {
          type: TicketType.TASK,
          title: `Implement: ${truncate(prompt, 60)}`,
          description: prompt,
          claims: [{ statement: prompt, source: "assumption" }],
        },
      ],
    };
  }

  const questionTickets: FrontierMappedTicket[] = assessment.questions.map((q) => ({
    id: randomUUID(),
    type: q.ticketType,
    title: q.question,
    description: q.context,
    question: q.question,
    claims: [
      {
        statement: `\u201c${q.question}\u201d is answered and confirmed.`,
        source: q.ticketType === TicketType.GRILLING ? "grilling" : "research",
      },
    ],
  }));

  const taskId = randomUUID();
  for (const ticket of questionTickets) ticket.blocks = [taskId];

  return {
    rootQuestion: prompt,
    tickets: [
      ...questionTickets,
      {
        id: taskId,
        type: TicketType.TASK,
        title: `Execute resolved requirement: ${truncate(prompt, 60)}`,
        description: prompt,
        blockedBy: questionTickets.map((t) => t.id as string),
        claims: [{ statement: "Every parent question above is answered.", source: "assumption" }],
      },
    ],
  };
}

/** Stamp ids/timestamps/claims and compute initial blocked statuses. */
function materializeMap(mapping: FrontierMapping): DecisionMap {
  const now = new Date().toISOString();
  const knownIds = new Set(mapping.tickets.map((t) => t.id).filter(Boolean));
  const tickets: DecisionTicket[] = mapping.tickets.map((raw) => {
    const ticket: DecisionTicket = {
      id: raw.id ?? randomUUID(),
      type: normalizeTicketType(raw.type),
      title: raw.title ?? "",
      description: raw.description ?? "",
      status: "open",
      claims: normalizeClaims(raw.claims),
      blocks: asStringArray(raw.blocks).filter((id) => knownIds.has(id)),
      blockedBy: asStringArray(raw.blockedBy).filter((id) => knownIds.has(id)),
      createdAt: now,
      updatedAt: now,
    };
    if (raw.question !== undefined) ticket.question = raw.question;
    return ticket;
  });
  reconcileEdges(tickets);
  breakCycles({ tickets });
  const map: DecisionMap = { tickets, rootQuestion: mapping.rootQuestion, updatedAt: now };
  recomputeStatuses(map);
  return finalize(map);
}

/**
 * Mark a ticket resolved (optionally with claims gathered while answering it),
 * unblock any children whose parents are all resolved, and propagate the
 * resolved ticket's claims into those children. Returns the same map unchanged
 * for an unknown ticket id.
 */
export function resolveTicket(
  map: DecisionMap,
  ticketId: string,
  resolution: string,
  extraClaims: Array<TicketClaim | string> = [],
): DecisionMap {
  const result = cloneMap(map);
  const ticket = result.tickets.find((t) => t.id === ticketId);
  if (!ticket) return map;

  ticket.status = "resolved";
  ticket.resolution = resolution;
  ticket.claims = dedupeClaims([...ticket.claims, ...normalizeClaims(extraClaims)]);
  ticket.updatedAt = new Date().toISOString();
  if (result.activeTicket === ticketId) delete result.activeTicket;

  recomputeStatuses(result);
  propagateClaims(result, ticket);
  return finalize(result);
}

/** Add a parent/child blocking edge (blocked waits on blocker). */
export function blockTicket(map: DecisionMap, blockerId: string, blockedId: string): DecisionMap {
  const result = cloneMap(map);
  const blocker = result.tickets.find((t) => t.id === blockerId);
  const blocked = result.tickets.find((t) => t.id === blockedId);
  if (!blocker || !blocked || blocker.id === blocked.id) return map;
  // Invariant (i5): the blocking graph must stay acyclic. Adding blocker ->
  // blocked is refused when blocked already reaches blocker, because that
  // would close a cycle and let the decision graph self-lock.
  if (canReachTicket(result.tickets, blockedId, blockerId)) return map;
  if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
  if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
  recomputeStatuses(result);
  return finalize(result);
}

/** Remove a parent/child blocking edge. */
export function unblockTicket(map: DecisionMap, blockerId: string, blockedId: string): DecisionMap {
  const result = cloneMap(map);
  const blocker = result.tickets.find((t) => t.id === blockerId);
  const blocked = result.tickets.find((t) => t.id === blockedId);
  if (!blocker || !blocked) return map;
  blocker.blocks = blocker.blocks.filter((id) => id !== blockedId);
  blocked.blockedBy = blocked.blockedBy.filter((id) => id !== blockerId);
  recomputeStatuses(result);
  return finalize(result);
}

/**
 * 1/session constraint: returns the single ticket for the current session.
 * Idempotent — a second call while one ticket is in-progress returns the same
 * ticket; the next ticket only becomes available once the active one resolves.
 */
export function beginSession(map: DecisionMap): { map: DecisionMap; ticket?: DecisionTicket } {
  const result = cloneMap(map);
  const active = result.tickets.find((t) => t.id === result.activeTicket && t.status === "in-progress");
  if (active) return { map: finalize(result), ticket: active };

  const next = result.tickets.find((t) => t.status === "open");
  if (!next) return { map: finalize(result) };

  next.status = "in-progress";
  next.updatedAt = new Date().toISOString();
  result.activeTicket = next.id;
  return { map: finalize(result), ticket: next };
}

/** The ticket currently reserved for the active session, if any. */
export function getSessionTicket(map: DecisionMap): DecisionTicket | undefined {
  return map.tickets.find((t) => t.id === map.activeTicket && t.status === "in-progress");
}

/** Next actionable step: the session ticket, else first open, else blocked/proceed. */
export function getNextAction(map: DecisionMap): { action: string; ticketId?: string } {
  const active = getSessionTicket(map);
  if (active) return { action: "in-session", ticketId: active.id };

  const open = map.tickets.find((t) => t.status === "open");
  if (open) return { action: `resolve-${open.type}`, ticketId: open.id };

  if (map.tickets.some((t) => t.status === "blocked")) return { action: "blocked" };
  return { action: "proceed" };
}

/** Stub prompt for dispatching a ticket's research to a subagent. */
export function buildResearchPrompt(ticket: DecisionTicket): string {
  const question = ticket.question ? `Question to answer: ${ticket.question}` : `Resolve: ${ticket.title}`;
  const claims =
    ticket.claims.length > 0
      ? `Claims that must hold after your research:\n${ticket.claims.map((c) => `- ${c.statement}`).join("\n")}`
      : "";
  return `[wayfinder research dispatch]\n${question}\n${claims}`.trim();
}

/**
 * Parallel research dispatch seam. Without a runtime this returns a
 * not-dispatched stub; with one it fans the ticket's research prompt out
 * through the workflow runtime's parallel()/agent() primitives.
 */
export async function dispatchTicketResearch(
  ticket: DecisionTicket,
  runtime?: WayfinderRuntime,
): Promise<ResearchDispatch> {
  if (!runtime) return { dispatched: false, ticketId: ticket.id, reason: "no-runtime" };
  const findings = await runtime.parallel([
    () => runtime.agent(buildResearchPrompt(ticket), { label: `wayfinder-research:${ticket.id}`, tier: "small" }),
  ]);
  return { dispatched: true, ticketId: ticket.id, findings };
}

/**
 * Decision ticket types that dissolve fog (research / prototype / grilling).
 * TASK tickets carry the implementation work itself, so they never gate the
 * wayfinder's own completion — a clear prompt maps to a single task ticket
 * and the wayfinder step completes immediately.
 */
const DECISION_TICKET_TYPES: ReadonlySet<TicketType> = new Set([
  TicketType.RESEARCH,
  TicketType.PROTOTYPE,
  TicketType.GRILLING,
]);

/**
 * Whether a decision map's fog is fully dissolved: every decision ticket
 * (research/prototype/grilling) is resolved. Blocked and in-progress tickets
 * are unresolved fog by another name, so only "resolved" counts.
 */
export function isMapFogResolved(map: DecisionMap): boolean {
  return map.tickets.every((ticket) => !DECISION_TICKET_TYPES.has(ticket.type) || ticket.status === "resolved");
}

/** Options for the run-entry Phase 0 stage (see runWayfinderStage). */
interface WayfinderStageOptions {
  /** Persisted phase state machine whose wayfinderComplete flag gates prewalk. */
  stateManager: WorkflowStateManager;
  /** The task prompt being assessed (input to the statable-question gate). */
  prompt: string;
  /** Directory that receives `.pi/workflows/map.md` + `map.json`. */
  dir: string;
  /** Frontier-model mapper seam; defaults to the deterministic stub. */
  mapper?: FrontierMapper;
  /** Run-log sink so pipeline steps are visible in the run's logs. */
  onLog?: (message: string) => void;
}

/** Outcome of the run-entry Phase 0 stage (see runWayfinderStage). */
interface WayfinderStageResult {
  /** The map in effect after this stage (loaded or freshly created). */
  map: DecisionMap;
  /** Whether a decision map was (re)written to disk by this stage. */
  savedMap: boolean;
  /** Whether the wayfinder step is complete (fog dissolved) — gates prewalk. */
  completed: boolean;
}

/**
 * Phase 0 stage wired into the workflow run entry: assess the prompt's fog,
 * persist a decision map, and mark wayfinderComplete once the fog is
 * dissolved.
 *
 * Session-by-session resolution: an existing map whose rootQuestion still
 * matches the prompt is kept (a previous session's ticket progress survives);
 * a missing map — or one for a different prompt — is (re)created through the
 * mapper seam. Completion means every decision ticket is resolved; a clear
 * prompt therefore completes immediately with its single-task map, while a
 * foggy prompt blocks prewalk until its tickets are resolved.
 */
export async function runWayfinderStage(options: WayfinderStageOptions): Promise<WayfinderStageResult> {
  const assessment = assessPrompt(options.prompt);
  options.onLog?.(
    `wayfinder: prompt assessed ${assessment.isFoggy ? "foggy" : "clear"} (${assessment.questions.length} statable question(s))`,
  );

  const existing = await loadDecisionMap(options.dir);
  const mapMatchesPrompt = existing !== null && existing.rootQuestion === options.prompt;
  let map: DecisionMap;
  let savedMap = false;
  if (mapMatchesPrompt && existing) {
    map = existing;
  } else {
    map = await createDecisionMap(options.prompt, { mapper: options.mapper });
    await saveDecisionMap(map, options.dir);
    savedMap = true;
  }

  const completed = isMapFogResolved(map);
  if (completed) {
    await options.stateManager.markWayfinderComplete();
    options.onLog?.("wayfinder complete: fog cleared — Phase 1 (prewalk) may proceed");
  } else {
    const pending = map.tickets.filter(
      (ticket) => DECISION_TICKET_TYPES.has(ticket.type) && ticket.status !== "resolved",
    );
    options.onLog?.(
      `wayfinder pending: ${pending.length} decision ticket(s) unresolved — prewalk stays blocked until they are resolved`,
    );
  }
  return { map, savedMap, completed };
}

/** Render the decision map as a MARKDOWN index (headings + ticket statuses). */
export function renderMarkdownMap(map: DecisionMap): string {
  const lines: string[] = [];
  const indexById = new Map(map.tickets.map((t, i) => [t.id, i + 1]));

  lines.push("# Wayfinder Map", "");
  lines.push(`> Root question: ${map.rootQuestion}`);
  lines.push(`> Updated: ${map.updatedAt}`, "");

  lines.push("## Ticket Index", "");
  lines.push("| # | Type | Title | Status |");
  lines.push("|---|------|-------|--------|");
  for (const [index, ticket] of map.tickets.entries()) {
    lines.push(`| ${index + 1} | ${ticket.type} | ${ticket.title} | ${STATUS_BADGES[ticket.status]} |`);
  }
  lines.push("", "## Tickets", "");

  for (const [index, ticket] of map.tickets.entries()) {
    lines.push(`### #${index + 1} — ${ticket.type}: ${ticket.title}`, "");
    lines.push(`- **Status:** ${STATUS_BADGES[ticket.status]}`);
    if (ticket.question) lines.push(`- **Question:** ${ticket.question}`);
    if (ticket.claims.length > 0) {
      lines.push("- **Claims:**");
      for (const claim of ticket.claims) lines.push(`  - [${claim.source}] ${claim.statement}`);
    }
    const blocks = ticket.blocks.map((id) => `#${indexById.get(id)}`).join(", ");
    const blockedBy = ticket.blockedBy.map((id) => `#${indexById.get(id)}`).join(", ");
    lines.push(`- **Blocks:** ${blocks || "—"}`);
    lines.push(`- **Blocked by:** ${blockedBy || "—"}`);
    if (ticket.resolution) lines.push(`- **Resolution:** ${ticket.resolution}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Persist the map: map.md is the human-facing MARKDOWN index; map.json is the
 * machine sidecar that loadDecisionMap reads back.
 */
export async function saveDecisionMap(map: DecisionMap, dir: string): Promise<void> {
  const mapDir = join(dir, ".pi", "workflows");
  await mkdir(mapDir, { recursive: true });
  await writeFile(join(mapDir, MAP_FILE_NAME), renderMarkdownMap(map), "utf-8");
  await writeFile(join(mapDir, SIDECAR_FILE_NAME), JSON.stringify(map, null, 2), "utf-8");
}

/** Load a previously saved decision map from the JSON sidecar. */
export async function loadDecisionMap(dir: string): Promise<DecisionMap | null> {
  try {
    const data = await readFile(join(dir, ".pi", "workflows", SIDECAR_FILE_NAME), "utf-8");
    return normalizeDecisionMap(JSON.parse(data));
  } catch {
    return null;
  }
}

/**
 * Normalize a parsed sidecar blob into a structurally valid DecisionMap.
 *
 * Stale or hand-edited sidecars degrade to defaults (invalid statuses/types
 * reset, non-array lists become empty, garbage timestamps are replaced)
 * instead of throwing TypeErrors downstream; dangling edges are dropped,
 * blocking cycles are broken, and statuses/nextTicket are recomputed so the
 * loaded graph can never self-lock. Returns null for a fundamentally
 * unrecognizable shape (non-object, missing tickets array).
 */
function normalizeDecisionMap(value: unknown): DecisionMap | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.tickets)) return null;

  const now = new Date().toISOString();
  const asString = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
  const asTimestamp = (v: unknown): string => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : now);

  const knownIds = new Set<string>();
  const tickets: DecisionTicket[] = [];
  for (const entry of raw.tickets) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const t = entry as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : "";
    if (!id || knownIds.has(id)) continue; // ids are unique identifiers; duplicates drop
    knownIds.add(id);
    const ticket: DecisionTicket = {
      id,
      type: normalizeTicketType(t.type),
      title: asString(t.title, ""),
      description: asString(t.description, ""),
      status: normalizeTicketStatus(t.status),
      claims: normalizeClaims(t.claims),
      blocks: asStringArray(t.blocks).filter((b) => knownIds.has(b)),
      blockedBy: asStringArray(t.blockedBy).filter((b) => knownIds.has(b)),
      createdAt: asTimestamp(t.createdAt),
      updatedAt: asTimestamp(t.updatedAt),
    };
    if (typeof t.question === "string") ticket.question = t.question;
    if (typeof t.resolution === "string") ticket.resolution = t.resolution;
    tickets.push(ticket);
  }

  reconcileEdges(tickets);
  breakCycles({ tickets });

  const map: DecisionMap = {
    tickets,
    rootQuestion: asString(raw.rootQuestion, ""),
    updatedAt: asTimestamp(raw.updatedAt),
  };
  if (typeof raw.activeTicket === "string" && knownIds.has(raw.activeTicket)) {
    map.activeTicket = raw.activeTicket;
  }
  recomputeStatuses(map);
  recomputeNextTicket(map);
  return map;
}

function cloneMap(map: DecisionMap): DecisionMap {
  return {
    ...map,
    tickets: map.tickets.map((t) => ({
      ...t,
      claims: [...t.claims],
      blocks: [...t.blocks],
      blockedBy: [...t.blockedBy],
    })),
  };
}

function normalizeClaims(claims: unknown = []): TicketClaim[] {
  if (!Array.isArray(claims)) return [];
  return dedupeClaims(
    claims
      .map((c): TicketClaim | null => {
        if (typeof c === "string") return { statement: c, source: "assumption" };
        if (typeof c === "object" && c !== null && typeof (c as TicketClaim).statement === "string") {
          return { statement: (c as TicketClaim).statement, source: normalizeSource((c as TicketClaim).source) };
        }
        return null;
      })
      .filter((c): c is TicketClaim => c !== null),
  );
}

const VALID_TYPES: readonly TicketType[] = [
  TicketType.RESEARCH,
  TicketType.PROTOTYPE,
  TicketType.GRILLING,
  TicketType.TASK,
];

const VALID_STATUSES: readonly TicketStatus[] = ["open", "in-progress", "resolved", "blocked"];

const VALID_SOURCES: readonly ClaimSource[] = ["grilling", "research", "assumption"];

/** Invalid/unknown ticket types degrade to TASK (the executable default). */
function normalizeTicketType(value: unknown): TicketType {
  return VALID_TYPES.includes(value as TicketType) ? (value as TicketType) : TicketType.TASK;
}

/** Invalid/unknown statuses degrade to open (the safe default). */
function normalizeTicketStatus(value: unknown): TicketStatus {
  return VALID_STATUSES.includes(value as TicketStatus) ? (value as TicketStatus) : "open";
}

/** Invalid claim sources degrade to assumption (the weakest evidence). */
function normalizeSource(value: unknown): ClaimSource {
  return VALID_SOURCES.includes(value as ClaimSource) ? (value as ClaimSource) : "assumption";
}

/** Degrade a non-array (or mixed-type array) edge list to string[] */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function dedupeClaims(claims: TicketClaim[]): TicketClaim[] {
  const seen = new Set<string>();
  const result: TicketClaim[] = [];
  for (const claim of claims) {
    if (seen.has(claim.statement)) continue;
    seen.add(claim.statement);
    result.push(claim);
  }
  return result;
}

/** Flip tickets to blocked (any unresolved parent) or back to open. */
function recomputeStatuses(map: DecisionMap): DecisionMap {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  const now = new Date().toISOString();
  for (const ticket of map.tickets) {
    const hasUnresolvedBlocker = ticket.blockedBy.some((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && blocker.status !== "resolved";
    });
    if (hasUnresolvedBlocker) {
      // A resolved ticket stays resolved even when a new blocker appears later:
      // the resolution already happened, so re-blocking it would silently
      // discard completed work (phases-machinery:f4).
      if (ticket.status !== "blocked" && ticket.status !== "resolved") {
        ticket.status = "blocked";
        ticket.updatedAt = now;
      }
    } else if (ticket.status === "blocked") {
      ticket.status = "open";
      ticket.updatedAt = now;
    }
  }
  return map;
}

/** Inherit a parent's claims into children it has just unblocked. */
function propagateClaims(map: DecisionMap, resolvedTicket: DecisionTicket): void {
  const now = new Date().toISOString();
  for (const child of map.tickets) {
    if (!child.blockedBy.includes(resolvedTicket.id)) continue;
    if (child.status !== "open" && child.status !== "blocked") continue;
    const existing = new Set(child.claims.map((c) => c.statement));
    const inherited = resolvedTicket.claims.filter((c) => !existing.has(c.statement));
    if (inherited.length > 0) {
      child.claims = [...child.claims, ...inherited];
      child.updatedAt = now;
    }
  }
}

/** Recompute nextTicket and stamp the map's updatedAt. */
function finalize(map: DecisionMap): DecisionMap {
  recomputeNextTicket(map);
  map.updatedAt = new Date().toISOString();
  return map;
}

/** Recompute nextTicket without touching the map's timestamp. */
function recomputeNextTicket(map: DecisionMap): void {
  const active = map.tickets.find((t) => t.id === map.activeTicket && t.status === "in-progress");
  const next = active?.id ?? map.tickets.find((t) => t.status === "open")?.id;
  if (next !== undefined) {
    map.nextTicket = next;
  } else {
    delete map.nextTicket;
  }
}

/**
 * Sync the blocks <=> blockedBy directions so a graph declaring only one
 * direction still yields a fully linked parent/child pair.
 */
function reconcileEdges(tickets: DecisionTicket[]): void {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  for (const ticket of tickets) {
    for (const parentId of ticket.blockedBy) {
      const parent = byId.get(parentId);
      if (parent && !parent.blocks.includes(ticket.id)) parent.blocks.push(ticket.id);
    }
    for (const childId of ticket.blocks) {
      const child = byId.get(childId);
      if (child && !child.blockedBy.includes(ticket.id)) child.blockedBy.push(ticket.id);
    }
  }
}

/**
 * Detect a blocking cycle (a ticket that can reach itself via blocks edges).
 * Returns the cycle as a ticket-id path (including the closing repeat) or null
 * when the graph is acyclic. Self-blocking is a trivial 2-node cycle.
 */
export function findCycle(map: Pick<DecisionMap, "tickets">): string[] | null {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  const color = new Map<string, 0 | 1 | 2>();
  for (const t of map.tickets) color.set(t.id, 0);
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    const ticket = byId.get(id);
    for (const child of ticket ? ticket.blocks : []) {
      if (!byId.has(child)) continue;
      const childColor = color.get(child);
      if (childColor === 1) {
        return [...stack.slice(stack.indexOf(child)), child];
      }
      if (childColor === 0) {
        const cycle = visit(child);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };

  for (const t of map.tickets) {
    if (color.get(t.id) === 0) {
      const cycle = visit(t.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Break blocking cycles in place by removing back edges, so the decision graph
 * is always a DAG and can never self-lock. Returns whether any edge was cut.
 */
function breakCycles(map: Pick<DecisionMap, "tickets">): boolean {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  let changed = false;
  const color = new Map<string, 0 | 1 | 2>();
  for (const t of map.tickets) color.set(t.id, 0);

  const visit = (id: string): void => {
    color.set(id, 1);
    const ticket = byId.get(id);
    if (!ticket) {
      color.set(id, 2);
      return;
    }
    for (const child of [...ticket.blocks]) {
      const childColor = color.get(child);
      if (childColor === 1) {
        // Back edge id -> child closes a cycle; cut it from both directions.
        ticket.blocks = ticket.blocks.filter((b) => b !== child);
        const childTicket = byId.get(child);
        if (childTicket) childTicket.blockedBy = childTicket.blockedBy.filter((b) => b !== id);
        changed = true;
      } else if (childColor === 0) {
        visit(child);
      }
    }
    color.set(id, 2);
  };

  for (const t of map.tickets) if (color.get(t.id) === 0) visit(t.id);
  return changed;
}

/** Whether `to` is reachable from `from` via blocks edges (BFS). */
function canReachTicket(tickets: DecisionTicket[], from: string, to: string): boolean {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const ticket = byId.get(id);
    if (ticket) queue.push(...ticket.blocks);
  }
  return false;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
