/**
 * B3 claimer tests: the write-conflict interceptor is LIVE.
 *
 * Covers:
 *  - createWorktreeWriteClaimer: run-identity claims visible to
 *    checkFileConflict at runtime, wrapExecutor claim-for-the-edit-duration,
 *    re-entrancy for the same run, and never stealing a foreign run's lock.
 *  - guardWorktreeWriteConflicts claimOnWrite (default TRUE): a guarded edit
 *    claims the file for its edit duration, so a concurrent conflicting edit
 *    queues or blocks with the structured JSON error — the blocking is no
 *    longer dormant; claimOnWrite: false restores the legacy pass-through.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { HostToolsBundle } from "../../src/gateway/host-tool-gateway.js";
import type { ToolCallResult, ToolExecutor } from "../../src/gateway/types.js";
import {
  acquireFileLock,
  checkFileConflict,
  createWorktreeWriteClaimer,
  guardWorktreeWriteConflicts,
  releaseFileLock,
  WORKTREE_CONFLICT_BLOCK_CODE,
} from "../../src/workflow-status.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` inside a temp cwd so lock files land in the temp `.pi` dir.
 * Returns the wrapper WITHOUT executing it (the runner invokes it per test),
 * so the chdir happens at test-run time, never at registration.
 */
function withStatusEnv(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), "worktree-claimer-"));
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await fn();
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** A host bundle whose write executors are observable stubs. */
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

describe("createWorktreeWriteClaimer (B3 live claimer)", () => {
  test(
    "a claim is LIVE: checkFileConflict sees it and the guard blocks a conflicting edit naming the run",
    withStatusEnv(async () => {
      const claimer = createWorktreeWriteClaimer({ runId: "run-9", taskId: "task-3" });
      assert.equal(await claimer.claim("src/claimed.ts"), true);
      // The claim is visible at runtime — no longer dormant.
      assert.deepEqual(await checkFileConflict("src/claimed.ts"), {
        locked: true,
        runId: "run-9",
        taskId: "task-3",
      });

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
      assert.equal(result.isError, true, "an edit against a live claimer claim must block");
      assert.equal(editCalled, false, "the inner editor must never run for a blocked edit");
      const payload = JSON.parse(result.content) as Record<string, unknown>;
      assert.equal(payload.error, "file_locked_by_worktree");
      assert.equal(payload.code, WORKTREE_CONFLICT_BLOCK_CODE);
      assert.equal(payload.filePath, "src/claimed.ts");
      assert.equal(payload.runId, "run-9", "the block must name the worktree run that claimed the file");
      assert.equal(payload.taskId, "task-3");

      assert.equal(await claimer.release("src/claimed.ts"), true);
      assert.deepEqual(await checkFileConflict("src/claimed.ts"), { locked: false });
    }),
  );

  test(
    "wrapExecutor claims for the edit duration and releases in finally (even on failure)",
    withStatusEnv(async () => {
      const claimer = createWorktreeWriteClaimer({ runId: "run-5", taskId: "task-5" });
      let sawClaimDuringEdit = false;
      const wrapped = claimer.wrapExecutor(async () => {
        const conflict = await checkFileConflict("src/w.ts");
        sawClaimDuringEdit = conflict.locked && conflict.runId === "run-5";
        return { content: "ok", isError: false } as ToolCallResult;
      });
      const result = await wrapped({ path: "src/w.ts" });
      assert.equal(result.isError, false);
      assert.equal(sawClaimDuringEdit, true, "the claim must be live DURING the edit");
      assert.deepEqual(await checkFileConflict("src/w.ts"), { locked: false }, "released after the edit");

      // Failure path: a throwing inner must still release the claim.
      const failing = claimer.wrapExecutor(async () => {
        throw new Error("boom");
      });
      await assert.rejects(failing({ path: "src/w.ts" }), /boom/);
      assert.deepEqual(await checkFileConflict("src/w.ts"), { locked: false }, "released after a failing edit");
    }),
  );

  test(
    "claims are re-entrant for the same run and balanced across nested wraps",
    withStatusEnv(async () => {
      const claimer = createWorktreeWriteClaimer({ runId: "run-1", taskId: "task-1" });
      assert.equal(await claimer.claim("src/nested.ts"), true);
      assert.equal(await claimer.claim("src/nested.ts"), true, "a same-run claim is re-entrant");
      // Still ONE on-disk lock for the nested depth.
      const conflict = await checkFileConflict("src/nested.ts");
      assert.equal(conflict.locked, true);
      assert.equal(conflict.runId, "run-1");
      // Releasing one depth leaves the lock held (outer wrap still active).
      assert.equal(await claimer.release("src/nested.ts"), true);
      assert.equal((await checkFileConflict("src/nested.ts")).locked, true, "inner release must not drop the lock");
      assert.equal(await claimer.release("src/nested.ts"), true);
      assert.deepEqual(await checkFileConflict("src/nested.ts"), { locked: false });
    }),
  );

  test(
    "a claimer never steals a lock held by a different run",
    withStatusEnv(async () => {
      assert.equal(await acquireFileLock("src/other.ts", "run-1", "task-1"), true);
      const claimer = createWorktreeWriteClaimer({ runId: "run-2", taskId: "task-2" });
      assert.equal(await claimer.claim("src/other.ts"), false, "a foreign live holder must not be stolen");
      const conflict = await checkFileConflict("src/other.ts");
      assert.equal(conflict.runId, "run-1", "the foreign lock survives the refused claim");
      // The refused claimer's release is a harmless no-op on the foreign lock.
      assert.equal(await claimer.release("src/other.ts"), false);
      assert.equal((await checkFileConflict("src/other.ts")).runId, "run-1");
      assert.equal(await releaseFileLock("src/other.ts", "run-1"), true);
    }),
  );
});

describe("guardWorktreeWriteConflicts claimOnWrite (B3)", () => {
  test(
    "DEFAULT: a guarded edit claims the file for its duration, so a concurrent conflicting edit blocks",
    withStatusEnv(async () => {
      let innerCalls = 0;
      const guarded = guardWorktreeWriteConflicts(
        makeHostBundle({
          edit: async () => {
            innerCalls++;
            // Hold the claim while editing so the concurrent edit is truly racing.
            await sleep(60);
            return { content: "edited", isError: false };
          },
        }),
        { waitMs: 0 },
      );
      const edit = guarded.tools.get("edit") as ToolExecutor;

      // First edit starts and claims the file.
      const first = edit({ path: "src/shared.ts" });
      await sleep(20);
      // Second edit of the SAME file while the first holds its claim → block.
      const second = await edit({ path: "src/shared.ts" });
      assert.equal(second.isError, true, "a conflicting concurrent edit must block on the live claim");
      const payload = JSON.parse(second.content) as Record<string, unknown>;
      assert.equal(payload.error, "file_locked_by_worktree");
      assert.equal(payload.code, WORKTREE_CONFLICT_BLOCK_CODE);
      assert.equal(payload.filePath, "src/shared.ts");
      const firstResult = await first;
      assert.equal(firstResult.isError, false);
      assert.equal(innerCalls, 1, "the blocked edit must never reach the inner executor");
      assert.deepEqual(await checkFileConflict("src/shared.ts"), { locked: false }, "claims release per edit");
    }),
  );

  test(
    "claimOnWrite: false restores the legacy pass-through — unclaimed edits create no lock and do not block",
    withStatusEnv(async () => {
      let editCalled = 0;
      const guarded = guardWorktreeWriteConflicts(
        makeHostBundle({
          edit: async () => {
            editCalled++;
            return { content: "edited", isError: false };
          },
        }),
        { waitMs: 0, claimOnWrite: false },
      );
      const edit = guarded.tools.get("edit") as ToolExecutor;
      const [a, b] = await Promise.all([edit({ path: "src/free.ts" }), edit({ path: "src/free.ts" })]);
      assert.equal(a.isError, false);
      assert.equal(b.isError, false, "legacy mode never blocks unclaimed edits");
      assert.equal(editCalled, 2);
      assert.deepEqual(await checkFileConflict("src/free.ts"), { locked: false }, "no lock created in legacy mode");

      // Legacy mode still blocks an edit on a file claimed by a worktree run.
      await acquireFileLock("src/claimed-legacy.ts", "run-1", "task-7");
      const blocked = await edit({ path: "src/claimed-legacy.ts" });
      assert.equal(blocked.isError, true);
      const payload = JSON.parse(blocked.content) as Record<string, unknown>;
      assert.equal(payload.runId, "run-1");
      assert.equal(payload.taskId, "task-7");
      await releaseFileLock("src/claimed-legacy.ts", "run-1");
    }),
  );
});
