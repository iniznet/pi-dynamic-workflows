import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentUsage, OperationTrace } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  /** Full agent result, retained for the interactive detail pager. */
  result?: unknown;
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
  tokens?: number;
  /** Per-agent token usage breakdown (fresh input+output vs cached), when known. */
  tokenUsage?: AgentUsage;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /**
   * Epoch ms when the agent started (captured at onAgentStart, seeded from
   * the persisted agents[] on resume replay via seededAgentStats so a
   * replayed agent keeps its ORIGINAL start time — L4). Absent on legacy /
   * cold rows, which simply render no per-agent elapsed.
   */
  startedAtMs?: number;
  /**
   * Epoch ms when the agent finished. Terminal agents only — a still-running
   * agent has no endedAtMs. Replayed agents keep the seed's (their original
   * completion time); never a fabricated resume-time stamp (L4).
   */
  endedAtMs?: number;
  /**
   * Epoch ms of the latest per-agent event (onAgentStart / onAgentJournal /
   * onAgentHistory / onRetrySpend / onAgentEnd). EPHEMERAL by nature: never
   * persisted, recomputed on resume from journal replay + fresh events. Drives
   * the soft "idle" hint for running agents (see DEFAULT_IDLE_AGENT_MS).
   */
  lastActiveAtMs?: number;
  /**
   * The failing tool call (Fabric-style line-numbered failure repair), when
   * this agent failed after making tool calls. Absent on successes.
   */
  failingOperation?: OperationTrace;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  /**
   * Epoch ms when the run started (or was last resumed) — feeds live elapsed
   * segments across every surface. Absent on legacy snapshots, which simply
   * render no elapsed.
   */
  startedAtMs?: number;
  /**
   * Hard token budget the run started with (null = explicitly unbudgeted).
   * Absent on legacy snapshots, which render no budget bar.
   */
  tokenBudget?: number | null;
  result?: unknown;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** T1-01: the run's fresh (input+output) spend, for the fresh budget gate. */
    freshSpend?: number;
  };
  runId?: string;
}

/**
 * Canonical glyph for each run status — the ONE vocabulary every surface
 * (widget, task panel, /workflows list, navigator) uses, so a paused run reads
 * as "⏸ paused" everywhere instead of three different markers. Agent-level
 * statuses use {@link statusIcon} (a different key set: done/error/skipped).
 */
export const STATUS_GLYPH: Record<string, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

/**
 * Normalize any surface's status vocabulary onto the canonical run-status word
 * ("done"→"completed", "error"→"failed", "stopped"→"aborted",
 * "active"→"running"). Unknown statuses pass through untouched so a legacy or
 * unexpected value never renders an empty word.
 */
export function runStatusWord(status: string): string {
  switch (status) {
    case "done":
    case "complete":
      return "completed";
    case "error":
      return "failed";
    case "stopped":
      return "aborted";
    case "active":
      return "running";
    default:
      return status;
  }
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

/**
 * Displayable fresh/cached figures from a usage breakdown and/or a scalar
 * estimate. The token pipeline has two sources that don't always agree: the
 * provider-reported breakdown (input/output/cacheRead/cacheWrite) and a scalar
 * estimate (`total` at run level, `tokens` per agent) that keeps accruing even
 * when the provider reports nothing. Two rules:
 * - `fresh` counts input+output+cacheWrite: cache writes are first-time
 *   ingestion billed at full (or premium) price, so hiding them would
 *   under-report real spend; only cacheRead is the cheap reuse shown apart.
 * - `fresh` is never less than what the estimate can account for after
 *   removing cache reads, so estimate-only providers, cost-only providers
 *   (billed but zero token counts), and mixed runs keep the count the display
 *   showed before the split existed, instead of a false "0 tok".
 */
export function tokenFigures(
  usage: Partial<AgentUsage> | undefined,
  scalarTokens?: number,
): { fresh: number; cacheRead: number } {
  const cacheRead = usage?.cacheRead ?? 0;
  const reported = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
  const estimate = Math.max(scalarTokens ?? 0, usage?.total ?? 0);
  return { fresh: Math.max(reported, estimate - cacheRead), cacheRead };
}

/** Sum a set of agents into fresh vs cacheRead totals, via {@link tokenFigures}. */
export function aggregateAgentUsage(agents: ReadonlyArray<Pick<WorkflowAgentSnapshot, "tokens" | "tokenUsage">>): {
  fresh: number;
  cacheRead: number;
} {
  let fresh = 0;
  let cacheRead = 0;
  for (const a of agents) {
    const f = tokenFigures(a.tokenUsage, a.tokens);
    fresh += f.fresh;
    cacheRead += f.cacheRead;
  }
  return { fresh, cacheRead };
}

/**
 * Format a token count for a display surface: "12.4K tok" on its own, or
 * "89K tok · 3.0M cached" when there were cache reads. The cache segment is shown
 * only when `cacheRead > 0`, so a non-caching provider (or a single-turn agent that
 * never re-reads its cache) reads as a plain "tok" rather than a bare, contextless
 * "fresh". `fmt` adapts the number style per surface (compact in panels, full in
 * the print view).
 */
function fmtTokenCount(fresh: number, cacheRead: number, fmt: (n: number) => string): string {
  const f = fmt(fresh) || "0";
  return cacheRead > 0 ? `${f} tok · ${fmt(cacheRead)} cached` : `${f} tok`;
}

/**
 * Like {@link fmtTokenCount}, but "" when nothing is known yet (both figures 0),
 * so surfaces omit the segment instead of rendering a false "0 tok" — e.g. for a
 * journal-replayed resume or a run whose agents were all skipped. Every surface
 * should use this rather than re-implementing the zero guard.
 */
export function fmtTokenSegment(figures: { fresh: number; cacheRead: number }, fmt: (n: number) => string): string {
  return figures.fresh + figures.cacheRead > 0 ? fmtTokenCount(figures.fresh, figures.cacheRead, fmt) : "";
}

/**
 * "$1.23" from one cent up, four decimals below it, and "<$0.0001" for
 * anything smaller — a real cost never rounds to a zero-looking "$0.00".
 */
export function fmtCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}

/** Full (non-compact) number style for print/text surfaces: locale-grouped digits. */
export const fmtFull = (n: number): string => n.toLocaleString();

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((phase) => phase.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  // Mutable state captured by the component closure so re-renders
  // always read the latest snapshot even though the factory ran once.
  let snapshot: WorkflowSnapshot | undefined;
  let completed = false;

  // Store the factory so update()/complete() can re-register it to trigger re-render.
  const widgetFactory = (_tui: unknown, theme: Theme) => ({
    render: () => (snapshot ? renderWorkflowLines(snapshot, options, theme) : []),
    invalidate: () => {},
  });

  if (ctx.hasUI) {
    ctx.ui.setWidget(key, widgetFactory, { placement });
  }

  return {
    update(s) {
      snapshot = s;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, completed));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    complete(s) {
      snapshot = s;
      completed = true;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, true));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

/** Minimal theme surface so rendering works without a real Theme (tool output, tests). */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Identity passthrough for contexts where no theme is available (tool text output). */
const NO_THEME: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

/** The bracketed per-agent token cell (" [89 tok · 3,000 cached]"), or "" when nothing is known yet. */
function agentTokenCell(agent: WorkflowAgentSnapshot, theme: ThemeLike): string {
  const segment = fmtTokenSegment(tokenFigures(agent.tokenUsage, agent.tokens), fmtFull);
  return segment ? theme.fg("dim", ` [${segment}]`) : "";
}

/**
 * "(X/Y done[, N running | , M errors] · tokens · cost)" — the count suffix
 * shared by the widget header and the text/delivery header, so the merged
 * delivery header (F51) never drifts from the widget's identity line.
 */
function workflowCountsSuffix(snapshot: WorkflowSnapshot): string {
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  // Build header with token info (and cost when the provider reports it)
  const usage = snapshot.tokenUsage;
  const costInfo = usage?.cost ? ` · ${fmtCost(usage.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(usage), fmtFull);
  const tokenInfo = `${segment ? ` · ${segment}` : ""}${costInfo}`;
  return `(${snapshot.doneCount}/${snapshot.agentCount} done${state}${tokenInfo})`;
}

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {},
  theme: ThemeLike = NO_THEME,
): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const showResultPreviews = options.showResultPreviews ?? false;
  const headerFacts = workflowHeaderFacts(snapshot);
  const header = `${theme.bold(`◆ Workflow: ${snapshot.name}`)} ${workflowCountsSuffix(snapshot)}`;
  const lines = [headerFacts.length ? `${header} · ${headerFacts.join(" · ")}` : header];

  const phaseNames = snapshot.phases.length
    ? snapshot.phases
    : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean) as string[]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    // Queued phase (no agent started, not the current phase) reads as the
    // canonical pending glyph "·" instead of a blank — same vocabulary as the
    // /workflows list legend.
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : "·";
    lines.push(
      theme.fg("accent", `  ${marker} ${phase}`) +
        theme.fg(
          "dim",
          ` ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
        ),
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `[${agent.id}]`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(
        `    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokenCell(agent, theme)}${result}`,
      );
    }
    if (agents.length > visibleAgents.length)
      lines.push(theme.fg("dim", `    … ${agents.length - visibleAgents.length} earlier agents`));
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push(theme.fg("accent", "  No phase"));
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(
        `    [${agent.id}] ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokenCell(agent, theme)}${result}`,
      );
    }
  }

  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  return renderWorkflowStatusText(snapshot, completed ? "completed" : "running", options);
}

/**
 * Truthful header for a finished run, mapped from its FINAL status (M7). Never
 * the generic "Workflow completed" for a run that stopped, failed, or paused:
 * a paused run is explicitly labeled resumable so a usage-limit pause does not
 * read as a dead end, and stopped/failed runs say so.
 */
export function workflowFinalHeader(status: string): string {
  switch (status) {
    case "completed":
    case "done":
      return "Workflow completed";
    case "failed":
    case "error":
      return "Workflow failed";
    case "stopped":
    case "aborted":
      return "Workflow stopped";
    case "paused":
      return "Workflow paused (resumable)";
    default:
      return "Workflow running";
  }
}

/**
 * Elapsed + spend-vs-budget bar facts for the one-glance header. Live elapsed
 * comes from the run's start clock, then the spend-vs-budget bar when the run
 * carries a hard tokenBudget; both segments degrade away when the data is
 * absent (legacy snapshots, budget-free runs).
 */
function workflowHeaderFacts(snapshot: WorkflowSnapshot): string[] {
  const facts: string[] = [];
  const elapsed = elapsedMs(snapshot, Date.now());
  if (elapsed !== undefined) facts.push(formatElapsed(elapsed));
  const budgetBar = formatBudgetBar(snapshot.tokenUsage?.total ?? 0, snapshot.tokenBudget);
  if (budgetBar) facts.push(budgetBar);
  return facts;
}

/**
 * Render a snapshot with a truthful final-status header (see {@link workflowFinalHeader}).
 * ONE header (F51): the final status is folded into the identity line —
 * "Workflow completed ✓: <name> (X/Y done…) · <elapsed> · [bar]" — instead of
 * stacking "Workflow completed" over the widget's "◆ Workflow: <name>" line.
 * The canonical word leads (every surface reads "Workflow paused (resumable)"
 * first, M7) with the run-status glyph paired to it, and the elapsed + budget
 * facts the widget header carries are preserved so the text never degrades to
 * a bare counts line.
 */
export function renderWorkflowStatusText(
  snapshot: WorkflowSnapshot,
  status: string,
  options: WorkflowDisplayOptions = {},
): string {
  const lines = renderWorkflowLines(snapshot, options);
  const facts = workflowHeaderFacts(snapshot);
  const glyph = STATUS_GLYPH[runStatusWord(status)] ?? "◆";
  lines[0] =
    `${workflowFinalHeader(status)} ${glyph}: ${snapshot.name} ${workflowCountsSuffix(snapshot)}` +
    (facts.length ? ` · ${facts.join(" · ")}` : "");
  return lines.join("\n");
}

// ─── Live cost-meter math (task-panel detailed mode) ──────────────────────────

/**
 * Price per token (USD) from a provider's per-1M-OUTPUT-token price — the same
 * figure the tier ranking and /workflows-models preview use. Output price is a
 * rough proxy for blended spend, which is honest enough for a live estimate.
 * Undefined when the registry reports no price (self-hosted, unknown).
 */
export function pricePerToken(costOutputPerMillion: number | undefined): number | undefined {
  if (typeof costOutputPerMillion !== "number" || !Number.isFinite(costOutputPerMillion) || costOutputPerMillion <= 0) {
    return undefined;
  }
  return costOutputPerMillion / 1_000_000;
}

/** Estimated USD/second at a token rate × per-token price; undefined when either is unknown. */
export function costPerSecond(tokensPerSecondRate: number, perTokenPrice: number | undefined): number | undefined {
  if (!Number.isFinite(tokensPerSecondRate) || tokensPerSecondRate <= 0) return undefined;
  if (perTokenPrice === undefined || !Number.isFinite(perTokenPrice) || perTokenPrice <= 0) return undefined;
  return tokensPerSecondRate * perTokenPrice;
}

/** Estimated total USD for a token spend at a per-token price; undefined when unknown. */
export function estimatedCost(tokens: number, perTokenPrice: number | undefined): number | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (perTokenPrice === undefined || !Number.isFinite(perTokenPrice) || perTokenPrice <= 0) return undefined;
  return tokens * perTokenPrice;
}

/**
 * Compact spend-vs-budget bar for a run with a hard tokenBudget:
 * "[█████░░░░░] 45%". Empty when the run carries no budget, so budget-free runs
 * render nothing new. Ten cells keeps it readable in a narrow panel.
 */
const BUDGET_BAR_FILL = "█";
/** Empty budget-bar cell. */
const BUDGET_BAR_EMPTY = "░";
export function formatBudgetBar(spentTokens: number, budgetTokens: number | null | undefined): string {
  if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return "";
  const pct = Math.max(0, Math.min(1, spentTokens / budgetTokens));
  const filled = Math.round(pct * 10);
  return `[${BUDGET_BAR_FILL.repeat(filled)}${BUDGET_BAR_EMPTY.repeat(10 - filled)}] ${Math.round(pct * 100)}%`;
}

/**
 * "12s" / "4m 02s" / "1h 05m" — wall-clock duration for run rows. Rounds to
 * the nearest second and zero-pads the sub-leading unit so columnar lists keep
 * their alignment.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Live elapsed (ms) for a snapshot, or undefined when the run carries no start time. */
export function elapsedMs(snapshot: WorkflowSnapshot, now: number): number | undefined {
  if (typeof snapshot.startedAtMs !== "number" || !Number.isFinite(snapshot.startedAtMs)) return undefined;
  return Math.max(0, now - snapshot.startedAtMs);
}

/**
 * Per-agent elapsed (ms) since the agent started, clamped to >= 0 (a clock
 * skew never renders a negative duration). Undefined when the agent carries no
 * startedAtMs (legacy/cold rows) so surfaces render no elapsed segment.
 */
export function agentElapsedMs(agent: { startedAtMs?: number }, now: number): number | undefined {
  if (typeof agent.startedAtMs !== "number" || !Number.isFinite(agent.startedAtMs)) return undefined;
  return Math.max(0, now - agent.startedAtMs);
}

/**
 * Per-agent idle (ms) since the last per-agent event (lastActiveAtMs), clamped
 * to >= 0. Undefined when the agent has no lastActiveAtMs (legacy/cold rows) so
 * surfaces render no idle segment. Idle is a SOFT hint — a long idle is a
 * legitimate long agent, never a hard "stuck" claim.
 */
export function agentIdleMs(agent: { lastActiveAtMs?: number }, now: number): number | undefined {
  if (typeof agent.lastActiveAtMs !== "number" || !Number.isFinite(agent.lastActiveAtMs)) return undefined;
  return Math.max(0, now - agent.lastActiveAtMs);
}

/**
 * Idle threshold (ms) past which a RUNNING agent's row/phase-header renders the
 * dim "· idle <elapsed>" hint. Matches the user's example showing "idle 45s"
 * (45s > 30s), and onAgentHistory fires on the live message/tool-call cadence
 * so an actively working agent almost never trips it; a quiet agent past the
 * threshold gets the soft hint. Never a "stuck" claim — see agentIdleMs.
 */
export const DEFAULT_IDLE_AGENT_MS = 30_000;

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

export function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
