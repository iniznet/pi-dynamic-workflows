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
  status: "queued" | "running" | "done" | "error" | "skipped";
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

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
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
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
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
    return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  };

  // Bound the number of terminal (completed/failed/aborted) runs kept on
  // disk (see DEFAULT_MAX_TERMINAL_RUNS_ON_DISK) — called after every save()
  // whose state is terminal, since that's the only time the terminal count
  // can grow. Running/paused runs are never candidates: they're filtered out
  // before the cap is even considered.
  const enforceRetention = () => {
    const terminal = computeList()
      .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    const excess = terminal.length - maxTerminalRunsOnDisk;
    if (excess <= 0) return;
    for (const run of terminal.slice(0, excess)) {
      deleteRunFiles(run.runId);
    }
    invalidateListCache();
  };

  const deleteRunFiles = (runId: string): boolean => {
    let deleted = false;
    for (const path of candidateRunPaths(runId)) {
      const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
      // Best-effort cleanup of the sidecar files alongside the primary.
      for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(dir, runId)]) {
        unlinkIfExistsSafe(fs, sidecar);
        fileStateCache.delete(sidecar);
      }
      if (unlinkIfExistsSafe(fs, path)) deleted = true;
      fileStateCache.delete(path);
    }
    return deleted;
  };

  // ── Compare-and-swap persistence (core-orchestration:f3/i2) ──────────────

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
  // always migrated to the current schema.
  const parseFreshest = (runId: string): PersistedRunState | null => {
    for (const path of candidateRunPaths(runId)) {
      const raw = readJsonWithBackupRecovery<unknown>(fs, path);
      if (raw !== null) return migrateRunState(raw);
    }
    return null;
  };

  // Serialize once; scrub secrets only when the serialized form actually
  // contains a secret pattern (the common path stays single-stringify).
  const serializeRedacted = (state: PersistedRunState): string => {
    const json = JSON.stringify(state, null, 2);
    if (!SECRET_DETECTION_RE.test(json)) return json;
    return JSON.stringify(redactSecrets(JSON.parse(json) as PersistedRunState), null, 2);
  };

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
   * The CAS core every write funnels through (save(), updateRunState()):
   * re-read the freshest on-disk snapshot, apply `produce` to it, write
   * atomically (tmp + rename), and verify the write landed — retrying on any
   * concurrent modification detected between the read and the rename. A stale
   * in-memory snapshot can no longer overwrite a newer on-disk journal or a
   * concurrently-added checkpoint, because the mutation is always re-applied
   * to the snapshot that is CURRENT at write time. Cross-process writers
   * converge the same way: the writer whose rename lands second re-reads the
   * first writer's content, merges, and rewrites. Bounded retries — under
   * sustained contention the last produced snapshot is persisted without
   * verification (last-writer-wins beats failing a run forever).
   */
  const casWrite = (
    runId: string,
    produce: (current: PersistedRunState | null) => PersistedRunState,
    requireExisting = false,
  ): PersistedRunState | null => {
    ensureDir();
    const path = primaryRunPath(runId);
    let last: PersistedRunState | undefined;
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
      const before = readPrimaryText(runId);
      const current = parseFreshest(runId);
      if (requireExisting && current === null) return null;
      const next = produce(current);
      next.updatedAt = new Date().toISOString();
      next.schemaVersion = RUN_STATE_SCHEMA_VERSION;
      // Journal byte budget: bounded disk writes on huge runs. The count check
      // is cheap, so the (stringify-heavy) byte check only runs when it can
      // matter — typical runs never pay for it.
      if (next.journal && next.journal.length > JOURNAL_BYTE_CHECK_THRESHOLD) {
        next.journal = capJournalBudget(next.journal, DEFAULT_JOURNAL_BYTE_BUDGET);
      }
      last = next;
      const json = serializeRedacted(next);
      _writeFileSync(`${path}.tmp`, json);
      const mid = readPrimaryText(runId);
      // Another writer replaced the file since our read → re-read and merge
      // onto THEIR snapshot instead of overwriting it.
      if (mid !== before) continue;
      _renameSync(`${path}.tmp`, path);
      const landed = readPrimaryText(runId);
      if (landed === json) {
        try {
          _writeFileSync(`${path}.bak`, json);
        } catch {
          // Backup is best-effort; the primary write already succeeded.
        }
        invalidateListCache();
        if (TERMINAL_RUN_STATUSES.has(next.status)) enforceRetention();
        return next;
      }
      // Our rename lost a race against another writer → retry on the fresh base.
    }
    // Sustained contention: last-writer-wins rather than failing the run. The
    // loop above always assigns `last` on its first iteration
    // (CAS_MAX_ATTEMPTS > 0); this guard only satisfies the type system.
    if (last === undefined) {
      throw new Error(`unreachable: casWrite loop did not execute for ${runId}`);
    }
    const json = serializeRedacted(last);
    writeJsonAtomicWithBackup(fs, path, JSON.parse(json) as PersistedRunState);
    invalidateListCache();
    if (TERMINAL_RUN_STATUSES.has(last.status)) enforceRetention();
    return last;
  };

  return {
    save(state: PersistedRunState) {
      // Compare-and-swap: the incoming state is layered onto the freshest
      // on-disk snapshot so a concurrently-persisted journal or checkpoint is
      // never clobbered (see casWrite). Checkpoints are merged (both lists
      // survive); the journal merge keeps entries the caller didn't write
      // while letting the caller's own entries win per (runId, index).
      casWrite(state.runId, (current) => {
        return {
          ...(current ?? {}),
          ...state,
          checkpoints: mergeCheckpoints(current?.checkpoints, state.checkpoints),
          journal: mergeJournalFields(current, state),
        };
      });
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
        invalidateListCache();
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
          // expiry; a dead pid or an expired lease (bounded-delay reclaim) is
          // stale and gets replaced below.
          if (existing && existing.runPath === path && pidIsAlive(existing.pid) && !leaseIsExpired(existing)) {
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
        _writeFileSync(primaryLockPath(lease.runId), JSON.stringify(existing, null, 2));
        return true;
      } catch {
        return false;
      }
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
const REDACTION_RULES: ReadonlyArray<{ re: RegExp; replace: string }> = [
  { re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, replace: "[REDACTED]" },
  { re: /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, replace: "[REDACTED]" },
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: "$1 [REDACTED]" },
  {
    re: /\b([A-Za-z][A-Za-z0-9_-]{1,}(?:_?(?:API_KEY|APIKEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|BEARER)))\b\s*["']?\s*[:=]\s*["']?([^\s,;'"}]+)/g,
    replace: "$1=[REDACTED]",
  },
  { re: /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, replace: "[REDACTED]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[REDACTED]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "[REDACTED]" },
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: "[REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{16}/g, replace: "[REDACTED]" },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g, replace: "[REDACTED]" },
];

// Non-global union used to decide whether a serialized state needs scrubbing
// at all — the common (secret-free) persist path stays single-stringify.
const SECRET_DETECTION_RE = new RegExp(REDACTION_RULES.map((rule) => rule.re.source).join("|"));

/** Mask provider API keys/secrets inside a single string. */
export function redactText(text: string): string {
  let out = text;
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
 * Byte budget for a persisted journal. Only enforced once the entry count
 * makes it worth the stringify cost (see JOURNAL_BYTE_CHECK_THRESHOLD), so
 * the hot persist path never pays for it.
 */
export const DEFAULT_JOURNAL_BYTE_BUDGET = 32 * 1024 * 1024;

const JOURNAL_BYTE_CHECK_THRESHOLD = 10_000;

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
