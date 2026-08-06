/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { listAvailableModels } from "./agent.js";
import {
  aggregateAgentUsage,
  costPerSecond,
  estimatedCost,
  fmtCost,
  fmtTokenSegment,
  formatBudgetBar,
  formatElapsed,
  pricePerToken,
  shorten,
  statusIcon,
  tokenFigures,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import type { PersistedRunState, RunStatus } from "./run-persistence.js";
import { safeSetInterval } from "./timing.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { shortModel } from "./workflow-ui.js";

// `tokenUsage` is deliberately NOT subscribed: the event fires once at script
// end and the detailed panel's 2s timer refreshes the live tok/s readout, so
// subscribing only added a redraw of identical content in compact mode (M17).
const RUN_EVENTS = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
/** Events after which a run is gone and its token-rate samples can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped"] as const;

/**
 * Coalescing window for task-panel re-renders: agentStart/agentEnd/phase/log
 * fire several times per second per run during bursts, and each event would
 * redraw the whole panel. A trailing debounce (mirroring workflow-ui.ts's 125ms
 * agentHistory coalescing) repaints at most once per burst window; the 2s
 * ticker stays the floor cadence when events are sparse.
 */
const PANEL_RENDER_COALESCE_MS = 125;

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
  /**
   * Live settings loader. When provided, the panel reads it fresh (with a short
   * TTL cache) on each render so `/workflows-progress` takes effect without a
   * restart. Omitted in tests / minimal hosts → always compact.
   */
  loadSettings?: () => WorkflowSettings;
}

/** Default cap on the JSON-dump fallback in a delivered result summary. Overridable
 *  via the `deliveredResultMaxChars` setting in ~/.pi/workflows/settings.json. */
const DEFAULT_DELIVERED_MAX_CHARS = 400;

/** Human-readable byte size for the dropped-tail hint: 512 B, 3.2 KB, 1.4 MB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary`/`synthesis` string field, a bare
 * string result, else a JSON dump capped at `maxChars`. When the dump is truncated the
 * dropped size is reported (the full result is still reachable via the pointer
 * that {@link deliverText} appends).
 */
function summarizeResult(result: unknown, maxChars: number = DEFAULT_DELIVERED_MAX_CHARS): string {
  if (typeof result === "string") return result;
  if (result == null) return "null";
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    // `synthesis` is what the built-in multi-perspective workflow returns.
    for (const key of ["verdict", "report", "summary", "synthesis"] as const) {
      const val = obj[key];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  const json = JSON.stringify(result, null, 2);
  if (json.length <= maxChars) return json;
  // Slice once (the kept head); derive the dropped size by byte-length subtraction
  // so we don't also allocate the (potentially large) truncated tail to measure it.
  const kept = json.slice(0, maxChars);
  const droppedBytes = Buffer.byteLength(json, "utf8") - Buffer.byteLength(kept, "utf8");
  return `${kept}\n…(truncated ${formatBytes(droppedBytes)})`;
}

function fitLine(line: string, width?: number): string {
  if (typeof width !== "number" || !Number.isFinite(width)) return line;
  const maxWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth);
}

export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const summary = summarizeResult(run.result?.result, opts.maxChars);
  const tu = run.result?.tokenUsage;
  const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
  const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}).`,
    "",
    summary,
  ];
  // Always point at the full persisted result so the tail is never lost — even when
  // the summary above is a complete verdict/summary field or an untruncated dump.
  if (opts.resultPath) lines.push("", `↳ Full result: ${opts.resultPath}`);
  return lines.join("\n");
}

/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager: WorkflowManager, runId: string): string | undefined {
  try {
    return join(manager.getPersistence().getRunsDir(), `${runId}.json`);
  } catch {
    return undefined;
  }
}

/** Delivered JSON-dump truncation threshold from settings (already normalized),
 *  defaulting to 400 when unset or unreadable. */
function deliveredMaxChars(opts: { loadSettings?: () => WorkflowSettings }): number {
  try {
    return opts.loadSettings?.().deliveredResultMaxChars ?? DEFAULT_DELIVERED_MAX_CHARS;
  } catch {
    return DEFAULT_DELIVERED_MAX_CHARS;
  }
}

/**
 * When a background run finishes (or fails), deliver its result back into the
 * conversation AND continue the turn so the assistant can act on it — without
 * blocking the user meanwhile:
 *
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the
 *    result to the model so the paused conversation continues.
 *  - `deliverAs: "followUp"` means that if the user is busy in another turn, the
 *    result is queued and picked up after that turn finishes — never interrupting.
 *
 * Set up once per extension; idempotent via an internal guard.
 */
export interface ResultDeliveryOptions {
  loadSettings?: () => WorkflowSettings;
  /**
   * Fallback user-notification surface used when sendMessage fails (e.g. a
   * stale ctx after /reload). The extension entry has no command context at
   * install time, so this is wired wherever a ctx exists; console.warn always
   * records the original failure either way (L22 — never swallow silently).
   */
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
}

/**
 * Log the original delivery failure with run context and fall back to a visible
 * notify when one is configured — the result stays reachable via /workflows,
 * but the user must not be left thinking the delivery succeeded (L22).
 */
function reportDeliveryFailure(holder: { notify?: ResultDeliveryOptions["notify"] }, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[workflows] background result delivery failed: ${detail}`);
  holder.notify?.("Workflow result delivery failed — see /workflows for the full result.", "error");
}

/**
 * Install the background-run result delivery (see {@link ResultDeliveryOptions}
 * for the delivery contract). Set up once per extension; idempotent via an
 * internal guard.
 */
export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: ResultDeliveryOptions = {},
): void {
  // Mutable holder on the manager shared by extension generations across /reload.
  const m = manager as unknown as {
    __deliveryInstalled?: boolean;
    __holder?: { pi: ExtensionAPI; loadSettings?: () => WorkflowSettings; notify?: ResultDeliveryOptions["notify"] };
  };
  if (m.__deliveryInstalled) {
    // The manager and listeners survive /reload. Refresh every generation-bound
    // dependency while leaving listener registration exactly-once.
    if (m.__holder) {
      m.__holder.pi = pi;
      m.__holder.loadSettings = opts.loadSettings;
      m.__holder.notify = opts.notify;
    }
    return;
  }
  m.__deliveryInstalled = true;
  m.__holder = { pi, loadSettings: opts.loadSettings, notify: opts.notify };

  const deliver = (content: string) => {
    const holder = m.__holder;
    if (!holder) return;
    try {
      const ret = holder.pi.sendMessage(
        { customType: "workflow-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      // sendMessage may return a promise; a sync try/catch can't catch its
      // rejection, so swallow the async path too — but only after reporting it
      // (L22): a stale ctx after /reload is the expected failure, and the result
      // is still visible via /workflows.
      void Promise.resolve(ret).catch((error: unknown) => reportDeliveryFailure(holder, error));
    } catch (error) {
      // Synchronous failure (e.g. stale ctx) — same reporting contract.
      reportDeliveryFailure(holder, error);
    }
  };

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (run?.background) {
      deliver(
        deliverText(run, {
          resultPath: persistedResultPath(manager, runId),
          maxChars: deliveredMaxChars({ loadSettings: m.__holder?.loadSettings }),
        }),
      );
    }
  });
  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    if (!manager.getRun(runId)?.background) return;
    deliver(`✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`);
  });
  // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
  // user it is resumable once their budget refills, rather than letting it look dead.
  // Manual pause() also emits "paused" but with no reason — guard so only the
  // usage-limit case delivers a message.
  manager.on(
    "paused",
    ({
      runId,
      reason,
      error,
      resetHint,
    }: {
      runId: string;
      reason?: string;
      error?: { message?: string };
      resetHint?: string;
    }) => {
      if (reason !== "usage_limit") return;
      if (!manager.getRun(runId)?.background) return;
      const when = resetHint ? ` (${resetHint})` : "";
      const cause = error?.message ?? "provider usage limit reached";
      deliver(
        `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
          `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`,
      );
    },
  );
}

// ─── Elapsed clock (panel rows) ──────────────────────────────────────────────

/**
 * Wall-clock start of a run in ms: display-core's cumulative `startedAtMs`
 * (persisted so a resumed run keeps its original start) when present, else the
 * persisted ISO `startedAt`. Undefined when neither exists (test mocks / legacy
 * rows) — the elapsed segment then degrades away.
 */
/** Start-time data the elapsed clock reads — satisfied by persisted rows and live snapshots alike. */
interface PanelElapsedSource {
  status: string;
  startedAt?: string;
  startedAtMs?: number;
}

function runStartedAtMs(r: PanelElapsedSource): number | undefined {
  const cumulative = r.startedAtMs;
  if (typeof cumulative === "number" && Number.isFinite(cumulative) && cumulative > 0) return cumulative;
  if (typeof r.startedAt === "string" && r.startedAt) {
    const t = Date.parse(r.startedAt);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/**
 * Elapsed segment for a panel row: empty while paused (the wall clock is frozen,
 * so a growing "4m 02s" beside "⏸" would misread as progress) or when the start
 * time is unknown.
 */
function runElapsedSegment(r: PanelElapsedSource, now: number): string {
  if (r.status !== "running") return "";
  const startedAtMs = runStartedAtMs(r);
  if (startedAtMs === undefined) return "";
  return formatElapsed(Math.max(0, now - startedAtMs));
}

/**
 * Panel row source: a source-neutral view of one active run, fed from either a
 * live in-memory ManagedRun (snapshot-backed) or a persisted PersistedRunState
 * row. Renderers never branch on the source — {@link panelRunData} merges the
 * live view over the persisted one.
 */
interface PanelRunRow {
  runId: string;
  status: RunStatus;
  workflowName: string;
  agents: WorkflowAgentSnapshot[];
  tokenBudget?: number | null;
  tokenUsage?: WorkflowSnapshot["tokenUsage"];
  startedAt?: string;
  startedAtMs?: number;
  /** Live snapshot for detailed per-phase rendering; absent for disk-only rows. */
  snapshot?: WorkflowSnapshot;
}

/** The manager's live run map, reachable via the same cast protocol
 *  installResultDelivery uses for its cross-reload holder. */
type PanelRunsView = { runs?: ReadonlyMap<string, ManagedRun> };

/** Adapt a live in-memory run to the panel row shape (snapshot-backed). */
function toPanelRow(run: ManagedRun): PanelRunRow {
  return {
    runId: run.runId,
    status: run.status,
    workflowName: run.snapshot.name,
    agents: run.snapshot.agents,
    tokenBudget: run.tokenBudget,
    tokenUsage: run.snapshot.tokenUsage,
    startedAtMs: run.snapshot.startedAtMs,
    snapshot: run.snapshot,
  };
}

/** Adapt a persisted run row to the panel row shape (disk-backed, no snapshot). */
function fromPersistedRow(r: PersistedRunState): PanelRunRow {
  return {
    runId: r.runId,
    status: r.status,
    workflowName: r.workflowName,
    agents: r.agents,
    tokenBudget: r.tokenBudget,
    tokenUsage: r.tokenUsage,
    startedAt: r.startedAt,
    startedAtMs: r.startedAtMs,
  };
}

/**
 * Enumerate the panel's runs without paying a persistence walk for the runs it
 * actually draws: active rows come from the manager's LIVE in-memory view (its
 * private `runs` map, reached through {@link PanelRunsView}) so a render during
 * an event burst reads no disk for the rows it draws. The finished count for the
 * navigator hint stays disk-derived — listRuns() is 300ms-TTL-cached and kept
 * warm during progress persists by the S1 slice — because it must count runs
 * this process may never have held in memory. Managers with no reachable live
 * view (test mocks, legacy shapes, or no active runs in memory) fall back to
 * listRuns() plus the getRun() overlay, preserving the historical behavior
 * exactly.
 */
function panelRunData(manager: WorkflowManager): { active: PanelRunRow[]; finished: number } {
  const inMemory = (manager as unknown as PanelRunsView).runs;
  const inMemoryActive = inMemory
    ? [...inMemory.values()].filter((r) => r.status === "running" || r.status === "paused")
    : [];
  const inMemoryIds = new Set(inMemoryActive.map((r) => r.runId));
  // One disk read for both the finished hint and the active-row merge below:
  // listRuns() is 300ms-TTL-cached and kept warm during progress persists (S1),
  // so the merge does not reintroduce a per-render persistence walk.
  const diskRows = manager.listRuns();
  const finished = diskRows.filter((r) => r.status !== "running" && r.status !== "paused").length;
  const diskActive = diskRows
    .filter((r) => (r.status === "running" || r.status === "paused") && !inMemoryIds.has(r.runId))
    .map((r) => {
      const row = fromPersistedRow(r);
      // Keep the live-snapshot overlay for disk rows whose run IS in memory
      // (detailed mode's per-phase body reads it).
      const live = manager.getRun(r.runId);
      if (live) row.snapshot = live.snapshot;
      return row;
    });
  if (inMemoryActive.length > 0) {
    // Merge disk rows for active runs this process does not hold in memory
    // (e.g. a paused run the manager's bounded paused-run retention evicted,
    // or a prior-session run) so the panel never drops an active run from
    // view — the memory-first path only determines row SOURCE per run.
    return { active: [...inMemoryActive.map(toPanelRow), ...diskActive], finished };
  }
  return { active: diskActive, finished };
}

export function renderPanel(
  manager: WorkflowManager,
  theme: Theme,
  width?: number,
  now: number = Date.now(),
): string[] {
  const { active, finished } = panelRunData(manager);
  if (!active.length) return [];
  const rows = active.map((r) => {
    // Array guard (M6): a structurally corrupt persisted run (agents not an
    // array) would otherwise throw "agents is not iterable" here and take the
    // whole panel down; mirror the navigator's #110 coercion.
    const agents = (Array.isArray(r.agents) ? r.agents : []) as WorkflowAgentSnapshot[];
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    // Paused runs freeze both the clock and the phase readout: name the state so
    // the row can't misread as still progressing (the ⏸ marker stays the cue).
    const state = r.status === "paused" ? "Paused" : (r.snapshot?.currentPhase ?? "");
    const usage = aggregateAgentUsage(agents);
    const meta = [
      `${done}/${agents.length} agents`,
      state,
      runElapsedSegment(r, now),
      r.status === "running" ? formatBudgetBar(usage.fresh + usage.cacheRead, r.tokenBudget) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `  ${icon} ${r.workflowName}  ${meta}`;
  });
  // Finished runs leave this live panel but are kept in the navigator. Tell the
  // user so a completed run doesn't look like it vanished.
  const hint = theme.fg(
    "dim",
    finished > 0
      ? `  /workflows — open navigator (${finished} finished kept in history)`
      : "  /workflows — open navigator",
  );
  return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}

// ─── Detailed mode: live token rate ────────────────────────────────────────────

/** Rolling window for the token/s rate. Older samples age out so a stall decays to 0. */
const RATE_WINDOW_MS = 10_000;
/**
 * Map-level cap on tracked runs (token-samples-map): per-run samples are
 * already pruned to RATE_WINDOW_MS and cleared on run end, but a run whose end
 * event was missed (crash/aborted session) would otherwise retain one tiny
 * entry forever. At the cap, evict the oldest runId (Map insertion order).
 */
const TOKEN_SAMPLES_MAX_RUNS = 200;
/** Per-run (timestamp, cumulative total) samples, keyed by the persisted runId so
 *  the rolling rate survives pause→resume. Cleared when a run ends. */
const tokenSamples = new Map<string, Array<{ ts: number; total: number }>>();

/** Record a token-total sample for `runId` at time `now` (ms). */
export function sampleTokens(runId: string, total: number, now: number): void {
  const samples = tokenSamples.get(runId) ?? [];
  const last = samples[samples.length - 1];
  // Collapse repeat renders within the same instant (e.g. width recalcs).
  if (last && last.ts === now && last.total === total) return;
  samples.push({ ts: now, total });
  // Drop samples beyond the rolling window, always keeping ≥2 so a rate is computable.
  while (samples.length > 2 && now - samples[0].ts > RATE_WINDOW_MS) samples.shift();
  tokenSamples.set(runId, samples);
  if (tokenSamples.size > TOKEN_SAMPLES_MAX_RUNS) {
    const oldest = tokenSamples.keys().next().value;
    if (oldest !== undefined) tokenSamples.delete(oldest);
  }
}

/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export function tokensPerSecond(runId: string): number {
  const samples = tokenSamples.get(runId);
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.ts - oldest.ts;
  if (elapsedMs <= 0) return 0;
  const delta = newest.total - oldest.total;
  if (delta <= 0) return 0;
  return (delta / elapsedMs) * 1000;
}

/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export function clearTokenSamples(runId: string): void {
  tokenSamples.delete(runId);
}

/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(1000, Math.floor(value));
}

/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(
  snap: WorkflowSnapshot,
  agents: WorkflowAgentSnapshot[],
  maxAgents: number,
  theme: Theme,
): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [];
  // Group agents by phase, declared order first then discovery order (as the navigator does).
  const order = snap.phases.length ? [...snap.phases] : [];
  const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const a of agents) {
    const key = a.phase ?? "(no phase)";
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)?.push(a);
    if (!order.includes(key)) order.push(key);
  }
  for (const title of order) {
    const phaseAgents = byPhase.get(title) ?? [];
    if (!phaseAgents.length) continue;
    const done = phaseAgents.filter((a) => a.status === "done").length;
    const running = phaseAgents.filter((a) => a.status === "running").length;
    const errors = phaseAgents.filter((a) => a.status === "error").length;
    const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
    const complete = done + errors + skipped === phaseAgents.length;
    const marker = running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
    const phaseMeta = [
      `${done}/${phaseAgents.length} agents`,
      running ? `${running} running` : "",
      errors ? `${errors} errors` : "",
      fmtTokenSegment(aggregateAgentUsage(phaseAgents), fmtTokensShort),
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));

    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const segment = fmtTokenSegment(tokenFigures(a.tokenUsage, a.tokens), fmtTokensShort);
      const tok = segment ? dim(` ${segment}`) : "";
      const mdl = shortModel(a.model);
      const model = mdl ? dim(` · ${mdl}`) : "";
      lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}`);
    }
    if (phaseAgents.length > visible.length) {
      lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier agents`));
    }
  }
  return lines;
}

/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, a live token/s rate, an estimated cost/s, a spend-vs-budget bar, and a
 * session-aggregate cost line, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export function renderPanelDetailed(
  manager: WorkflowManager,
  theme: Theme,
  width: number | undefined,
  maxAgents: number,
  now: number,
): string[] {
  const { active, finished } = panelRunData(manager);
  if (!active.length) return [];
  const dim = (t: string) => theme.fg("dim", t);
  const out: string[] = [theme.bold(`Workflows running (${active.length}):`)];
  // One registry price lookup per render: the host model registry is in-memory,
  // so this stays cheap, and every miss degrades to the finalized-cost fallback.
  const prices = resolveRunPriceMap(manager);
  let sessionCost = 0;
  let sessionCostKnownRuns = 0;

  for (const r of active) {
    const snap = r.snapshot;
    // Array guard (M6): corrupt persisted agents must not take the panel down.
    const agents = (Array.isArray(r.agents) ? r.agents : []) as WorkflowAgentSnapshot[];
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const usage = snap?.tokenUsage ?? r.tokenUsage;
    // The run-level tokenUsage aggregate is only finalized when the run ends, so
    // it reads 0 for the whole live run; per-agent figures update on each agent
    // completion, so aggregate those instead. The rate samples the same
    // fresh+cacheRead sum the header displays, so tok/s tracks the visible
    // figures. Tokens land at agent-completion granularity, so the rate reflects
    // completion throughput — it decays to 0 during a single long-running agent
    // or a stall (which is the intended signal). Paused runs don't accrue
    // tokens, so their rate is suppressed (a stalled rate would mislead).
    const runUsage = aggregateAgentUsage(agents);
    sampleTokens(r.runId, runUsage.fresh + runUsage.cacheRead, now);
    const rate = r.status === "running" ? tokensPerSecond(r.runId) : 0;
    // Cost meter (FEATURE): price the run's newest agent that has a known model;
    // the run-level tokenUsage.cost is the finalized figure and wins when it
    // exists, otherwise observed tokens × price is the live estimate. Output
    // price is a rough proxy, so estimates carry a "~" marker.
    const perToken = runPricePerToken(prices, agents);
    const cps = costPerSecond(rate, perToken);
    const spentTokens = runUsage.fresh + runUsage.cacheRead;
    // Finalized cost wins when the provider reported one (>0; a zero aggregate
    // is the "not yet billed" signal and stays hidden like before); until then,
    // observed tokens × price is the live estimate. Output price is a rough
    // proxy, so estimates carry a "~" marker.
    const finalizedCost = usage && typeof usage.cost === "number" && usage.cost > 0 ? usage.cost : undefined;
    const spentCost = finalizedCost ?? estimatedCost(spentTokens, perToken);
    if (spentCost !== undefined) {
      sessionCost += spentCost;
      sessionCostKnownRuns++;
    }
    // Line 1: durable per-run facts (progress, phase, tokens, cost, budget bar).
    // Line 2 (dim): live rates. The 7-segment cram pushed tok/s and ~$/s past
    // fitLine's right-truncation on narrow overlays, so the rates get their own
    // line where the truncation tail can no longer swallow the progress facts.
    const meta = [
      `${done}/${agents.length} agents`,
      snap?.currentPhase || "",
      runElapsedSegment(r, now),
      fmtTokenSegment(runUsage, fmtTokensShort),
      spentCost !== undefined ? (finalizedCost !== undefined ? fmtCost(spentCost) : `~${fmtCost(spentCost)}`) : "",
      formatBudgetBar(spentTokens, r.tokenBudget),
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
    const liveRates = [rate > 0 ? `${Math.round(rate)} tok/s` : "", cps !== undefined ? `~${fmtCost(cps)}/s` : ""]
      .filter(Boolean)
      .join(" · ");
    if (liveRates) out.push(dim(`  ${liveRates}`));
    if (snap) out.push(...renderRunBody(snap, agents, maxAgents, theme));
  }

  if (sessionCostKnownRuns > 0) {
    const plural = sessionCostKnownRuns === 1 ? "run" : "runs";
    out.push(dim(`  ~${fmtCost(sessionCost)} estimated spend across ${sessionCostKnownRuns} active ${plural}`));
  }
  out.push(
    dim(
      finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator",
    ),
  );
  return out.map((line) => fitLine(line, width));
}

/**
 * Build the model-spec → per-token-price map from the host model registry, once
 * per render. Empty when no registry is exposed (headless/tests) — every call
 * site then degrades to the finalized-cost fallback. Never throws: a registry
 * hiccup must not take the always-on panel down.
 */
function resolveRunPriceMap(manager: WorkflowManager): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  const registry = manager.getModelRegistry?.();
  if (!registry) return map;
  try {
    for (const model of listAvailableModels(registry)) {
      const perToken = pricePerToken(model.costOutput);
      if (perToken !== undefined) map.set(model.spec, perToken);
    }
  } catch {
    // Registry hiccup — estimates degrade to finalized cost; never break the panel.
  }
  return map;
}

/**
 * The per-token price of the run's newest agent that has a known model — the
 * agent the run is most likely to be spending on right now. Undefined when no
 * agent's model has a known price.
 */
function runPricePerToken(
  prices: ReadonlyMap<string, number>,
  agents: readonly WorkflowAgentSnapshot[],
): number | undefined {
  for (let i = agents.length - 1; i >= 0; i--) {
    const model = agents[i]?.model;
    if (!model) continue;
    const price = prices.get(model);
    if (price !== undefined) return price;
  }
  return undefined;
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  // Live-read settings with a ~1s TTL: a render-path disk read every frame would
  // be wasteful, but re-reading at most once a second still makes
  // /workflows-progress take effect "immediately" (no restart).
  let cached: WorkflowSettings = {};
  let cachedAt = Number.NEGATIVE_INFINITY;
  const settings = (): WorkflowSettings => {
    if (!opts.loadSettings) return cached;
    const now = Date.now();
    if (now - cachedAt > 1000) {
      try {
        cached = opts.loadSettings() ?? {};
      } catch {
        cached = {};
      }
      cachedAt = now;
    }
    return cached;
  };
  const hasActiveRun = () => panelRunData(manager).active.length > 0;

  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      // Coalesce the per-event re-renders: agentStart/agentEnd/phase/log fire
      // several times per second per run during bursts, and each would redraw
      // the whole panel. A trailing debounce (mirroring workflow-ui.ts's 125ms
      // agentHistory coalescing) repaints at most once per burst window; the 2s
      // ticker below is the floor cadence when events are sparse.
      let renderTimer: ReturnType<typeof setTimeout> | undefined;
      const onEvent = () => {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
          renderTimer = undefined;
          tui.requestRender();
        }, PANEL_RENDER_COALESCE_MS);
        (renderTimer as { unref?: () => void }).unref?.();
      };
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      const onRunEnd = ({ runId }: { runId: string }) => clearTokenSamples(runId);
      for (const ev of RUN_END_EVENTS) manager.on(ev, onRunEnd);
      // In detailed mode, force a redraw every 2s while a run is active so the
      // token/s rate keeps updating between sparse token events — and decays to 0
      // when an agent stalls. Gated + unref'd so it costs nothing when idle;
      // cleared on dispose.
      const timer = safeSetInterval(() => {
        // Both panel modes now carry a live elapsed readout, so the 2s tick that
        // once refreshed only the detailed token rate must also repaint the
        // compact panel — otherwise its clock freezes between manager events.
        if (hasActiveRun()) tui.requestRender();
      }, 2000);
      timer.unref();
      // Purely informational: it lists running runs and re-renders on events. To
      // open the navigator, the user runs /workflows (the panel takes no input).
      const comp: Component & { dispose?(): void } = {
        render: (width: number) => {
          const s = settings();
          if (s.progressPanelMode === "detailed") {
            return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
          }
          return renderPanel(manager, theme, width);
        },
        invalidate: () => {},
        dispose: () => {
          timer.clear();
          if (renderTimer) clearTimeout(renderTimer);
          renderTimer = undefined;
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
          for (const ev of RUN_END_EVENTS) manager.off(ev, onRunEnd);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
