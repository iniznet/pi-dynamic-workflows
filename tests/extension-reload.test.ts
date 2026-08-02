import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseStrandedWorkflowRuntime,
  takeWorkflowRuntime,
  WORKFLOW_EXTENSION_VERSION,
  type WorkflowReloadRuntime,
} from "../src/extension-reload.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Agent that stays running until a deferred resolve is called externally. */
function deferredAgent() {
  const pending = new Map<number, { resolve: (v: unknown) => void }>();
  let callIndex = 0;
  return {
    resolve: (index: number, value: unknown = "done") => pending.get(index)?.resolve(value),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: unknown) => void }) {
        const index = callIndex++;
        return new Promise((resolve) => {
          pending.set(index, { resolve });
        });
      },
    },
  };
}

const twoAgentScript = `export const meta = { name: 'two_agent_ttl', description: 'two agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

/** Run with isolated cwd + HOME so the real manager's persistence stays sandboxed. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-reload-ttl-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-reload-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

function runtime(cwd: string): WorkflowReloadRuntime {
  return {
    cwd,
    extensionVersion: WORKFLOW_EXTENSION_VERSION,
    manager: { marker: cwd } as unknown as WorkflowReloadRuntime["manager"],
    effort: { level: "high" },
  };
}

/** Runtime that counts dispose-fanout invocations (each must be idempotent). */
function disposableRuntime(cwd: string): WorkflowReloadRuntime & { disposeCount: () => number } {
  let disposeCount = 0;
  const value = {
    ...runtime(cwd),
    // The TTL-expiry path pauses stranded runs, so the mock manager must
    // present the minimal listRuns/pause surface (no runs to pause here).
    manager: { listRuns: () => [], pause: () => false } as unknown as WorkflowReloadRuntime["manager"],
    dispose: () => {
      disposeCount++;
    },
    disposeCount: () => disposeCount,
  };
  return value;
}

test("reload handoff transfers the exact live runtime once", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-once`;
  const value = runtime(cwd);
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  assert.equal(takeWorkflowRuntime(cwd), value);
  assert.equal(takeWorkflowRuntime(cwd), undefined, "a second extension generation cannot claim it twice");
});

test("a changed package version is rejected and its live runs are paused for recovery", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-version`;
  const paused: string[] = [];
  const value: WorkflowReloadRuntime = {
    ...runtime(cwd),
    extensionVersion: `${WORKFLOW_EXTENSION_VERSION}-next`,
    manager: {
      listRuns: () => [
        { runId: "running-1", status: "running" },
        { runId: "paused-1", status: "paused" },
        { runId: "done-1", status: "completed" },
      ],
      pause: (runId: string) => {
        paused.push(runId);
        return true;
      },
    } as unknown as WorkflowReloadRuntime["manager"],
  };
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  const claim = claimWorkflowRuntime(cwd);

  assert.equal(claim.compatible, undefined);
  assert.ok(claim.versionMismatch);
  assert.equal(claim.versionMismatch, value);
  assert.equal(pauseStrandedWorkflowRuntime(claim.versionMismatch), 1);
  assert.deepEqual(paused, ["running-1"]);
});

test("a handoff nobody claims before its TTL expires pauses any still-running run", async () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-ttl-expiry`;
  const paused: string[] = [];
  const value: WorkflowReloadRuntime = {
    ...runtime(cwd),
    manager: {
      listRuns: () => [
        { runId: "running-1", status: "running" },
        { runId: "done-1", status: "completed" },
      ],
      pause: (runId: string) => {
        paused.push(runId);
        return true;
      },
    } as unknown as WorkflowReloadRuntime["manager"],
  };
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value, 10);
  // Nobody ever claims it (simulating a reload that failed or never happened).
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(paused, ["running-1"], "the stranded running run must be paused, not left to burn tokens");
  assert.equal(takeWorkflowRuntime(cwd), undefined, "the expired entry must be gone so it can't be claimed later");
});

test(
  "a real in-flight run left stranded past the TTL is paused with its journal persisted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId } = manager.startInBackground(twoAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Let agent 1 finish so it lands in the journal; agent 2 stays pending
    // forever, so the run is still "running" when the handoff expires.
    da.resolve(0, "first-result");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.getRun(runId)?.status, "running", "run must still be in flight when the TTL fires");

    const value: WorkflowReloadRuntime = {
      cwd,
      extensionVersion: WORKFLOW_EXTENSION_VERSION,
      manager: manager as unknown as WorkflowReloadRuntime["manager"],
      effort: { level: "high" },
    };
    discardWorkflowRuntime(cwd);
    handoffWorkflowRuntime(value, 10);

    // Nobody ever claims it (simulating a reload that failed or never started).
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(manager.getRun(runId)?.status, "paused", "stranded run must be paused, not left running forever");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.ok(persisted?.journal && persisted.journal.length >= 1, "agent 1's result must be journaled to disk");
    assert.equal(takeWorkflowRuntime(cwd), undefined, "expired entry must be gone so it can't be claimed later");
  }),
);

test("reload handoffs are isolated by cwd and identity-guarded on cleanup", () => {
  const cwdA = `/tmp/reload-handoff-${process.pid}-a`;
  const cwdB = `/tmp/reload-handoff-${process.pid}-b`;
  const first = runtime(cwdA);
  const replacement = runtime(cwdA);
  const other = runtime(cwdB);
  discardWorkflowRuntime(cwdA);
  discardWorkflowRuntime(cwdB);

  handoffWorkflowRuntime(first);
  handoffWorkflowRuntime(replacement);
  handoffWorkflowRuntime(other);
  discardWorkflowRuntime(cwdA, first);

  assert.equal(takeWorkflowRuntime(cwdA), replacement, "stale cleanup cannot delete a newer generation");
  assert.equal(takeWorkflowRuntime(cwdB), other);
});

test("same-state reload is a no-op: a re-fired shutdown cannot re-stage or double-dispose", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-same-state`;
  const value = disposableRuntime(cwd);
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  // A second session_shutdown for the same generation (double-fire race): the
  // identical runtime is already staged and in flight — nothing may change.
  handoffWorkflowRuntime(value);
  handoffWorkflowRuntime(value);

  assert.equal(value.disposeCount(), 1, "the runtime's resources close exactly once (at stage time)");
  assert.equal(takeWorkflowRuntime(cwd), value, "the single staged entry is still claimable");
  assert.equal(takeWorkflowRuntime(cwd), undefined, "and still only claimable once");
});

test("a newer generation replacing an unclaimed handoff disposes the stale one", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-replace`;
  const stale = disposableRuntime(cwd);
  const fresh = disposableRuntime(cwd);
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(stale);
  handoffWorkflowRuntime(fresh);

  assert.equal(stale.disposeCount(), 1, "the replaced generation's resources are closed");
  assert.equal(fresh.disposeCount(), 1, "the staging generation's resources are closed");
  assert.equal(takeWorkflowRuntime(cwd), fresh, "the newest generation wins the claim");
});

test("discard runs the dispose fanout exactly once", () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-discard`;
  const value = disposableRuntime(cwd);
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value);
  discardWorkflowRuntime(cwd, value);
  discardWorkflowRuntime(cwd, value); // idempotent re-discard

  assert.equal(value.disposeCount(), 1, "resources close once even when discard re-fires");
  assert.equal(takeWorkflowRuntime(cwd), undefined);
});

test("an unclaimed handoff past its TTL disposes the abandoned generation's resources", async () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-expiry-dispose`;
  const value = disposableRuntime(cwd);
  discardWorkflowRuntime(cwd);

  handoffWorkflowRuntime(value, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(value.disposeCount(), 1, "the abandoned generation's resources are closed on expiry");
  assert.equal(takeWorkflowRuntime(cwd), undefined);
});

test("dispose is at-most-once even across handoff + expiry paths", async () => {
  const cwd = `/tmp/reload-handoff-${process.pid}-once-across-paths`;
  const value = disposableRuntime(cwd);
  discardWorkflowRuntime(cwd);

  // Stage (dispose #1), then let the TTL expiry path fire (would be #2
  // without the WeakSet guard).
  handoffWorkflowRuntime(value, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(value.disposeCount(), 1, "stage + expiry must never double-close");
  assert.equal(takeWorkflowRuntime(cwd), undefined);
});
