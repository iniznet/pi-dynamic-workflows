/**
 * Unit tests for the cross-invocation suite lock (scripts/suite-lock.mjs).
 *
 * All tests are hermetic: the git runner is stubbed to throw (exercising the
 * non-repo fallback key), each test gets a fresh temp cwd (so every lock file
 * lands in os.tmpdir() keyed on that cwd), and env vars are snapshot/restored
 * per test. The real two-invocation serialization proof is the Verify phase
 * (two concurrent `npm run test:unit` invocations).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type AcquireResult,
  acquireSuiteLock,
  lockPathForCommonDir,
  readLockRecord,
  releaseSuiteLock,
  resolveLockBaseKey,
  type SuiteLockAcquired,
  type SuiteLockOptions,
  type SuiteLockRecord,
  suiteLockPath,
} from "../scripts/suite-lock.mjs";

/** Stub git runner: throws, so resolveLockBaseKey falls back to path.resolve(cwd). */
const notAGitRepo = async () => {
  throw new Error("not a git repo");
};

const tempDirs: string[] = [];
const heldLocks: { lockPath: string; token: string }[] = [];

async function freshCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "suite-lock-test-"));
  tempDirs.push(dir);
  return dir;
}

function testOptions(cwd: string, extra: Partial<SuiteLockOptions> = {}): SuiteLockOptions {
  return {
    cwd,
    gitRunner: notAGitRepo,
    pollIntervalMs: 20,
    progressEveryMs: 0,
    log: () => {},
    ...extra,
  };
}

/** Narrow an acquire result to the acquired variant, failing otherwise. */
function expectAcquired(result: AcquireResult): SuiteLockAcquired {
  assert.ok(result.ok && !result.skipped, `expected an acquired lock, got ${JSON.stringify(result)}`);
  return result;
}

/** A pid guaranteed to be dead by the time the caller uses it (child already exited). */
async function deadPid(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => {
      if (child.pid !== undefined) resolve(child.pid);
      else reject(new Error("spawned child reported no pid"));
    });
  });
}

let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {
    PI_TEST_LOCK: process.env.PI_TEST_LOCK,
    PI_TEST_LOCK_TIMEOUT_MS: process.env.PI_TEST_LOCK_TIMEOUT_MS,
  };
  delete process.env.PI_TEST_LOCK;
  delete process.env.PI_TEST_LOCK_TIMEOUT_MS;
});

afterEach(async () => {
  for (const held of heldLocks) {
    await releaseSuiteLock(held.lockPath, held.token);
  }
  heldLocks.length = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  for (const [name, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("suite-lock", () => {
  it("acquires an exclusive lock with the documented payload shape", async () => {
    const cwd = await freshCwd();
    const result = expectAcquired(await acquireSuiteLock(testOptions(cwd)));
    heldLocks.push({ lockPath: result.lockPath, token: result.lock.token });

    // Atomic content shape: the lock file is complete, parseable JSON with the
    // documented fields — no torn or partial payload.
    const parsed = JSON.parse(await readFile(result.lockPath, "utf-8")) as SuiteLockRecord;
    assert.equal(parsed.pid, process.pid);
    assert.equal(typeof parsed.startedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(parsed.startedAt)), "startedAt must be a parseable timestamp");
    assert.equal(parsed.hostname, hostname());
    assert.equal(typeof parsed.token, "string");
    assert.ok(parsed.token.length > 0);
    assert.equal(result.lock.token, parsed.token);
  });

  it("blocks a second acquire until the timeout (PI_TEST_LOCK_TIMEOUT_MS)", async () => {
    const cwd = await freshCwd();
    const first = expectAcquired(await acquireSuiteLock(testOptions(cwd)));
    heldLocks.push({ lockPath: first.lockPath, token: first.lock.token });

    process.env.PI_TEST_LOCK_TIMEOUT_MS = "1";
    const second = await acquireSuiteLock(testOptions(cwd));
    assert.ok(!second.ok, "second acquire must time out while the first holds");
    if (!second.ok) {
      assert.equal(second.reason, "timeout");
      assert.equal(second.heldBy?.pid, process.pid, "timeout must report the live holder");
      assert.ok(second.waitedMs >= 0);
    }
  });

  it("waits and proceeds after the holder releases", async () => {
    const cwd = await freshCwd();
    const first = expectAcquired(await acquireSuiteLock(testOptions(cwd)));
    heldLocks.push({ lockPath: first.lockPath, token: first.lock.token });

    const secondPromise = acquireSuiteLock(testOptions(cwd, { timeoutMs: 5_000 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await releaseSuiteLock(first.lockPath, first.lock.token);

    const second = expectAcquired(await secondPromise);
    assert.notEqual(second.lock.token, first.lock.token);
    heldLocks.push({ lockPath: second.lockPath, token: second.lock.token });
  });

  it("steals a stale lock whose holder pid is dead", async () => {
    const cwd = await freshCwd();
    const lockPath = await suiteLockPath(cwd, notAGitRepo);
    const stale: SuiteLockRecord = {
      pid: await deadPid(),
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      token: "stale-token",
    };
    await writeFile(lockPath, JSON.stringify(stale, null, 2), "utf-8");

    const result = expectAcquired(await acquireSuiteLock(testOptions(cwd)));
    heldLocks.push({ lockPath: result.lockPath, token: result.lock.token });
    assert.equal(result.lock.pid, process.pid);
  });

  it("skips locking entirely when PI_TEST_LOCK=0", async () => {
    const cwd = await freshCwd();
    process.env.PI_TEST_LOCK = "0";
    const result = await acquireSuiteLock(testOptions(cwd));
    assert.ok(result.ok);
    assert.equal(result.skipped, true);
    assert.equal(result.lockPath, null);
    // No lock file was created anywhere for this cwd.
    const lockPath = await suiteLockPath(cwd, notAGitRepo);
    assert.equal(await readLockRecord(lockPath), null);
  });

  it("keys the lock on the git common dir so worktrees share one lock", async () => {
    const gitRunner = async () => "C:/repo/main/.git";
    const worktreeA = await suiteLockPath("C:/repo/worktree-a", gitRunner);
    const worktreeB = await suiteLockPath("C:/repo/worktree-b", gitRunner);
    assert.equal(worktreeA, worktreeB);
    assert.ok(worktreeA.includes("pi-dynamic-workflows-suite-"));

    const otherRepo = await suiteLockPath("C:/elsewhere/checkout", async () => "C:/elsewhere/checkout/.git");
    assert.notEqual(worktreeA, otherRepo);
  });

  it("falls back to the resolved cwd when git is unavailable", async () => {
    const dirA = join(tmpdir(), "suite-lock-nogit-a");
    const dirB = join(tmpdir(), "suite-lock-nogit-b");
    assert.equal(await resolveLockBaseKey(dirA, notAGitRepo), dirA);
    assert.equal(await resolveLockBaseKey(dirB, notAGitRepo), dirB);
    assert.notEqual(await suiteLockPath(dirA, notAGitRepo), await suiteLockPath(dirB, notAGitRepo));
    assert.equal(lockPathForCommonDir(dirA), lockPathForCommonDir(dirA));
  });

  it("release removes the lock only for its owner token", async () => {
    const cwd = await freshCwd();
    const acquired = expectAcquired(await acquireSuiteLock(testOptions(cwd)));
    heldLocks.push({ lockPath: acquired.lockPath, token: acquired.lock.token });

    // A non-owner token must not delete the holder's lock.
    await releaseSuiteLock(acquired.lockPath, "not-the-owner-token");
    const stillHeld = await readLockRecord(acquired.lockPath);
    assert.ok(stillHeld !== null);
    assert.equal(stillHeld.token, acquired.lock.token);

    await releaseSuiteLock(acquired.lockPath, acquired.lock.token);
    assert.equal(await readLockRecord(acquired.lockPath), null);
  });
});
