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
      await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: "wx" });
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
// Worktree write-conflict interceptor (PRD Task 9, audit G7)
// ---------------------------------------------------------------------------
// The host bundle's write executors are wrapped so a main-session (or proxied)
// edit targeting a file claimed by an active worktree queues behind the holder
// (bounded) or blocks with a structured JSON tool error naming the run/task.
// Read-only executors are never touched. Lock keys are exact-string, so the
// caller must claim with the same path spelling the guard checks with.

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
  /** Run identity recorded when the seam takes over a freed lock. */
  ownerRunId?: string;
  /** Task identity recorded when the seam takes over a freed lock. */
  ownerTaskId?: string;
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
  };
}

/**
 * Wrap one host write executor with the conflict check → bounded queue →
 * block flow. The acquired lock is held only for the duration of the edit, so
 * the check→write window cannot race a concurrent claimer, and a success never
 * leaves a stale interactive-session lock behind.
 */
function createGuardedWriteExecutor(inner: ToolExecutor, options: Required<WorktreeWriteGuardOptions>): ToolExecutor {
  return async (args, signal) => {
    const filePath = typeof args?.path === "string" && args.path.length > 0 ? args.path : undefined;
    if (!filePath) return inner(args, signal);
    const conflict = await checkFileConflict(filePath);
    // Unclaimed file: the interceptor does not fire, and no lock is created.
    if (!conflict.locked) return inner(args, signal);
    // Claimed by an active worktree: queue behind the holder (bounded wait;
    // reclaims an expired/stale holder), then proceed while we own the lock.
    const acquired = await acquireFileLock(filePath, options.ownerRunId, options.ownerTaskId, options.lockTtlMs, {
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    if (!acquired) {
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
