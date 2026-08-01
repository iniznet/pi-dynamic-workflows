/**
 * Non-blocking Multi-tasking & File Conflict Detection (Task 9).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRunPersistence, type PersistedRunState, type RunStatus } from "./run-persistence.js";

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
export const DEFAULT_LOCK_TTL_MS = 300000;

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

export async function acquireFileLock(
  filePath: string,
  runId: string,
  taskId: string,
  ttl: number = DEFAULT_LOCK_TTL_MS,
): Promise<boolean> {
  const dir = lockDir();
  await mkdir(dir, { recursive: true });
  const lockPath = lockPathFor(filePath);
  const now = Date.now();
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
      // Exclusive create (O_EXCL): atomic claim — racing processes cannot
      // both pass a read-then-write check on the same path.
      await writeFile(lockPath, JSON.stringify(lock, null, 2), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      if (await readActiveLock(lockPath, now)) return false;
      // Stale/corrupt holder: reclaim its file and retry the exclusive create.
      try {
        await unlink(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
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
