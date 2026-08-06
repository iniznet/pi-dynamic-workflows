/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AgentUsage, usageComponentsTotal, type WorkflowAgent } from "./agent.js";
import { preview, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { isProviderOverloaded, isProviderUsageLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import type { ProviderPool } from "./gateway/provider-pool.js";
import { compactJournal, verifyJournalCompaction } from "./journal-compaction.js";
import { DEFAULT_MAX_LOG_ENTRIES, pushBoundedLog } from "./logger.js";
import { createMemoizedLoadModelTierConfig } from "./model-tier-config.js";
import {
  buildResumeJournal,
  capJournalBudget,
  createRunPersistence,
  DEFAULT_RUN_LEASE_TTL_MS,
  generateRunId,
  JOURNAL_BYTE_CHECK_THRESHOLD,
  journalEntryKey,
  keepsResumeJournal,
  loadPersistedJournal,
  type PersistedRunState,
  type RunCheckpoint,
  type RunLease,
  type RunLeaseState,
  type RunPersistence,
  type RunStatus,
  renewRunLease,
} from "./run-persistence.js";
import {
  type AgentKillChannel,
  type CheckpointGate,
  type JournalEntry,
  type PhasePipelineOptions,
  type PhaseStateIntegration,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunResult,
} from "./workflow.js";
import type { KillAgentResult } from "./workflow-damage-control.js";
import { reconcileAgentAfterKill } from "./workflow-damage-control.js";
import { gitExec, pruneWorktrees } from "./worktree.js";

interface ManagedRunBase {
  runId: string;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /**
   * O(1) side-index for journal upserts: key (journalSideKey — the entry's own
   * `${runId}:${index}` pair) -> position in `journal`. Maintained alongside
   * the array by onAgentJournal (in-place replace) and rebuilt at resume()
   * seed time; onAgentJournal is the manager's ONLY writer of the pair, so
   * they can never drift. The persistence-layer upsertJournalEntry (O(n)
   * filter) is not used by the manager (see core-orchestration:i3).
   */
  journalIndex: Map<string, number>;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
  /**
   * Auto-resume eligibility for this run (see ExecOptions.autoResume). Set once
   * at creation and carried through resume() so it survives pause/resume cycles.
   * Undefined means eligible (default-on); false opts out.
   */
  autoResume?: boolean;
  /**
   * Frozen at start (like autoResume): whether agent failures settle this run
   * failed+resumable instead of completing with silent nulls. Undefined =
   * lenient (never set by the caller). Carried through resume() so a resumed
   * run keeps the strictness it started with.
   */
  failOnExhaustedAgent?: boolean;
  /**
   * OPT-IN resume-journal compaction (default OFF), frozen at run start like
   * tokenBudget and carried through resume() so a resumed run keeps
   * compacting if it started with the flag. When true, writeRunToDisk folds
   * the journal's resolved segments into a compact summary and persists it
   * only when reconstruction QA reproduces the original byte-identically
   * (failed-QA summaries are discarded; the original journal is kept).
   * F19: compaction + QA only run on lifecycle-settle writes (persistRun);
   * throttled progress writes persist the raw journal.
   */
  compactJournal?: boolean;
  /**
   * The run's resolved hard token budget (per-run value, else the manager
   * default), fixed at run start and carried through resume() — a resumed run
   * must keep the budget it started with, not re-resolve against the current
   * default (an explicit `null` opt-out would otherwise regain a budget).
   */
  tokenBudget?: number | null;
  /**
   * Named toolset tag for this run (see WorkflowManagerOptions.toolsets).
   * ToolDefinitions are functions and can't be persisted, so the tag is what
   * survives on disk — resume() re-resolves it so e.g. a resumed
   * `/deep-research` run keeps its web tools instead of silently degrading to
   * the default coding tools.
   */
  toolset?: string;
  /**
   * Real per-agent start/end timestamps, captured at onAgentStart/onAgentEnd
   * (never fabricated), keyed by the agent's snapshot id. A running agent has
   * an entry with no endedAt; persistRun() reads from here instead of stamping
   * every agent with the run's startedAt / "now".
   */
  agentTimestamps: Map<number, { startedAt: string; endedAt?: string }>;
  /**
   * Live snapshot-agent lookup keyed by the agent CALL's unique id (see
   * WorkflowRunOptions.onAgentStart/onAgentEnd/onAgentHistory's `id` field in
   * workflow.ts — unique per call, never per label). onAgentEnd/onAgentHistory
   * must resolve the snapshot entry to update through this map, never by
   * scanning managed.snapshot.agents for a label match: two concurrent agents
   * routinely share a label (e.g. parallel()'s default `"${phase} agent N"`
   * labeling, or an author-supplied label reused across a fan-out), and a
   * label+status scan would update whichever same-label entry it happens to
   * find first — misattributing one agent's end/history event to a different,
   * still-running sibling.
   */
  agentsById: Map<string, WorkflowAgentSnapshot>;
  /**
   * S1-4: snapshot.agents index up to which full result/history detail has
   * been trimmed from memory (older agents keep resultPreview only). The
   * watermark is advanced monotonically as agents leave the last
   * MAX_FULL_AGENT_DETAIL_IN_MEMORY window; onAgentEnd/onAgentHistory use it
   * to drop a late-set result/history on an agent that is already outside the
   * window. Init 0; never read before the first onAgentStart.
   */
  trimmedAgentDetailUpTo: number;
  /**
   * The run's cap on total agents (per-run value, else left undefined so
   * runWorkflow applies its own MAX_AGENTS_PER_RUN default), fixed at run
   * start/resume and carried through resume() — mirrors ManagedRun.tokenBudget
   * exactly: a resumed run must keep the cap it started with, not silently
   * regain the (much larger) default because ExecOptions.maxAgents isn't
   * threaded through resume()'s executeRun() call.
   */
  maxAgents?: number;
  /**
   * The run's resolved per-agent timeout (per-run value, else the manager
   * default at the time), fixed at run start/resume — same rationale as
   * tokenBudget/maxAgents: resume() must not re-resolve against the manager's
   * CURRENT defaultAgentTimeoutMs.
   */
  agentTimeoutMs?: number | null;
  /**
   * The run's resolved drain-side grace period in milliseconds (H1): how long
   * the top-level completion may wait for outstanding (possibly un-awaited)
   * agent() calls to settle before aborting them and completing anyway. Fixed
   * at run start/resume and persisted so a resumed run keeps the same grace.
   * Absent = runWorkflow's DRAIN_ABORT_TIMEOUT_MS default.
   */
  drainTimeoutMs?: number;
  /**
   * Seed of per-agent start/end timestamps for REPLAYED (cache-hit) agents
   * (L4): keyed by the agent call id (the same `${runId}:${callIndex}` id
   * onAgentStart/onAgentEnd receive), populated by resume() from the persisted
   * agents[] so a replayed agent reports its ORIGINAL timestamps instead of
   * fabricated resume-time ones. Live agents (calls that never completed
   * before the pause) have no seed and keep real captured times.
   */
  seededAgentTimestamps?: Map<string, { startedAt: string; endedAt?: string }>;
  /**
   * The run's resolved concurrency (per-run value, else the manager's
   * concurrency at the time), fixed at run start/resume for the same reason
   * as tokenBudget.
   */
  concurrency?: number;
  /**
   * The run's resolved agent-retry count (per-run value, else the manager
   * default at the time), fixed at run start/resume for the same reason as
   * tokenBudget.
   */
  agentRetries?: number;
  /**
   * Human-approval checkpoints for this run (see RunCheckpoint in
   * run-persistence.ts). The manager carries them in memory and writeRunToDisk
   * persists them with every write — before this field existed, a manager
   * persist landing after a persistence-layer saveCheckpoint() erased the
   * just-written checkpoints from the shared JSON file (core-orchestration:f3;
   * the persistence slice's compare-and-swap keeps the two writers in sync).
   * Seeded from persisted.checkpoints on resume().
   */
  checkpoints: RunCheckpoint[];
  /**
   * Damage-control kill channel for this execution (workflow_damage_control
   * kill-agent). Created by executeRun, cast onto the managed run, and threaded
   * into runWorkflow; absent until the first execution starts (and absent on
   * direct runWorkflow embeds). killAgent() feature-detects this — no channel,
   * no live abort, persisted reconciliation only.
   */
  agentKills?: AgentKillChannel;
  /**
   * F03: per-call ledger of RETRIED-attempt spend for the CURRENT execution,
   * keyed by the call's deltaKey (`${runId}:${callIndex}`). Seeded from the
   * persisted ledger on resume() — minus the entries refunded at seed time
   * (see retrySpendToRefund / resume()) — and appended to by onRetrySpend;
   * writeRunToDisk persists it (JSON-dropped when empty). Lets a resume
   * exclude from its spend seed the retry-spend of calls it will RE-RUN live,
   * so a pause landing mid-retry never charges the same failed attempt twice
   * against the run's tokenBudget (the A2 seed logic).
   */
  retryLedger: Record<string, AgentUsage>;
}

/** Statuses a run can rest in while it is NOT executing (lease released). */
type IdleRunStatus = Exclude<RunStatus, "running">;

/** A run that is executing: status "running" and its exclusive RunLease — see RunLeaseState. */
type ExecutingRun = ManagedRunBase & Extract<RunLeaseState, { status: "running" }>;

/** A run that is idle: any resting status, lease released — see RunLeaseState. */
type IdleRun = ManagedRunBase & Exclude<RunLeaseState, { status: "running" }>;

/**
 * A managed run — the "lease ⟺ executing" invariant, enforced by the TYPE
 * SYSTEM (see RunLeaseState in run-persistence.ts) instead of a comment:
 *
 *  - ExecutingRun: status "running" AND an exclusive cross-process lease.
 *    Its executeRun() promise is in flight (or about to start); it owns the
 *    run's lease until it settles.
 *  - IdleRun: any other status, no lease property at all. Nothing will
 *    asynchronously touch its lease bookkeeping again.
 *
 * An "executing run without a lease" or an "idle run holding a lease" cannot
 * be expressed — the compiler rejects both. The two members share one runtime
 * object (startExecuting()/settleExecuting() mutate it in place so
 * isCurrent()/getRun() keep seeing the live entry); those two helpers, plus
 * releaseHeldLease() for discard paths, are the ONLY code that writes
 * `status`/`lease`.
 */
export type ManagedRun = ExecutingRun | IdleRun;

/**
 * Writable runtime layout of a ManagedRun: both union members share one
 * in-memory shape, and transitions mutate it in place so object identity
 * survives (isCurrent()/getRun()/tests depend on it). This view is the cast
 * bridge used ONLY by startExecuting()/settleExecuting()/releaseHeldLease()
 * — the sole writers of `status`/`lease` — so every other read sees the
 * immutable union, which is what refuses to express an illegal state.
 */
type ManagedRunRuntime = ManagedRunBase & { status: RunStatus; lease?: RunLease };

/** Options for resume() — run-level overrides (script/args) plus a passthrough
 * of ExecOptions so a UI-bearing resume (TUI) keeps live checkpoints/progress
 * while the headless scheduler path stays unchanged (core-orchestration:i4).
 * Additive: opts remains optional and backward-compatible with the former
 * `{ script?: string; args?: unknown }` shape. */
export interface ResumeOptions extends ExecOptions {
  /** Resume with an EDITED script (cached-prefix reuse / iteration); omitted = persisted script. */
  script?: string;
  /** Override the persisted args; omitted = persisted args. */
  args?: unknown;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /**
   * Base exponential-backoff delay (ms) between retry attempts after a
   * recoverable agent failure (attempt N→N+1 waits base × 2^(N-1), capped at
   * 8× base). Default 1000. 0 disables the wait (tests). A pure timing knob —
   * deliberately NOT frozen per run (unlike agentRetries, which is
   * safety-relevant): a resumed run just uses whatever this execution passes.
   */
  retryBackoffMs?: number;
  /**
   * Replay these journaled agent/checkpoint results for the unchanged prefix
   * (resume), keyed by `${runId}:${index}` — see
   * WorkflowRunOptions.resumeJournal in workflow.ts.
   */
  resumeJournal?: Map<string, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /**
   * Drain-side grace period in milliseconds (H1): how long this run's
   * completion may wait for outstanding (possibly un-awaited) agent() calls to
   * settle before aborting them via the run-fatal controller and completing
   * anyway. Defaults to runWorkflow's DRAIN_ABORT_TIMEOUT_MS when omitted.
   */
  drainTimeoutMs?: number;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /**
   * Tool set for this run's subagents, replacing the default coding tools —
   * e.g. built-in `/deep-research` appends web tools. Omit for the default.
   * Not persistable (functions): pair with `toolset` so a resumed run can
   * re-resolve the same tools.
   */
  tools?: ToolDefinition[];
  /**
   * Named toolset tag, resolved via WorkflowManagerOptions.toolsets. Persisted
   * with the run and re-resolved on resume(). When both `tools` and `toolset`
   * are given, `tools` wins for this execution and `toolset` is what resumes use.
   */
  toolset?: string;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /**
   * Whether agents that end with a failure (exhausted recoverable retries, or a
   * parallel-absorbed item error) make this run settle failed (journal kept,
   * resumable) instead of completing with silent nulls. Frozen at start like
   * autoResume; undefined means the flag was not set (lenient, matches direct
   * runWorkflow embeds). The workflow TOOL sets true by default.
   */
  failOnExhaustedAgent?: boolean;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
  /**
   * Optional visual approve/deny gate for checkpoint() (e.g. the plannotator
   * SSE bridge). Threaded into runWorkflow; absent → checkpoint() keeps its
   * default headless/confirm behavior. Additive: no existing caller regresses.
   */
  checkpointGate?: CheckpointGate;
  /**
   * Opt-in Phase 0/1 pipeline wiring (wayfinder -> prewalk) threaded into
   * runWorkflow for this execution. Absent → no wayfinder/prewalk stages fire;
   * strictly additive (see PhasePipelineOptions in workflow.ts).
   */
  pipeline?: PhasePipelineOptions;
  /**
   * Opt-in PhaseGuard phase-state integration (persisted state machine) threaded
   * into runWorkflow for this execution. Absent → agent() calls stay ungated;
   * strictly additive (see PhaseStateIntegration in workflow.ts).
   */
  phaseState?: PhaseStateIntegration;
  /**
   * Whether this run is eligible for auto-resume when it pauses on a provider
   * usage limit. Default-on: omit or pass true to stay eligible, pass false to
   * opt out. Persisted on the run so a cold-start UsageLimitScheduler respects
   * it too. See usage-limit-scheduler.ts.
   */
  autoResume?: boolean;
  /**
   * OPT-IN resume-journal compaction (default OFF): when true, the run's
   * journal is folded into a compact summary at persist time — resolved
   * segments (calls whose operation traces are all "ok") are interned into
   * shared tables — and the summary is persisted ONLY when reconstruction QA
   * reproduces the original journal byte-identically (a failed-QA summary is
   * discarded and the original journal is kept). The positional deltaKey
   * scheme is untouched. Default off: the persisted journal is byte-identical
   * to today's shape. See journal-compaction.ts.
   */
  compactJournal?: boolean;
  /**
   * Seed for the execution's cumulative token counters — passed through to
   * runWorkflow's WorkflowRunOptions.initialTokenUsage. Only resume() sets
   * this (from the persisted run's tokenUsage-at-pause), so the resumed
   * execution's fresh SharedRuntime starts counting from the already-spent
   * total instead of zero (see A2 in workflow-manager's resume()).
   */
  initialTokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /**
   * The host Pi session's model registry. When provided, workflow subagents
   * resolve models against the same registry as the main session, including
   * extension-registered providers such as ollama-cloud.
   */
  modelRegistry?: ModelRegistry;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Default hard token budget when a run does not pass tokenBudget. null/omitted means no budget. */
  defaultTokenBudget?: number | null;
  /**
   * Named toolsets resolvable by ExecOptions.toolset — e.g.
   * `{ "web-research": () => [...createCodingTools(cwd), ...createWebTools()] }`.
   * Called lazily per execution (including on resume); factories may be async.
   * An unknown tag resolves to the default coding tools.
   */
  toolsets?: Record<string, () => ToolDefinition[] | Promise<ToolDefinition[]>>;
  /**
   * Default toolset factory resolved only when a run passes neither `tools`
   * nor a `toolset` tag — e.g. the extension's merged coding + proxied host
   * tools. May be async. An unknown toolset tag still falls through to the
   * agent's default coding tools (unchanged): defaultTools only fires for
   * untagged runs.
   */
  defaultTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  /**
   * Extra tool NAMES to deny in every subagent session, on top of the always-on
   * `workflow`/`workflow_control` defaults (see DEFAULT_EXCLUDED_SUBAGENT_TOOLS).
   * Host wiring passes settings.excludeSubagentTools here so users can also block
   * other recursive-orchestration tools (#107).
   */
  excludeSubagentTools?: string[];
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory. Default false (in-memory, discarded).
   */
  persistAgentSessions?: boolean;
  /**
   * How many terminal (completed/failed/aborted) runs to retain full
   * in-memory state for before the oldest is evicted from `runs` (see the
   * class-level doc comment on that field). Defaults to
   * DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY; exposed mainly for tests that want
   * to observe eviction without creating dozens of runs.
   */
  maxTerminalRunsInMemory?: number;
  /**
   * How many fully-settled paused runs to retain full in-memory state for
   * before the oldest is evicted from `runs` (paused-run-retention; see
   * DEFAULT_MAX_PAUSED_RUNS_IN_MEMORY). Defaults to that constant; exposed
   * mainly for tests that want to observe eviction without many runs. Only
   * FULLY-SETTLED paused executions are ever evicted — never one whose
   * executeRun() promise is still pending.
   */
  maxPausedRunsInMemory?: number;
  /**
   * How long an aborted execution may take to settle before the settle
   * watchdog force-releases its run from the in-memory registry (see
   * armSettleWatchdog / forceReleaseUnsettledRun). Generous default: a
   * cooperative abort (pause/stop/Esc) winds down in seconds, so the deadline
   * only fires for genuinely hung executions that would otherwise pin their
   * run in `runs` forever. Exposed for tests (core-orchestration:i5).
   */
  settleWatchdogMs?: number;
  /**
   * How often a running execution renews its exclusive cross-process lease
   * (see renewRunLease in run-persistence.ts). Defaults to one third of
   * DEFAULT_RUN_LEASE_TTL_MS, so a run that outlives the 30-minute TTL is
   * never evicted by the bounded-delay reclaim while it is genuinely
   * executing. Exposed for tests that want to observe the heartbeat without
   * waiting out the full TTL (F01).
   */
  leaseRenewIntervalMs?: number;
}

/** Options that a fresh extension generation may safely refresh on a live
 * manager handed across `/reload`. Execution identity (`cwd`, persistence,
 * injected agent, and in-memory runs) is intentionally excluded. */
export type WorkflowManagerReloadOptions = Pick<
  WorkflowManagerOptions,
  | "concurrency"
  | "loadSavedWorkflow"
  | "defaultAgentTimeoutMs"
  | "defaultAgentRetries"
  | "defaultTokenBudget"
  | "toolsets"
  | "defaultTools"
  | "excludeSubagentTools"
  | "persistAgentSessions"
>;

/**
 * Statuses in which a run's execution has genuinely settled — no promise is
 * still pending, no lease is still held, nothing will asynchronously mutate
 * this ManagedRun again. "paused" is deliberately excluded: both a manual
 * pause() and a usage-limit checkpoint leave the run resumable and, from the
 * in-memory-retention question's point of view, still "the run the user is
 * looking at" — only completed/failed/aborted runs are eviction candidates.
 * See the `runs` field doc comment for the full eviction lifecycle contract.
 */
const IN_MEMORY_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

/**
 * How many terminal (completed/failed/aborted) runs' full in-memory state
 * (agents array, journal, snapshot, agentTimestamps) to retain in `runs`
 * before the oldest is evicted. Kept small: a terminal run's data is fully
 * on disk (run-persistence.ts) by the time it's eviction-eligible, so the
 * in-memory copy exists only to serve a `getRun()`/`getSnapshot()` caller
 * that wants the LIVE object (vs. listRuns()'s persisted view) for a run
 * that *just* finished — a handful is enough for that; unbounded retention
 * is exactly the leak this bounds (run-level analog of the subagent
 * memory-retention mitigation in agent.ts).
 */
const DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY = 20;

/**
 * How many fully-settled PAUSED runs (manual pause() or a usage-limit
 * checkpoint whose execution has finished winding down) to retain in the
 * in-memory registry before the oldest is evicted (paused-run-retention).
 * Paused entries were previously never evicted at all — the audit found that
 * unbounded paused-run retention (each entry carrying its journal, snapshot,
 * and agent detail) grows memory without bound on a long host session that
 * accumulates usage-limit pauses. The cap deliberately applies only to
 * FULLY-SETTLED paused runs (see recordPausedRun) — never to one whose
 * executeRun() promise is still pending. Once evicted, the run's disk state
 * stays authoritative exactly as for an evicted terminal run: listRuns() and
 * resume() never depend on the in-memory copy.
 */
const DEFAULT_MAX_PAUSED_RUNS_IN_MEMORY = 20;

/**
 * S1-4: how many of the MOST RECENT agents keep their full in-memory
 * result + history (the interactive detail pager and the terminal-boundary
 * serialization payload). Older agents are trimmed to resultPreview — the
 * same compact form every non-pager surface already renders — so a run with
 * hundreds of agents keeps both its live snapshot and its boundary write
 * payload bounded instead of retaining every full result forever.
 */
const MAX_FULL_AGENT_DETAIL_IN_MEMORY = 50;

/**
 * Generous deadline for an aborted execution to settle before the settle
 * watchdog force-releases its run from `runs` (see armSettleWatchdog).
 * Cooperative aborts (pause/stop/Esc) are expected to wind down in seconds;
 * only a genuinely hung execution exceeds this — the watchdog's job is to
 * stop that hung execution from pinning its run in memory forever (its disk
 * state stays authoritative: listRuns()/resume() never depend on the
 * in-memory copy). The deadline, not a poll, bounds the wait (deterministic).
 */
const DEFAULT_SETTLE_WATCHDOG_MS = 30_000;

/**
 * Side-index key for journal upserts: the entry's OWN (runId, index) pair —
 * deliberately NOT the resume-time fallback (`runId ?? frameRunId`) that
 * buildResumeJournal uses. The manager's upsert must mirror the
 * persistence-layer upsertJournalEntry semantics (raw runId equality), where
 * a legacy entry (no runId) and a fresh entry for this run are DISTINCT keys
 * — a legacy entry must never be evicted by a fresh same-index entry.
 */
function journalSideKey(entry: JournalEntry): string {
  return journalEntryKey(entry.runId ?? "", entry.index);
}

/**
 * F03: aggregate the retry-spend ledger of calls that a resume will RE-RUN
 * live, so that spend can be refunded from the resume's spend seed (see
 * resume()). A call with a ledger entry but NO journal entry was interrupted
 * mid-retry: its failed-attempt spend is folded into the persisted
 * tokenUsage (via onRetrySpend → accumulateTokenUsage) but its result was
 * never journaled, so the replay misses and the call re-runs from scratch,
 * charging those attempts again — the seed would otherwise count them twice
 * and trip the tokenBudget cap early. A call WITH a journal entry replays
 * from the journal (charging 0) and keeps its spend. Matching uses the same
 * resume-time key buildResumeJournal uses (`journalEntryKey(entry.runId ??
 * frameRunId, entry.index)`), which is exactly the deltaKey shape
 * (`${runId}:${callIndex}`) the ledger is keyed by — including nested
 * workflow() frames, whose own runId namespaces both sides. Returns the
 * aggregate breakdown to subtract and the refunded keys (the caller clears
 * those from the seeded ledger so it stays consistent with the aggregate it
 * refunds against across repeated pause/resume cycles); undefined when
 * nothing needs refunding.
 */
function retrySpendToRefund(
  frameRunId: string,
  journal: JournalEntry[],
  ledger: Record<string, AgentUsage> | undefined,
): { refund: AgentUsage; refundedKeys: Set<string> } | undefined {
  if (!ledger) return undefined;
  const journaledKeys = new Set(journal.map((entry) => journalEntryKey(entry.runId ?? frameRunId, entry.index)));
  let refund: AgentUsage | undefined;
  const refundedKeys = new Set<string>();
  for (const [key, spend] of Object.entries(ledger)) {
    if (journaledKeys.has(key)) continue;
    refundedKeys.add(key);
    refund ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    refund.input += spend.input ?? 0;
    refund.output += spend.output ?? 0;
    refund.cacheRead += spend.cacheRead ?? 0;
    refund.cacheWrite += spend.cacheWrite ?? 0;
    refund.cost += spend.cost ?? 0;
    // Mirror accumulateTokenUsage's M26 handling: a breakdown-less ledger
    // entry (provider reported a scalar, or an estimate was used) contributes
    // its scalar; the aggregate's total is the component sum by construction.
    const components = usageComponentsTotal(spend);
    refund.total += components > 0 ? components : (spend.total ?? 0);
  }
  return refund ? { refund, refundedKeys } : undefined;
}

/**
 * Build the journalIndex side-index from a journal array (resume() seed time).
 * Iterating with set() keeps the LAST entry per key, matching buildResumeJournal's
 * Map semantics and the persistence layer's dedup: duplicates in a legacy
 * persisted journal collapse to the newest.
 */
function buildJournalSideIndex(journal: JournalEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  journal.forEach((entry, i) => {
    index.set(journalSideKey(entry), i);
  });
  return index;
}

export class WorkflowManager extends EventEmitter {
  /**
   * Lifecycle contract for `runs`:
   *
   *  - An entry is added when a run starts (startInBackground/runSync) or is
   *    resumed (resume()), always with a live AbortController and (usually)
   *    an active RunLease.
   *  - While status is "running" or "paused", the entry is NEVER evicted
   *    while its execution is still live — a pending executeRun() promise can
   *    still settle into the in-memory entry. Eviction only ever considers an
   *    entry AFTER executeRun() has fully settled it to "completed" |
   *    "failed" | "aborted" (see IN_MEMORY_TERMINAL_STATUSES) and persisted +
   *    released its lease — i.e. strictly after the same isCurrent()-gated
   *    persistRun() + settleExecuting() lease-release in executeRun()'s
   *    success/catch tails — or, for paused entries, after the execution has
   *    settled to "paused" (recordPausedRun, called from executeRun()'s
   *    finally): fully-settled paused runs beyond maxPausedRunsInMemory are
   *    evicted oldest-first (paused-run-retention), exactly like terminal
   *    runs beyond maxTerminalRunsInMemory.
   *  - Once terminal, an entry becomes eviction-ELIGIBLE (recordTerminalRun())
   *    but is not necessarily evicted immediately: up to
   *    maxTerminalRunsInMemory terminal entries are kept, oldest evicted
   *    first, so a `getRun()` call immediately after completion (e.g. the
   *    "complete" event's own synchronous listeners — task-panel's result
   *    delivery, `/workflows watch`) still sees the live object. Once
   *    evicted, the entry is simply removed from `runs`; nothing else reads
   *    or writes it again.
   *  - Every caller of getRun()/getSnapshot() must treat "undefined"/null as
   *    "no live in-memory copy right now" and fall back to listRuns() (backed
   *    by run-persistence.ts, which is what's authoritative for a run once
   *    the in-memory copy is gone) — this mirrors how those callers already
   *    treat any run this process never had in memory (e.g. one started by a
   *    different process and only ever seen via listRuns()). resume() never
   *    depends on `runs` for a run's state either: it always reloads from
   *    persistence, so an evicted runId resumes exactly like one from a
   *    prior process.
   *  - isCurrent(managed) composes with eviction the same way it composes
   *    with resume()/deleteRun() replacing or removing an entry: eviction
   *    removes the map entry outright, so a stale execution's later settle
   *    (isCurrent() check) sees `this.runs.get(runId) !== managed` (in fact
   *    undefined) and correctly no-ops, exactly as it would after
   *    resume()/deleteRun().
   */
  private runs = new Map<string, ManagedRun>();
  /**
   * FIFO of runIds that reached IN_MEMORY_TERMINAL_STATUSES, oldest first —
   * the eviction order for `runs` (see its doc comment). A runId can appear
   * more than once (e.g. resumed after eviction, then terminates again);
   * evicting is idempotent (recordTerminalRun() re-checks the CURRENT status
   * of the current map entry for that id before deleting), so duplicates
   * are harmless.
   */
  private terminalRunQueue: string[] = [];
  private maxTerminalRunsInMemory: number;
  /**
   * FIFO of runIds whose PAUSED execution has fully settled (see
   * recordPausedRun), oldest first — the eviction order for `runs` paused
   * entries beyond maxPausedRunsInMemory. Mirrors terminalRunQueue's
   * semantics: a runId can appear more than once across repeated
   * pause/resume cycles; evicting re-checks the CURRENT entry's status so a
   * resumed (running) run is never evicted.
   */
  private pausedRunQueue: string[] = [];
  private maxPausedRunsInMemory: number;
  /** How long an aborted execution may take to settle (see armSettleWatchdog). */
  private settleWatchdogMs: number;
  /** How often a running execution renews its lease (see armLeaseHeartbeat). */
  private leaseRenewIntervalMs: number;
  /** Pending settle watchdogs keyed by runId — see armSettleWatchdog. */
  private settleWatchdogs = new Map<string, { timer: ReturnType<typeof setTimeout>; managed: ManagedRun }>();
  /**
   * Active lease heartbeats keyed by runId — see armLeaseHeartbeat. One per
   * executing run; cleared when its execution settles (disarmLeaseHeartbeat).
   */
  private leaseHeartbeats = new Map<string, { timer: ReturnType<typeof setTimeout>; managed: ManagedRun }>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The host Pi session's model registry, shared with subagents. */
  private modelRegistry?: ModelRegistry;
  /** The host Pi session's provider pool, shared with subagents. */
  private providerPool?: ProviderPool;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;
  private defaultTokenBudget: number | null;
  private toolsets?: Record<string, () => ToolDefinition[] | Promise<ToolDefinition[]>>;
  private defaultTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  private excludeSubagentTools?: string[];
  private persistAgentSessions: boolean;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultTokenBudget = options.defaultTokenBudget ?? null;
    this.toolsets = options.toolsets;
    this.defaultTools = options.defaultTools;
    this.excludeSubagentTools = options.excludeSubagentTools;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.maxTerminalRunsInMemory = options.maxTerminalRunsInMemory ?? DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY;
    this.maxPausedRunsInMemory = options.maxPausedRunsInMemory ?? DEFAULT_MAX_PAUSED_RUNS_IN_MEMORY;
    this.settleWatchdogMs = options.settleWatchdogMs ?? DEFAULT_SETTLE_WATCHDOG_MS;
    this.leaseRenewIntervalMs =
      options.leaseRenewIntervalMs ?? Math.max(1_000, Math.floor(DEFAULT_RUN_LEASE_TTL_MS / 3));
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
    this.opportunisticWorktreePrune();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            this.persistence.save({ ...p, status: "paused" });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /**
   * Fire-and-forget `git worktree prune` (M14): reclaim stale worktree
   * registrations (metadata for directories that no longer exist) so a
   * deterministic slug's reuse path never collides with ghost registrations.
   * Best-effort. Gated by a cheap synchronous `.git` existence probe: spawning
   * git is only worthwhile inside a repository, and `git -C` chdirs into the
   * target — holding a Windows handle on that directory for the child's
   * lifetime — so an un-gated spawn would race directory deletion (EPERM in
   * tests/CI) and add a pointless child process for every non-repo consumer.
   */
  private opportunisticWorktreePrune(): void {
    if (!existsSync(join(this.cwd, ".git"))) return;
    void (async () => {
      try {
        const repoRoot = (await gitExec(["-C", this.cwd, "rev-parse", "--show-toplevel"])).trim();
        await pruneWorktrees(repoRoot);
      } catch {
        // not a git repository / git unavailable — nothing to prune
      }
    })();
  }

  /**
   * Refresh host configuration after Pi reloads the extension while retaining
   * this manager's live runs, controllers, leases, and event listeners.
   * Existing executions keep the options they captured at start; subsequent
   * runs and resumes use these refreshed defaults.
   */
  reconfigureAfterReload(options: WorkflowManagerReloadOptions): void {
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultTokenBudget = options.defaultTokenBudget ?? null;
    this.toolsets = options.toolsets;
    this.defaultTools = options.defaultTools;
    this.excludeSubagentTools = options.excludeSubagentTools;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host session's model registry so subagents resolve models consistently. */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * Expose the host session's model registry to integrations sharing this
   * manager. Workflow execution reads the same registry internally.
   */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  /** Set the host session's provider pool so subagents route through it. */
  setProviderPool(pool: ProviderPool | undefined): void {
    this.providerPool = pool;
  }

  /**
   * Expose the host session's provider pool to integrations sharing this
   * manager. Workflow execution reads the same pool internally.
   */
  getProviderPool(): ProviderPool | undefined {
    return this.providerPool;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const parsed = parseWorkflowScript(script);
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    const controller = new AbortController();
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    // Freeze the start-time budget once, so the snapshot's budget bar and the
    // run's tokenBudget cap can never drift apart (see ManagedRun.tokenBudget).
    const startTokenBudget = exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget;

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        // Cumulative start clock for every surface's live elapsed readout; the
        // ISO startedAt on the managed run is the resume-locally-observable
        // counterpart (see PersistedRunState.startedAtMs for the disk mapping).
        startedAtMs: Date.now(),
        tokenBudget: startTokenBudget,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
      journalIndex: new Map(),
      checkpoints: [],
      background: true,
      lease,
      autoResume: exec.autoResume,
      failOnExhaustedAgent: exec.failOnExhaustedAgent,
      compactJournal: exec.compactJournal === true,
      // Resolve the budget once at start and freeze it on the run (see
      // ManagedRun.tokenBudget) so resume keeps start-time semantics.
      tokenBudget: startTokenBudget,
      toolset: exec.toolset,
      // Same freeze-at-start pattern as tokenBudget, for the same reason: a
      // resumed run must keep these values, not re-resolve against the
      // manager's current defaults (see ManagedRun doc comments).
      maxAgents: exec.maxAgents,
      agentTimeoutMs: exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs,
      drainTimeoutMs: exec.drainTimeoutMs,
      concurrency: exec.concurrency !== undefined ? exec.concurrency : this.concurrency,
      agentRetries: exec.agentRetries !== undefined ? exec.agentRetries : this.defaultAgentRetries,
      agentTimestamps: new Map(),
      agentsById: new Map(),
      trimmedAgentDetailUpTo: 0,
      retryLedger: {},
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      this.persistence.save({
        runId,
        workflowName: parsed.meta.name,
        script,
        args,
        sessionId: this.sessionId,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        startedAtMs: managed.snapshot.startedAtMs,
        updatedAt: managed.startedAt.toISOString(),
        autoResume: managed.autoResume,
        failOnExhaustedAgent: managed.failOnExhaustedAgent,
        // Persisted only when opted in so a default run's file is byte-identical
        // to the pre-compaction shape (undefined keys are dropped by JSON).
        compactJournal: managed.compactJournal === true ? true : undefined,
        tokenBudget: managed.tokenBudget,
        toolset: managed.toolset,
        maxAgents: managed.maxAgents,
        agentTimeoutMs: managed.agentTimeoutMs,
        drainTimeoutMs: managed.drainTimeoutMs,
        concurrency: managed.concurrency,
        agentRetries: managed.agentRetries,
      });
    } catch (err) {
      // Nothing was persisted; the entry is discarded. Release the lease and
      // drop the run from memory — no settle transition needed.
      this.releaseHeldLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    const executing = this.startExecuting(managed, lease);
    executing.autoResume = exec.autoResume;
    executing.failOnExhaustedAgent = exec.failOnExhaustedAgent;
    executing.compactJournal = exec.compactJournal === true;
    executing.tokenBudget = exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget;
    executing.toolset = exec.toolset;
    // Same freeze-at-start pattern as tokenBudget (see startInBackground/ManagedRun).
    executing.maxAgents = exec.maxAgents;
    executing.agentTimeoutMs = exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs;
    executing.drainTimeoutMs = exec.drainTimeoutMs;
    executing.concurrency = exec.concurrency !== undefined ? exec.concurrency : this.concurrency;
    executing.agentRetries = exec.agentRetries !== undefined ? exec.agentRetries : this.defaultAgentRetries;
    this.runs.set(executing.runId, executing);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(executing);
    return this.executeRun(executing, script, args, exec);
  }

  /**
   * Build a fresh managed run with an empty snapshot, in the released-and-idle
   * "pending" state: created but not yet executing. The caller acquires the
   * lease and flips it into the executing state via startExecuting() — until
   * then the run is never in the map and never persisted, so the transient
   * "pending" status is unobservable.
   */
  private createManaged(script: string, args?: unknown): IdleRun {
    const parsed = parseWorkflowScript(script);
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    return {
      runId,
      status: "pending",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        startedAtMs: Date.now(),
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      journalIndex: new Map(),
      checkpoints: [],
      background: false,
      agentTimestamps: new Map(),
      agentsById: new Map(),
      trimmedAgentDetailUpTo: 0,
      retryLedger: {},
    };
  }

  private async executeRun(
    managed: ExecutingRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      drainTimeoutMs,
      externalSignal,
      onProgress,
      tokenBudget,
      concurrency,
      agentRetries,
      retryBackoffMs,
      confirm,
      checkpointGate,
      pipeline,
      phaseState,
      tools,
      initialTokenUsage,
    } = exec;
    // maxAgents/agentTimeoutMs/concurrency/agentRetries were resolved (per-run
    // value, else the manager default at the time) and frozen on the managed
    // run at start/resume (see ManagedRun doc comments) — read them from there
    // first, exactly like resolvedTokenBudget below, so a resumed run keeps the
    // values it started with instead of re-resolving against the manager's
    // CURRENT defaults. The exec.* fallbacks are a safety net for direct
    // executeRun callers that skipped the start paths (same rationale as
    // resolvedTokenBudget's tokenBudget fallback).
    const resolvedMaxAgents = managed.maxAgents !== undefined ? managed.maxAgents : maxAgents;
    const resolvedAgentTimeoutMs =
      managed.agentTimeoutMs !== undefined
        ? managed.agentTimeoutMs
        : agentTimeoutMs !== undefined
          ? agentTimeoutMs
          : this.defaultAgentTimeoutMs;
    const resolvedConcurrency =
      managed.concurrency !== undefined ? managed.concurrency : (concurrency ?? this.concurrency);
    const resolvedAgentRetries =
      managed.agentRetries !== undefined ? managed.agentRetries : (agentRetries ?? this.defaultAgentRetries);
    // Frozen at start like the other knobs (undefined = lenient, never set by
    // the caller; the workflow TOOL sends true/false explicitly).
    const resolvedFailOnExhaustedAgent =
      managed.failOnExhaustedAgent !== undefined ? managed.failOnExhaustedAgent : exec.failOnExhaustedAgent;
    // Same freeze-at-start pattern as the other per-run knobs (H1): a resumed
    // run keeps the drain grace it started with.
    const resolvedDrainTimeoutMs = managed.drainTimeoutMs !== undefined ? managed.drainTimeoutMs : drainTimeoutMs;
    // The budget was resolved (per-run value, else defaultTokenBudget) and frozen
    // on the managed run at start/resume — read it from there so a resumed run
    // keeps the budget it started with. exec.tokenBudget is a safety net for
    // direct executeRun callers that skipped the start paths.
    const resolvedTokenBudget = managed.tokenBudget !== undefined ? managed.tokenBudget : (tokenBudget ?? null);
    // Explicit tools win for this execution; else re-resolve the run's persisted
    // toolset tag (how a resumed /deep-research keeps its web tools); else, for
    // a run with NO tag, resolve the manager's defaultTools (e.g. host tools);
    // else the agent layer's default coding tools.
    let resolvedTools = tools ?? (managed.toolset ? await this.toolsets?.[managed.toolset]?.() : undefined);
    if (resolvedTools === undefined && managed.toolset === undefined) {
      resolvedTools = await this.defaultTools?.();
    }
    // Gated the same way as this.emitLive() below (see isCurrent()) — a stale
    // execution's progress callback would otherwise keep driving live UI
    // (task panel, etc.) for a run that's been superseded or deleted.
    const progress = () => {
      if (this.isCurrent(managed)) onProgress?.(managed.snapshot);
    };
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        managed.controller.abort();
        this.armSettleWatchdog(managed);
      } else {
        onExternalAbort = () => {
          managed.controller.abort();
          this.armSettleWatchdog(managed);
        };
        // { once: true } covers the fired case; the listener is ALSO removed in
        // executeRun's finally (L3) so a long-lived host signal can never
        // accumulate one leaked listener per settled run.
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    // Damage-control kill channel (workflow_damage_control kill-agent): owned
    // by THIS execution — created fresh per start/resume so a stale channel
    // from a superseded execution can never abort a newer one. Exposed on the
    // managed run (ManagedRunBase.agentKills) and threaded into runWorkflow;
    // killAgent() feature-detects it — absent on direct runWorkflow embeds,
    // where the kill gates in workflow.ts are no-ops and today's behavior is
    // preserved exactly.
    const agentKills: AgentKillChannel = { killedCallIds: new Set(), killControllers: new Map() };
    managed.agentKills = agentKills;
    // Lease heartbeat (F01): this execution owns the run's exclusive lease —
    // keep renewing it so a run that outlives DEFAULT_RUN_LEASE_TTL_MS is never
    // evicted by the bounded-delay reclaim. Disarmed in the finally below when
    // the execution settles (success or failure); a pause()/stop() that already
    // released the lease makes later ticks no-op via the status/isCurrent gates.
    this.armLeaseHeartbeat(managed);
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args,
        agentKillChannel: agentKills,
        // Use the managed run's persisted id as the workflow runId so the value
        // returned in result.runId matches the id that listRuns()/resume() use.
        // Otherwise runWorkflow mints an ephemeral `run-<ts>` id and the sync
        // path would surface a non-resumable id to the model.
        runId: managed.runId,
        // F15: per-run memoized model-tiers loader (mtime/size-guarded) so the
        // resume-replay hash's per-agent() config read stops re-parsing the
        // file on every call (up to 1000x/run). Nested workflow() frames
        // inherit this same memo via runWorkflow's spread options; the file is
        // run-frozen by design.
        loadTierConfig: createMemoizedLoadModelTierConfig(),
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        persistAgentSessions: this.persistAgentSessions,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        retryBackoffMs,
        maxAgents: resolvedMaxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        drainTimeoutMs: resolvedDrainTimeoutMs,
        tokenBudget: resolvedTokenBudget,
        tools: resolvedTools,
        excludeTools: this.excludeSubagentTools,
        confirm,
        checkpointGate,
        pipeline,
        phaseState,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        // The run's frozen compaction opt-in — surfaced on runWorkflow's options
        // surface (the journal owner, writeRunToDisk, honors it at persist time).
        compactJournal: managed.compactJournal === true,
        // Seed the fresh SharedRuntime's spend counter from the persisted total
        // (resume()) so the hard tokenBudget cap holds cumulatively across a
        // pause/resume cycle instead of resetting to zero each time (see A2 —
        // runWorkflow only applies this on the fresh-SharedRuntime branch, never
        // overriding an inherited options.sharedRuntime from a nested workflow()).
        initialTokenUsage,
        // Retried-attempt spend (see WorkflowRunOptions.onRetrySpend and A2):
        // recordTokens() in workflow.ts already folded this into
        // shared.spent/tokenUsage, but onAgentEnd never sees a retried
        // (non-final) attempt — fold it into the same persisted aggregate here
        // so a run paused after a retry doesn't under-count against the budget.
        onRetrySpend: (spend, callId) => {
          this.accumulateTokenUsage(managed, spend.total, spend);
          // F03: keep the per-call retry ledger (see ManagedRun.retryLedger) so
          // a later pause/resume can refund the spend of calls that re-run —
          // the persisted total includes this spend, and without the ledger a
          // resume would charge the same failed attempt twice.
          const prior = managed.retryLedger[callId];
          managed.retryLedger[callId] = prior
            ? {
                input: prior.input + (spend.input ?? 0),
                output: prior.output + (spend.output ?? 0),
                cacheRead: prior.cacheRead + (spend.cacheRead ?? 0),
                cacheWrite: prior.cacheWrite + (spend.cacheWrite ?? 0),
                total: prior.total + spend.total,
                cost: prior.cost + (spend.cost ?? 0),
              }
            : { ...spend };
          // F13: notify progress listeners like the other spend paths
          // (onAgentEnd/onTokenUsage call progress() after accumulating) so a
          // retried attempt's spend doesn't sit invisible in memory until the
          // next unrelated event or the settle persist.
          progress();
        },
        onAgentJournal: (entry) => {
          // O(1) upsert via the journalIndex side-index (see its doc comment):
          // keep the LATEST entry per (runId, index) pair exactly like the
          // persistence-layer upsertJournalEntry, without the O(n) array
          // filter on the high-frequency progress persist (once per completed
          // agent, can burst under concurrency). Matching on index ALONE would
          // let a nested workflow()'s callIndex-0 entry evict the parent's own
          // callIndex-0 entry (and vice versa) — they're only distinguished by
          // runId (JournalEntry.runId). Legacy entries (no runId) are distinct
          // keys from fresh ones (see journalSideKey).
          const key = journalSideKey(entry);
          const at = managed.journalIndex.get(key);
          if (
            at !== undefined &&
            managed.journal[at]?.runId === entry.runId &&
            managed.journal[at]?.index === entry.index
          ) {
            // Same (runId, index) pair already journaled: replace in place.
            managed.journal[at] = entry;
          } else {
            managed.journalIndex.set(key, managed.journal.length);
            managed.journal.push(entry);
          }
          this.schedulePersist(managed);
        },
        onLog: (message) => {
          // Bounded like the logger's own ring (pushBoundedLog): snapshot.logs
          // is re-serialized in full on every persist, so an unbounded array
          // would grow the persisted file without bound per long run.
          pushBoundedLog(managed.snapshot.logs, message);
          this.emitLive(managed, "log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emitLive(managed, "phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          const id = managed.snapshot.agents.length + 1;
          const agentSnapshot: WorkflowAgentSnapshot = {
            id,
            callId: event.id,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
          };
          managed.snapshot.agents.push(agentSnapshot);
          // S1-4: each new agent can push older siblings out of the
          // full-detail retention window — sweep the watermark so a run with
          // hundreds of agents never retains every full result/history in
          // memory (bounded boundary-serialization payload too).
          this.trimStaleAgentDetail(managed);
          // Index by the call's unique id (never label — see agentsById's doc
          // comment) so onAgentEnd/onAgentHistory can resolve back to exactly
          // THIS entry even when a concurrent sibling shares its label.
          managed.agentsById.set(event.id, agentSnapshot);
          // Real per-agent start time, captured the moment the agent actually
          // starts (not the run's startedAt) — see agentTimestamps. A REPLAYED
          // (cache-hit) agent carries its ORIGINAL start time seeded from the
          // persisted agents[] by call id (L4), so resume never fabricates
          // fresh timestamps for work that actually finished before the pause.
          const seeded = managed.seededAgentTimestamps?.get(event.id);
          managed.agentTimestamps.set(
            id,
            seeded ? { startedAt: seeded.startedAt, endedAt: seeded.endedAt } : { startedAt: new Date().toISOString() },
          );
          this.emitLive(managed, "agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = managed.agentsById.get(event.id);
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            // Keep the full value for the interactive pager; compact surfaces
            // continue to use resultPreview.
            agent.result = event.result;
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.failingOperation = event.failingOperation;
            agent.tokens = event.tokens;
            if (event.tokenUsage) agent.tokenUsage = event.tokenUsage;
            if (event.model) agent.model = event.model;
            // S1-4: a slow agent that ends AFTER newer siblings pushed it out
            // of the retention window must not re-inflate memory — drop its
            // freshly-set full detail immediately, keep the preview.
            if (agent.id <= managed.trimmedAgentDetailUpTo) {
              delete agent.result;
              delete agent.history;
            }
            // Real per-agent end time — only terminal agents get one; a still-
            // running agent's entry keeps endedAt undefined. A replayed agent's
            // seeded endedAt (its original completion time) is preserved; only
            // agents that genuinely finish in THIS execution get "now" (L4).
            const ts = managed.agentTimestamps.get(agent.id);
            if (ts) ts.endedAt = ts.endedAt ?? new Date().toISOString();
          }
          // Progressive run-wide token aggregate (A2): workflow.ts's onTokenUsage
          // callback below fires exactly once, only when the whole script finishes
          // successfully (a deliberate, tested contract — see
          // "agent() accumulates usage across multiple agents" in agent.test.ts,
          // which asserts one final event, not one per agent). A run that
          // pauses/aborts/fails mid-flight never reaches it, so without tracking
          // it here too, a paused run's persisted tokenUsage would stay whatever
          // it was (usually unset) — starving resume()'s spend-seeding of the
          // very data it needs. Accumulate additively from every onAgentEnd
          // instead: a cache-hit replay reports tokens: 0 (see agent()'s replay
          // branch in workflow.ts), so replaying the unchanged prefix on resume
          // is a no-op add here, matching the "already historically spent, don't
          // double-count" semantics of journal replay.
          this.accumulateTokenUsage(managed, event.tokens ?? 0, event.tokenUsage);
          this.emitLive(managed, "agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          const agent = managed.agentsById.get(event.id);
          if (agent) {
            agent.history = event.history;
            // S1-4: same late-setter guard as onAgentEnd — an agent already
            // outside the full-detail window keeps only its preview.
            if (agent.id <= managed.trimmedAgentDetailUpTo) {
              delete agent.history;
            }
          }
          this.emitLive(managed, "agentHistory", { runId: managed.runId, agentId: agent?.id, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emitLive(managed, "tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      managed.result = result;
      // Settle the run to idle (completed): flip status + release the lease
      // (isCurrent-gated — see settleExecuting). The flip happens before the
      // "complete" emit below so listeners observe the settled run; the
      // isCurrent()-gated recordTerminalRun() then makes it eviction-eligible
      // (see the `runs` field doc comment). persistRun() below lands the final
      // state on disk — it no-ops if `managed` was superseded while awaiting
      // (resume()/deleteRun() took over this runId), and settleExecuting()'s
      // lease release is guarded the same way: a stale execution settling after
      // resume() has already acquired a NEW lease for this runId must not
      // touch that newer lease's bookkeeping.
      this.settleExecuting(managed, "completed");
      // Gated the same way as disk/lease below (see emitLive()): a stale
      // execution's "complete" would otherwise still deliver a result for a
      // run that's been superseded or deleted (e.g. background result
      // delivery into the conversation) even though it's no longer current.
      this.emitLive(managed, "complete", { runId: managed.runId, result });

      // Persist final state.
      this.persistRun(managed);
      if (this.isCurrent(managed)) {
        // Now (and only now — after the run's data is safely on disk and its
        // lease released) does this run become eviction-eligible; see the
        // `runs` field doc comment.
        this.recordTerminalRun(managed.runId);
      }
      // The execution settled on its own — cancel the abort watchdog (see
      // armSettleWatchdog) so it can't later fire against a newer execution
      // of this runId.
      this.disarmSettleWatchdog(managed);

      // Completion-time strictness gate: agent() returning null is the SCRIPT's
      // contract (recoverable retries exhausted, or a parallel()-absorbed item
      // error), but a run that resolves with failed agents must not silently
      // "complete" on the orchestration surface — that is exactly what used to
      // force the orchestrator into a full restart (completion drops the
      // journal, so every agent re-ran from scratch). Fail here instead (settles
      // "failed", journal preserved) so the tool's sync path throws
      // withResumeHint: the orchestrator resumes, completed agents replay from
      // cache, and only the failed call re-runs live with a fresh session.
      if (resolvedFailOnExhaustedAgent === true && result.failedAgents?.length) {
        const summary = result.failedAgents.map((f) => `${f.label} (${f.errorCode})`).join(", ");
        throw new WorkflowError(
          `${result.failedAgents.length} agent(s) exhausted retries: ${summary}`,
          WorkflowErrorCode.AGENT_EXHAUSTED,
          { recoverable: false },
        );
      }

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      const usageLimitPaused = !managed.controller.signal.aborted && isProviderUsageLimit(workflowError);
      // 503/504 overload: like a usage limit, the condition resolves on its own
      // (the endpoint recovers) — checkpoint the run as paused instead of
      // failing it, so resume() replays the journal once the provider is back.
      const overloadedPaused = !managed.controller.signal.aborted && isProviderOverloaded(workflowError);
      const checkpointPaused = usageLimitPaused || overloadedPaused;
      // Settle the run to idle in the status this failure warrants. The abort
      // branch is the abort/drain interplay's hinge: pause()/stop() may have
      // already settled THIS SAME object to idle (status flipped + lease
      // released) while this execution was awaiting — re-check its CURRENT
      // state and only settle it here if it is still genuinely executing, so
      // an already-settled run is never double-settled (its lease was already
      // released, and releasing again would be a type error at best, a
      // wrong-lease release at worst).
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop().
        if (managed.status === "running") {
          this.settleExecuting(managed, "aborted");
        }
      } else if (checkpointPaused) {
        // Provider condition that resolves on its own (quota/usage limit, or a
        // 503/504 outage): NOT a failure. Checkpoint the run as paused so the
        // persisted journal (completed agent results) is replayed by resume()
        // once the budget refills / the endpoint recovers — instead of the
        // user starting from scratch.
        this.settleExecuting(managed, "paused");
      } else {
        this.settleExecuting(managed, "failed");
      }
      managed.error = workflowError;
      // Both branches gated via emitLive() (see its doc comment) — a stale
      // execution's "paused"/"error" is equally misleading once superseded.
      if (checkpointPaused) {
        this.emitLive(managed, "paused", {
          runId: managed.runId,
          reason: overloadedPaused ? "provider_overloaded" : "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else if (!managed.controller.signal.aborted && this.listenerCount("error") > 0) {
        // Guarded: EventEmitter throws on an unlistened "error" emit, which
        // would abort this catch block mid-way — skipping the final persist,
        // the lease release, and the real error rethrow below.
        // `!managed.controller.signal.aborted` (core-orchestration:f1):
        // intentional aborts (pause()/stop()/deleteRun()/external signal) all
        // set managed.controller.signal.aborted, and the usageLimitPaused
        // branch above already excludes them from "paused" — without this
        // gate they'd fall through to the failure branch and fire a spurious
        // 'error' event for a deliberate user action. Run-fatal aborts use the
        // SharedRuntime.runFatalController (NOT managed.controller), so a
        // genuine run failure still reaches this branch and emits 'error'.
        // Surface the failing operation (Fabric-style line-numbered failure
        // repair) from the failed agent that carries one, when present.
        const failedAgent = [...managed.agentsById.values()]
          .filter((a) => a.error !== undefined)
          .reverse()
          .find((a) => a.failingOperation !== undefined);
        this.emitLive(managed, "error", {
          runId: managed.runId,
          error: workflowError,
          ...(failedAgent?.failingOperation ? { failingOperation: failedAgent.failingOperation } : {}),
        });
      }

      // Persist final state (see the success-path comment above for the
      // isCurrent() rationale — same guard, same reason).
      this.persistRun(managed);
      if (this.isCurrent(managed)) {
        // "paused" (manual pause() or a usage-limit checkpoint) is
        // deliberately NOT eviction-eligible — only a genuinely settled
        // terminal status is (see IN_MEMORY_TERMINAL_STATUSES / the `runs`
        // field doc comment). recordTerminalRun() itself re-checks this too,
        // but skip the call entirely here so a paused run never even enters
        // the eviction queue.
        if (IN_MEMORY_TERMINAL_STATUSES.has(managed.status)) this.recordTerminalRun(managed.runId);
      }
      // The execution settled (failure path) — cancel the abort watchdog.
      this.disarmSettleWatchdog(managed);

      throw workflowError;
    } finally {
      // L3: the run has settled (success or failure) — drop the host-signal
      // listener so a long-lived external signal never accumulates one leaked
      // listener per run. ({ once: true } already handled the fired case.)
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      // The execution settled — stop renewing its lease (see armLeaseHeartbeat).
      this.disarmLeaseHeartbeat(managed);
      // The execution has FULLY settled — a paused run (manual pause() or a
      // usage-limit/provider-outage checkpoint) can now be retired from the
      // in-memory registry when the paused-run cap is exceeded
      // (paused-run-retention). Only ever here, never earlier: while
      // executeRun() is pending, the settle path may still write into the
      // in-memory entry (the lifecycle contract's original reason paused
      // entries were never evicted).
      if ((managed as unknown as ManagedRunRuntime).status === "paused") this.recordPausedRun(managed);
    }
  }

  /**
   * True when `managed` is still the live, current entry for its runId in
   * `this.runs` — false once resume() has replaced it with a new ManagedRun
   * object for the same runId, or deleteRun() has removed it entirely. A
   * superseded ManagedRun's async completion (executeRun's promise settling
   * well after something else already took over or tore down that runId)
   * must not write to disk or touch lease state on the newer execution's
   * behalf — see writeRunToDisk() and executeRun()'s post-await persist calls.
   */
  private isCurrent(managed: ManagedRun): boolean {
    return this.runs.get(managed.runId) === managed;
  }

  /**
   * Emit an event on behalf of `managed`, but only while it's still the
   * current entry for its runId (see isCurrent()) — mirrors the disk/lease
   * guard for the observer-facing side of the same problem. A superseded
   * execution's progress/terminal events (log, phase, agentStart/End,
   * tokenUsage, complete, error, paused) are not just stale-but-harmless:
   * "complete" in particular can drive background result delivery into the
   * conversation, so letting a deleted/superseded run's stale settle still
   * fire it would deliver a result for a run that, from the caller's POV, no
   * longer exists (or has since been superseded by a newer execution whose
   * own events already tell the true story). No event in this set has a
   * legitimate reason to still reach listeners once superseded — unlike
   * disk writes there's no "expected race, harmless no-op" nuance here, it's
   * simply wrong to notify twice (or for a run that's gone). Events emitted
   * directly by pause()/stop()/resume()/deleteRun() themselves are NOT routed
   * through this helper — those methods own the transition and ARE current
   * at the moment they fire, same precedent as their persist/lease calls.
   */
  private emitLive(managed: ManagedRun, event: string, payload: unknown): void {
    if (this.isCurrent(managed)) {
      try {
        this.emit(event, payload);
      } catch (error) {
        // M1: a throwing EventEmitter listener (e.g. a task-panel renderer
        // mid-delivery) must never abort the run's control flow — the event is
        // observability, not execution. Log and continue.
        console.warn(
          `[workflow-manager] a "${event}" listener threw (run continues): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Mark `runId` as eviction-eligible now that its execution has genuinely
   * settled to a terminal status (completed/failed/aborted — see
   * IN_MEMORY_TERMINAL_STATUSES), and evict the oldest eligible entries
   * beyond maxTerminalRunsInMemory. Callers must only invoke this after the
   * same isCurrent()-gated persistRun() + settleExecuting() lease-release
   * sequence executeRun() already uses (see the `runs` field doc comment for
   * the full contract) —
   * this method itself re-validates the CURRENT entry's status before
   * deleting anything, so it never evicts a run that isn't (or is no longer)
   * genuinely terminal, including one resumed back to "running" after being
   * queued here but before its turn to be evicted came up.
   */
  private recordTerminalRun(runId: string): void {
    this.terminalRunQueue.push(runId);
    while (this.terminalRunQueue.length > this.maxTerminalRunsInMemory) {
      const oldest = this.terminalRunQueue.shift();
      if (oldest === undefined) break;
      const current = this.runs.get(oldest);
      // Re-check the CURRENT entry for this id (not the ManagedRun object
      // that was terminal when queued) — resume() may have since replaced
      // it with a fresh, live execution, which must never be evicted here.
      if (current && IN_MEMORY_TERMINAL_STATUSES.has(current.status)) {
        this.runs.delete(oldest);
      }
    }
  }

  /**
   * Paused-run-retention: mark `runId` as eviction-eligible now that its
   * PAUSED execution has fully settled, and evict the oldest eligible paused
   * entries beyond maxPausedRunsInMemory. Callers must only invoke this from
   * executeRun()'s finally (the settle-complete point) — a paused run whose
   * executeRun() promise is still pending must never be evicted (it can still
   * settle into the in-memory entry). Like recordTerminalRun, this re-checks
   * the CURRENT entry's status before deleting: a run resumed back to
   * "running" after being queued is never evicted while its newer execution
   * lives, and a paused run is only dropped from the registry — its disk
   * state (the pause persist) stays authoritative, so resume()/listRuns()
   * work exactly as they do for an evicted terminal run.
   */
  private recordPausedRun(managed: ManagedRun): void {
    const runId = managed.runId;
    this.pausedRunQueue.push(runId);
    while (this.pausedRunQueue.length > this.maxPausedRunsInMemory) {
      const oldest = this.pausedRunQueue.shift();
      if (oldest === undefined) break;
      const current = this.runs.get(oldest);
      if (current && current.status === "paused") {
        this.runs.delete(oldest);
      }
    }
  }

  /**
   * Additively fold one agent-call's token cost into the run-wide persisted
   * aggregate (managed.snapshot.tokenUsage), seeded (on resume) from the
   * persisted total-at-pause — see A2. Shared by onAgentEnd (a completed or
   * finally-failed agent call) and onRetrySpend (a failed attempt that WILL
   * be retried, whose cost recordTokens() already folded into
   * shared.spent/tokenUsage in workflow.ts, but which onAgentEnd never sees —
   * see WorkflowRunOptions.onRetrySpend for why that needs its own channel).
   */
  private accumulateTokenUsage(
    managed: ManagedRun,
    tokens: number,
    tokenUsage?: { input: number; output: number; cost: number; cacheRead: number; cacheWrite: number },
  ): void {
    const prior = managed.snapshot.tokenUsage;
    const usage = {
      input: prior?.input ?? 0,
      output: prior?.output ?? 0,
      total: prior?.total ?? 0,
      cost: prior?.cost ?? 0,
      cacheRead: prior?.cacheRead ?? 0,
      cacheWrite: prior?.cacheWrite ?? 0,
    };
    if (tokenUsage) {
      usage.input += tokenUsage.input;
      usage.output += tokenUsage.output;
      usage.cost += tokenUsage.cost;
      usage.cacheRead += tokenUsage.cacheRead;
      usage.cacheWrite += tokenUsage.cacheWrite;
      // M26: same invariant as workflow.ts's recordTokens — when a breakdown
      // exists, the aggregate total is the component sum, so the persisted
      // aggregate satisfies total === input+output+cacheRead+cacheWrite by
      // construction (a breakdown-less usage falls back to the scalar).
      const components = usageComponentsTotal(tokenUsage);
      usage.total += components > 0 ? components : tokens;
    } else {
      usage.total += tokens;
    }
    managed.snapshot.tokenUsage = usage;
  }

  /**
   * Idle → executing transition: attach the exclusive lease and flip status
   * together, so "executing" and "leased" can never drift apart (see the
   * ManagedRun union). The run is already in `runs`; this happens
   * synchronously before any await, so the transition is unobservable.
   */
  private startExecuting(run: IdleRun, lease: RunLease): ExecutingRun {
    const runtime = run as unknown as ManagedRunRuntime;
    runtime.status = "running";
    runtime.lease = lease;
    return run as unknown as ExecutingRun;
  }

  /**
   * Executing → idle transition: flip the status and release the lease as ONE
   * state change. The release is isCurrent()-gated exactly as the old inline
   * release was: a stale execution settling after resume()/deleteRun() took
   * over this runId must not release the newer execution's lease (or call
   * releaseRunLease(undefined) — deleteRun() clears the lease first).
   * persistRun() is deliberately NOT bundled here: callers keep their existing
   * emit→persist order and single final persist (see the burst-coalescing
   * test), so the settled status lands on disk at the same moment as before.
   */
  private settleExecuting(run: ExecutingRun, status: IdleRunStatus): IdleRun {
    const runtime = run as unknown as ManagedRunRuntime;
    runtime.status = status;
    if (this.isCurrent(run)) {
      this.persistence.releaseRunLease(run.lease);
      runtime.lease = undefined;
    }
    return run as unknown as IdleRun;
  }

  /**
   * Release a run's lease WITHOUT settling it — for discard paths where the
   * run leaves `runs` entirely (deleteRun(), or startInBackground()'s
   * initial-persist failure), so no legal idle state is needed afterward.
   */
  private releaseHeldLease(run: ExecutingRun): void {
    this.persistence.releaseRunLease(run.lease);
    (run as unknown as ManagedRunRuntime).lease = undefined;
  }

  /**
   * Settle watchdog (core-orchestration:i5): bound how long an aborted
   * execution may take to settle after pause()/stop()/an external signal fired
   * its abort. A cooperative abort winds down in seconds; a genuinely hung
   * execution (a subagent session that never observes the signal, a stuck
   * store write, ...) would otherwise pin its run in `this.runs` forever —
   * pause()/stop() already flipped its status and released its lease
   * synchronously, but the pending executeRun() promise never settles, so
   * recordTerminalRun() (which only runs after the real settle) never evicts
   * it. The watchdog fires after settleWatchdogMs and force-releases the run:
   * settle-and-persist where the execution never got there itself, then drop
   * the entry from `runs`. The hung execution's eventual settle is a harmless
   * no-op via isCurrent() — the entry is gone (or superseded) by then.
   * Disarmed in executeRun's settle tails when the execution settles on its
   * own. The deadline, not a poll, bounds the wait; every callback path is
   * identity-checked against the ManagedRun it was armed for, so a superseded
   * execution's watchdog can never release a newer execution of the same
   * runId.
   */
  private armSettleWatchdog(managed: ManagedRun): void {
    const existing = this.settleWatchdogs.get(managed.runId);
    if (existing?.managed === managed) return; // already armed for this execution
    if (existing) clearTimeout(existing.timer); // superseded execution's watchdog — replace it
    const timer = setTimeout(() => {
      this.settleWatchdogs.delete(managed.runId);
      this.forceReleaseUnsettledRun(managed);
    }, this.settleWatchdogMs);
    // A pending watchdog must never keep the process alive on its own.
    timer.unref?.();
    this.settleWatchdogs.set(managed.runId, { timer, managed });
  }

  /** Cancel a pending watchdog — called only by the exact execution it was armed for. */
  private disarmSettleWatchdog(managed: ManagedRun): void {
    const existing = this.settleWatchdogs.get(managed.runId);
    if (existing?.managed !== managed) return;
    clearTimeout(existing.timer);
    this.settleWatchdogs.delete(managed.runId);
  }

  /**
   * Lease heartbeat (F01): renew the run's exclusive lease periodically so a
   * long-running execution never loses it to the bounded-delay reclaim (see
   * DEFAULT_RUN_LEASE_TTL_MS) — a second process could otherwise acquire the
   * same runId mid-run and execute it concurrently, and clean/recover could
   * normalize a live run to paused. Armed by executeRun() on every start and
   * resume (the single choke point for all three start paths) and disarmed in
   * its finally, so the timer is scoped exactly to the execution that owns
   * the lease. Mirrors armSettleWatchdog's identity-checked bookkeeping: a
   * superseded execution's heartbeat can never renew (or re-arm for) a newer
   * execution of the same runId. The timer is unref'd so a pending heartbeat
   * never keeps the process alive on its own.
   */
  private armLeaseHeartbeat(managed: ExecutingRun): void {
    const existing = this.leaseHeartbeats.get(managed.runId);
    if (existing?.managed === managed) return; // already armed for this execution
    if (existing) clearTimeout(existing.timer); // superseded execution's heartbeat — replace it
    const timer = setTimeout(() => {
      this.leaseHeartbeatTick(managed);
    }, this.leaseRenewIntervalMs);
    timer.unref?.();
    this.leaseHeartbeats.set(managed.runId, { timer, managed });
  }

  /** Cancel a pending heartbeat — called only by the exact execution it was armed for. */
  private disarmLeaseHeartbeat(managed: ManagedRun): void {
    const existing = this.leaseHeartbeats.get(managed.runId);
    if (existing?.managed !== managed) return;
    clearTimeout(existing.timer);
    this.leaseHeartbeats.delete(managed.runId);
  }

  /**
   * Heartbeat tick: re-arm for the next tick, then push the lease's expiry
   * forward (see renewRunLease). No-ops when the run is no longer the current
   * entry for its runId (settled/superseded/evicted) or no longer executing
   * (pause()/stop() already flipped the status and released the lease — renew
   * would return false against the deleted lock and only log a spurious
   * warning). A renewal failure (lease lost to a reclaim, or a filesystem
   * error) is best-effort: the run keeps executing and its own failure paths
   * still settle it normally — the heartbeat is the bounded-delay reclaim's
   * counterpart, not a liveness enforcement.
   */
  private leaseHeartbeatTick(managed: ExecutingRun): void {
    try {
      if (!this.isCurrent(managed) || this.leaseHeartbeats.get(managed.runId)?.managed !== managed) return;
      if (managed.status !== "running") {
        this.disarmLeaseHeartbeat(managed);
        return;
      }
      this.armLeaseHeartbeat(managed);
      const renewed = this.persistence.renewRunLease?.(managed.lease) ?? renewRunLease(managed.lease, this.cwd);
      if (!renewed) {
        console.warn(`[workflow-manager] run ${managed.runId} lost its lease (renewRunLease returned false)`);
      }
    } catch (error) {
      console.warn(
        `[workflow-manager] lease heartbeat for run ${managed.runId} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Watchdog callback: the aborted execution never settled within
   * settleWatchdogMs — force-release its run from the in-memory registry (see
   * armSettleWatchdog). Safe for every resting status the run can have at this
   * point ("running" from an external-signal abort whose subagent ignored the
   * signal; "paused"/"aborted" from pause()/stop()): disk state is and stays
   * authoritative, and resume()/listRuns() never depend on the in-memory copy.
   */
  private forceReleaseUnsettledRun(managed: ManagedRun): void {
    // Only release the exact execution the watchdog was armed for — a resume()
    // may have replaced this runId's entry with a newer execution since.
    if (this.runs.get(managed.runId) !== managed) return;
    const runtime = managed as unknown as ManagedRunRuntime;
    if (runtime.status === "running") {
      // The abort fired but the execution never settled it. Settle + persist
      // here so the lease is released and "aborted" lands on disk (persistRun
      // also flushes any pending throttled write for this runId); the hung
      // execution's later settle is a no-op via isCurrent().
      this.settleExecuting(managed as unknown as ExecutingRun, "aborted");
      this.persistRun(managed);
    } else {
      // Idle status (paused/aborted/...): pause()/stop() already released the
      // lease and persisted the status. Cancel any pending throttled write so
      // a deferred persist can't fire after the entry is gone.
      const timer = this.persistTimers.get(managed.runId);
      if (timer) {
        clearTimeout(timer);
        this.persistTimers.delete(managed.runId);
      }
    }
    this.runs.delete(managed.runId);
  }

  /** Trailing-edge throttle window for high-frequency progress persists (see schedulePersist). */
  private static readonly PERSIST_THROTTLE_MS = 400;

  /** Pending trailing-edge persist timers for high-frequency progress events, keyed by runId. */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Pending S1-3 deferred-compaction setImmediate tasks, keyed by runId,
   * remembering the status snapshot each was queued from. A non-terminal
   * settle write (start/pause/resume) with compactJournal enabled queues one
   * of these instead of running compactJournal + the reconstruction QA on the
   * critical path; the task re-persists the compacted form only if the run is
   * still the SAME live ManagedRun in the SAME state (see
   * queueDeferredCompaction), so a resumed/completed/deleted run is never
   * clobbered by a stale compacted snapshot.
   */
  private deferredCompactions = new Map<string, { timer: ReturnType<typeof setImmediate>; status: RunStatus }>();

  /**
   * Coalesce rapid progress persists (currently: onAgentJournal, which fires
   * once per completed agent and can burst under concurrency) to at most one
   * disk write per PERSIST_THROTTLE_MS (trailing edge) instead of one write
   * per tick — persistRun() does a full JSON.stringify of the run plus up to
   * 3 sync writes, so firing it once per agent in a long run is O(N^2).
   *
   * Lifecycle-critical writes (status transitions, run end, pause/resume/stop)
   * must NOT use this — call persistRun() directly, which flushes (and cancels)
   * any pending timer first so a stale trailing write can never fire after, and
   * resurrect, a terminal state.
   */
  private schedulePersist(managed: ManagedRun): void {
    if (this.persistTimers.has(managed.runId)) return; // already scheduled; the trailing write reads live state
    const timer = setTimeout(() => {
      this.persistTimers.delete(managed.runId);
      // F19: throttled progress writes are the FAST path — persist the raw
      // journal only. Compaction + reconstruction QA (several full-journal
      // stringifies) run exclusively at lifecycle settle boundaries via
      // persistRun(); the final settled state always compacts again.
      this.writeRunToDisk(managed, false);
    }, WorkflowManager.PERSIST_THROTTLE_MS);
    // A pending progress persist should never keep the process alive on its own.
    timer.unref?.();
    this.persistTimers.set(managed.runId, timer);
  }

  /**
   * Persist immediately and synchronously. Cancels any pending throttled write
   * for this run first, so the write that lands is always the caller's current
   * (final) state — never superseded by a stale deferred write. Use this for
   * every lifecycle-critical persist: run start, status transitions, run end,
   * pause()/resume()/stop().
   */
  private persistRun(managed: ManagedRun): void {
    // A superseded execution's persist call must not touch the CURRENT
    // execution's pending-timer bookkeeping for this runId (see isCurrent()).
    // writeRunToDisk() below re-checks this too (it's the sole choke point
    // schedulePersist()'s deferred timer also funnels through), so this is a
    // belt-and-suspenders early-out specifically for the timer-clearing side
    // effect, which writeRunToDisk() alone wouldn't prevent.
    if (!this.isCurrent(managed)) return;
    const timer = this.persistTimers.get(managed.runId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(managed.runId);
    }
    // F19: lifecycle-settle writes (start, pause/resume/stop, complete, error,
    // force-release) are the compaction boundaries — see writeRunToDisk.
    this.writeRunToDisk(managed, true);
  }

  /**
   * S1-3: run compactJournal + verifyJournalCompaction for a run and decide
   * what lands on disk — the compacted summary ONLY when reconstruction QA
   * reproduces the journal byte-identically AND the summary actually shrinks
   * it; otherwise the original journal (with a warn when QA rejected it).
   * Shared by the terminal-settle branch and the deferred-compaction task so
   * the gate's semantics are identical everywhere it runs.
   */
  private foldJournalCompaction(managed: ManagedRun): {
    journal?: PersistedRunState["journal"];
    journalCompacted?: PersistedRunState["journalCompacted"];
  } {
    const summary = compactJournal(managed.journal);
    const qa = verifyJournalCompaction(summary, managed.journal);
    if (qa.ok && JSON.stringify(summary).length <= JSON.stringify(managed.journal).length) {
      return { journalCompacted: summary };
    }
    if (!qa.ok) {
      console.warn(
        `[workflow-manager] journal compaction QA rejected for run ${managed.runId} (${qa.reason}) — keeping the original journal`,
      );
    }
    return { journal: managed.journal };
  }

  /**
   * S1-3: queue compactJournal + verifyJournalCompaction off the pause/resume
   * critical path. The raw journal is already on disk (the caller persisted it
   * first); this task re-runs the fold and re-persists the compacted form ONLY
   * when `managed` is still the current live entry for its runId AND still in
   * the same non-terminal state it was queued from. Any of resume() (replaces
   * the object), a terminal settle, stop(), or deleteRun() invalidates the task
   * — the newer writer's state is never clobbered by a stale compacted
   * snapshot. unref'd: a pending compaction must never keep the process alive.
   *
   * Superseding: at most one pending task per (runId, status snapshot). A task
   * queued while another is pending for the SAME status is a duplicate — skip
   * it (the pending fold will land the same compacted form). A task for a
   * DIFFERENT status supersedes the pending one: the older task's fold would
   * be skipped anyway (its status snapshot no longer matches the live run), so
   * leaving it armed would swallow the newer deferral entirely and no fold
   * would ever land.
   */
  private queueDeferredCompaction(managed: ManagedRun): void {
    const runId = managed.runId;
    const status = managed.status;
    const pending = this.deferredCompactions.get(runId);
    if (pending) {
      if (pending.status === status) return; // same-status duplicate — the pending fold covers it
      clearImmediate(pending.timer);
      this.deferredCompactions.delete(runId);
    }
    const timer = setImmediate(() => {
      this.deferredCompactions.delete(runId);
      const current = this.runs.get(runId);
      // Same-object AND same-status: resume() swaps in a fresh ManagedRun, and
      // a terminal settle/stop changes the status — either way this run has
      // moved on and its own writes already handled the fold (or are the
      // current word), so a stale compacted re-persist must not land.
      if (!current || current !== managed || current.status !== status) return;
      this.writeRunToDisk(current, true, { forceSyncCompaction: true });
    });
    timer.unref?.();
    this.deferredCompactions.set(runId, { timer, status });
  }

  /**
   * S1-4: advance the per-run full-detail watermark. Agents whose snapshot
   * index fell out of the last MAX_FULL_AGENT_DETAIL_IN_MEMORY window have
   * their heavy in-memory result/history dropped (resultPreview stays — the
   * compact form every non-pager surface renders). Amortized O(1) per new
   * agent: each agent is visited once, when the window moves past it.
   */
  private trimStaleAgentDetail(managed: ManagedRun): void {
    const agents = managed.snapshot.agents;
    const windowStart = Math.max(0, agents.length - MAX_FULL_AGENT_DETAIL_IN_MEMORY);
    if (windowStart <= managed.trimmedAgentDetailUpTo) return;
    for (let i = managed.trimmedAgentDetailUpTo; i < windowStart; i++) {
      const agent = agents[i];
      if (agent === undefined) continue;
      delete agent.result;
      delete agent.history;
    }
    managed.trimmedAgentDetailUpTo = windowStart;
  }

  /**
   * The sole choke point for every disk write (both persistRun()'s direct
   * calls and schedulePersist()'s deferred timer funnel through here).
   * F19: `compact` gates the opt-in compaction + reconstruction-QA work — it
   * is true only at lifecycle settle boundaries (persistRun); the throttled
   * fast path writes the raw journal. When compaction is enabled and QA
   * passes, the compacted summary REPLACES the plain journal on disk, so the
   * byte-identity guarantee (a summary is never persisted unless it
   * reconstructs to the exact original) is unchanged — a fast-path raw write
   * simply defers the fold to the next settle boundary.
   */
  private writeRunToDisk(managed: ManagedRun, compact = true, opts: { forceSyncCompaction?: boolean } = {}) {
    // The sole choke point for every disk write (both persistRun()'s direct
    // calls and schedulePersist()'s deferred timer funnel through here) — skip
    // silently when `managed` is no longer the current entry for its runId
    // (see isCurrent()). This is an expected race outcome (resume() replaced
    // it, or deleteRun() removed it), not an error: writing anyway would
    // resurrect a torn-down run's file, or clobber a newer execution's
    // in-progress/completed state with this stale one's.
    //
    // This check is redundant with persistRun()'s own early-return for every
    // CURRENT call site — it earns its keep solely for schedulePersist()'s
    // deferred setTimeout callback, the one path into this method that skips
    // persistRun() entirely. That callback only fires from onAgentJournal, and
    // onAgentJournal only fires for a call that got PAST agent()'s
    // throwIfAborted() check (see workflow.ts) — which, since run-fatal abort
    // (SharedRuntime.runFatalController) now seals every top-level run's
    // shared runtime the instant any error escapes it uncaught, means a
    // genuinely superseded-but-never-aborted execution (the only kind that
    // could previously still journal a stray call after resume() replaced it)
    // is structurally impossible to construct anymore — see the "unreachable
    // defense-in-depth (#2)" test in workflow-manager.test.ts for the worked
    // example and its own note. This check is KEPT anyway: it costs nothing,
    // and removing it would silently reopen a stale-write path the moment any
    // future change (e.g. a new way to journal without throwIfAborted()'s
    // gate) reintroduces a producer for it.
    if (!this.isCurrent(managed)) return;
    try {
      // Resumable states need their journal; completed/aborted states need rich
      // agent details. Persist exactly one full copy of each agent result instead
      // of writing it to both agents[].result and journal[].result.
      const keepJournal = keepsResumeJournal(managed.status);
      // E4/S1-1: throttled progress writes (compact=false) take the append-only
      // journal-delta fast path — the persistence layer writes ONLY the new
      // journal entries to the `.jdelta` sidecar instead of re-serializing the
      // full run state on every tick (O(n^2) as the journal grows), and skips
      // the .bak sidecar (kept only for boundary writes). Lifecycle-settle
      // writes (compact=true) are unchanged and always fold + compact.
      const useFastPath = !compact && keepJournal;
      // S1-3: budget-truncate the in-memory journal BEFORE the compaction fold
      // (and before the boundary persist) so a pathological journal never enters
      // compactJournal/verifyJournalCompaction — both re-stringify the whole
      // journal — and the persisted form never exceeds the byte budget. Count-
      // gated with the persistence layer's own JOURNAL_BYTE_CHECK_THRESHOLD so
      // typical runs pay nothing. The truncation applies to the in-memory
      // journal itself (and its O(1) upsert side-index is rebuilt) so memory,
      // disk, and the persistence layer's foldedByRun map stay consistent —
      // otherwise the next fast-path write would re-delta the entries the
      // budget dropped from disk. Dropped entries simply re-run live on resume
      // (capJournalBudget's documented degradation).
      if (compact && keepJournal && managed.journal.length > JOURNAL_BYTE_CHECK_THRESHOLD) {
        managed.journal = capJournalBudget(managed.journal);
        managed.journalIndex = buildJournalSideIndex(managed.journal);
      }
      // P2-5 opt-in compaction (ExecOptions.compactJournal): fold the journal's
      // resolved segments into a compact summary and persist it ONLY when the
      // reconstruction-QA gate reproduces the original journal byte-identically
      // (verifyJournalCompaction) — a failed-QA summary is discarded and the
      // original journal is kept; a compacted form is never persisted without
      // passing the gate. A summary that does not actually shrink the journal
      // (nothing foldable / everything verbatim) is also skipped — persisting a
      // larger "compaction" buys nothing. The positional deltaKey scheme
      // (`${runId}:${callIndex}`) is untouched in both forms. F19: this block
      // runs only when `compact` is set — the throttled fast path (schedule-
      // Persist) skips it and persists the raw journal.
      //
      // S1-3: on NON-terminal settle writes (start/pause/resume) the fold is
      // moved off the critical path — the raw journal is persisted synchronously
      // FIRST, and compactJournal + verifyJournalCompaction run in a queued
      // setImmediate task (queueDeferredCompaction) whose re-persist lands the
      // compacted form only if the run is still the same live run in the same
      // state. Terminal settles (completed/failed/aborted) and the deferred
      // task itself (forceSyncCompaction) still fold synchronously — the QA
      // gate always runs, just possibly off the pause/resume critical path.
      let journal: PersistedRunState["journal"];
      let journalCompacted: PersistedRunState["journalCompacted"];
      const isTerminalSettle = compact && keepJournal && IN_MEMORY_TERMINAL_STATUSES.has(managed.status);
      if (isTerminalSettle && managed.compactJournal === true) {
        ({ journal, journalCompacted } = this.foldJournalCompaction(managed));
      } else if (compact && keepJournal && managed.compactJournal === true) {
        if (opts.forceSyncCompaction) {
          // The deferred compaction task's own write: fold synchronously here
          // (the event loop is idle — that is the point of the deferral).
          ({ journal, journalCompacted } = this.foldJournalCompaction(managed));
        } else {
          // Non-terminal settle: raw journal now, compaction + QA queued.
          journal = managed.journal;
          this.queueDeferredCompaction(managed);
        }
      } else {
        journal = keepJournal ? managed.journal : undefined;
      }
      this.persistence.save(
        {
          runId: managed.runId,
          workflowName: managed.snapshot.name,
          // Persist the real script + journal so the run can be resumed. Runs live
          // in workflow run storage — protect via directory permissions, not blanking.
          script: managed.script,
          args: managed.args,
          sessionId: this.sessionId,
          journal,
          journalCompacted,
          status: managed.status,
          // Cumulative start clock (see PersistedRunState.startedAtMs): carried
          // through every write so a resume keeps the run's ORIGINAL start.
          startedAtMs: managed.snapshot.startedAtMs,
          // Persisted every write (not just at pause) so a stale read during the
          // "paused" event race (see UsageLimitScheduler) is still correct — this
          // is fixed at run-start and doesn't change over the run's lifetime.
          autoResume: managed.autoResume,
          failOnExhaustedAgent: managed.failOnExhaustedAgent,
          // The run's frozen compaction opt-in (see ExecOptions.compactJournal),
          // persisted so a resumed run keeps compacting if it started with the
          // flag; omitted (JSON-dropped) on default runs so their persisted files
          // stay byte-identical to the pre-compaction shape.
          compactJournal: managed.compactJournal === true ? true : undefined,
          // Start-time execution context, re-read by resume() (see ManagedRun).
          tokenBudget: managed.tokenBudget,
          toolset: managed.toolset,
          maxAgents: managed.maxAgents,
          agentTimeoutMs: managed.agentTimeoutMs,
          drainTimeoutMs: managed.drainTimeoutMs,
          concurrency: managed.concurrency,
          agentRetries: managed.agentRetries,
          // Why a usage-limit/provider-outage pause happened, so the navigator /
          // a future cold start can show it and (eventually) re-arm resume after
          // the budget refills / the endpoint recovers.
          pauseReason:
            managed.status === "paused" && isProviderUsageLimit(managed.error)
              ? "usage_limit"
              : managed.status === "paused" && isProviderOverloaded(managed.error)
                ? "provider_overloaded"
                : undefined,
          resetHint:
            managed.status === "paused" && isProviderUsageLimit(managed.error) ? managed.error.resetHint : undefined,
          phases: managed.snapshot.phases,
          currentPhase: managed.snapshot.currentPhase,
          // Real per-agent timestamps only (see agentTimestamps) — never the run's
          // own startedAt or "now" stamped onto every agent on every write. A
          // still-running agent is persisted with no endedAt.
          agents: managed.snapshot.agents.map((a) => {
            const { result, ...summary } = a;
            const ts = managed.agentTimestamps.get(a.id);
            return {
              ...summary,
              // Live runs keep the rich value in memory. Cold resumable runs use
              // the journal and retain resultPreview until replay reconstructs it.
              ...(keepJournal || result === undefined ? {} : { result }),
              startedAt: ts?.startedAt,
              endedAt: ts?.endedAt,
            };
          }),
          logs: managed.snapshot.logs,
          // Checkpoints live in their own array on disk (see RunCheckpoint); the
          // manager carries its in-memory copy so a resume-seeded list round-trips
          // through every persist (core-orchestration:f3). Omitted (JSON-dropped)
          // when empty: the persistence layer's CAS merge treats an EXPLICIT empty
          // array as a clear, so a fresh run (which has no checkpoints in memory)
          // must send undefined to keep externally CAS-written checkpoints — that
          // is the whole point of the single-writer fix. A non-empty list merges
          // by taskId, newest timestamp wins.
          checkpoints: managed.checkpoints.length > 0 ? managed.checkpoints : undefined,
          result: managed.result?.result,
          tokenUsage: managed.snapshot.tokenUsage
            ? {
                input: managed.snapshot.tokenUsage.input,
                output: managed.snapshot.tokenUsage.output,
                total: managed.snapshot.tokenUsage.total,
                cost: managed.snapshot.tokenUsage.cost,
                cacheRead: managed.snapshot.tokenUsage.cacheRead,
                cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
              }
            : undefined,
          // F03 retry ledger (see ManagedRun.retryLedger). JSON-dropped when
          // empty so a default run's persisted file stays byte-identical to the
          // pre-fix shape (same pattern as compactJournal).
          retryLedger: Object.keys(managed.retryLedger).length > 0 ? managed.retryLedger : undefined,
          startedAt: managed.startedAt.toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
          durationMs: managed.result?.durationMs,
        },
        useFastPath ? { fastPath: true, checkBudget: false } : undefined,
      );
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory. Log so
      // an operator debugging state-loss has a lead, but never crash the
      // workflow over a disk-full situation. M27: a SWALLOWED terminal-persist
      // failure would leave the run "running" on disk — a ghost run in
      // listRuns() whose lease is already released. Retry once with a minimal
      // status-only write (the CAS merge layers it onto whatever is on disk,
      // flipping just the status); if even that fails, surface a distinct
      // persist-error event so the host never mistakes the run for alive.
      console.warn("[workflow-manager] Persist run failed:", err);
      try {
        // Minimal status-only retry (M27): flip the status so the disk never
        // keeps a ghost "running" for a settled run. agents[] is deliberately
        // empty here (the run's rich detail lives in memory; the journal below
        // is preserved for resumable statuses so resume() can still replay).
        this.persistence.save({
          runId: managed.runId,
          workflowName: managed.snapshot.name,
          script: managed.script,
          args: managed.args,
          status: managed.status,
          phases: managed.snapshot.phases,
          agents: [],
          logs: managed.snapshot.logs,
          journal: keepsResumeJournal(managed.status) ? managed.journal : undefined,
          startedAt: managed.startedAt.toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (retryErr) {
        console.warn(`[workflow-manager] Minimal status-only persist also failed for ${managed.runId}:`, retryErr);
        this.emitLive(managed, "persist-error", {
          runId: managed.runId,
          status: managed.status,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    this.armSettleWatchdog(managed);
    this.settleExecuting(managed, "paused");
    this.emit("paused", { runId });
    this.persistRun(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   *
   * `opts.script` lets the orchestrating model resume with an EDITED script
   * (cached-prefix reuse / iteration): unchanged agent() calls whose content
   * hash still matches the journal entry at their positional callIndex replay
   * from cache, while the first changed or newly inserted call — and everything
   * after it — re-runs live. When `opts.script` is omitted, resume behaves
   * exactly as before and uses the persisted script (auto-resume, TUI resume);
   * this keeps the existing single-arg `resume(runId)` callers (e.g. the
   * UsageLimitScheduler) unchanged. `opts.args` overrides the persisted args
   * only when provided; otherwise the persisted args are kept. Any remaining
   * ResumeOptions (an ExecOptions passthrough, core-orchestration:i4) are
   * forwarded to the resumed execution — e.g. a TUI resume passes onProgress/
   * confirm to keep live checkpoints and progress, while the headless
   * scheduler path stays as-is by simply omitting them.
   */
  async resume(runId: string, opts?: ResumeOptions): Promise<boolean> {
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    // This in-memory check (and the load below) is ADVISORY — see M23.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;

    const advisory = this.persistence.load(runId);
    if (!advisory?.script || advisory.status === "completed" || advisory.status === "aborted") return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;

    // M23 (resume TOCTOU): the pre-lease load above was advisory only. A
    // concurrent process may have completed/aborted this run between that read
    // and the lease acquisition — re-load UNDER the lease and re-validate
    // before committing to resume. Refusing here releases the lease and leaves
    // the freshest on-disk state untouched (no partial resume is ever started).
    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") {
      this.persistence.releaseRunLease(lease);
      return false;
    }

    // Use the edited script when supplied, else the persisted one (backward-compat).
    const { script: editedScript, args: overrideArgs, ...exec } = opts ?? {};
    const script = editedScript ?? persisted.script;
    const args = overrideArgs !== undefined ? overrideArgs : persisted.args;

    // The run's resume journal in normalized (de-compacted) form, computed
    // ONCE and reused for the in-memory seed, the upsert side-index, and the
    // resume-replay map below (see loadPersistedJournal).
    const persistedJournal = loadPersistedJournal(persisted);

    // F03: refund the retry-spend of calls that this resume will RE-RUN live.
    // A call with a retry-ledger entry but no journal entry was interrupted
    // mid-retry — its failed-attempt spend was folded into the persisted
    // tokenUsage (via onRetrySpend → accumulateTokenUsage) but its result was
    // never journaled, so the replay misses and the call re-runs from scratch,
    // charging those same attempts again. Refunding them from the seed keeps a
    // failed attempt charged EXACTLY ONCE across the pause/resume boundary
    // (the persisted total would otherwise count it twice, tripping the hard
    // tokenBudget cap early). A call WITH a journal entry replays from the
    // journal (charging 0) and keeps its spend. Refunded calls' ledger entries
    // are also cleared from the seeded ledger so it stays consistent with the
    // aggregate it refunds against across repeated pause/resume cycles.
    const refundState = retrySpendToRefund(runId, persistedJournal, persisted.retryLedger);
    const seededRetryLedger = { ...(persisted.retryLedger ?? {}) };
    if (refundState) {
      for (const key of refundState.refundedKeys) delete seededRetryLedger[key];
    }

    // Normalize the persisted total-at-pause once: PersistedRunState.tokenUsage
    // has optional cost/cacheRead/cacheWrite (legacy runs may lack them), but
    // both the seeded snapshot and initialTokenUsage need concrete numbers.
    // F03: the F03 refund above is subtracted here, component-wise (clamped at
    // zero), so BOTH the seeded snapshot and the fresh SharedRuntime's spend
    // counter exclude the retry-spend of calls that will re-run.
    const priorTokenUsage = persisted.tokenUsage
      ? (() => {
          const base = {
            input: persisted.tokenUsage.input,
            output: persisted.tokenUsage.output,
            total: persisted.tokenUsage.total,
            cost: persisted.tokenUsage.cost ?? 0,
            cacheRead: persisted.tokenUsage.cacheRead ?? 0,
            cacheWrite: persisted.tokenUsage.cacheWrite ?? 0,
          };
          const refund = refundState?.refund;
          if (!refund) return base;
          return {
            input: Math.max(0, base.input - refund.input),
            output: Math.max(0, base.output - refund.output),
            total: Math.max(0, base.total - refund.total),
            cost: Math.max(0, base.cost - refund.cost),
            cacheRead: Math.max(0, base.cacheRead - refund.cacheRead),
            cacheWrite: Math.max(0, base.cacheWrite - refund.cacheWrite),
          };
        })()
      : undefined;

    // L4: seed per-agent timestamps from the persisted agents[] by call id so
    // REPLAYED (cache-hit) agents report their ORIGINAL startedAt/endedAt
    // instead of fabricated resume-time stamps. Only agents with a stored call
    // id + start time qualify; a call that was interrupted mid-flight before
    // the pause has a seed with no endedAt (its live re-run completes it).
    const seededAgentTimestamps = new Map<string, { startedAt: string; endedAt?: string }>();
    for (const agent of persisted.agents) {
      if (agent.callId && agent.startedAt) {
        seededAgentTimestamps.set(agent.callId, { startedAt: agent.startedAt, endedAt: agent.endedAt });
      }
    }

    const controller = new AbortController();
    // Resolve the budget once at resume and freeze it on the run (see the
    // ManagedRun.tokenBudget comment) so re-resume keeps start-time semantics.
    const resumeTokenBudget =
      exec.tokenBudget !== undefined
        ? exec.tokenBudget
        : persisted.tokenBudget !== undefined
          ? persisted.tokenBudget
          : null;
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        // Seed the live snapshot's logs bounded to the same cap: a run
        // persisted before the ring-buffer existed could carry >1000 entries,
        // and every resume persist re-serializes the whole array.
        logs: (persisted.logs ?? []).slice(-DEFAULT_MAX_LOG_ENTRIES),
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        // Seed the live snapshot's aggregate from the persisted total-at-pause
        // (see A2) so a pause that lands before this resume's first agent
        // completes doesn't lose the prior spend — onAgentEnd accumulates on
        // top of this rather than starting from scratch.
        tokenUsage: priorTokenUsage,
        // CUMULATIVE start clock: prefer the run's ORIGINAL first-start stamp
        // so elapsed readouts keep counting across pause/resume boundaries
        // instead of resetting; legacy runs without one fall back to now.
        startedAtMs: persisted.startedAtMs ?? Date.now(),
        tokenBudget: resumeTokenBudget,
      },
      controller,
      startedAt: new Date(),
      // The (possibly edited) script + args become the run's own — persistRun()
      // writes them below, so a later resume of this run sees the edited script.
      script,
      args,
      journal: persistedJournal,
      // Rebuild the O(1) upsert side-index from the seeded journal (see
      // ManagedRunBase.journalIndex) so onAgentJournal can replace seeded
      // entries in place when a resume re-runs a call.
      journalIndex: buildJournalSideIndex(persistedJournal),
      checkpoints: persisted.checkpoints ?? [],
      background: true,
      lease,
      // Carry the original opt-out forward across resumes; it's fixed at
      // run-start and persistRun() re-persists it on every subsequent write.
      autoResume: persisted.autoResume,
      // Carry the compaction opt-in forward across resumes the same way: a run
      // that started compacting keeps compacting (persisted as a boolean).
      compactJournal: persisted.compactJournal === true,
      // Restore start-time execution context: the budget the run started with
      // (legacy runs without one resume unbudgeted — never re-apply the current
      // default to a run that predates it) and the toolset tag executeRun
      // re-resolves so e.g. a resumed /deep-research keeps its web tools. An
      // EXPLICIT exec override from the caller (the workflow tool forwards
      // raw params) wins over the persisted value — e.g. raising the cap to
      // recover a run paused at its usage limit, where spent >= persisted
      // budget would block the very first agent() call. Unset restores
      // start-time semantics.
      tokenBudget: resumeTokenBudget,
      toolset: persisted.toolset,
      // Same explicit-wins-else-persisted rule as tokenBudget for the other four
      // per-run knobs (see ManagedRun doc comments) — same rationale as
      // tokenBudget: never re-resolve against the manager's CURRENT defaults.
      // maxAgents: legacy/never-set runs resume with no cap carried forward
      // (runWorkflow's own MAX_AGENTS_PER_RUN default applies), exactly as if
      // maxAgents had never been passed at all.
      maxAgents: exec.maxAgents !== undefined ? exec.maxAgents : persisted.maxAgents,
      // agentTimeoutMs: unlike tokenBudget, a legacy run's real timeout at
      // start was never "no timeout" by omission — it was always
      // this.defaultAgentTimeoutMs, because pre-A1 resume() never threaded
      // agentTimeoutMs through at all and unconditionally fell back to the
      // manager default (see executeRun's resolvedAgentTimeoutMs fallback
      // chain). Falling back to null here would change what a legacy run's
      // resume actually does versus both its original start AND pre-fix
      // resume behavior. So — deliberately unlike tokenBudget's null
      // fallback — legacy runs resume with the manager's CURRENT default,
      // matching the only semantics such a run ever had.
      agentTimeoutMs:
        exec.agentTimeoutMs !== undefined
          ? exec.agentTimeoutMs
          : persisted.agentTimeoutMs !== undefined
            ? persisted.agentTimeoutMs
            : this.defaultAgentTimeoutMs,
      // concurrency/agentRetries have no "explicit opt-out sentinel" the way
      // tokenBudget's null does — a legacy run without a persisted value falls
      // back to the manager's current values, matching how this execution
      // resolved unset concurrency/agentRetries before this fix ever existed.
      concurrency: exec.concurrency !== undefined ? exec.concurrency : (persisted.concurrency ?? this.concurrency),
      agentRetries:
        exec.agentRetries !== undefined ? exec.agentRetries : (persisted.agentRetries ?? this.defaultAgentRetries),
      drainTimeoutMs: exec.drainTimeoutMs !== undefined ? exec.drainTimeoutMs : persisted.drainTimeoutMs,
      // failOnExhaustedAgent is a SAFETY knob and stays frozen at run start —
      // unlike the other knobs there is DELIBERATELY no exec override path:
      // a run that started strict stays strict, so a recovery resume can never
      // silently downgrade failure semantics (see the "resume cannot downgrade"
      // test). The workflow tool therefore does not forward it on resume.
      failOnExhaustedAgent: persisted.failOnExhaustedAgent,
      // Fresh per-resume: agents (and any prior timing) are rebuilt live as
      // onAgentStart/onAgentEnd fire again for this attempt (see `agents: []`
      // above); the journal, not this map, is what makes replayed agents cheap.
      // REPLAYED (cache-hit) agents keep their ORIGINAL persisted timestamps
      // via seededAgentTimestamps (L4) — never fabricated resume-time ones.
      agentTimestamps: new Map(),
      agentsById: new Map(),
      trimmedAgentDetailUpTo: 0,
      seededAgentTimestamps,
      retryLedger: seededRetryLedger,
    };
    this.runs.set(runId, managed);
    // Persist before notifying renderers: listRuns() is their source of truth for
    // lifecycle status, while getRun() supplies the live in-memory snapshot.
    this.persistRun(managed);

    // Namespace by (runId, index) exactly like the live onAgentJournal dedup
    // and like SharedStore's deltaKey — see JournalEntry.runId and
    // buildResumeJournal in run-persistence.ts. A legacy entry persisted
    // before namespacing existed has no `runId`; it is assumed to belong to
    // this run's own top-level runId (the only frame that existed before
    // nested workflow() journaling was namespaced), so it still resume-hits
    // for a top-level call and safely cache-misses (re-runs live, does not
    // misapply) for what was actually a nested-run entry.
    const resumeJournal = buildResumeJournal(runId, persistedJournal);
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    // initialTokenUsage seeds the resumed execution's fresh SharedRuntime.spent
    // (A2) from the persisted total-at-pause, so the tokenBudget cap holds
    // cumulatively instead of resetting to zero. Note: shared.agentCount is
    // deliberately NOT seeded the same way — it doesn't need to be. Unlike
    // token spend (whose cache-hit replay branch skips recordTokens() to avoid
    // double-counting already-spent tokens), agent()'s shared.agentCount++
    // fires unconditionally for EVERY call, cache-hit or live, before the
    // replay check runs (see workflow.ts). Because resume() always replays the
    // whole script from callIndex 0, that replay alone reconstructs the
    // correct cumulative count inside this fresh SharedRuntime by the time any
    // new live agent runs — so maxAgents (via A1) is already a genuine
    // cumulative cap across resume with no extra seeding required.
    // ExecOptions passthrough: `...exec` is spread FIRST so the manager's own
    // resumeJournal/initialTokenUsage (computed above) always win over any
    // caller-supplied values.
    void this.executeRun(managed, script, args, { ...exec, resumeJournal, initialTokenUsage: priorTokenUsage }).catch(
      () => {},
    );
    return true;
  }

  /**
   * Stop a running workflow.
   *
   * Fast path: the run is live in this process (`this.runs`) — abort its
   * controller and persist "aborted" as before. Fallback: the run is not in
   * memory but is persisted as "running" or "paused" — e.g. it belongs to a
   * prior pi session that this process's recoverStaleRuns() flipped to
   * "paused" on disk without repopulating this.runs (see workflow-control-tool's
   * findRun(), which resolves candidates from disk via listRuns()). There is no
   * live controller to abort in that case — the run simply isn't executing in
   * this process — so mark it aborted on disk directly, mirroring resume()'s
   * persisted-fallback lease handling.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      if (managed.status !== "running" && managed.status !== "paused") return false;
      // Whether this run's OWN executeRun() promise has already fully settled
      // matters for whether stop() itself must be the one to call
      // recordTerminalRun(): a usage-limit checkpoint runs executeRun()'s
      // catch tail to completion before "paused" is ever observable (it
      // deliberately skipped recordTerminalRun() then, since "paused" isn't
      // terminal) — so there is no FUTURE tail left that will ever call it
      // for this managed object. A manual pause() sets "paused" while its
      // cooperative abort may still be settling; in that narrow window the
      // tail later settles this object to "aborted" (terminal) and records a
      // SECOND time — a tolerated duplicate: recordTerminalRun() is
      // idempotent-safe under duplicates (re-validates the current entry),
      // the lease was already cleared here, and the worst case is the
      // stopped run leaving memory earlier than FIFO order (persistence
      // fallback covers every consumer). A "running" run, by contrast,
      // always still has that tail pending;
      // it (not stop()) is what calls recordTerminalRun() once it actually
      // settles to "aborted" — see the `runs` field doc comment's rule that
      // eviction eligibility must wait for the real settle, not a request to
      // abort. Without this, stopping an already-paused run left it in
      // `runs` forever (no future tail to mark it eviction-eligible) — a
      // small leak in exactly the class this manager otherwise bounds.
      const hadNoPendingSettle = managed.status === "paused";
      managed.controller.abort();
      this.armSettleWatchdog(managed);
      if (managed.status === "running") {
        this.settleExecuting(managed, "aborted");
      } else {
        // Already idle (paused): just flip the resting status — the lease is
        // already released, and an idle→idle status write is legal on the
        // IdleRun member.
        managed.status = "aborted";
      }
      this.emit("stopped", { runId });
      this.persistRun(managed);
      if (hadNoPendingSettle) this.recordTerminalRun(runId);
      return true;
    }

    const persisted = this.persistence.load(runId);
    if (!persisted || (persisted.status !== "running" && persisted.status !== "paused")) return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      // F02 (stop TOCTOU): the pre-lease load above was advisory only — a
      // concurrent process may have completed/aborted this run between that
      // read and the lease acquisition. Re-load UNDER the lease and
      // re-validate before marking it aborted (mirrors resume()'s M23
      // pattern), so a completed run can never be flipped back to "aborted"
      // by a stale stop() using the pre-lease snapshot.
      const fresh = this.persistence.load(runId);
      if (!fresh || (fresh.status !== "running" && fresh.status !== "paused")) return false;
      this.persistence.save({ ...fresh, status: "aborted", updatedAt: new Date().toISOString() });
    } finally {
      this.persistence.releaseRunLease(lease);
    }
    this.emit("stopped", { runId });
    return true;
  }

  /**
   * Terminate ONE subagent of a run (workflow_damage_control kill-agent).
   *
   * Resolution: `agentId` matches a live-snapshot agents[].id/callId first
   * (the in-process snapshot is authoritative for live runs and is populated
   * at attempt start, whereas the PERSISTED agents[] may not be written yet —
   * nothing has completed in a fresh run), then the persisted inventory
   * (`${runId}:${callIndex}`, the same deltaKey the journal/SharedStore use)
   * for cross-process runs. Live runs in THIS process get a live abort when
   * the run carries the agentKills channel (executeRun): the call id is
   * committed to killedCallIds FIRST (so the attempt-loop kill gates report
   * AGENT_KILLED and never retry), then the attempt's AbortController is
   * aborted when one is registered. State reconciliation always lands via CAS
   * (updateRunState?) using the pure reconcileAgentAfterKill flip
   * (status→error, error→"killed via workflow_damage_control",
   * errorCode→AGENT_KILLED, recoverable→false); when the persisted inventory
   * has not been written yet, the live snapshot entry is adopted into it so
   * the kill mark survives the run's next write cycle. Cross-process runs get
   * persisted-only reconciliation (liveAborted:false) — the owning process
   * sees the mark on its next write.
   */
  async killAgent(runId: string, agentId: string): Promise<KillAgentResult> {
    const persisted = this.persistence.load(runId);
    if (!persisted) {
      return {
        ok: false,
        reason: "run not found",
        runId,
        agentId,
        found: false,
        liveAborted: false,
        reconciled: false,
        snapshotUpdated: false,
      };
    }
    const managed = this.runs.get(runId);
    const matches = (candidate: { id: number; callId?: string }) =>
      String(candidate.id) === agentId || (candidate.callId ?? journalEntryKey(runId, candidate.id)) === agentId;
    // Live snapshot first (authoritative, populated at attempt start), then
    // the persisted inventory (a run whose agents[] was never written — no
    // agent completed yet — only resolves via the live snapshot).
    const liveAgent = managed?.snapshot.agents.find(matches);
    const agent = liveAgent ?? persisted.agents.find(matches);
    if (!agent) {
      return {
        ok: false,
        reason: "agent not found",
        runId,
        agentId,
        found: false,
        liveAborted: false,
        reconciled: false,
        snapshotUpdated: false,
      };
    }
    const callId = agent.callId ?? journalEntryKey(runId, agent.id);

    // Live abort: commit the kill BEFORE aborting so the attempt's catch sees
    // the kill gate and reports AGENT_KILLED instead of a generic abort.
    let liveAborted = false;
    const channel = managed?.agentKills;
    if (channel) {
      channel.killedCallIds.add(callId);
      const controller = channel.killControllers.get(callId);
      if (controller) {
        controller.abort();
        liveAborted = true;
      }
    }

    // State reconciliation (always, via CAS when the persistence provides it).
    let outcome = { found: false, alreadyTerminal: false, changed: false };
    let reconciled = false;
    const adoptLiveAgent = (state: PersistedRunState) => {
      if (!liveAgent) return;
      const known = state.agents.some((candidate) => candidate.id === liveAgent.id);
      if (!known) {
        // The persisted inventory has not been written yet — carry the live
        // entry so the AGENT_KILLED mark survives the run's next write cycle.
        state.agents.push({
          id: liveAgent.id,
          callId: liveAgent.callId ?? journalEntryKey(runId, liveAgent.id),
          label: liveAgent.label,
          phase: liveAgent.phase,
          prompt: liveAgent.prompt,
          status: liveAgent.status,
          tokens: liveAgent.tokens,
          model: liveAgent.model,
        });
      }
    };
    const cas = this.persistence.updateRunState;
    if (cas) {
      const updated = cas(runId, (state) => {
        adoptLiveAgent(state);
        outcome = reconcileAgentAfterKill(state, agentId);
      });
      reconciled = updated !== null;
    } else {
      const current = this.persistence.load(runId);
      if (current) {
        adoptLiveAgent(current);
        outcome = reconcileAgentAfterKill(current, agentId);
        this.persistence.save(current);
        reconciled = true;
      }
    }

    // Live snapshot: mark the matching in-memory agent the same way so the
    // task panel / status verb reflect the kill immediately.
    let snapshotUpdated = false;
    if (managed) {
      const snap = managed.snapshot.agents.find(
        (candidate) =>
          (candidate.callId ?? journalEntryKey(runId, candidate.id)) === callId || String(candidate.id) === agentId,
      );
      if (snap && snap.status !== "error" && snap.status !== "done" && snap.status !== "skipped") {
        snap.status = "error";
        snap.error = "killed via workflow_damage_control";
        snap.errorCode = WorkflowErrorCode.AGENT_KILLED;
        snap.recoverable = false;
        const timestamps = managed.agentTimestamps.get(snap.id);
        if (timestamps) timestamps.endedAt = timestamps.endedAt ?? new Date().toISOString();
        snapshotUpdated = true;
      }
    }

    this.emit("agentKilled", { runId, agentId, callId, liveAborted });
    return {
      ok: outcome.found,
      runId,
      agentId,
      callId,
      found: outcome.found,
      alreadyTerminal: outcome.alreadyTerminal,
      liveAborted,
      reconciled: reconciled && outcome.found,
      snapshotUpdated,
    };
  }

  /** The project cwd this manager was constructed with (damage-control clean repo resolution). */
  getProjectCwd(): string {
    return this.cwd;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   *
   * If `runId` is still live in this process (running or paused-in-memory),
   * abort its controller FIRST, before any teardown below — a live run left
   * un-aborted would otherwise keep executing in the background indefinitely
   * (burning API calls/tokens/holding a worktree) after its record is gone.
   * Aborting first, while `managed` is still `this.runs.get(runId)`, costs
   * nothing extra: the abort signal is fire-and-forget (cooperative — the
   * execution winds down on its own schedule), so the exact instant we flip
   * `this.runs`/release the lease/delete files relative to it doesn't matter
   * for correctness. What DOES matter is that once this method returns, the
   * aborted execution's eventual settle (executeRun's success/catch path,
   * asynchronously, possibly much later) must be a harmless no-op rather than
   * a resurrection — that's what isCurrent() guarantees: `this.runs.delete()`
   * below means executeRun's later persistRun()/settleExecuting() calls on
   * this same `managed` object find `this.runs.get(runId) !== managed` (in
   * fact `undefined`, since the entry is gone) and skip writing/releasing.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      if (!managed.controller.signal.aborted) managed.controller.abort();
      // A live execution holds the run's lease; release it before the entry is
      // discarded. No settle transition is needed — the object leaves `runs`
      // entirely, so isCurrent() makes its eventual settle a no-op (and the
      // lease is already gone for idle runs).
      if (managed.status === "running") this.releaseHeldLease(managed);
    }
    this.runs.delete(runId);
    // Cancel any pending throttled write so a deferred persist can't fire after
    // deletion and resurrect the run's file on disk.
    const timer = this.persistTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(runId);
    }
    return this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
