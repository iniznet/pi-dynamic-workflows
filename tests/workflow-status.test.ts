/**
 * Unit tests for the non-blocking multi-tasking module (Task 9):
 * file conflict detection and workflow status queries.
 */

import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import {
  acquireFileLock,
  checkFileConflict,
  getWorkflowStatus,
  listRunningWorkflows,
  releaseFileLock,
  renewFileLock,
} from "../src/workflow-status.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function makeRunState(
  runId: string,
  status: PersistedRunState["status"],
  overrides: Partial<PersistedRunState> = {},
): PersistedRunState {
  return {
    runId,
    workflowName: "demo",
    script: "export const meta = { name: 'demo', description: 'demo' }",
    status,
    phases: ["plan", "execute", "review"],
    currentPhase: "execute",
    agents: [],
    logs: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Run `fn` inside a temp cwd with a temp fake home, so persisted runs land
 * under the fake homedir (workflowProjectPaths) instead of the real one.
 */
function withStatusEnv(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-status-"));
    const home = await mkdtemp(join(tmpdir(), "workflow-status-home-"));
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await withFakeHomeAsync(home, () => fn(dir));
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  };
}

describe("file locking", () => {
  it(
    "acquires a lock that does not exist yet",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1"), true);
    }),
  );

  it(
    "refuses a second acquire while the lock is active",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1"), true);
      assert.equal(await acquireFileLock("src/a.ts", "run-2", "task-2"), false);
    }),
  );

  it(
    "allows different files to lock independently",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1"), true);
      assert.equal(await acquireFileLock("src/b.ts", "run-1", "task-1"), true);
    }),
  );

  it(
    "releaseFileLock frees the path for the next acquirer",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1"), true);
      assert.equal(await releaseFileLock("src/a.ts", "run-1"), true);
      assert.equal(await acquireFileLock("src/a.ts", "run-2", "task-2"), true);
    }),
  );

  it(
    "an expired lock (TTL) can be acquired again",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1", 50), true);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(await acquireFileLock("src/a.ts", "run-2", "task-2", 5000), true);
    }),
  );

  it(
    "checkFileConflict reports the locking run and task",
    withStatusEnv(async () => {
      await acquireFileLock("src/a.ts", "run-1", "task-7");
      const conflict = await checkFileConflict("src/a.ts");
      assert.equal(conflict.locked, true);
      assert.equal(conflict.runId, "run-1");
      assert.equal(conflict.taskId, "task-7");
    }),
  );

  it(
    "checkFileConflict reports unlocked after release",
    withStatusEnv(async () => {
      await acquireFileLock("src/a.ts", "run-1", "task-1");
      await releaseFileLock("src/a.ts", "run-1");
      assert.deepEqual(await checkFileConflict("src/a.ts"), { locked: false });
    }),
  );

  it(
    "rejects a non-owner release while the lock is active",
    withStatusEnv(async () => {
      await acquireFileLock("src/a.ts", "run-1", "task-1");
      assert.equal(await releaseFileLock("src/a.ts", "run-2"), false);
      // The owner's lock is untouched by the rejected release.
      const conflict = await checkFileConflict("src/a.ts");
      assert.equal(conflict.locked, true);
      assert.equal(conflict.runId, "run-1");
      assert.equal(await releaseFileLock("src/a.ts", "run-1"), true);
      assert.deepEqual(await checkFileConflict("src/a.ts"), { locked: false });
    }),
  );

  it(
    "two concurrent acquire attempts yield exactly one winner",
    withStatusEnv(async () => {
      const results = await Promise.all([
        acquireFileLock("src/a.ts", "run-1", "task-1"),
        acquireFileLock("src/a.ts", "run-2", "task-2"),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
    }),
  );

  it(
    "renewFileLock extends the TTL so a working holder is not reclaimed as stale",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1", 80), true);
      // Renew shortly before the original TTL would expire.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await renewFileLock("src/a.ts", "run-1", 5000), true);
      // Wait past the ORIGINAL TTL: the renewed lock must still be live.
      await new Promise((r) => setTimeout(r, 80));
      const conflict = await checkFileConflict("src/a.ts");
      assert.equal(conflict.locked, true, "renewed lock should outlive the original TTL");
      assert.equal(conflict.runId, "run-1");
      // A second acquire still refuses while the renewed lock is live.
      assert.equal(await acquireFileLock("src/a.ts", "run-2", "task-2", 5000), false);
    }),
  );

  it(
    "renewFileLock refuses to renew a lock owned by a different runId",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1", 5000), true);
      assert.equal(await renewFileLock("src/a.ts", "run-2", 5000), false);
      // The owner's lock is untouched.
      const conflict = await checkFileConflict("src/a.ts");
      assert.equal(conflict.locked, true);
      assert.equal(conflict.runId, "run-1");
    }),
  );

  it(
    "renewFileLock fails cleanly when no lock exists",
    withStatusEnv(async () => {
      assert.equal(await renewFileLock("src/none.ts", "run-1", 5000), false);
    }),
  );

  it(
    "a bounded wait acquires the lock once a live holder releases it",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1", 5000), true);
      setTimeout(() => void releaseFileLock("src/a.ts", "run-1"), 120);
      // With no wait budget the acquire fails fast against the live holder…
      assert.equal(await acquireFileLock("src/a.ts", "run-2", "task-2", 5000), false);
      // …but with a bounded wait it polls until the holder releases.
      assert.equal(
        await acquireFileLock("src/a.ts", "run-2", "task-2", 5000, { waitMs: 1000, pollIntervalMs: 20 }),
        true,
      );
    }),
  );

  it(
    "a bounded wait gives up when the live holder never releases",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1", 5000), true);
      const start = Date.now();
      assert.equal(
        await acquireFileLock("src/a.ts", "run-2", "task-2", 5000, { waitMs: 150, pollIntervalMs: 20 }),
        false,
        "must fail once the wait budget is exhausted",
      );
      assert.ok(Date.now() - start >= 120, "should actually wait, not fail instantly");
      // The owner's lock survives the failed wait.
      const conflict = await checkFileConflict("src/a.ts");
      assert.equal(conflict.locked, true);
      assert.equal(conflict.runId, "run-1");
    }),
  );

  it(
    "an expired lock is reclaimed by a bounded wait even when the holder never releases",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/a.ts", "run-1", "task-1", 60), true);
      assert.equal(
        await acquireFileLock("src/a.ts", "run-2", "task-2", 5000, { waitMs: 2000, pollIntervalMs: 20 }),
        true,
        "stale (expired) holder should be reclaimed within the wait",
      );
      const conflict = await checkFileConflict("src/a.ts");
      assert.equal(conflict.runId, "run-2", "the new owner holds the lock");
    }),
  );
});

describe("getWorkflowStatus", () => {
  it(
    "returns null when the run does not exist",
    withStatusEnv(async () => {
      assert.equal(await getWorkflowStatus("missing-run"), null);
    }),
  );

  it(
    "returns null when no run id is given",
    withStatusEnv(async () => {
      assert.equal(await getWorkflowStatus(), null);
    }),
  );

  it(
    "returns a persisted run with phase and task progress",
    withStatusEnv(async (dir) => {
      createRunPersistence(dir).save(
        makeRunState("run-9", "running", {
          currentPhase: "review",
          agents: [
            { id: 0, label: "a", prompt: "p", status: "done" },
            { id: 1, label: "b", prompt: "p", status: "done" },
            { id: 2, label: "c", prompt: "p", status: "running" },
          ],
        }),
      );
      const status = await getWorkflowStatus("run-9");
      assert.ok(status);
      assert.equal(status.phase, 2); // index of "review" in phases
      assert.equal(status.completedTasks, 2);
      assert.equal(status.totalTasks, 3);
      assert.equal(status.activeTasks, 1);
      assert.equal(status.isRunning, true);
      assert.equal(status.startedAt, "2026-01-01T00:00:00.000Z");
    }),
  );

  it(
    "reports isRunning false for a persisted paused run",
    withStatusEnv(async (dir) => {
      createRunPersistence(dir).save(makeRunState("run-p", "paused"));
      const status = await getWorkflowStatus("run-p");
      assert.ok(status);
      assert.equal(status.isRunning, false);
    }),
  );
});

describe("listRunningWorkflows", () => {
  it(
    "returns persisted running and paused runs, excluding terminal ones",
    withStatusEnv(async (dir) => {
      const rp = createRunPersistence(dir);
      rp.save(makeRunState("run-running", "running"));
      rp.save(makeRunState("run-paused", "paused"));
      rp.save(makeRunState("run-done", "completed"));
      const running = await listRunningWorkflows();
      assert.deepEqual(running.map((r) => r.runId).sort(), ["run-paused", "run-running"]);
      assert.ok(running.every((r) => r.isRunning === (r.runId === "run-running")));
    }),
  );

  it(
    "returns an empty list when nothing is running",
    withStatusEnv(async (dir) => {
      createRunPersistence(dir).save(makeRunState("run-done", "failed"));
      assert.deepEqual(await listRunningWorkflows(), []);
    }),
  );
});
