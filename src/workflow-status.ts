/**
 * Non-blocking Multi-tasking & File Conflict Detection (Task 9).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Type-only: erased at compile, so the lock module gains no runtime dependency
// on the gateway layer (same pattern as subagent-host-tools.ts).
import type { HostToolsBundle } from "./gateway/host-tool-gateway.js";
import type { ToolExecutor } from "./gateway/types.js";
import { createRunPersistence, type PersistedRunState, type RunStatus } from "./run-persistence.js";
import { safeSetTimeout } from "./timing.js";

export interface WorkflowStatus {
  runId: string;
  phase: number;
  activeTasks: number;
  completedTasks: number;
  totalTasks: number;
  isRunning: boolean;
  startedAt: string;
}

export interface FileLock {
  filePath: string;
  runId: string;
  taskId: string;
  lockedAt: string;
  expiresAt: string;
}

/** Default time-to-live for a file lock in ms: stale holders can be reclaimed after this. */
const DEFAULT_LOCK_TTL_MS = 300000;

/** Options for acquireFileLock's bounded wait on a live (unexpired) holder. */
interface AcquireFileLockOptions {
  /**
   * Keep polling for the lock when a live holder owns it. 0/omitted fails fast
   * (the historical behavior); a positive value bounds the total wait.
   */
  waitMs?: number;
  /** Poll interval while waiting for a live holder to release or expire. */
  pollIntervalMs?: number;
}

const RUNNING_OR_PAUSED: ReadonlySet<RunStatus> = new Set(["running", "paused"]);

/** On-disk lock record: public FileLock plus a random per-acquire owner token. */
interface LockFileRecord extends FileLock {
  token: string;
}

function lockDir(): string {
  return join(process.cwd(), ".pi", "workflows", "locks");
}

function lockKey(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

function lockPathFor(filePath: string): string {
  return join(lockDir(), `${lockKey(filePath)}.json`);
}

/** Map a persisted run onto the public WorkflowStatus shape. */
function toWorkflowStatus(state: PersistedRunState, runId: string): WorkflowStatus {
  const completedTasks = state.agents.filter((agent) => agent.status === "done").length;
  const phaseIndex = state.currentPhase ? state.phases.indexOf(state.currentPhase) : -1;
  return {
    runId,
    phase: phaseIndex >= 0 ? phaseIndex : 0,
    activeTasks: state.agents.length - completedTasks,
    completedTasks,
    totalTasks: state.agents.length,
    isRunning: state.status === "running",
    startedAt: state.startedAt,
  };
}

/**
 * Read the lock file at `path`; returns it only while it is a valid,
 * unexpired holder. Corrupt, empty, or expired files count as stale.
 */
async function readActiveLock(path: string, now: number): Promise<LockFileRecord | null> {
  try {
    const data = await readFile(path, "utf-8");
    const lock = JSON.parse(data) as LockFileRecord;
    if (lock.filePath && new Date(lock.expiresAt).getTime() > now) return lock;
  } catch {
    // Unreadable/corrupt lock -> treated as stale, never as a live holder.
  }
  return null;
}

/** Outcome of probing an existing lock file for reclamation. */
type StaleProbe = { kind: "live" } | { kind: "stale"; record: LockFileRecord } | { kind: "corrupt" };

/**
 * Classify an existing lock file: live (valid unexpired holder), stale (an
 * expired record we may reclaim), or corrupt (unparseable garbage).
 */
async function probeLock(path: string, now: number): Promise<StaleProbe> {
  try {
    const data = await readFile(path, "utf-8");
    const lock = JSON.parse(data) as LockFileRecord;
    if (lock.filePath && new Date(lock.expiresAt).getTime() > now) return { kind: "live" };
    return { kind: "stale", record: lock };
  } catch {
    return { kind: "corrupt" };
  }
}

/**
 * Delete a stale lock file ONLY when its on-disk content is still the exact
 * record we read — closes the read→unlink TOCTOU where a lock that another
 * process reclaimed (with a fresh token) between our read and our unlink
 * would otherwise be destroyed.
 */
async function unlinkIfUnchanged(lockPath: string, expected: LockFileRecord): Promise<boolean> {
  try {
    const current = JSON.parse(await readFile(lockPath, "utf-8")) as LockFileRecord;
    if (current.token !== expected.token) return false;
    await unlink(lockPath);
    return true;
  } catch {
    // Vanished or unreadable between read and unlink: someone else reclaimed
    // it (or is mid-reclaim) — back off rather than delete blindly.
    return false;
  }
}

/**
 * One atomic acquire attempt: exclusive-create the lock file; on EEXIST,
 * reclaim a stale/corrupt holder via a content-verified unlink and retry once.
 */
async function tryAcquireOnce(
  lockPath: string,
  filePath: string,
  runId: string,
  taskId: string,
  now: number,
  ttl: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const lock: LockFileRecord = {
      filePath,
      runId,
      taskId,
      lockedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      token: `${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
    };
    try {
      // Exclusive create (O_EXCL): an atomic check-and-create — racing
      // processes cannot both pass a read-then-write check on the same path.
      await createLockFileExclusive(lockPath, lock);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }
    const probe = await probeLock(lockPath, now);
    if (probe.kind === "live") return false;
    if (probe.kind === "corrupt") {
      // Garbage file with no owner to protect: delete it and let the next
      // attempt re-create. A failed unlink means someone else reclaimed it.
      try {
        await unlink(lockPath);
      } catch {
        return false;
      }
      continue;
    }
    // Expired holder: reclaim only if nobody has re-acquired since our read.
    if (!(await unlinkIfUnchanged(lockPath, probe.record))) return false;
  }
  return false;
}

/**
 * Exclusive-create a lock file with a bounded retry for the transient Windows
 * race where a path just released (unlinked by the holder) is still held
 * pending-deletion by the OS for a few ms and CREATE_NEW fails EPERM/EACCES
 * instead of EEXIST — the poller can land exactly on the release boundary
 * (same cadence as the WPA-01 rename retry, fs-persistence.ts). EEXIST is NOT
 * retried here: it means a live holder and is handled by the probe/reclaim
 * path in {@link tryAcquireOnce}; genuine persistent EPERM/EACCES (permission
 * problems) survive the bounded window and propagate unchanged.
 */
async function createLockFileExclusive(lockPath: string, lock: LockFileRecord): Promise<void> {
  const payload = JSON.stringify(lock, null, 2);
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(lockPath, payload, { flag: "wx" });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EPERM" && code !== "EACCES") throw err;
      if (attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export async function acquireFileLock(
  filePath: string,
  runId: string,
  taskId: string,
  ttl: number = DEFAULT_LOCK_TTL_MS,
  options: AcquireFileLockOptions = {},
): Promise<boolean> {
  const dir = lockDir();
  await mkdir(dir, { recursive: true });
  const lockPath = lockPathFor(filePath);
  const deadline = options.waitMs ? Date.now() + options.waitMs : 0;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  while (true) {
    if (await tryAcquireOnce(lockPath, filePath, runId, taskId, Date.now(), ttl)) return true;
    // A live holder with no wait budget fails fast (historical behavior).
    if (!deadline) return false;
    if (Date.now() >= deadline) return false;
    // unref'd so a polling wait never pins the event loop on its own —
    // matches the timing.ts safe-timer contract used across the codebase.
    await new Promise<void>((resolve) => {
      safeSetTimeout(resolve, pollIntervalMs).unref();
    });
  }
}

/**
 * @internal
 *
 * Deliberately kept exported for library/test callers — see the lock-primitives
 * note at src/index.ts:383-393 ("no live claimer yet").
 *
 * Extend a lock's TTL so a still-working holder is not reclaimed as stale
 * (the holder must refresh before expiry). Refuses to renew a lock owned by a
 * different runId, and rotates the owner token so a concurrent reclaimer that
 * read the old record backs off (content-verified unlink mismatch) instead of
 * deleting the renewed lock.
 */
export async function renewFileLock(
  filePath: string,
  runId: string,
  ttl: number = DEFAULT_LOCK_TTL_MS,
): Promise<boolean> {
  const lockPath = lockPathFor(filePath);
  // Only the initial read+parse is an expected, recoverable failure: a missing
  // lock file (ENOENT) means "nothing we own to renew", and a corrupt record
  // is treated the same way (logged so the failure stays observable). Genuine
  // write/rename errors (EACCES, ENOSPC, cross-device rename, EEXIST on the
  // temp) are NOT caught here — they propagate so a caller can distinguish
  // "no lock owned by me" from "disk/io failure".
  let lock: LockFileRecord;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf-8")) as LockFileRecord;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      console.warn(`[workflow-status] renewFileLock: unreadable lock ${lockPath}`, code ?? err);
    }
    return false;
  }
  if (!lock.filePath || lock.runId !== runId) return false;
  const now = Date.now();
  const renewed: LockFileRecord = {
    ...lock,
    lockedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    token: `${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
  // Write via a temp file + atomic rename so a concurrent reader never sees
  // a truncated lock, and the rotated token makes our own read→unlink
  // reclamation (or another process's) safely miss.
  const tmp = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(renewed, null, 2), { flag: "wx" });
    await rename(tmp, lockPath);
  } catch (err) {
    // ENOENT is benign here (the temp was never written or already cleaned up
    // by a concurrent renewer), but EACCES/EPERM/ENOSPC would signal a
    // systemic permission/disk problem worth observing rather than masking
    // behind the rethrown write/rename error.
    try {
      await unlink(tmp);
    } catch (cleanupErr) {
      if ((cleanupErr as { code?: string }).code !== "ENOENT") {
        console.warn(
          `[workflow-status] renewFileLock: temp cleanup failed ${tmp}`,
          (cleanupErr as { code?: string }).code ?? cleanupErr,
        );
      }
    }
    throw err;
  }
  return true;
}

export async function getWorkflowStatus(runId?: string): Promise<WorkflowStatus | null> {
  if (!runId) return null;
  const state = createRunPersistence(process.cwd()).load(runId);
  if (!state) return null;
  return toWorkflowStatus(state, runId);
}

export async function listRunningWorkflows(): Promise<WorkflowStatus[]> {
  return createRunPersistence(process.cwd())
    .list()
    .filter((run) => RUNNING_OR_PAUSED.has(run.status))
    .map((run) => toWorkflowStatus(run, run.runId));
}

export async function releaseFileLock(filePath: string, runId: string): Promise<boolean> {
  const lockPath = lockPathFor(filePath);
  const now = Date.now();
  const lock = await readActiveLock(lockPath, now);
  if (lock) {
    if (lock.runId !== runId) return false; // another owner holds a live lock
    try {
      await unlink(lockPath);
    } catch {
      return false;
    }
    return true;
  }
  // No active holder (already released, expired, or corrupt): clear any stale
  // artifact so a later acquire isn't blocked by a dead file.
  try {
    await unlink(lockPath);
  } catch {
    // Nothing to clear.
  }
  return true;
}

export async function checkFileConflict(
  filePath: string,
): Promise<{ locked: boolean; runId?: string; taskId?: string }> {
  const lock = await readActiveLock(lockPathFor(filePath), Date.now());
  if (lock) return { locked: true, runId: lock.runId, taskId: lock.taskId };
  return { locked: false };
}

// ---------------------------------------------------------------------------
// Worktree write-conflict interceptor (PRD Task 9, audit G7 + B3)
// ---------------------------------------------------------------------------
// The host bundle's write executors are wrapped so a main-session (or proxied)
// edit targeting a file claimed by an active worktree queues behind the holder
// (bounded) or blocks with a structured JSON tool error naming the run/task.
// B3 made the interceptor LIVE: guarded writes claim the target file for the
// edit duration (claimOnWrite, default true), so checkFileConflict sees real
// locks at runtime and a conflicting concurrent edit is actually blocked — the
// claimer side is no longer dormant. Read-only executors are never touched.
// Lock keys are exact-string, so the caller must claim with the same path
// spelling the guard checks with.

/** Host-bundle tool names that mutate files; everything else is left untouched. */
export const WORKFLOW_WRITE_TOOL_NAMES: readonly string[] = ["edit", "write"];

/** How long an edit may queue behind a live worktree holder before blocking. */
const DEFAULT_WORKTREE_CONFLICT_WAIT_MS = 5000;

/** Stable machine-readable code carried by the structured block error. */
export const WORKTREE_CONFLICT_BLOCK_CODE = "FILE_LOCKED_BY_WORKTREE";

/** Lock owner recorded when this seam takes over a freed/expired lock. */
const INTERACTIVE_SESSION_OWNER = { runId: "interactive-session", taskId: "manual-edit" };

/** Queue/owner knobs for {@link guardWorktreeWriteConflicts}. */
export interface WorktreeWriteGuardOptions {
  /** Bounded wait behind a live holder (0/omitted = default 5s). */
  waitMs?: number;
  /** Poll interval while waiting for a live holder to release or expire. */
  pollIntervalMs?: number;
  /** TTL for the lock this seam acquires while performing the guarded edit. */
  lockTtlMs?: number;
  /**
   * Run identity recorded on the claim this seam holds while a guarded edit
   * runs (default "interactive-session"). The claim-on-write claimer (B3)
   * makes every guarded write create a live lock, so a conflicting concurrent
   * edit sees THIS identity in the block error.
   */
  ownerRunId?: string;
  /** Task identity recorded on the claim this seam holds during a guarded edit. */
  ownerTaskId?: string;
  /**
   * Whether guarded write executors CLAIM the target file for the duration of
   * every edit (default true, B3): the interceptor is LIVE — the first edit
   * creates a lock that a concurrent conflicting edit sees and queues behind
   * (or blocks on after the bounded wait). false restores the legacy G7
   * contract exactly: the interceptor only fires on an EXISTING claim and an
   * unclaimed edit creates no lock.
   */
  claimOnWrite?: boolean;
}

/** Structured JSON tool-error payload naming the conflicting worktree run/task. */
interface WorktreeConflictBlockPayload {
  error: "file_locked_by_worktree";
  code: string;
  filePath: string;
  runId?: string;
  taskId?: string;
  message: string;
}

/**
 * Build the structured block payload for a claimed file. Pure and deterministic
 * so tests can assert on the exact shape without driving a real lock.
 */
function buildWorktreeConflictBlockError(
  filePath: string,
  conflict: { runId?: string; taskId?: string },
): WorktreeConflictBlockPayload {
  const owner = conflict.runId ? `workflow run '${conflict.runId}'` : "an active workflow run";
  const task = conflict.taskId ? ` (task '${conflict.taskId}')` : "";
  return {
    error: "file_locked_by_worktree",
    code: WORKTREE_CONFLICT_BLOCK_CODE,
    filePath,
    runId: conflict.runId,
    taskId: conflict.taskId,
    message:
      `File '${filePath}' is claimed by ${owner}${task}; ` +
      "the edit was blocked to avoid racing the worktree subagent. " +
      "Wait for the run to finish, or retry once the file lock expires.",
  };
}

/** Resolve guard options onto their defaults. */
function resolveGuardOptions(options: WorktreeWriteGuardOptions): Required<WorktreeWriteGuardOptions> {
  return {
    waitMs: options.waitMs ?? DEFAULT_WORKTREE_CONFLICT_WAIT_MS,
    pollIntervalMs: options.pollIntervalMs ?? 100,
    lockTtlMs: options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
    ownerRunId: options.ownerRunId ?? INTERACTIVE_SESSION_OWNER.runId,
    ownerTaskId: options.ownerTaskId ?? INTERACTIVE_SESSION_OWNER.taskId,
    claimOnWrite: options.claimOnWrite ?? true,
  };
}

/**
 * Wrap one host write executor with the claim → bounded queue → block flow
 * (B3 live claimer). With claimOnWrite (default true) EVERY guarded write
 * claims the file for the duration of the edit, so checkFileConflict sees a
 * live lock at runtime and a concurrent conflicting edit queues behind it or
 * blocks — the interceptor is no longer inert. The lock is held only for the
 * edit duration, so the claim→write window cannot race a concurrent claimer
 * and a success never leaves a stale lock behind. claimOnWrite: false keeps
 * the legacy G7 flow: check first, pass through unclaimed files untouched.
 */
function createGuardedWriteExecutor(inner: ToolExecutor, options: Required<WorktreeWriteGuardOptions>): ToolExecutor {
  return async (args, signal) => {
    const filePath = typeof args?.path === "string" && args.path.length > 0 ? args.path : undefined;
    if (!filePath) return inner(args, signal);
    // Legacy mode: the interceptor fires only when the file is already claimed.
    if (!options.claimOnWrite) {
      const conflict = await checkFileConflict(filePath);
      // Unclaimed file: the interceptor does not fire, and no lock is created.
      if (!conflict.locked) return inner(args, signal);
    }
    // Claim the file for the edit duration (live claimer). A live holder means
    // queue behind it (bounded wait; reclaims an expired/stale holder), then
    // proceed while we own the lock.
    const acquired = await acquireFileLock(filePath, options.ownerRunId, options.ownerTaskId, options.lockTtlMs, {
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    if (!acquired) {
      // Re-read the holder AFTER the failed wait so the block names the run
      // that actually owns the file now (fresher than the pre-wait probe).
      const conflict = await checkFileConflict(filePath);
      return {
        content: JSON.stringify(buildWorktreeConflictBlockError(filePath, conflict), null, 2),
        isError: true,
      };
    }
    try {
      return await inner(args, signal);
    } finally {
      await releaseFileLock(filePath, options.ownerRunId);
    }
  };
}

/**
 * Wrap a host tool bundle so its write executors are conflict-guarded. Returns
 * a new bundle sharing toolDefs; non-write executors keep their original
 * references (read-only operations are unaffected).
 */
export function guardWorktreeWriteConflicts(
  bundle: HostToolsBundle,
  options: WorktreeWriteGuardOptions = {},
): HostToolsBundle {
  const resolved = resolveGuardOptions(options);
  const tools = new Map(bundle.tools);
  for (const name of WORKFLOW_WRITE_TOOL_NAMES) {
    const inner = bundle.tools.get(name);
    if (inner) tools.set(name, createGuardedWriteExecutor(inner, resolved));
  }
  return { ...bundle, tools };
}

/** Options for {@link createWorktreeWriteClaimer}. */
export interface WorktreeWriteClaimerOptions {
  /** Run identity recorded on every claim (and named in block errors). */
  runId: string;
  /** Task identity recorded on every claim. */
  taskId: string;
  /** Lock TTL in ms (default {@link DEFAULT_LOCK_TTL_MS}). */
  ttlMs?: number;
}

/** The run-identity claimer surface ({@link createWorktreeWriteClaimer}). */
export interface WorktreeWriteClaimer {
  /**
   * Claim a file for this run: true when claimed (or already owned by this
   * run — re-entrant), false when a DIFFERENT live run owns it (never stolen).
   */
  claim(filePath: string): Promise<boolean>;
  /** Release one claim depth for the file (outermost release touches the lock). */
  release(filePath: string): Promise<boolean>;
  /** Wrap one write executor so it claims the file for the edit duration. */
  wrapExecutor(inner: ToolExecutor): ToolExecutor;
}

/**
 * A run-identity claimer for the worktree side (B3): claims files a worktree
 * run is editing so the guard's conflict check sees LIVE locks at runtime and
 * a conflicting subagent edit queues or blocks with the run/task named.
 *
 * Claim semantics:
 *  - Re-entrant: a claim on a file this run already owns just deepens the
 *    in-memory depth (an outer guard takeover or a nested claimer of the same
 *    run never self-blocks).
 *  - Non-stealing: a claim on a file owned by a DIFFERENT live run returns
 *    false and leaves their lock untouched — their guard is the arbiter that
 *    serializes us (we queue/block there); this claimer never steals a lock.
 *  - Balanced: {@link WorktreeWriteClaimer.release} mirrors the claim depth,
 *    so nested wraps of the same run release only at the outermost level.
 *
 * The per-run wiring site (the run's agent() tool construction, where runId
 * and taskId live) is owned by the runtime layer; this primitive ships the
 * mechanism plus a wrapExecutor for that wiring.
 */
export function createWorktreeWriteClaimer(options: WorktreeWriteClaimerOptions): WorktreeWriteClaimer {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  /** Per-file claim depth so nested wraps of the same run stay balanced. */
  const depth = new Map<string, number>();

  return {
    async claim(filePath: string): Promise<boolean> {
      const conflict = await checkFileConflict(filePath);
      // Already owned by this run (an outer claimer / the guard's takeover):
      // re-entrant — count the nesting, do not re-acquire.
      if (conflict.locked && conflict.runId === options.runId) {
        depth.set(filePath, (depth.get(filePath) ?? 0) + 1);
        return true;
      }
      // Owned by a DIFFERENT live run: do not touch their lock — proceeding
      // unclaimed lets their guard be the arbiter (we queue/block there).
      if (conflict.locked) return false;
      const acquired = await acquireFileLock(filePath, options.runId, options.taskId, ttlMs, { waitMs: 0 });
      if (acquired) depth.set(filePath, (depth.get(filePath) ?? 0) + 1);
      return acquired;
    },
    async release(filePath: string): Promise<boolean> {
      const current = depth.get(filePath) ?? 0;
      if (current <= 1) {
        depth.delete(filePath);
        return releaseFileLock(filePath, options.runId);
      }
      depth.set(filePath, current - 1);
      return true;
    },
    /**
     * Wrap one write executor: claim the target file for the edit duration,
     * release in finally (including on failure/abort). A foreign live holder
     * means the claim yields false and the edit still proceeds — never steal.
     */
    wrapExecutor(inner: ToolExecutor): ToolExecutor {
      return async (args, signal) => {
        const filePath = typeof args?.path === "string" && args.path.length > 0 ? args.path : undefined;
        if (!filePath) return inner(args, signal);
        await this.claim(filePath);
        try {
          return await inner(args, signal);
        } finally {
          await this.release(filePath);
        }
      };
    },
  };
}
