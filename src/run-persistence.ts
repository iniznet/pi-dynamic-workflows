/**
 * Workflow run state persistence for pause/resume support.
 */

import { join } from "node:path";
import type { AgentUsage, OperationTrace } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import {
  ensureDir as ensureDirFs,
  listJsonFilesSafe,
  type PersistenceFsLayer,
  RENAME_RETRY_ATTEMPTS,
  RENAME_RETRY_DELAY_MS,
  readJsonWithBackupRecovery,
  resolvePersistenceFs,
  unlinkIfExistsSafe,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";
import { type CompactJournalSummary, reconstructJournal } from "./journal-compaction.js";
import type { JournalEntry } from "./workflow.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  status: "running" | "done" | "error" | "skipped";
  result?: unknown;
  /** Compact result written by releases before full agent results were retained. */
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
  tokens?: number;
  /** Per-agent token usage breakdown, when the provider reported one. */
  tokenUsage?: AgentUsage;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /**
   * The failing tool call (Fabric-style line-numbered failure repair), when
   * this agent failed after making tool calls. Absent on successes and on
   * runs that never observed a tool call.
   */
  failingOperation?: OperationTrace;
}

export interface PersistedRunState {
  /**
   * On-disk schema version of this state (see RUN_STATE_SCHEMA_VERSION /
   * migrateRunState). Absent on legacy files written before versioning
   * existed; load() treats those as version 0 and migrates them.
   */
  schemaVersion?: number;
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  status: RunStatus;
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  /**
   * Cumulative wall-clock start (epoch ms) of the run's FIRST start, carried
   * across every persist so a resume keeps the original stamp (display-core's
   * WorkflowSnapshot.startedAtMs mapping). Absent on legacy runs.
   */
  startedAtMs?: number;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /**
   * F03: per-call ledger of RETRIED-attempt spend, keyed by the call's
   * deltaKey (`${runId}:${callIndex}` — the same key the journal's
   * resume-replay map uses). Every entry was ALSO folded into tokenUsage
   * (via onRetrySpend → accumulateTokenUsage), so this is pure bookkeeping:
   * it lets resume() refund the retry-spend of calls that will be RE-RUN
   * live (an interrupted call has a ledger entry but no journal entry),
   * keeping a failed attempt charged exactly once across a pause/resume
   * boundary instead of twice (see WorkflowManager.resume). Absent on runs
   * that never retried (JSON-dropped like compactJournal).
   */
  retryLedger?: Record<string, AgentUsage>;
  /**
   * Cached agent/checkpoint results for resume, keyed by deterministic call
   * index. `runId` namespaces `index` (a nested workflow() call restarts its
   * own callSeq at 0) — absent on journals persisted before that namespacing
   * existed; see JournalEntry.runId in workflow.ts for the resume-time
   * legacy-degradation behavior. `storeDelta` is this call's SharedStore
   * write delta, replayed additively on resume.
   */
  journal?: Array<{
    index: number;
    runId?: string;
    hash: string;
    result: unknown;
    storeDelta?: Record<string, unknown>;
    /**
     * Monotonic per-store commit ordinal captured when this call's store delta
     * was committed in the ORIGINAL run (see SharedStore.commitDeltaOrdered):
     * the delta's position in the run's real completion order. Resume replay
     * applies replayed deltas sorted by this ordinal instead of in callSeq
     * order, so parallel same-key writers reconstruct the same final store the
     * live run ended with. Absent on journals persisted before this field
     * existed — those replay in callSeq order (the pre-fix behavior, kept for
     * resume integrity). JSON-dropped when undefined.
     */
    storeCommitSeq?: number;
    /**
     * Typed operation traces for this call (one entry per tool call, pinned to
     * the owning agent() call's script line). Absent on legacy journals — the
     * resume path treats a missing field exactly like a missing storeDelta:
     * it replays the result and skips the optional payload.
     */
    operations?: OperationTrace[];
  }>;
  /**
   * The run's resume journal in COMPACTED form (see CompactJournalSummary in
   * journal-compaction.ts): written INSTEAD of `journal` when the run opted
   * into compaction (ExecOptions.compactJournal) AND the reconstruction-QA
   * gate (verifyJournalCompaction) reproduced the original journal
   * byte-identically. Never both: a compacted write omits `journal`; the
   * default (opt-out) write omits this field and persists `journal` exactly
   * as before this field existed. Load-side normalization is
   * loadPersistedJournal() — reconstructs this form, else falls back to the
   * plain array (legacy and default runs unchanged).
   */
  journalCompacted?: CompactJournalSummary;
  /**
   * Human-approval checkpoints for this run (see saveCheckpoint). Kept in
   * their own array, deliberately NOT in `journal`: the resume path replays
   * journal entries as call hashes, so a checkpoint written there could fake
   * a cache hit for a changed checkpoint (P0-4). Absent on legacy runs whose
   * checkpoints were written into the journal before this split; loadRunState
   * falls back to checkpoint-shaped journal entries for those.
   */
  checkpoints?: RunCheckpoint[];
  /**
   * Opt-out of auto-resume for this run (default true, i.e. eligible unless
   * explicitly set to false via ExecOptions.autoResume). Set once at run start
   * and carried through resumes; see UsageLimitScheduler.
   */
  autoResume?: boolean;
  /**
   * Frozen at run start (like autoResume): whether agent failures settle this
   * run failed+resumable instead of completing with silent nulls. Undefined =
   * lenient (never set by the caller); the workflow TOOL persists true by
   * default. Carried through resume() so a resumed run keeps the strictness it
   * started with.
   */
  failOnExhaustedAgent?: boolean;
  /**
   * The run's opt-in resume-journal compaction flag (see
   * ExecOptions.compactJournal), frozen at run start and persisted so a
   * resumed run keeps compacting if it started with the flag. Absent/undefined
   * on legacy and default runs (never compacted).
   */
  compactJournal?: boolean;
  /**
   * The run's resolved hard token budget, fixed at start (per-run value, else
   * the manager default at the time). Resume re-applies THIS value — never the
   * current default — so an explicit no-budget (`null`) or custom cap survives
   * a pause/resume cycle. Absent on legacy runs (resumed unbudgeted).
   */
  tokenBudget?: number | null;
  /**
   * Named toolset tag (WorkflowManagerOptions.toolsets). ToolDefinitions are
   * functions and can't be serialized, so this tag is how a resumed run (e.g.
   * /deep-research with web tools) re-resolves the tool set it started with.
   */
  toolset?: string;
  /**
   * The run's resolved cap on total agents, fixed at start (per-run value,
   * else undefined so runWorkflow applies its own MAX_AGENTS_PER_RUN default).
   * Resume re-applies THIS value — never the manager's current default — same
   * rationale as tokenBudget. Absent on legacy runs (resumed with no cap
   * carried forward, i.e. runWorkflow's own default applies).
   */
  maxAgents?: number;
  /**
   * The run's resolved per-agent timeout, fixed at start (per-run value, else
   * the manager default at the time). Absent on legacy runs — unlike
   * tokenBudget, a legacy run's real timeout was never "no timeout" by
   * omission; it was always the manager's default (pre-A1 resume always fell
   * back to it), so resume applies the manager's CURRENT default for such
   * runs rather than null, preserving both the run's original semantics and
   * pre-fix resume behavior.
   */
  agentTimeoutMs?: number | null;
  /**
   * The run's resolved drain-side grace period in milliseconds (H1), fixed at
   * start/resume so a resumed run keeps the same completion deadline it
   * started with. Absent = runWorkflow's DRAIN_ABORT_TIMEOUT_MS default.
   */
  drainTimeoutMs?: number;
  /**
   * The run's resolved concurrency, fixed at start (per-run value, else the
   * manager's concurrency at the time). Same rationale as tokenBudget.
   */
  concurrency?: number;
  /**
   * The run's resolved agent-retry count, fixed at start (per-run value, else
   * the manager default at the time). Same rationale as tokenBudget.
   */
  agentRetries?: number;
  /**
   * Auto-resume attempt counter for the current usage_limit pause-cycle, owned
   * and persisted by UsageLimitScheduler (best-effort). Absent/0 means no
   * auto-resume attempt has been recorded yet.
   */
  autoResumeAttempts?: number;
}

export interface RunPersistenceSaveOptions {
  /**
   * Throttled progress write (E4): persist ONLY the run's journal delta to
   * the append-only `.jdelta` sidecar instead of re-serializing the full run
   * state (O(n^2) as the journal grows). The primary file is written at the
   * next boundary (pause/checkpoint/failed/complete) or periodic full
   * checkpoint. Only valid for resumable statuses; ignored otherwise.
   */
  fastPath?: boolean;
  /**
   * Skip the journal byte-budget enforcement (capJournalBudget — a full-journal
   * stringify plus binary-search truncation) for this write. Throttled progress
   * writes (fastPath) pass false so the hot path stays stringify-free; the
   * count gate (JOURNAL_BYTE_CHECK_THRESHOLD) and the binary-search truncation
   * still run on every lifecycle/terminal write (the default).
   */
  checkBudget?: boolean;
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState, opts?: RunPersistenceSaveOptions): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run, or when the lock exists but is CORRUPT (its
   * ownership cannot be verified — never silently re-acquire a runId whose
   * lease we cannot prove stale; core-01). Genuinely stale lock files (dead
   * pid / expired / age-stale) are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /**
   * Compare-and-swap primitive: apply `mutate` to the freshest on-disk
   * snapshot and persist atomically, retrying on concurrent modification.
   * Returns the persisted state, or null when the run does not exist.
   * Optional so existing mock implementations keep typechecking — use the
   * standalone updateRunState() when an instance may not provide it.
   */
  updateRunState?(runId: string, mutate: (state: PersistedRunState) => void): PersistedRunState | null;
  /**
   * Lease heartbeat: push the owner's lease expiry forward (see
   * DEFAULT_RUN_LEASE_TTL_MS). Returns false when this process no longer owns
   * the lease. Optional so existing mock implementations keep typechecking —
   * use the standalone renewRunLease() when an instance may not provide it.
   */
  renewRunLease?(lease: RunLease): boolean;
  /**
   * Read a run's current lease WITHOUT acquiring it — the read-only view
   * damage-control `clean`/`recover` use to classify a run's ownership
   * (reclaimable vs owned-elsewhere) and to report stale-lease candidates.
   * Returns null when the run holds no lease at all. Optional so existing mock
   * implementations keep typechecking — mirroring updateRunState?/renewRunLease?.
   */
  getLeaseInfo?(runId: string): RunLeaseInfo | null;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

/**
 * Read-only snapshot of a run's lease state (see getLeaseInfo?). Derived from
 * the lock file without mutating it: pid liveness + TTL expiry + age-based
 * staleness compose into `reclaimable`, the same predicate acquireRunLease
 * uses to decide whether a stale lock may be replaced.
 */
export interface RunLeaseInfo {
  runId: string;
  pid: number;
  startedAt: string;
  expiresAt?: string;
  /** Whether the lease owner's pid is currently alive on this host. */
  alive: boolean;
  /** Whether the lease's TTL expiry has passed (bounded-delay reclaim). */
  expired: boolean;
  /** Whether the lease is older than MAX_RUN_LEASE_AGE_MS (L2 staleness). */
  staleByAge: boolean;
  /** !alive || expired || staleByAge — the exact predicate acquireRunLease uses. */
  reclaimable: boolean;
}

/**
 * A run's lease state — the "lease ⟺ executing" invariant, machine-checked.
 * A run is either EXECUTING (status "running" + holding its exclusive
 * cross-process lease) or IDLE (any other status, lease released). The two
 * halves are one discriminated union, so the compiler refuses to express an
 * executing run without its lease or an idle run holding one — see
 * WorkflowManager's `ManagedRun` (workflow-manager.ts), which composes this
 * type. The only lease transitions are the acquire/release primitives below
 * and the manager's startExecuting()/settleExecuting() helpers.
 */
export type RunLeaseState = { status: "running"; lease: RunLease } | { status: Exclude<RunStatus, "running"> };

/**
 * Namespaced journal key for an agent() call: `${frameRunId}:${index}`. A
 * nested workflow() restarts its own callSeq at 0, so `index` alone collides
 * between a parent's and a child's same-numbered calls — the key is what
 * distinguishes them (same format as SharedStore's deltaKey and the resume
 * replay map built by buildResumeJournal).
 */
export function journalEntryKey(frameRunId: string, index: number): string {
  return `${frameRunId}:${index}`;
}

/**
 * Append one journaled agent() result, keeping the LATEST entry per
 * (runId, index) pair. Matching on index ALONE would let a nested
 * workflow()'s callIndex-0 entry evict the parent's own callIndex-0 entry
 * (and vice versa) — they're only distinguished by runId (JournalEntry.runId).
 * Returns a new array; the input is not mutated.
 */
export function upsertJournalEntry(journal: JournalEntry[], entry: JournalEntry): JournalEntry[] {
  const next = [...journal.filter((e) => !(e.index === entry.index && e.runId === entry.runId)), entry];
  // Journal growth cap: beyond MAX_JOURNAL_ENTRIES the OLDEST entries are
  // dropped (they simply re-run live on resume) so memory and disk stay bounded.
  return next.length > MAX_JOURNAL_ENTRIES ? next.slice(next.length - MAX_JOURNAL_ENTRIES) : next;
}

/**
 * Build the resume-replay map from a persisted journal. A legacy entry
 * persisted before runId-namespacing existed has no `runId`; it is assumed to
 * belong to this run's own top-level runId (the only frame that existed then),
 * so it still resume-hits for a top-level call and safely cache-misses for a
 * nested-run entry (re-runs live, never misapplies).
 */
export function buildResumeJournal(runId: string, journal: JournalEntry[] | undefined): Map<string, JournalEntry> {
  return new Map((journal ?? []).map((entry) => [journalEntryKey(entry.runId ?? runId, entry.index), entry] as const));
}

/**
 * Whether a run's status keeps its resume journal on disk. Resumable states
 * (running/paused/failed/pending) keep it so resume() can replay the
 * completed prefix; settled "completed"/"aborted" runs drop it — their full
 * agent detail lives in `agents[]` instead (see writeRunToDisk).
 */
export function keepsResumeJournal(status: RunStatus): boolean {
  return status !== "completed" && status !== "aborted";
}

/**
 * Normalize a persisted run's journal for resume: a compacted form (written
 * by the P2-5 opt-in compaction path) is reconstructed back to the original
 * entries; a plain `journal` array (default and legacy runs) is returned
 * unchanged. The reconstructed entries are what resume() seeds its in-memory
 * journal with and feeds to buildResumeJournal — the positional deltaKey
 * (`${runId}:${index}`) surface is untouched by compaction, so replay
 * behaves exactly as it would against the original journal.
 */
export function loadPersistedJournal(state: {
  journal?: JournalEntry[];
  journalCompacted?: CompactJournalSummary;
}): JournalEntry[] {
  if (state.journalCompacted) return reconstructJournal(state.journalCompacted);
  return state.journal ?? [];
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
  /**
   * ISO expiry of this lease. A lease whose expiry passed is reclaimable even
   * while its pid appears alive (pid reuse / hung owner) — the bounded-delay
   * reclaim. Absent on legacy lock files (pid-based liveness only).
   */
  expiresAt?: string;
}

/**
 * Synchronous bounded sleep for the SYNC lease layer (core-01's atomic renewal
 * retries the rename like the async writeJsonFileAtomic, but the lease path is
 * synchronous — Atomics.wait is the only non-blocking-forever sync sleep).
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 * (Alias of the shared PersistenceFsLayer — see fs-persistence.ts.)
 */
export type FsLayer = PersistenceFsLayer;

/**
 * Retention policy for terminal (completed/failed/aborted) runs kept on
 * disk. Bounded so a long-lived project directory can't accumulate an
 * unbounded number of run files (each polled/listed on every list() call).
 * A run in "running" or "paused" status is NEVER counted against this cap
 * or evicted by it — only genuinely finished runs age out, oldest (by
 * updatedAt) first, once the terminal-run count exceeds the cap. 300 is
 * generous enough to cover weeks of typical usage while keeping list()'s
 * per-call directory scan bounded.
 */
export const DEFAULT_MAX_TERMINAL_RUNS_ON_DISK = 300;

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

export interface RunPersistenceOptions {
  /** Override DEFAULT_MAX_TERMINAL_RUNS_ON_DISK (tests; advanced tuning). */
  maxTerminalRunsOnDisk?: number;
  /**
   * Override DEFAULT_JOURNAL_DELTA_CHECKPOINT_BYTES (tests; advanced tuning):
   * the sidecar byte size at which a fast-path write folds into a full
   * checkpoint instead of appending.
   */
  journalDeltaCheckpointBytes?: number;
}

/**
 * `list()` does a full readdirSync + per-file readFileSync + JSON.parse of the
 * entire lifetime run history. It is called on essentially every progress tick
 * (task-panel re-render → WorkflowManager.listRuns()/listAllRuns()), so an
 * unbounded number of ticks each re-walked and re-parsed every run file on
 * disk. Cache the computed list for a short TTL — long enough to absorb a
 * burst of same-tick reads, short enough that a read from a DIFFERENT process
 * (or a mutation this instance doesn't own) still shows up quickly. Mirrors
 * the ~1s settings-read TTL cache in task-panel.ts.
 */
const LIST_CACHE_TTL_MS = 300;

export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  options?: RunPersistenceOptions,
): RunPersistence {
  const fs = resolvePersistenceFs(fsOverride);
  const _existsSync = fs.existsSync;
  const _readFileSync = fs.readFileSync;
  const _renameSync = fs.renameSync;
  const _statSync = fs.statSync;
  const _unlinkSync = fs.unlinkSync;
  const _writeFileSync = fs.writeFileSync;
  const maxTerminalRunsOnDisk = options?.maxTerminalRunsOnDisk ?? DEFAULT_MAX_TERMINAL_RUNS_ON_DISK;
  const journalDeltaCheckpointBytes = options?.journalDeltaCheckpointBytes ?? DEFAULT_JOURNAL_DELTA_CHECKPOINT_BYTES;

  const paths = workflowProjectPaths(cwd);
  const runsDir = paths.runsDir;
  const legacyRunsDir = paths.legacyRunsDir;

  const ensureDir = () => ensureDirFs(fs, runsDir);

  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const legacyRunPath = (runId: string) => runPath(legacyRunsDir, runId);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
  const legacyLockPath = (runId: string) => lockPath(legacyRunsDir, runId);
  const candidateRunPaths = (runId: string) => [primaryRunPath(runId), legacyRunPath(runId)];

  // E4: the append-only journal-delta sidecar next to the primary run file.
  const journalDeltaPath = (runId: string) => `${primaryRunPath(runId)}${JOURNAL_DELTA_SUFFIX}`;

  // E4: per-instance memory of which journal entries are already on disk
  // (folded into the primary AND/OR appended to the sidecar), keyed by the
  // deltaKey (`${runId}:${index}`). Entry objects are stored BY REFERENCE —
  // the manager's journal array keeps the same objects between saves, and an
  // in-place replacement swaps in a new object, so reference inequality is an
  // exact, O(1) per-entry replacement detector (no deep compares on the hot
  // path). Cold-start (empty map) is self-correcting: the first fast-path
  // save sees the whole journal as delta, hits the checkpoint threshold, and
  // folds — matching the boundary write that precedes every fast write.
  const foldedByRun = new Map<string, Map<string, JournalEntry>>();

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
      return false;
    }
  };

  const readLockAt = (path: string): LockFile | null => {
    try {
      return JSON.parse(_readFileSync(path, "utf-8")) as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null => readLockAt(primaryLockPath(runId));

  // A lease is expired when it carries an expiresAt that has passed. Legacy
  // lock files (no expiresAt) are never expiry-reclaimable — pid liveness is
  // their only guard, exactly as before the TTL existed.
  const leaseIsExpired = (lock: LockFile): boolean => {
    if (typeof lock.expiresAt !== "string") return false;
    const expiry = Date.parse(lock.expiresAt);
    return !Number.isNaN(expiry) && expiry <= Date.now();
  };

  // Age-based staleness (L2): a lock started more than MAX_RUN_LEASE_AGE_MS
  // ago is stale even while its pid appears alive (pid reuse) and its TTL is
  // unexpired (a runaway renew loop). Complements leaseIsExpired.
  const leaseIsStaleByAge = (lock: LockFile): boolean => {
    const started = Date.parse(lock.startedAt);
    return !Number.isNaN(started) && Date.now() - started > MAX_RUN_LEASE_AGE_MS;
  };

  // list() cache: recomputed lazily, invalidated synchronously by every
  // mutation this instance performs (save()/delete()) so a stale read can
  // never outlive a mutation this process made. A read from another process
  // (or a direct fs write bypassing this instance) is picked up once the TTL
  // elapses, same as before this cache existed on the next un-cached call.
  let listCache: PersistedRunState[] | undefined;
  let listCacheAt = 0;
  const invalidateListCache = () => {
    listCache = undefined;
  };

  // Per-file mtime+size+ino cache, keyed by absolute path: even once the
  // TTL-level listCache above expires (the active panel polls roughly every
  // 300ms, i.e. faster than or comparable to the TTL), most run files on
  // disk haven't changed since the last recompute. Re-stat is cheap; re-read
  // + re-JSON.parse is not, and scales with total lifetime run history, not
  // with what actually changed. A file whose (mtimeMs, size, ino) all match
  // what we last parsed is reused as-is instead of being re-read; entries
  // for files that vanished between recomputes are pruned so this cache
  // can't grow unbounded independent of what's actually on disk.
  //
  // ino is load-bearing, not redundant with mtime+size: save() writes via
  // tmp-write + rename (writeJsonAtomicWithBackup), and a rename onto an
  // existing path allocates a NEW inode for the replacement file. Two
  // consecutive saves landing in the same mtime tick (400ms-throttled
  // progress persists vs. 1-2s mtime granularity on HFS+/many network
  // mounts/some Docker volume drivers is entirely realistic) with
  // coincidentally equal byte length (e.g. "paused" and "failed" are the
  // same length) would otherwise be indistinguishable from "unchanged" by
  // (mtimeMs, size) alone — serving stale, previously-cached content
  // forever until something ELSE about the file changes. The inode always
  // changes on such a rename, so adding it closes that hole for free.
  const fileStateCache = new Map<string, { mtimeMs: number; size: number; ino: number; state: PersistedRunState }>();

  const removeStaleLegacyLock = (runId: string): boolean => {
    const lock = legacyLockPath(runId);
    const existing = readLockAt(lock);
    if (existing?.runId === runId && pidIsAlive(existing.pid)) return false;
    try {
      if (_existsSync(lock)) _unlinkSync(lock);
    } catch {
      return false;
    }
    return true;
  };

  const computeList = (): PersistedRunState[] => {
    const byRunId = new Map<string, PersistedRunState>();
    const seenPaths = new Set<string>();
    for (const dir of [runsDir, legacyRunsDir]) {
      for (const file of listJsonFilesSafe(fs, dir)) {
        const path = join(dir, file);
        seenPaths.add(path);
        try {
          const stat = _statSync(path);
          const cached = fileStateCache.get(path);
          // Reuse the last parse when the file is byte-identical (same
          // mtime + size + inode) to what produced it — the dominant case
          // on every poll tick once a run goes terminal and stops changing.
          // ino is what actually rules out a false "unchanged" match on a
          // coarse-mtime filesystem (see the field doc comment above).
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
            if (!byRunId.has(cached.state.runId)) byRunId.set(cached.state.runId, cached.state);
            continue;
          }
          const state = JSON.parse(_readFileSync(path, "utf-8")) as PersistedRunState;
          fileStateCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, state });
          if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
        } catch {
          // Skip corrupted/unreadable files; don't let a stale cache entry
          // for a file that's now failing to read linger either.
          fileStateCache.delete(path);
        }
      }
    }
    // Prune cache entries for files that no longer exist (deleted runs) so
    // this map's size tracks what's actually on disk, not lifetime history.
    for (const path of fileStateCache.keys()) {
      if (!seenPaths.has(path)) fileStateCache.delete(path);
    }
    // E4: list() must present the same merged view load() does — a run whose
    // journal deltas live in the `.jdelta` sidecar shows its full journal here
    // too (status/list consumers read the persisted run directly, not the
    // live in-memory overlay). The cached state is cloned on merge so the
    // cache itself is never mutated. Runs without a sidecar pass through.
    const merged = [...byRunId.values()].map((state) => {
      const delta = readJournalDelta(state.runId);
      if (delta.length === 0) return state;
      return {
        ...state,
        journal: mergeJournalEntries(loadPersistedJournal(state), delta),
        journalCompacted: undefined,
      };
    });
    return merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  };

  // Bound the number of terminal (completed/failed/aborted) runs kept on
  // disk (see DEFAULT_MAX_TERMINAL_RUNS_ON_DISK) — called after every save()
  // whose state is terminal, since that's the only time the terminal count
  // can grow. Running/paused runs are never candidates: they're filtered out
  // before the cap is even considered.
  //
  // core-10: the count is tracked incrementally so the full readdir+stat scan
  // (computeList) is skipped while it is comfortably below the cap. undefined
  // means unknown (first terminal write of this process, or a deletion
  // invalidated it) and forces the authoritative scan; the scan also re-seeds
  // the counter, so cross-process additions are absorbed whenever a scan does
  // run (seed time, after a delete, or once the count nears the cap).
  const RETENTION_NEAR_CAP_FRACTION = 0.9;
  let terminalRunCount: number | undefined;

  const enforceRetention = () => {
    // Skip computeList until the terminal count is unknown or within 10% of
    // the cap — below that margin the scan cannot evict anything, so the only
    // cost of skipping it is a bounded, locally-approximate count (this
    // instance's own writes, re-synced on the next scan).
    if (terminalRunCount === undefined || terminalRunCount >= maxTerminalRunsOnDisk * RETENTION_NEAR_CAP_FRACTION) {
      const terminal = computeList()
        .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
        .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      terminalRunCount = terminal.length;
      const excess = terminal.length - maxTerminalRunsOnDisk;
      if (excess <= 0) return;
      for (const run of terminal.slice(0, excess)) {
        deleteRunFiles(run.runId);
      }
      terminalRunCount = Math.max(0, terminalRunCount - excess);
      invalidateListCache();
    }
  };

  const deleteRunFiles = (runId: string): boolean => {
    // S1-4: drop the per-run in-memory folded-journal map with the files — a
    // deleted run's entries must not leak memory, and a stale map for a reused
    // runId would make the fast path skip real deltas (foldedByRun is the
    // "already on disk" memory, so it must never outlive the files it tracks).
    foldedByRun.delete(runId);
    let deleted = false;
    for (const path of candidateRunPaths(runId)) {
      const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
      // Best-effort cleanup of the sidecar files alongside the primary.
      for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(dir, runId), `${path}${JOURNAL_DELTA_SUFFIX}`]) {
        unlinkIfExistsSafe(fs, sidecar);
        fileStateCache.delete(sidecar);
      }
      if (unlinkIfExistsSafe(fs, path)) deleted = true;
      fileStateCache.delete(path);
    }
    return deleted;
  };

  // ── E4: append-only journal-delta sidecar (fast-path writes) ─────────────

  // Raw sidecar text (null when absent or unreadable) — the single-syscall
  // read shared by the parsed form below, the cross-process fold guard
  // (casWrite folds + clears the sidecar only when its bytes match what the
  // write merged), and parseFreshest's delta replay. One try/catch
  // readFileSync replaces the old existsSync-probe + read pair, so the hot
  // list()/parse path pays one syscall per sidecar check instead of two
  // whenever the sidecar is present.
  const readJournalDeltaText = (runId: string): string | null => {
    try {
      return _readFileSync(journalDeltaPath(runId), "utf-8");
    } catch {
      // A missing sidecar (ENOENT) or a torn/unreadable one is null — "no
      // pending delta" — the ENOENT throw IS the absent-sidecar signal.
      return null;
    }
  };

  // Parse sidecar text leniently: corrupt-but-readable text is [] — a torn
  // delta silently degrades to "nothing new since the last fold" (those
  // calls re-run live on resume), which is the same degradation the
  // plain-journal cap already accepts; it never corrupts replay.
  const parseJournalDeltaText = (raw: string): JournalEntry[] => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
    } catch {
      return [];
    }
  };

  // Read the journal-delta sidecar leniently: a missing OR corrupt sidecar
  // is [] (see parseJournalDeltaText).
  const readJournalDelta = (runId: string): JournalEntry[] => {
    const text = readJournalDeltaText(runId);
    return text === null ? [] : parseJournalDeltaText(text);
  };

  // Write the sidecar atomically (tmp + rename): a torn in-place write would
  // silently drop journal deltas on crash-recovery.
  const writeJournalDelta = (runId: string, entries: JournalEntry[]): void => {
    ensureDir();
    const path = journalDeltaPath(runId);
    _writeFileSync(`${path}.tmp`, JSON.stringify(entries));
    _renameSync(`${path}.tmp`, path);
  };

  // ── Compare-and-swap persistence (core-orchestration:f3/i2) ──────────────

  /**
   * Windows-EPERM-safe rename for the run-record CAS write (same family as
   * writeJsonFileAtomic's async retry and renewRunLease's lock rename below):
   * a concurrent reader — the /workflows status poller, listRuns(), a
   * list-cache warm, or antivirus scanning the temp dir — opens the
   * destination without delete-sharing (libuv default) for a few ms, and
   * MoveFileEx fails EPERM. The window is LONGER than the plan-file/lease
   * cadence (5×20ms) on purpose: the run record is polled on a 50ms cadence
   * (vs 250ms for plan files) and the terminal settle is the one write that
   * must land or the run is left a ghost "running" on disk (M27). Bounded
   * retry, then propagate (the manager's M27 catch treats a genuinely stuck
   * disk as best-effort).
   */
  const CAS_RENAME_RETRY_ATTEMPTS = 10;
  const CAS_RENAME_RETRY_DELAY_MS = 50;
  const renameWithRetry = (from: string, to: string): void => {
    for (let attempt = 0; attempt < CAS_RENAME_RETRY_ATTEMPTS; attempt++) {
      try {
        _renameSync(from, to);
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== "EPERM") throw err;
        if (attempt < CAS_RENAME_RETRY_ATTEMPTS - 1) {
          sleepSync(CAS_RENAME_RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
  };

  // The raw text of the PRIMARY run file right now (null when absent). This is
  // the exact-byte fingerprint for concurrent-modification detection — content
  // comparison, deliberately NOT stat mtime/ino: mtime granularity is coarser
  // than the write cadence on many filesystems, and ino is synthetic on some
  // platforms, so only the bytes are trustworthy.
  const readPrimaryText = (runId: string): string | null => {
    try {
      return _readFileSync(primaryRunPath(runId), "utf-8");
    } catch {
      return null;
    }
  };

  // Freshest on-disk state: primary first, then .bak — a corrupt primary
  // doesn't lose the run (readJsonWithBackupRecovery), and the result is
  // always migrated to the current schema. E4: journal deltas appended since
  // the last fold live in the `.jdelta` sidecar — replay them on top so every
  // consumer (load(), the CAS base) sees the full journal. A compacted
  // primary that also has deltas materializes to the plain journal (resume
  // replay must see the deltas); with no deltas the compacted form is
  // preserved exactly as persisted.
  const parseFreshest = (runId: string, sidecarText?: string | null): PersistedRunState | null => {
    for (const path of candidateRunPaths(runId)) {
      const raw = readJsonWithBackupRecovery<unknown>(fs, path);
      if (raw !== null) {
        const state = migrateRunState(raw);
        // Share a caller-supplied sidecar read (casWrite reads the raw text
        // once and passes it to its own fold guard baseline) so the same file
        // is never probed twice in one write; undefined → read it here.
        const text = sidecarText === undefined ? readJournalDeltaText(runId) : sidecarText;
        const delta = text === null ? [] : parseJournalDeltaText(text);
        if (delta.length > 0) {
          state.journal = mergeJournalEntries(loadPersistedJournal(state), delta);
          state.journalCompacted = undefined;
        }
        return state;
      }
    }
    return null;
  };

  // Serialize once, scrubbing secrets inline. JSON.stringify's replacer applies
  // redactText to every string value in the SAME traversal the serializer
  // already makes — a single pass, no parse/deep-walk/re-stringify round trip.
  // The old '.' probe (a JWT hint) misfired on ordinary prose, forcing that
  // round trip on every write whose state contained a period; the replacer
  // needs no probe because the linear scanner (redactPathologicalRules) runs
  // per string and is a no-op on prose. Key order, indentation, and non-string
  // values are byte-identical to a plain stringify, and redaction is idempotent
  // (redacting an already-redacted payload changes nothing) — the persisted
  // form is stable across repeated saves of the same state.
  const serializeRedacted = (state: PersistedRunState): string =>
    JSON.stringify(state, (_key, value) => (typeof value === "string" ? redactText(value) : value), 2);

  // Both checkpoint lists survive a concurrent save: dedupe by taskId keeping
  // the newest timestamp, in first-seen order. An explicit empty array clears.
  const mergeCheckpoints = (
    base: RunCheckpoint[] | undefined,
    incoming: RunCheckpoint[] | undefined,
  ): RunCheckpoint[] | undefined => {
    if (incoming === undefined) return base; // caller didn't manage checkpoints → keep disk's
    if (incoming.length === 0) return []; // explicit clear
    if (!base || base.length === 0) return incoming;
    const newestByTask = new Map<string, RunCheckpoint>();
    for (const c of base) newestByTask.set(c.taskId, c);
    for (const c of incoming) {
      const existing = newestByTask.get(c.taskId);
      if (!existing || (c.timestamp ?? "") >= (existing.timestamp ?? "")) newestByTask.set(c.taskId, c);
    }
    const seen = new Set<string>();
    const merged: RunCheckpoint[] = [];
    for (const c of [...base, ...incoming]) {
      if (seen.has(c.taskId)) continue;
      seen.add(c.taskId);
      const newest = newestByTask.get(c.taskId);
      if (newest) merged.push(newest);
    }
    return merged;
  };

  // Journal merge: a plain-journal writer (the manager) owns every (runId,
  // index) key it writes, so incoming entries win per-key conflicts; entries
  // only on disk (concurrent writers) are kept. A compacted form replaces the
  // plain journal (never both); completed/aborted drops it by design; a
  // resumable state without an explicit journal carries disk's (a stale
  // partial writer must not erase it).
  const mergeJournalFields = (
    base: PersistedRunState | null,
    incoming: PersistedRunState,
  ): PersistedRunState["journal"] => {
    if (incoming.journalCompacted !== undefined) return undefined;
    if (incoming.journal !== undefined) return mergeJournalEntries(base?.journal, incoming.journal);
    if (TERMINAL_RUN_STATUSES.has(incoming.status)) return undefined;
    return base?.journal;
  };

  // O(n) Map-based union (see the callers above for conflict semantics).
  const mergeJournalEntries = (
    base: JournalEntry[] | undefined,
    incoming: JournalEntry[],
  ): JournalEntry[] | undefined => {
    if (!base || base.length === 0) {
      return incoming.length > MAX_JOURNAL_ENTRIES ? incoming.slice(incoming.length - MAX_JOURNAL_ENTRIES) : incoming;
    }
    if (incoming.length === 0) return base;
    const byKey = new Map<string, JournalEntry>();
    for (const entry of base) byKey.set(journalEntryKey(entry.runId ?? "", entry.index), entry);
    for (const entry of incoming) byKey.set(journalEntryKey(entry.runId ?? "", entry.index), entry);
    const merged = [...byKey.values()];
    return merged.length > MAX_JOURNAL_ENTRIES ? merged.slice(merged.length - MAX_JOURNAL_ENTRIES) : merged;
  };

  const CAS_MAX_ATTEMPTS = 8;

  /**
   * The CAS core every full write funnels through (save() boundary writes,
   * updateRunState()): re-read the freshest on-disk snapshot, apply `produce`
   * to it, write atomically (tmp + rename), and verify the write landed —
   * retrying on any concurrent modification detected between the read and the
   * rename. A stale in-memory snapshot can no longer overwrite a newer
   * on-disk journal or a concurrently-added checkpoint, because the mutation
   * is always re-applied to the snapshot that is CURRENT at write time.
   * Cross-process writers converge the same way: the writer whose rename
   * lands second re-reads the first writer's content, merges, and rewrites.
   * Bounded retries — under sustained contention the loop falls back to one
   * final converged write (re-read + re-merge against the freshest snapshot)
   * rather than verifying it landed, so a run is never failed forever while
   * still preserving merges.
   *
   * E4 opts: `backup` gates the .bak sidecar (only boundary writes keep it),
   * `foldSidecar` gates the journal-delta fold: a full write merges the
   * sidecar deltas (via parseFreshest) into the primary, then clears the
   * sidecar — guarded by a byte re-check so a cross-process fast-path
   * appender's newer deltas are never cleared unmerged. `checkBudget` gates
   * the journal byte-budget enforcement (default true): the throttled
   * fast-path fold passes false so the hot path stays stringify-free; every
   * lifecycle/terminal write keeps it.
   *
   * S1-4c: the write itself is deliberately SYNCHRONOUS (writeFileSync +
   * read-back verification). The CAS read/verify/rename sequence is
   * inherently synchronous — resume() and every list()/load() immediately
   * after a settle must observe the written bytes — so the terminal-boundary
   * stall is bounded by reducing the PAYLOAD (per-agent detail retention
   * cap, S1-4b) rather than by asynchronizing the write.
   */
  const casWrite = (
    runId: string,
    produce: (current: PersistedRunState | null) => PersistedRunState,
    requireExisting = false,
    opts: { backup?: boolean; foldSidecar?: boolean; checkBudget?: boolean } = {},
  ): PersistedRunState | null => {
    const backup = opts.backup ?? true;
    const foldSidecar = opts.foldSidecar ?? true;
    const checkBudget = opts.checkBudget !== false;
    ensureDir();
    const path = primaryRunPath(runId);
    let last: PersistedRunState | undefined;
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
      const before = readPrimaryText(runId);
      // Read the sidecar ONCE and share its raw text between parseFreshest
      // (the delta merge) and the fold-guard baseline below — the old code
      // probed the same file twice per CAS iteration (parseFreshest's
      // readJournalDelta, then readJournalDeltaText), pure syscall overhead.
      const sidecarAtRead = foldSidecar ? readJournalDeltaText(runId) : null;
      const current = parseFreshest(runId, sidecarAtRead);
      if (requireExisting && current === null) return null;
      const next = produce(current);
      next.updatedAt = new Date().toISOString();
      next.schemaVersion = RUN_STATE_SCHEMA_VERSION;
      // Journal byte budget: bounded disk writes on huge runs. The count check
      // is cheap, so the (stringify-heavy) byte check only runs when it can
      // matter — typical runs never pay for it — and the throttled fast-path
      // fold (checkBudget=false) skips it entirely so the hot path stays
      // stringify-free. Lifecycle/terminal writes keep full enforcement + the
      // binary-search truncation, and the manager truncates the in-memory
      // journal BEFORE its compaction fold so a pathological journal never
      // reaches this merge untruncated.
      if (checkBudget && next.journal && next.journal.length > JOURNAL_BYTE_CHECK_THRESHOLD) {
        next.journal = capJournalBudget(next.journal, DEFAULT_JOURNAL_BYTE_BUDGET);
      }
      last = next;
      const json = serializeRedacted(next);
      _writeFileSync(`${path}.tmp`, json);
      const mid = readPrimaryText(runId);
      // Another writer replaced the file since our read → re-read and merge
      // onto THEIR snapshot instead of overwriting it.
      if (mid !== before) continue;
      renameWithRetry(`${path}.tmp`, path);
      const landed = readPrimaryText(runId);
      if (landed === json) {
        if (backup) {
          try {
            _writeFileSync(`${path}.bak`, json);
          } catch (e) {
            // The .bak is the documented crash-recovery fallback used by
            // readJsonWithBackupRecovery; a silent failure here (ENOSPC,
            // permissions) degrades recovery invisibly, so surface it once.
            console.warn(`[run-persistence] backup write failed for ${runId}:`, (e as Error).message);
          }
        }
        if (foldSidecar) {
          // A cross-process fast-path appender may have written the sidecar
          // since we read it — only fold (clear) when the sidecar is
          // byte-identical to what THIS write merged. Otherwise retry: the
          // next iteration re-reads the newer deltas and folds them too.
          if (readJournalDeltaText(runId) !== sidecarAtRead) continue;
          unlinkIfExistsSafe(fs, journalDeltaPath(runId));
        }
        foldedByRun.set(
          runId,
          new Map((next.journal ?? []).map((e) => [journalEntryKey(e.runId ?? runId, e.index), e])),
        );
        // S1-5: invalidate the list cache only when this write changed the run's
        // status (or when retention evicted files below) — NOT on every write, so
        // the 300ms TTL cache stays warm across same-status throttled progress
        // folds. Terminal writes always transition and therefore always
        // invalidate; delete/rename invalidate via their own paths.
        if (current?.status !== next.status) invalidateListCache();
        // core-10: count the terminal run incrementally — the status-change
        // guard keeps re-saves of an already-terminal run (progress folds of a
        // failed run, live-stats re-saves) from double counting. undefined
        // stays undefined here so enforceRetention's seed scan still runs.
        if (
          current?.status !== next.status &&
          TERMINAL_RUN_STATUSES.has(next.status) &&
          terminalRunCount !== undefined
        ) {
          terminalRunCount++;
        }
        if (TERMINAL_RUN_STATUSES.has(next.status)) enforceRetention();
        return next;
      }
      // Our rename lost a race against another writer → retry on the fresh base.
    }
    // Sustained contention: rather than failing the run, fall back to a single
    // last write — but STILL re-read the freshest on-disk snapshot and re-apply
    // `produce` to it so a concurrent writer's journal/checkpoints are merged
    // in rather than clobbered (preserving the convergence guarantee above).
    // The loop above always assigns `last` on its first iteration
    // (CAS_MAX_ATTEMPTS > 0); this guard only satisfies the type system.
    if (last === undefined) {
      throw new Error(`unreachable: casWrite loop did not execute for ${runId}`);
    }
    const finalCurrent = parseFreshest(runId);
    if (requireExisting && finalCurrent === null) return null;
    const finalNext = produce(finalCurrent);
    finalNext.updatedAt = new Date().toISOString();
    finalNext.schemaVersion = RUN_STATE_SCHEMA_VERSION;
    if (finalNext.journal && checkBudget && finalNext.journal.length > JOURNAL_BYTE_CHECK_THRESHOLD) {
      finalNext.journal = capJournalBudget(finalNext.journal, DEFAULT_JOURNAL_BYTE_BUDGET);
    }
    writeJsonAtomicWithBackup(fs, path, finalNext);
    // E4: the fallback deliberately does NOT clear the sidecar — any deltas
    // the write merged are also still in the sidecar, and load() merges both
    // (per-key upsert), so nothing is ever lost. Refresh the folded map from
    // what the primary now holds so the next fast-path write stays delta-only.
    foldedByRun.set(
      runId,
      new Map((finalNext.journal ?? []).map((e) => [journalEntryKey(e.runId ?? runId, e.index), e])),
    );
    // S1-5: same status-transition-only invalidation rule as the main path.
    if (finalCurrent?.status !== finalNext.status) invalidateListCache();
    // core-10: same incremental count as the main path (see above).
    if (
      finalCurrent?.status !== finalNext.status &&
      TERMINAL_RUN_STATUSES.has(finalNext.status) &&
      terminalRunCount !== undefined
    ) {
      terminalRunCount++;
    }
    if (TERMINAL_RUN_STATUSES.has(finalNext.status)) enforceRetention();
    return finalNext;
  };

  /**
   * E4 fast path: persist ONLY the journal delta since the last fold. The
   * incoming state's journal is diffed against the per-instance folded map
   * with CONTENT-based detection — object identity is the fast reject (the
   * manager's journal array holds the same entry objects between saves, so
   * an in-place replacement is a new object), and when the reference differs
   * the two small entries are stringified and compared, so callers that
   * re-construct the state with fresh but identical objects do NOT re-delta
   * an already-folded entry. The delta is upserted into the `.jdelta`
   * sidecar, and the sidecar is written atomically. The primary run file is
   * NOT touched on this tick: it keeps the last boundary/checkpoint
   * snapshot, and list()/the task panel overlay the LIVE in-memory run for
   * running statuses (see WorkflowManager.getRun). The periodic full
   * checkpoint fires when the merged sidecar would serialize past
   * journalDeltaCheckpointBytes — a full CAS write (with .bak) that folds
   * the sidecar into the primary.
   */
  const saveFastPath = (state: PersistedRunState, opts?: RunPersistenceSaveOptions): void => {
    ensureDir();
    const runId = state.runId;
    const journal = state.journal as JournalEntry[];
    // Delta = entries whose key is not yet on disk, or whose entry object was
    // replaced in place (same key, newer value). O(n) Map lookups only.
    const folded = foldedByRun.get(runId);
    // Content-based delta detection: identity is the fast reject (same object
    // as last save => already on disk). When the reference differs, compare
    // serialized content — a re-constructed entry with identical content is
    // folded, not re-delted; only a genuine content difference is a delta.
    const delta: JournalEntry[] = [];
    // Copy-on-write folded map: materialized ONLY when an entry's identity
    // actually changed — a real delta, or a content-identical re-construction
    // that must refresh the map so the next save short-circuits on identity.
    // A no-op save (every entry is still the same object as the last save)
    // performs no O(|journal|) copy at all; the existing map remains
    // authoritative for what is on disk.
    let nextFolded: Map<string, JournalEntry> | undefined;
    for (const entry of journal) {
      const key = journalEntryKey(entry.runId ?? runId, entry.index);
      const known = folded?.get(key);
      if (known === entry) continue; // same object — already on disk
      if (known === undefined || JSON.stringify(known) !== JSON.stringify(entry)) delta.push(entry);
      // Identity refresh: copy-then-set only the touched key.
      nextFolded ??= folded ? new Map(folded) : new Map<string, JournalEntry>();
      nextFolded.set(key, entry);
    }
    if (delta.length > 0) {
      // Re-read the sidecar (a concurrent full writer may have folded and
      // cleared it) and upsert the delta — newest entry per key wins.
      const byKey = new Map<string, JournalEntry>();
      for (const e of readJournalDelta(runId)) byKey.set(journalEntryKey(e.runId ?? runId, e.index), e);
      for (const e of delta) byKey.set(journalEntryKey(e.runId ?? runId, e.index), e);
      const sidecar = [...byKey.values()];
      if (JSON.stringify(sidecar).length > journalDeltaCheckpointBytes) {
        // Periodic full checkpoint: fold everything into the primary now. The
        // budget check stays off (opts.checkBudget === false from the throttled
        // caller) — this is still a progress write, not a lifecycle boundary.
        casWrite(
          runId,
          (current) => {
            return {
              ...(current ?? {}),
              ...state,
              checkpoints: mergeCheckpoints(current?.checkpoints, state.checkpoints),
              journal: mergeJournalFields(current, state),
              // The incoming state is authoritative for the journal's on-disk
              // form — a plain-journal fold REPLACES a stale compacted summary
              // (never both: loadPersistedJournal prefers the compacted form,
              // so a surviving summary would shadow the folded delta entries
              // and lose them on resume). An explicit summary is kept.
              journalCompacted: state.journalCompacted,
            };
          },
          false,
          { checkBudget: opts?.checkBudget },
        );
        return;
      }
      writeJournalDelta(runId, sidecar);
    }
    // Track what is now on disk for this run (primary-folded ∪ sidecar) so
    // the next fast write stays delta-only. Content-identical re-constructions
    // refresh the map too, so the next save short-circuits on identity. A
    // save that touched nothing leaves the existing map in place — it is
    // still exactly what is on disk.
    if (nextFolded !== undefined) foldedByRun.set(runId, nextFolded);
  };

  return {
    save(state: PersistedRunState, opts?: RunPersistenceSaveOptions) {
      if (opts?.fastPath === true && Array.isArray(state.journal) && keepsResumeJournal(state.status)) {
        // E4 fast path (throttled progress write): append only the journal
        // delta to the `.jdelta` sidecar — no primary rewrite, no .bak — and
        // fold into a full checkpoint once the sidecar passes the threshold.
        saveFastPath(state, opts);
        return;
      }
      // Compare-and-swap: the incoming state is layered onto the freshest
      // on-disk snapshot so a concurrently-persisted journal or checkpoint is
      // never clobbered (see casWrite). Checkpoints are merged (both lists
      // survive); the journal merge keeps entries the caller didn't write
      // while letting the caller's own entries win per (runId, index).
      // Boundary writes (start/pause/checkpoint/failed/complete) fold the
      // journal-delta sidecar into the primary and keep the .bak sidecar.
      casWrite(
        state.runId,
        (current) => {
          return {
            ...(current ?? {}),
            ...state,
            checkpoints: mergeCheckpoints(current?.checkpoints, state.checkpoints),
            journal: mergeJournalFields(current, state),
            // Same never-both rule as the fast-path fold: a boundary write that
            // carries a plain journal (or drops it on a terminal status) must
            // clear any stale compacted summary from a prior write instead of
            // letting it shadow the journal on load.
            journalCompacted: state.journalCompacted,
          };
        },
        false,
        { checkBudget: opts?.checkBudget },
      );
    },

    load(runId: string): PersistedRunState | null {
      // Primary first, then .bak — a corrupt primary doesn't lose the run —
      // always migrated to the current schema (migrateRunState).
      return parseFreshest(runId);
    },

    updateRunState(runId: string, mutate: (state: PersistedRunState) => void): PersistedRunState | null {
      return casWrite(
        runId,
        (current) => {
          if (current === null) {
            // Only reachable if the run is deleted mid-loop after the
            // requireExisting pre-check — surface it loudly, don't fabricate state.
            throw new Error(`Run ${runId} disappeared during update`);
          }
          mutate(current);
          return current;
        },
        true,
      );
    },

    list(): PersistedRunState[] {
      const now = Date.now();
      // Return a fresh array on every call (a cheap ref-copy) so a caller that
      // sorts/reverses/mutates the result in place can't corrupt the cache — the
      // pre-cache code re-parsed into a new array each call, preserve that.
      if (listCache && now - listCacheAt < LIST_CACHE_TTL_MS) {
        return [...listCache];
      }
      const result = computeList();
      listCache = result;
      listCacheAt = now;
      return [...result];
    },

    delete(runId: string): boolean {
      try {
        return deleteRunFiles(runId);
      } finally {
        // S1-4: belt-and-suspenders — the public delete path must never leave a
        // folded-journal map behind even if deleteRunFiles' shape changes.
        foldedByRun.delete(runId);
        invalidateListCache();
        // core-10: a deleted run may have been terminal — the incremental
        // counter can't know without a read, so invalidate it; the next
        // terminal write re-seeds with an authoritative scan (catching
        // external/manager deletions too).
        terminalRunCount = undefined;
      }
    },

    acquireRunLease(runId: string): RunLease | null {
      ensureDir();
      const path = primaryRunPath(runId);
      const lock = primaryLockPath(runId);
      if (!removeStaleLegacyLock(runId)) return null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const now = Date.now();
        const token = `${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
        const payload: LockFile = {
          runId,
          runPath: path,
          pid: process.pid,
          startedAt: new Date(now).toISOString(),
          token,
          expiresAt: new Date(now + DEFAULT_RUN_LEASE_TTL_MS).toISOString(),
        };
        try {
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
          return { runId, token };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "EEXIST") throw err;
          const existing = readLock(runId);
          // Refuse only while the owner is BOTH alive and within its lease
          // expiry; a dead pid, an expired lease (bounded-delay reclaim), or an
          // age-stale lease (recycled PID / runaway renew — L2) is stale and
          // gets replaced below.
          if (existing) {
            if (
              existing.runPath === path &&
              pidIsAlive(existing.pid) &&
              !leaseIsExpired(existing) &&
              !leaseIsStaleByAge(existing)
            ) {
              return null;
            }
          } else if (_existsSync(lock)) {
            // core-01: the lock exists (EEXIST) but does not parse — a
            // torn/corrupt lock (a legacy non-atomic renewal crash, external
            // tampering). Ownership cannot be verified, so treat the lease as
            // HELD: never unlink-and-reacquire a runId whose lease we cannot
            // prove stale. That silent re-acquisition was the double-execution
            // vector — a torn lock parsed as null → "no lease" → re-acquire →
            // the SAME runId ran twice (double token spend). A human can
            // delete a genuinely stuck corrupt lock by hand.
            return null;
          }
          try {
            _unlinkSync(lock);
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    releaseRunLease(lease: RunLease): void {
      try {
        const existing = readLock(lease.runId);
        if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
      } catch {
        // Best-effort cleanup only.
      }
    },

    renewRunLease(lease: RunLease): boolean {
      try {
        const existing = readLock(lease.runId);
        if (!existing || existing.token !== lease.token) return false;
        existing.expiresAt = new Date(Date.now() + DEFAULT_RUN_LEASE_TTL_MS).toISOString();
        const lockPath = primaryLockPath(lease.runId);
        // core-01: atomic renewal — write a sibling tmp, then rename over the
        // live lock. The old truncate-then-write (writeFileSync on the lock
        // itself) could crash mid-write, leaving a torn lock that readLockAt
        // parsed as null → acquireRunLease re-acquired → the SAME runId ran
        // twice (double token spend). A rename is atomic on the same
        // filesystem, so a reader sees either the old or the new complete
        // lock, never a half-written one.
        const tmpPath = `${lockPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
        _writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
        // Token/owner guard: re-verify ownership immediately before the rename
        // so a lease that was stolen (expired → reclaimed by another process)
        // between our read above and this rename is never clobbered.
        const current = readLock(lease.runId);
        if (!current || current.token !== lease.token) {
          try {
            _unlinkSync(tmpPath);
          } catch {
            // best-effort cleanup; the ownership loss is the real result.
          }
          return false;
        }
        for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
          try {
            _renameSync(tmpPath, lockPath);
            return true;
          } catch {
            if (attempt < RENAME_RETRY_ATTEMPTS - 1) {
              // Windows EPERM: a concurrent reader may hold the destination
              // open without delete-sharing for a few ms; bounded sync sleep
              // then retry (same cadence as the async writeJsonFileAtomic).
              sleepSync(RENAME_RETRY_DELAY_MS);
              continue;
            }
            try {
              _unlinkSync(tmpPath);
            } catch {
              // best-effort cleanup; the renewal failure is the real result.
            }
            return false;
          }
        }
        return false;
      } catch {
        return false;
      }
    },

    getLeaseInfo(runId: string): RunLeaseInfo | null {
      const lock = readLock(runId);
      if (lock === null) {
        if (!_existsSync(primaryLockPath(runId))) return null;
        // core-01: a lock file exists but is torn/corrupt. Ownership cannot be
        // verified, so the lease is treated as HELD by an unknown owner — never
        // reclaimable. The old reader returned null here ("no lease"), which
        // let damage-control clean/recover classify the run as unleased and
        // force-remove state whose orphanhood we cannot prove.
        return {
          runId,
          pid: 0,
          startedAt: "",
          expiresAt: "",
          alive: false,
          expired: false,
          staleByAge: false,
          reclaimable: false,
        };
      }
      const alive = pidIsAlive(lock.pid);
      const expired = leaseIsExpired(lock);
      const staleByAge = leaseIsStaleByAge(lock);
      return {
        runId: lock.runId,
        pid: lock.pid,
        startedAt: lock.startedAt,
        expiresAt: lock.expiresAt,
        alive,
        expired,
        staleByAge,
        reclaimable: !alive || expired || staleByAge,
      };
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

// ─── RunState schema versioning (migrateRunState) ─────────────────────────────

/**
 * Current on-disk schema version of PersistedRunState. Files written before
 * this field existed (no `schemaVersion` key) are treated as version 0 and
 * migrated on load by migrateRunState.
 */
export const RUN_STATE_SCHEMA_VERSION = 1 as const;

const VALID_RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
]);

/**
 * Migrate a persisted run state from any prior schema version to the current
 * one. Never throws: unknown/missing fields get safe defaults, unknown extra
 * fields and unknown version numbers are preserved (forward-compatible), and
 * the current schema version is stamped. Applied on every load(), so a legacy
 * fixture resumes exactly like a current one — defaults are filled in where
 * the shape changed, data is never dropped. The journal itself is deliberately
 * NOT defaulted to [] (absent stays absent): the resume path and the persisted
 * shape both distinguish "no journal" from "empty journal", and a compacted
 * form must never be shadowed by a fabricated plain array.
 */
export function migrateRunState(raw: unknown): PersistedRunState {
  const src = (raw ?? {}) as Record<string, unknown>;
  const journalCompacted =
    src.journalCompacted !== undefined &&
    typeof src.journalCompacted === "object" &&
    (src.journalCompacted as { kind?: unknown }).kind === "compact"
      ? (src.journalCompacted as CompactJournalSummary)
      : undefined;
  return {
    ...(src as unknown as PersistedRunState),
    status: VALID_RUN_STATUSES.has(String(src.status)) ? (src.status as RunStatus) : "paused",
    phases: Array.isArray(src.phases) ? (src.phases as string[]) : [],
    agents: Array.isArray(src.agents) ? (src.agents as PersistedAgentState[]) : [],
    logs: Array.isArray(src.logs) ? (src.logs as string[]) : [],
    journal: Array.isArray(src.journal) ? (src.journal as JournalEntry[]) : undefined,
    journalCompacted,
    checkpoints: Array.isArray(src.checkpoints) ? (src.checkpoints as RunCheckpoint[]) : undefined,
    startedAt: typeof src.startedAt === "string" ? src.startedAt : "1970-01-01T00:00:00.000Z",
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : "1970-01-01T00:00:00.000Z",
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
  };
}

// ─── Secret redaction ─────────────────────────────────────────────────────────

// Masking rules applied to every string that reaches the disk: provider API
// keys, env-var assignments, bearer/basic auth, JWTs, and PEM blocks. Each
// replacement is JSON-safe inside a string (no quotes/backslashes), so
// redaction can run on the serialized form without ever corrupting it.
//
// The JWT and KEY=value patterns are NOT regexes here: their natural regex
// forms (`[A-Za-z0-9_-]{20,}\.` and `[A-Za-z0-9_-]{1,}(?:...|KEY|...)`)
// backtrack O(n²) on long homogeneous runs, which a multi-MB journal turns
// into a ReDoS-class event-loop stall — exactly the big-run CPU spike this
// audit fixes. They are handled by the linear single-pass scanner
// (redactPathologicalRules) below, which visits every char exactly once.
//
// Char-code helpers so the scanner never pays a per-char regex call.
const isWordChar = (code: number): boolean =>
  (code >= 65 && code <= 90) || // A-Z
  (code >= 97 && code <= 122) || // a-z
  (code >= 48 && code <= 57) || // 0-9
  code === 95 || // _
  code === 45; // -
const isLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isBlank = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13 || code === 12; // space \t \n \r \f

// Keyword suffixes matched by the KEY=value scanner rule (case-sensitive, like
// the original regex). Order is irrelevant — the scanner checks each per token.
const SCANNER_KEYWORDS = [
  "API_KEY",
  "APIKEY",
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIALS",
  "CREDENTIAL",
  "AUTH",
  "BEARER",
] as const;

/**
 * Linear single-pass redactor for the JWT-like and KEY=value patterns (see
 * REDACTION_RULES note — the regex forms are O(n²) on long runs). Every char
 * is visited exactly once; word tokens pay only a bounded keyword check.
 *
 * JWT rule (replaces a dot token of 3+ segments with ≥20 [A-Za-z0-9_-] each):
 *   `aaaa...bbbb...cccc` → `[REDACTED]`
 * KEY=value rule (replaces `IDENT <sep> value` where IDENT ends in a keyword
 * suffix, replicating the original regex's matching semantics exactly):
 *   `OPENAI_API_KEY = sk-1234` → `OPENAI_API_KEY=[REDACTED]`
 */
function redactPathologicalRules(text: string): string {
  const n = text.length;
  let out = "";
  let i = 0;
  while (i < n) {
    // Copy the next non-word run wholesale (fast path for JSON structure).
    const start = i;
    while (i < n && !isWordChar(text.charCodeAt(i))) i++;
    if (i > start) out += text.slice(start, i);
    if (i >= n) break;
    // Consume a maximal word run, allowing single dots between word chars so
    // the whole dot token is one unit (the JWT shape).
    let j = i;
    while (j < n) {
      const code = text.charCodeAt(j);
      if (isWordChar(code)) {
        j++;
      } else if (code === 46 && j + 1 < n && isWordChar(text.charCodeAt(j + 1))) {
        j++; // internal dot between two word chars stays part of the token
      } else {
        break;
      }
    }
    const token = text.slice(i, j);
    // JWT rule first (original rule order — a KEY=value pair whose value is a
    // JWT must redact the value, not the whole assignment).
    const segments = token.split(".");
    if (segments.length >= 3 && segments.every((segment) => segment.length >= 20)) {
      out += "[REDACTED]";
      i = j;
      continue;
    }
    // KEY=value rule: IDENT ending in `_?` + keyword, then optional
    // ws/quotes/ws, `:` or `=`, optional ws/quotes/ws, then a ≥1-char value.
    if (isLetter(token.charCodeAt(0)) && token.length >= 2) {
      let keywordHit = false;
      for (const keyword of SCANNER_KEYWORDS) {
        // Faithful to the original: the identifier is `[A-Za-z]` + `[A-Za-z0-9_-]{1,}`
        // + optional `_` + keyword — at least 2 chars before the keyword suffix
        // (the `_` counts in the prefix, so `_KEY`-suffixed identifiers are
        // covered by the plain endsWith check too).
        if (token.endsWith(keyword) && token.length - keyword.length >= 2) {
          keywordHit = true;
          break;
        }
      }
      if (keywordHit) {
        let k = j;
        const skipBlanks = () => {
          while (k < n && isBlank(text.charCodeAt(k))) k++;
        };
        skipBlanks();
        if (k < n && (text[k] === '"' || text[k] === "'")) {
          k++;
          skipBlanks();
        }
        if (k < n && (text[k] === ":" || text[k] === "=")) {
          k++;
          skipBlanks();
          if (k < n && (text[k] === '"' || text[k] === "'")) {
            k++;
            skipBlanks();
          }
          // Value: ≥1 char of [^\s,;'"}].
          const valueStart = k;
          while (k < n) {
            const code = text.charCodeAt(k);
            if (
              !isBlank(code) &&
              code !== 44 && // ,
              code !== 59 && // ;
              code !== 39 && // '
              code !== 34 && // "
              code !== 125 // }
            ) {
              k++;
            } else {
              break;
            }
          }
          if (k > valueStart) {
            out += `${token}=[REDACTED]`;
            i = k;
            continue;
          }
        }
      }
    }
    out += token;
    i = j;
  }
  return out;
}

const REDACTION_RULES: ReadonlyArray<{ re: RegExp; replace: string }> = [
  { re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, replace: "[REDACTED]" },
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: "$1 [REDACTED]" },
  { re: /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, replace: "[REDACTED]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[REDACTED]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "[REDACTED]" },
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: "[REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{16}/g, replace: "[REDACTED]" },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g, replace: "[REDACTED]" },
];

/** Mask provider API keys/secrets inside a single string. */
export function redactText(text: string): string {
  let out = redactPathologicalRules(text);
  for (const rule of REDACTION_RULES) out = out.replace(rule.re, rule.replace);
  return out;
}

/**
 * Deep-copy `value` masking provider API keys/secrets in every string
 * (agent results, logs, tool I/O, checkpoints). Structure and non-secret
 * content are preserved exactly.
 */
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactText(node);
    if (Array.isArray(node)) {
      const out = new Array(node.length);
      for (let i = 0; i < node.length; i++) out[i] = walk(node[i]);
      return out;
    }
    if (node !== null && typeof node === "object") {
      if (seen.has(node)) return node;
      seen.add(node);
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) out[key] = walk(value);
      return out;
    }
    return node;
  };
  return walk(value);
}

// ─── Journal growth budget ────────────────────────────────────────────────────

/**
 * Upper bound on journal entries kept (in-memory upsert and persisted form):
 * the NEWEST entries are kept, the oldest re-run live on resume.
 */
export const MAX_JOURNAL_ENTRIES = 50_000;

/**
 * Sidecar suffix for the E4 append-only journal-delta log: the primary run
 * file's journal is the last FOLDED snapshot; entries journaled since then
 * accumulate here (compact single-line JSON of JournalEntry[]) until the next
 * boundary write or periodic full checkpoint folds them into the primary.
 */
export const JOURNAL_DELTA_SUFFIX = ".jdelta";

/**
 * Periodic full checkpoint threshold (E4): when the merged journal-delta
 * sidecar serializes larger than this, the next fast-path write folds into a
 * full-state write (checkpoint) instead of appending — bounding the sidecar
 * and the primary's staleness window. Boundary writes always fold regardless.
 */
export const DEFAULT_JOURNAL_DELTA_CHECKPOINT_BYTES = 1024 * 1024;

/**
 * Byte budget for a persisted journal. Only enforced once the entry count
 * makes it worth the stringify cost (see JOURNAL_BYTE_CHECK_THRESHOLD), so
 * the hot persist path never pays for it.
 */
export const DEFAULT_JOURNAL_BYTE_BUDGET = 32 * 1024 * 1024;

/**
 * Entry-count gate below which the (stringify-heavy) journal byte check never
 * runs: the count check is cheap, so the byte check only fires when it can
 * matter — typical runs never pay for it (see casWrite and the manager's
 * pre-fold truncation, which reuse this same gate).
 */
export const JOURNAL_BYTE_CHECK_THRESHOLD = 10_000;

/**
 * Drop the OLDEST entries until the journal fits `maxBytes`. Entries are
 * resume-cache keys: dropping the oldest means those calls re-run live on
 * resume — safe, never a correctness regression. Returns the input when it
 * already fits (no copy).
 */
export function capJournalBudget(journal: JournalEntry[], maxBytes = DEFAULT_JOURNAL_BYTE_BUDGET): JournalEntry[] {
  if (journal.length === 0) return journal;
  if (JSON.stringify(journal).length <= maxBytes) return journal;
  // Binary-search the smallest number of oldest entries to drop.
  let drop = 1;
  let hi = journal.length;
  while (drop < hi) {
    const mid = (drop + hi) >> 1;
    if (JSON.stringify(journal.slice(mid)).length <= maxBytes) hi = mid;
    else drop = mid + 1;
  }
  return journal.slice(drop);
}

// ─── Run lease lifecycle ──────────────────────────────────────────────────────

/**
 * Default lease expiry for acquireRunLease. A long-running owner must renew
 * (renewRunLease heartbeat) to hold past this — the bounded delay after which
 * an orphaned lease is reclaimable even when its pid appears alive (pid reuse,
 * hung owner). A lease whose pid is DEAD is reclaimable immediately, with no
 * TTL wait.
 */
export const DEFAULT_RUN_LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * Absolute ceiling on a lease's age before it is reclaimable even when its pid
 * is alive and its TTL has not expired (L2). Covers the recycled-PID class (a
 * dead owner's pid reused by an unrelated process) and a runaway owner that
 * keeps renewing a lease it no longer legitimately holds: no single run in
 * this package legitimately outlives 24h, so any lease older than this is
 * stale by definition. Belt-and-suspenders alongside the TTL expiry.
 */
export const MAX_RUN_LEASE_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Task 8: Checkpointing & Crash Recovery ─────────────────────────────────

export interface RunCheckpoint {
  runId: string;
  taskId: string;
  status: string;
  worktreePath?: string;
  branch?: string;
  output?: string;
  timestamp: string;
}

export interface RunCheckpointState {
  runId: string;
  status: "active" | "completed" | "failed" | "recovered";
  checkpoints: RunCheckpoint[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export async function createRunState(runId: string, _cwd?: string): Promise<RunCheckpointState> {
  const now = new Date().toISOString();
  return { runId, status: "active", checkpoints: [], startedAt: now, updatedAt: now };
}

/**
 * True for values shaped like a persisted RunCheckpoint (taskId + timestamp
 * are required fields). Used to extract legacy checkpoints out of a resume
 * journal written by the pre-P0-4 saveCheckpoint, without mistaking real
 * agent-call journal entries (whose `result` is an arbitrary agent result)
 * for checkpoints.
 */
function isRunCheckpoint(value: unknown): value is RunCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as RunCheckpoint;
  return typeof candidate.taskId === "string" && typeof candidate.timestamp === "string";
}

function checkpointsFromJournal(state: PersistedRunState): RunCheckpoint[] {
  return (state.journal || []).map((j) => j.result).filter(isRunCheckpoint);
}

export async function saveCheckpoint(runId: string, checkpoint: RunCheckpoint, cwd?: string): Promise<void> {
  // Compare-and-swap against the freshest snapshot: a checkpoint written while
  // the manager's throttled persist is mid-cycle can never clobber (or be
  // clobbered by) a concurrently-journaled entry — the mutation is re-applied
  // to the snapshot that is current at write time.
  const result = await updateRunState(
    runId,
    (state) => {
      // Checkpoints live in checkpoints[], never in journal[]: the resume path
      // replays journal entries as call hashes, so a checkpoint written there
      // could fake a cache hit for a changed checkpoint (P0-4). Dedupe by
      // taskId and update in place so first-seen order is preserved.
      state.checkpoints = state.checkpoints ?? [];
      const at = state.checkpoints.findIndex((c) => c.taskId === checkpoint.taskId);
      if (at >= 0) state.checkpoints[at] = checkpoint;
      else state.checkpoints.push(checkpoint);
    },
    cwd,
  );
  if (!result) throw new Error(`Run ${runId} not found`);
}

export async function loadRunState(runId: string, cwd?: string): Promise<RunCheckpointState | null> {
  const persistence = createRunPersistence(cwd || process.cwd());
  const state = persistence.load(runId);
  if (!state) return null;
  return {
    runId: state.runId,
    status: state.status === "completed" ? "completed" : state.status === "failed" ? "failed" : "active",
    checkpoints: state.checkpoints ?? checkpointsFromJournal(state),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
  };
}

export async function listActiveRuns(cwd?: string): Promise<RunCheckpointState[]> {
  const persistence = createRunPersistence(cwd || process.cwd());
  const runs = persistence.list();
  return runs
    .filter((r) => r.status === "running" || r.status === "paused")
    .map((r) => ({
      runId: r.runId,
      status: "active" as const,
      checkpoints: r.checkpoints ?? checkpointsFromJournal(r),
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
    }));
}

export async function resumeRun(runId: string, cwd?: string): Promise<RunCheckpointState> {
  // CAS status flip: the freshest snapshot keeps its journal/checkpoints.
  const result = await updateRunState(
    runId,
    (state) => {
      state.status = "running";
    },
    cwd,
  );
  if (!result) throw new Error(`Run ${runId} not found`);
  return loadRunState(runId, cwd) as Promise<RunCheckpointState>;
}

export async function cleanupRun(runId: string, cwd?: string): Promise<void> {
  // No-op when the run is missing (matches the pre-CAS behavior).
  await updateRunState(
    runId,
    (state) => {
      state.status = "completed";
      state.completedAt = new Date().toISOString();
    },
    cwd,
  );
}

// ─── Exported CAS primitives (manager slice coordination) ─────────────────────

/**
 * Compare-and-swap primitive: apply `mutate` to the freshest on-disk snapshot
 * of `runId` and persist atomically (tmp + rename), retrying when a concurrent
 * writer lands between the read and the rename — merging onto the newer
 * snapshot instead of overwriting it. Returns the persisted state, or null
 * when the run does not exist (nothing is written). The mutation must be
 * idempotent: on a concurrent-modification retry it is re-applied to the newer
 * snapshot (e.g. upsert a journal entry by key, or set a status).
 */
export async function updateRunState(
  runId: string,
  mutate: (state: PersistedRunState) => void,
  cwd?: string,
): Promise<PersistedRunState | null> {
  return createRunPersistence(cwd || process.cwd()).updateRunState?.(runId, mutate) ?? null;
}

/**
 * Lease heartbeat: push the owner's lease expiry forward so a long-running
 * owner is never evicted by the bounded-delay reclaim (see
 * DEFAULT_RUN_LEASE_TTL_MS). Returns false when this process no longer owns
 * the lease (it was lost to a reclaim).
 */
export function renewRunLease(lease: RunLease, cwd?: string): boolean {
  return createRunPersistence(cwd || process.cwd()).renewRunLease?.(lease) ?? false;
}
