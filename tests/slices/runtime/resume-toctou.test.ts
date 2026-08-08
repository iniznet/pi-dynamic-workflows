import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PersistedRunState } from "../../../src/run-persistence.js";
import { WorkflowManager } from "../../../src/workflow-manager.js";
import { rmForce } from "../../helpers/rm-force.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-runtime-"));
    try {
      await fn(cwd);
    } finally {
      await rmForce(cwd);
    }
  };
}

/** An agent that hangs forever — lets a test pause a run mid-flight. */
function hangingAgent(quick: (prompt: string) => unknown) {
  return {
    async run(prompt: string, options?: { onUsage?: (u: unknown) => void }): Promise<any> {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
      return quick(prompt);
    },
  };
}

test(
  "M23: resume re-validates status UNDER the acquired lease — a concurrent completion refuses the resume",
  withTempCwd(async (cwd) => {
    // First execution: 'a' completes, 'b' hangs -> pause it (status "paused").
    const calls = { b: 0 };
    const agent = hangingAgent((prompt) => {
      if (prompt === "b") {
        calls.b++;
        return new Promise(() => {});
      }
      return `${prompt}-result`;
    });
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'toctou_demo', description: 'resume race' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(script, undefined);
    promise.catch(() => {});
    for (let i = 0; i < 200 && calls.b === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.b, 1, "'b' is in flight before pausing");
    assert.equal(manager.pause(runId), true);

    // Simulate the TOCTOU: the first (advisory) load inside resume() sees the
    // paused state; a "concurrent process" completes the run before the
    // post-lease re-validation — the second load must see "completed" and
    // refuse, releasing the lease, without starting a partial execution.
    const persistence = manager.getPersistence();
    const originalLoad = persistence.load.bind(persistence);
    let loads = 0;
    persistence.load = (id: string) => {
      loads++;
      const state = originalLoad(id);
      if (loads >= 2 && state) return { ...state, status: "completed" as const };
      return state;
    };

    let resumed = false;
    manager.on("resumed", () => {
      resumed = true;
    });

    assert.equal(await manager.resume(runId), false, "resume refuses once the post-lease state is completed");
    assert.equal(resumed, false, "no 'resumed' event fired for the refused resume");
    assert.ok(loads >= 2, "resume re-loaded the state under the lease (M23)");

    // The lease acquired during the refused resume was released again.
    const lease = persistence.acquireRunLease(runId);
    assert.ok(lease, "the refused resume released its lease");
    if (lease) persistence.releaseRunLease(lease);

    // The on-disk state is untouched (still paused — our simulated completion
    // was only visible to resume's re-load, not written).
    const persisted: PersistedRunState | null = originalLoad(runId);
    assert.equal(persisted?.status, "paused", "the freshest on-disk state is unchanged");
  }),
);
