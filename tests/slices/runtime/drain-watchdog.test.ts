import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowManager } from "../../../src/workflow-manager.js";

/** Isolated cwd per test so run state never leaks between tests. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-runtime-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test(
  "drain watchdog (H1): a never-settling un-awaited agent cannot wedge run completion past the drain grace",
  withTempCwd(async (cwd) => {
    // The agent IGNORES its abort signal and never settles — the exact wedge
    // H1 guards against (un-awaited agent() + signal-ignoring runner + no
    // per-agent timeout). The manager-level drain grace (drainTimeoutMs) must
    // bound the completion, mark the run terminal on disk, and release the
    // lease so a later process can resume/re-run.
    const neverSettles = {
      async run() {
        return new Promise<never>(() => {});
      },
    };
    const manager = new WorkflowManager({ cwd, agent: neverSettles });

    const script = `export const meta = { name: 'drain_watchdog', description: 'un-awaited hang' }
agent('never')  // deliberately NOT awaited
return 'done'`;

    const started = Date.now();
    const { runId, promise } = manager.startInBackground(script, undefined, { drainTimeoutMs: 200 });
    const result = await promise;

    assert.equal(result.result, "done", "the script's own result is preserved");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `run completed within a bounded time (took ${elapsed}ms)`);

    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.status, "completed", "the run is terminal on disk, not a ghost 'running'");

    const lease = manager.getPersistence().acquireRunLease(runId);
    assert.ok(lease, "the lease was released after the terminal settle");
    if (lease) manager.getPersistence().releaseRunLease(lease);
  }),
);
