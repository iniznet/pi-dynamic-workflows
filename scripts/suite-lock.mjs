/**
 * Cross-invocation lock for the unit-suite runner (scripts/run-tests.mjs).
 *
 * WHY THIS EXISTS: the CPU audit (tasks/cpu-agent-testing/report.md §2 F1)
 * traced sustained 100%-CPU reports to STACKED suite invocations — the node
 * test runner defaults to `availableParallelism() - 1` file workers, so even
 * two capped runs oversubscribed this 16-core box (m2-fanout2: 86.8% avg /
 * 98.9% peak / 133s > 80%). Nothing stopped N `test:unit` invocations from
 * running at once. This module makes a second invocation WAIT instead.
 *
 * Lock key: the git COMMON dir (`git rev-parse --git-common-dir`, resolved to
 * an absolute path) so every worktree of this repo shares ONE lock file —
 * two worktrees of the same repo are the same suite. Fallback when the cwd is
 * not a git repo: the resolved cwd itself. The lock file lives in os.tmpdir(),
 * never in the repo, so it cannot dirty a worktree or be clobbered by a clean.
 *
 * Acquire is an exclusive atomic create (`flag: "wx"`) of the complete payload
 * in one syscall — strictly stronger than the tmp-write + rename idiom for a
 * CLAIM, because rename-over is non-exclusive (a concurrent claimant would
 * silently overwrite the holder's lock and both would run). The re-read race
 * guard then verifies our token survived the create. The Windows-EPERM retry
 * mirrors src/workflow-status.ts:196-204 (release-boundary race) and the
 * content-verified stale steal mirrors its reclaim path.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { readFile as readFileAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * How long to wait for a live holder before giving up. 10 minutes: a cap-2
 * full suite is ~4 minutes wall (measured 296s at cap 2, 162s at cap 4), so
 * 10 min is ~2x the longest single suite and the fork-safety margin against a
 * stuck holder; the cost of waiting too long is one clean exit-2 message, the
 * cost of waiting too little is a false failure.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROGRESS_EVERY_MS = 15_000;
// Mirrors the bounded EPERM/EACCES window of createLockFileExclusive
// (src/workflow-status.ts:198-204) and the WPA-01 rename retry (fs-persistence).
const RETRY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 20;

/** @typedef {{ pid: number; startedAt: string; hostname: string; token: string }} SuiteLockRecord */

/**
 * Local HH:MM:SS for progress and timeout messages. Falls back to the raw
 * value when the record's ISO timestamp is not parseable.
 * @param {string} iso
 * @returns {string}
 */
export function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** True when `pid` names a live process. EPERM means the process exists but is not signalable (Windows). */
function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Read + shape-verify the lock record. Returns null when the file is missing,
 * unparseable, or not a valid lock payload — callers decide how to react.
 * @param {string} lockPath
 * @returns {Promise<SuiteLockRecord | null>}
 */
export async function readLockRecord(lockPath) {
  try {
    const raw = await readFileAsync(lockPath, "utf-8");
    return parseLockRecord(raw);
  } catch {
    return null;
  }
}

/**
 * Synchronous variant for process-exit handlers, where only sync code runs.
 * @param {string} lockPath
 * @returns {SuiteLockRecord | null}
 */
export function readLockRecordSync(lockPath) {
  try {
    return parseLockRecord(readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} raw
 * @returns {SuiteLockRecord | null}
 */
function parseLockRecord(raw) {
  const parsed = JSON.parse(raw);
  if (
    typeof parsed?.pid !== "number" ||
    typeof parsed?.startedAt !== "string" ||
    typeof parsed?.hostname !== "string" ||
    typeof parsed?.token !== "string"
  ) {
    return null;
  }
  return { pid: parsed.pid, startedAt: parsed.startedAt, hostname: parsed.hostname, token: parsed.token };
}

/**
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function runGitCommonDir(cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git rev-parse exited with code ${code}`));
      }
    });
  });
}

/**
 * Stable lock-key base for `cwd`: the absolute git COMMON dir, or the
 * resolved cwd when git is unavailable / the cwd is not a repo. `gitRunner` is
 * injectable so tests never depend on a real git binary.
 * @param {string} [cwd]
 * @param {(cwd: string) => Promise<string>} [gitRunner]
 * @returns {Promise<string>}
 */
export async function resolveLockBaseKey(cwd = process.cwd(), gitRunner = runGitCommonDir) {
  try {
    const commonDir = (await gitRunner(cwd)).trim();
    if (commonDir) return path.resolve(cwd, commonDir);
  } catch {
    // Not a git repo (or git missing): per-cwd fallback below.
  }
  return path.resolve(cwd);
}

/**
 * @param {string} commonDir
 * @returns {string}
 */
export function lockPathForCommonDir(commonDir) {
  const hash = createHash("sha1").update(commonDir).digest("hex");
  return path.join(tmpdir(), `pi-dynamic-workflows-suite-${hash}.lock`);
}

/**
 * @param {string} [cwd]
 * @param {(cwd: string) => Promise<string>} [gitRunner]
 * @returns {Promise<string>}
 */
export async function suiteLockPath(cwd = process.cwd(), gitRunner = runGitCommonDir) {
  return lockPathForCommonDir(await resolveLockBaseKey(cwd, gitRunner));
}

/**
 * @returns {SuiteLockRecord}
 */
function makeLockRecord() {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    token: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
}

/**
 * @param {string} raw
 * @returns {number}
 */
function resolveEnvTimeoutMs(raw) {
  if (!raw) return DEFAULT_LOCK_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`PI_TEST_LOCK_TIMEOUT_MS must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * @param {SuiteLockRecord | null} heldBy
 * @returns {string}
 */
function waitMessage(heldBy) {
  if (heldBy) {
    return `waiting on suite lock (held by pid ${heldBy.pid} since ${formatClock(heldBy.startedAt)})...`;
  }
  return "waiting on suite lock...";
}

/**
 * Wait-loop sleep. Ref'd, NOT unref'd: an unref'd timer would let this single-
 * purpose CLI's event loop drain while `await acquireSuiteLock()` is still
 * pending — verified live: the runner exited 0 mid-wait with no output. The
 * unref'd safe-timer idiom (src/workflow-status.ts:220) exists for long-lived
 * hosts that have other live handles; for a lock-waiting CLI the wait IS the
 * process's only job, and a 1s ref'd poll is the work, not a busy-spin.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded EPERM/EACCES retry around a state-changing fs op — the release-
 * boundary window where Windows still holds a just-released path pending
 * deletion (see src/workflow-status.ts:196-204). Non-EPERM failures propagate.
 * @template T
 * @param {() => Promise<T>} op
 * @param {(error: unknown) => boolean} isRetryable
 * @returns {Promise<T>}
 */
async function withEpermRetry(op, isRetryable) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (!isRetryable(error) || attempt >= RETRY_ATTEMPTS - 1) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Exclusive claim: one atomic syscall publishes the complete payload — no torn
 * reads, no double-hold. EEXIST means a live claimant; EPERM/EACCES is the
 * transient Windows window and is retried.
 * @param {string} lockPath
 * @param {SuiteLockRecord} lock
 * @returns {Promise<boolean>}
 */
async function claimLock(lockPath, lock) {
  const payload = JSON.stringify(lock, null, 2);
  try {
    await withEpermRetry(
      () => writeFileAsync(lockPath, payload, { flag: "wx" }),
      (error) => error?.code === "EPERM" || error?.code === "EACCES",
    );
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Content-verified stale steal: delete the dead holder's lock only when the
 * file still carries the exact record we probed — a concurrent reclaimer that
 * won the race since our read must not have its lock deleted.
 * @param {string} lockPath
 * @param {SuiteLockRecord} probed
 * @returns {Promise<boolean>}
 */
async function stealLock(lockPath, probed) {
  const fresh = await readLockRecord(lockPath);
  if (!fresh || fresh.token !== probed.token) return false;
  try {
    await withEpermRetry(
      () => unlinkAsync(lockPath),
      (error) => error?.code === "EPERM" || error?.code === "EACCES",
    );
    return true;
  } catch (error) {
    // ENOENT: someone else already reclaimed — treat as stolen.
    return error?.code === "ENOENT";
  }
}

/**
 * Re-read race guard: after a successful create, confirm the file still holds
 * OUR token. With exclusive create this can only fail if an external actor
 * deleted/replaced the file between create and re-read; treat it as contention
 * and re-enter the wait loop rather than assume we hold.
 * @param {string} lockPath
 * @param {string} token
 * @returns {Promise<boolean>}
 */
async function ownsLock(lockPath, token) {
  const record = await readLockRecord(lockPath);
  return record !== null && record.token === token;
}

/**
 * Acquire the suite lock, waiting (with progress prints) until the holder
 * releases or its pid dies (stale steal), or until the timeout.
 *
 * Env contract:
 *   PI_TEST_LOCK=0            — skip locking entirely (fast no-op).
 *   PI_TEST_LOCK_TIMEOUT_MS   — wait cap (default DEFAULT_LOCK_TIMEOUT_MS).
 * @param {Partial<{
 *   cwd: string;
 *   timeoutMs: number;
 *   pollIntervalMs: number;
 *   progressEveryMs: number;
 *   disabled: boolean;
 *   gitRunner: (cwd: string) => Promise<string>;
 *   log: (message: string) => void;
 * }>} [options]
 * @returns {Promise<
 *   | { ok: true; skipped: true; lockPath: null; lock: null; waitedMs: 0 }
 *   | { ok: true; skipped: false; lockPath: string; lock: SuiteLockRecord; waitedMs: number }
 *   | { ok: false; reason: "timeout"; lockPath: string; heldBy: SuiteLockRecord | null; waitedMs: number }
 * >}
 */
export async function acquireSuiteLock(options = {}) {
  const disabled = options.disabled ?? process.env.PI_TEST_LOCK === "0";
  if (disabled) return { ok: true, skipped: true, lockPath: null, lock: null, waitedMs: 0 };

  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? resolveEnvTimeoutMs(process.env.PI_TEST_LOCK_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const progressEveryMs = options.progressEveryMs ?? DEFAULT_PROGRESS_EVERY_MS;
  const log = options.log ?? ((message) => console.error(message));
  const gitRunner = options.gitRunner ?? runGitCommonDir;

  const lockPath = await suiteLockPath(cwd, gitRunner);
  const lock = makeLockRecord();
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastHeldBy = null;

  while (true) {
    if (await claimLock(lockPath, lock)) {
      if (await ownsLock(lockPath, lock.token)) {
        return { ok: true, skipped: false, lockPath, lock, waitedMs: Date.now() - startedAt };
      }
      // Lost the re-read race: an external actor replaced our lock — re-enter
      // the wait loop and probe who holds it now.
    }
    const heldBy = await readLockRecord(lockPath);
    if (heldBy !== null && !holderAlive(heldBy.pid)) {
      if (await stealLock(lockPath, heldBy)) continue;
    }
    lastHeldBy = heldBy;
    if (Date.now() >= deadline) {
      return { ok: false, reason: "timeout", lockPath, heldBy: lastHeldBy, waitedMs: Date.now() - startedAt };
    }
    if (progressEveryMs > 0 && Date.now() - lastProgressAt >= progressEveryMs) {
      log(waitMessage(lastHeldBy));
      lastProgressAt = Date.now();
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Release the lock ONLY if we still own it (token match) — a non-owner's
 * release must never delete a newer holder's lock. Idempotent, best-effort.
 * @param {string} lockPath
 * @param {string} token
 * @returns {Promise<void>}
 */
export async function releaseSuiteLock(lockPath, token) {
  if (!lockPath || !token) return;
  const record = await readLockRecord(lockPath);
  if (record === null || record.token !== token) return;
  try {
    await withEpermRetry(
      () => unlinkAsync(lockPath),
      (error) => error?.code === "EPERM" || error?.code === "EACCES",
    );
  } catch {
    // Best-effort: a leftover lock is reclaimed as stale by the next acquirer.
  }
}

/**
 * Synchronous release for process-exit / signal handlers.
 * @param {string} lockPath
 * @param {string} token
 * @returns {void}
 */
export function releaseSuiteLockSync(lockPath, token) {
  if (!lockPath || !token) return;
  const record = readLockRecordSync(lockPath);
  if (record === null || record.token !== token) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Best-effort (see releaseSuiteLock).
  }
}
