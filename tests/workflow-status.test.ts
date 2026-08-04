/**
 * Unit tests for the non-blocking multi-tasking module (Task 9):
 * file conflict detection and workflow status queries.
 */

import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostToolsBundle } from "../src/gateway/host-tool-gateway.js";
import type { ToolCallResult, ToolExecutor } from "../src/gateway/types.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import {
  acquireFileLock,
  checkFileConflict,
  getWorkflowStatus,
  guardWorktreeWriteConflicts,
  listRunningWorkflows,
  releaseFileLock,
  renewFileLock,
  WORKFLOW_WRITE_TOOL_NAMES,
  WORKTREE_CONFLICT_BLOCK_CODE,
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

describe("worktree write-conflict interceptor", () => {
  /** Build a host bundle whose executors are plain, observable stubs. */
  function makeHostBundle(executors: Record<string, ToolExecutor>): HostToolsBundle {
    return {
      tools: new Map(Object.entries(executors)),
      toolDefs: Object.keys(executors).map((name) => ({
        name,
        description: `test ${name}`,
        inputSchema: { type: "object" },
        source: "host" as const,
      })),
    };
  }

  it(
    "blocks a main-session edit on a file claimed by an active worktree with the structured JSON error",
    withStatusEnv(async () => {
      await acquireFileLock("src/claimed.ts", "run-1", "task-7");
      let editCalled = false;
      const guarded = guardWorktreeWriteConflicts(
        makeHostBundle({
          edit: async () => {
            editCalled = true;
            return { content: "edited", isError: false };
          },
        }),
        { waitMs: 0 },
      );
      const result = await (guarded.tools.get("edit") as ToolExecutor)({ path: "src/claimed.ts" });
      assert.equal(result.isError, true, "a claimed-file edit must surface as an error result");
      assert.equal(editCalled, false, "the inner editor must never run for a blocked edit");
      const payload = JSON.parse(result.content) as Record<string, unknown>;
      assert.equal(payload.error, "file_locked_by_worktree");
      assert.equal(payload.code, WORKTREE_CONFLICT_BLOCK_CODE);
      assert.equal(payload.filePath, "src/claimed.ts");
      assert.equal(payload.runId, "run-1");
      assert.equal(payload.taskId, "task-7");
      assert.match(payload.message as string, /workflow run 'run-1'/);
      assert.match(payload.message as string, /task 'task-7'/);
    }),
  );

  it(
    "leaves read-only executors untouched and free to run on claimed files",
    withStatusEnv(async () => {
      await acquireFileLock("src/claimed.ts", "run-1", "task-7");
      const readInner: ToolExecutor = async (args) => ({ content: `read ${args.path}`, isError: false });
      const guarded = guardWorktreeWriteConflicts(
        makeHostBundle({
          read: readInner,
          edit: async () => ({ content: "x", isError: false }),
        }),
      );
      assert.equal(guarded.tools.get("read"), readInner, "read executor must keep its identity");
      const result = await (guarded.tools.get("read") as ToolExecutor)({ path: "src/claimed.ts" });
      assert.equal(result.isError, false);
      assert.equal(result.content, "read src/claimed.ts");
    }),
  );

  it(
    "does not fire for unclaimed files and creates no lock",
    withStatusEnv(async () => {
      let editCalled = false;
      const guarded = guardWorktreeWriteConflicts(
        makeHostBundle({
          edit: async (args) => {
            editCalled = true;
            return { content: `edited ${args.path}`, isError: false };
          },
          write: async () => ({ content: "written", isError: false }),
        }),
        { waitMs: 0 },
      );
      const editResult = await (guarded.tools.get("edit") as ToolExecutor)({ path: "src/free.ts" });
      assert.equal(editResult.isError, false);
      assert.equal(editResult.content, "edited src/free.ts");
      assert.equal(editCalled, true, "an unclaimed edit must reach the inner executor");
      assert.deepEqual(await checkFileConflict("src/free.ts"), { locked: false });
      const writeResult = await (guarded.tools.get("write") as ToolExecutor)({ path: "src/other.ts" });
      assert.equal(writeResult.isError, false);
      assert.equal(writeResult.content, "written");
    }),
  );

  it(
    "queues behind a live holder and proceeds once it releases, leaving no interactive lock",
    withStatusEnv(async () => {
      await acquireFileLock("src/queued.ts", "run-1", "task-1", 5000);
      setTimeout(() => void releaseFileLock("src/queued.ts", "run-1"), 120);
      let editCalled = false;
      const guarded = guardWorktreeWriteConflicts(
        makeHostBundle({
          edit: async () => {
            editCalled = true;
            return { content: "edited", isError: false };
          },
        }),
        { waitMs: 2000, pollIntervalMs: 20 },
      );
      const result = await (guarded.tools.get("edit") as ToolExecutor)({ path: "src/queued.ts" });
      assert.equal(result.isError, false, "the edit must proceed once the holder releases");
      assert.equal(editCalled, true);
      assert.deepEqual(await checkFileConflict("src/queued.ts"), { locked: false });
    }),
  );

  it(
    "wraps only the declared write tool names and shares every other executor",
    withStatusEnv(async () => {
      const inner: ToolExecutor = async () => ({ content: "ok", isError: false }) as ToolCallResult;
      const guarded = guardWorktreeWriteConflicts(
        makeHostBundle({ edit: inner, write: inner, grep: inner, ls: inner, read: inner }),
      );
      assert.deepEqual([...guarded.tools.keys()].sort(), [...WORKFLOW_WRITE_TOOL_NAMES, "grep", "ls", "read"].sort());
      for (const name of ["grep", "ls", "read"]) {
        assert.equal(guarded.tools.get(name), inner, `${name} must keep its original executor`);
      }
      assert.notEqual(guarded.tools.get("edit"), inner, "edit must be wrapped");
      assert.notEqual(guarded.tools.get("write"), inner, "write must be wrapped");
    }),
  );
});
