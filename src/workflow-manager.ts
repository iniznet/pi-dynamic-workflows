/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import { preview, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { isProviderUsageLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { compactJournal, verifyJournalCompaction } from "./journal-compaction.js";
import {
  buildResumeJournal,
  createRunPersistence,
  generateRunId,
  journalEntryKey,
  keepsResumeJournal,
  loadPersistedJournal,
  type PersistedRunState,
  type RunCheckpoint,
  type RunLease,
  type RunLeaseState,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import { type JournalEntry, parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

export interface ManagedRunBase {
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
   * OPT-IN resume-journal compaction (default OFF), frozen at run start like
   * tokenBudget and carried through resume() so a resumed run keeps
   * compacting if it started with the flag. When true, writeRunToDisk folds
   * the journal's resolved segments into a compact summary and persists it
   * only when reconstruction QA reproduces the original byte-identically
   * (failed-QA summaries are discarded; the original journal is kept).
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
   * Replay these journaled agent/checkpoint results for the unchanged prefix
   * (resume), keyed by `${runId}:${index}` — see
   * WorkflowRunOptions.resumeJournal in workflow.ts.
   */
  resumeJournal?: Map<string, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
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
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
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
   * Called lazily per execution (including on resume). An unknown tag resolves
   * to the default coding tools.
   */
  toolsets?: Record<string, () => ToolDefinition[]>;
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
   * How long an aborted execution may take to settle before the settle
   * watchdog force-releases its run from the in-memory registry (see
   * armSettleWatchdog / forceReleaseUnsettledRun). Generous default: a
   * cooperative abort (pause/stop/Esc) winds down in seconds, so the deadline
   * only fires for genuinely hung executions that would otherwise pin their
   * run in `runs` forever. Exposed for tests (core-orchestration:i5).
   */
  settleWatchdogMs?: number;
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
 * Build the journalIndex side-index from a journal array (resume() seed time).
 * Iterating with set() keeps the LAST entry per key, matching buildResumeJournal's
 * Map semantics and the persistence layer's dedup: duplicates in a legacy
 * persisted journal collapse to the newest.
 */
function buildJournalSideIndex(journal: JournalEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < journal.length; i++) index.set(journalSideKey(journal[i]), i);
  return index;
}

export class WorkflowManager extends EventEmitter {
  /**
   * Lifecycle contract for `runs`:
   *
   *  - An entry is added when a run starts (startInBackground/runSync) or is
   *    resumed (resume()), always with a live AbortController and (usually)
   *    an active RunLease.
   *  - While status is "running" or "paused", the entry is NEVER evicted —
   *    its execution could still settle (a pending executeRun() promise) or
   *    it is mid-usage-limit-checkpoint/manually-paused and still considered
   *    "the current state of this run" by callers. Eviction only ever
   *    considers an entry AFTER executeRun() has fully settled it to
   *    "completed" | "failed" | "aborted" (see IN_MEMORY_TERMINAL_STATUSES)
   *    and persisted + released its lease — i.e. strictly after the same
   *    isCurrent()-gated persistRun() + settleExecuting() lease-release in
   *    executeRun()'s success/catch tails.
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
  /** How long an aborted execution may take to settle (see armSettleWatchdog). */
  private settleWatchdogMs: number;
  /** Pending settle watchdogs keyed by runId — see armSettleWatchdog. */
  private settleWatchdogs = new Map<string, { timer: ReturnType<typeof setTimeout>; managed: ManagedRun }>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The host Pi session's model registry, shared with subagents. */
  private modelRegistry?: ModelRegistry;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;
  private defaultTokenBudget: number | null;
  private toolsets?: Record<string, () => ToolDefinition[]>;
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
    this.excludeSubagentTools = options.excludeSubagentTools;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.maxTerminalRunsInMemory = options.maxTerminalRunsInMemory ?? DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY;
    this.settleWatchdogMs = options.settleWatchdogMs ?? DEFAULT_SETTLE_WATCHDOG_MS;
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
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
      compactJournal: exec.compactJournal === true,
      // Resolve the budget once at start and freeze it on the run (see
      // ManagedRun.tokenBudget) so resume keeps start-time semantics.
      tokenBudget: exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget,
      toolset: exec.toolset,
      // Same freeze-at-start pattern as tokenBudget, for the same reason: a
      // resumed run must keep these values, not re-resolve against the
      // manager's current defaults (see ManagedRun doc comments).
      maxAgents: exec.maxAgents,
      agentTimeoutMs: exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs,
      concurrency: exec.concurrency !== undefined ? exec.concurrency : this.concurrency,
      agentRetries: exec.agentRetries !== undefined ? exec.agentRetries : this.defaultAgentRetries,
      agentTimestamps: new Map(),
      agentsById: new Map(),
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
        updatedAt: managed.startedAt.toISOString(),
        autoResume: managed.autoResume,
        // Persisted only when opted in so a default run's file is byte-identical
        // to the pre-compaction shape (undefined keys are dropped by JSON).
        compactJournal: managed.compactJournal === true ? true : undefined,
        tokenBudget: managed.tokenBudget,
        toolset: managed.toolset,
        maxAgents: managed.maxAgents,
        agentTimeoutMs: managed.agentTimeoutMs,
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
    executing.compactJournal = exec.compactJournal === true;
    executing.tokenBudget = exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget;
    executing.toolset = exec.toolset;
    // Same freeze-at-start pattern as tokenBudget (see startInBackground/ManagedRun).
    executing.maxAgents = exec.maxAgents;
    executing.agentTimeoutMs = exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs;
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
      externalSignal,
      onProgress,
      tokenBudget,
      concurrency,
      agentRetries,
      confirm,
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
    // The budget was resolved (per-run value, else defaultTokenBudget) and frozen
    // on the managed run at start/resume — read it from there so a resumed run
    // keeps the budget it started with. exec.tokenBudget is a safety net for
    // direct executeRun callers that skipped the start paths.
    const resolvedTokenBudget = managed.tokenBudget !== undefined ? managed.tokenBudget : (tokenBudget ?? null);
    // Explicit tools win for this execution; else re-resolve the run's persisted
    // toolset tag (how a resumed /deep-research keeps its web tools); else the
    // agent layer's default coding tools.
    const resolvedTools = tools ?? (managed.toolset ? this.toolsets?.[managed.toolset]?.() : undefined);
    // Gated the same way as this.emitLive() below (see isCurrent()) — a stale
    // execution's progress callback would otherwise keep driving live UI
    // (task panel, etc.) for a run that's been superseded or deleted.
    const progress = () => {
      if (this.isCurrent(managed)) onProgress?.(managed.snapshot);
    };
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) {
        managed.controller.abort();
        this.armSettleWatchdog(managed);
      } else {
        externalSignal.addEventListener(
          "abort",
          () => {
            managed.controller.abort();
            this.armSettleWatchdog(managed);
          },
          { once: true },
        );
      }
    }
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args,
        // Use the managed run's persisted id as the workflow runId so the value
        // returned in result.runId matches the id that listRuns()/resume() use.
        // Otherwise runWorkflow mints an ephemeral `run-<ts>` id and the sync
        // path would surface a non-resumable id to the model.
        runId: managed.runId,
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        persistAgentSessions: this.persistAgentSessions,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents: resolvedMaxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        tokenBudget: resolvedTokenBudget,
        tools: resolvedTools,
        excludeTools: this.excludeSubagentTools,
        confirm,
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
        onRetrySpend: (tokens) => {
          this.accumulateTokenUsage(managed, tokens);
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
          managed.snapshot.logs.push(message);
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
          // Index by the call's unique id (never label — see agentsById's doc
          // comment) so onAgentEnd/onAgentHistory can resolve back to exactly
          // THIS entry even when a concurrent sibling shares its label.
          managed.agentsById.set(event.id, agentSnapshot);
          // Real per-agent start time, captured the moment the agent actually
          // starts (not the run's startedAt) — see agentTimestamps.
          managed.agentTimestamps.set(id, { startedAt: new Date().toISOString() });
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
            // Real per-agent end time — only terminal agents get one; a still-
            // running agent's entry keeps endedAt undefined.
            const ts = managed.agentTimestamps.get(agent.id);
            if (ts) ts.endedAt = new Date().toISOString();
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
      } else if (usageLimitPaused) {
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        this.settleExecuting(managed, "paused");
      } else {
        this.settleExecuting(managed, "failed");
      }
      managed.error = workflowError;
      // Both branches gated via emitLive() (see its doc comment) — a stale
      // execution's "paused"/"error" is equally misleading once superseded.
      if (usageLimitPaused) {
        this.emitLive(managed, "paused", {
          runId: managed.runId,
          reason: "usage_limit",
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
    if (this.isCurrent(managed)) this.emit(event, payload);
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
    usage.total += tokens;
    if (tokenUsage) {
      usage.input += tokenUsage.input;
      usage.output += tokenUsage.output;
      usage.cost += tokenUsage.cost;
      usage.cacheRead += tokenUsage.cacheRead;
      usage.cacheWrite += tokenUsage.cacheWrite;
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
      this.writeRunToDisk(managed);
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
    this.writeRunToDisk(managed);
  }

  private writeRunToDisk(managed: ManagedRun) {
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
      // P2-5 opt-in compaction (ExecOptions.compactJournal): fold the journal's
      // resolved segments into a compact summary and persist it ONLY when the
      // reconstruction-QA gate reproduces the original journal byte-identically
      // (verifyJournalCompaction) — a failed-QA summary is discarded and the
      // original journal is kept; a compacted form is never persisted without
      // passing the gate. A summary that does not actually shrink the journal
      // (nothing foldable / everything verbatim) is also skipped — persisting a
      // larger "compaction" buys nothing. The positional deltaKey scheme
      // (`${runId}:${callIndex}`) is untouched in both forms.
      let journal: PersistedRunState["journal"];
      let journalCompacted: PersistedRunState["journalCompacted"];
      if (keepJournal && managed.compactJournal === true) {
        const summary = compactJournal(managed.journal);
        const qa = verifyJournalCompaction(summary, managed.journal);
        if (qa.ok && JSON.stringify(summary).length <= JSON.stringify(managed.journal).length) {
          journalCompacted = summary;
        } else {
          if (!qa.ok) {
            console.warn(
              `[workflow-manager] journal compaction QA rejected for run ${managed.runId} (${qa.reason}) — keeping the original journal`,
            );
          }
          journal = managed.journal;
        }
      } else {
        journal = keepJournal ? managed.journal : undefined;
      }
      this.persistence.save({
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
        // Persisted every write (not just at pause) so a stale read during the
        // "paused" event race (see UsageLimitScheduler) is still correct — this
        // is fixed at run-start and doesn't change over the run's lifetime.
        autoResume: managed.autoResume,
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
        concurrency: managed.concurrency,
        agentRetries: managed.agentRetries,
        // Why a usage-limit pause happened, so the navigator / a future cold start
        // can show it and (eventually) re-arm resume after the budget refills.
        pauseReason: managed.status === "paused" && isProviderUsageLimit(managed.error) ? "usage_limit" : undefined,
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
        startedAt: managed.startedAt.toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
        durationMs: managed.result?.durationMs,
      });
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
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
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;

    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;

    // Use the edited script when supplied, else the persisted one (backward-compat).
    const { script: editedScript, args: overrideArgs, ...exec } = opts ?? {};
    const script = editedScript ?? persisted.script;
    const args = overrideArgs !== undefined ? overrideArgs : persisted.args;

    // Normalize the persisted total-at-pause once: PersistedRunState.tokenUsage
    // has optional cost/cacheRead/cacheWrite (legacy runs may lack them), but
    // both the seeded snapshot and initialTokenUsage need concrete numbers.
    const priorTokenUsage = persisted.tokenUsage
      ? {
          input: persisted.tokenUsage.input,
          output: persisted.tokenUsage.output,
          total: persisted.tokenUsage.total,
          cost: persisted.tokenUsage.cost ?? 0,
          cacheRead: persisted.tokenUsage.cacheRead ?? 0,
          cacheWrite: persisted.tokenUsage.cacheWrite ?? 0,
        }
      : undefined;

    // The run's resume journal in normalized (de-compacted) form, computed
    // ONCE and reused for the in-memory seed, the upsert side-index, and the
    // resume-replay map below (see loadPersistedJournal).
    const persistedJournal = loadPersistedJournal(persisted);

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
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
      // re-resolves so e.g. a resumed /deep-research keeps its web tools.
      tokenBudget: persisted.tokenBudget !== undefined ? persisted.tokenBudget : null,
      toolset: persisted.toolset,
      // Restore the same start-time execution context for the other four
      // per-run knobs (see ManagedRun doc comments) — same rationale as
      // tokenBudget: never re-resolve against the manager's CURRENT defaults.
      // maxAgents: legacy/never-set runs resume with no cap carried forward
      // (runWorkflow's own MAX_AGENTS_PER_RUN default applies), exactly as if
      // maxAgents had never been passed at all.
      maxAgents: persisted.maxAgents,
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
      agentTimeoutMs: persisted.agentTimeoutMs !== undefined ? persisted.agentTimeoutMs : this.defaultAgentTimeoutMs,
      // concurrency/agentRetries have no "explicit opt-out sentinel" the way
      // tokenBudget's null does — a legacy run without a persisted value falls
      // back to the manager's current values, matching how this execution
      // resolved unset concurrency/agentRetries before this fix ever existed.
      concurrency: persisted.concurrency !== undefined ? persisted.concurrency : this.concurrency,
      agentRetries: persisted.agentRetries !== undefined ? persisted.agentRetries : this.defaultAgentRetries,
      // Fresh per-resume: agents (and any prior timing) are rebuilt live as
      // onAgentStart/onAgentEnd fire again for this attempt (see `agents: []`
      // above); the journal, not this map, is what makes replayed agents cheap.
      agentTimestamps: new Map(),
      agentsById: new Map(),
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
      this.persistence.save({ ...persisted, status: "aborted", updatedAt: new Date().toISOString() });
    } finally {
      this.persistence.releaseRunLease(lease);
    }
    this.emit("stopped", { runId });
    return true;
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
