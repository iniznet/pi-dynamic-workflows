/**
 * Type declarations for scripts/suite-lock.mjs (plain ESM, no tsx).
 * NodeNext resolves `import ".../suite-lock.mjs"` from TS to this file.
 */

export interface SuiteLockRecord {
  pid: number;
  startedAt: string;
  hostname: string;
  token: string;
}

export interface SuiteLockOptions {
  cwd?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  progressEveryMs?: number;
  disabled?: boolean;
  gitRunner?: (cwd: string) => Promise<string>;
  log?: (message: string) => void;
}

export type SuiteLockAcquired = {
  ok: true;
  skipped: false;
  lockPath: string;
  lock: SuiteLockRecord;
  waitedMs: number;
};

export type SuiteLockSkipped = {
  ok: true;
  skipped: true;
  lockPath: null;
  lock: null;
  waitedMs: 0;
};

export type SuiteLockTimeout = {
  ok: false;
  reason: "timeout";
  lockPath: string;
  heldBy: SuiteLockRecord | null;
  waitedMs: number;
};

export type AcquireResult = SuiteLockAcquired | SuiteLockSkipped | SuiteLockTimeout;

export const DEFAULT_LOCK_TIMEOUT_MS: number;

export function formatClock(iso: string): string;
export function readLockRecord(lockPath: string): Promise<SuiteLockRecord | null>;
export function readLockRecordSync(lockPath: string): SuiteLockRecord | null;
export function resolveLockBaseKey(cwd?: string, gitRunner?: (cwd: string) => Promise<string>): Promise<string>;
export function lockPathForCommonDir(commonDir: string): string;
export function suiteLockPath(cwd?: string, gitRunner?: (cwd: string) => Promise<string>): Promise<string>;
export function acquireSuiteLock(options?: SuiteLockOptions): Promise<AcquireResult>;
export function releaseSuiteLock(lockPath: string, token: string): Promise<void>;
export function releaseSuiteLockSync(lockPath: string, token: string): void;
