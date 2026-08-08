import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../../../src/agent.js";
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

test(
  "L4: replayed (cache-hit) agents keep their ORIGINAL persisted timestamps on resume",
  withTempCwd(async (cwd) => {
    const zeroUsage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 };
    let bCalls = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        options?.onUsage?.({ ...zeroUsage });
        if (prompt === "b") {
          bCalls++;
          if (bCalls === 1) return new Promise(() => {}); // first 'b' hangs until paused
          return "b-result"; // post-resume 'b' completes
        }
        return `${prompt}-result`;
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'ts_demo', description: 'replayed timestamps' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(script, undefined);
    promise.catch(() => {});
    for (let i = 0; i < 200 && bCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(bCalls, 1, "first 'b' is in flight before pausing");
    // Let 'a' finish in memory (its journal entry lands on completion), then
    // pause. NOTE: the fast path (journal-delta sidecar) means the PRIMARY's
    // agents array only lands at a boundary write — so 'a''s real timestamps
    // are read from the pause write, not from a pre-pause progress write that
    // never touches the primary.
    for (let i = 0; i < 200 && !(manager.getRun(runId)?.journal.length ?? 0); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok((manager.getRun(runId)?.journal.length ?? 0) > 0, "'a' completed in memory before pausing");
    assert.equal(manager.pause(runId), true);
    await new Promise((r) => setTimeout(r, 30));
    const before = manager.getPersistence().load(runId);
    const beforeA = before?.agents.find((ag) => ag.label === "a");
    assert.ok(beforeA, "'a' persisted at the pause boundary");
    const originalStartedAt = beforeA?.startedAt;
    const originalEndedAt = beforeA?.endedAt;
    assert.ok(originalStartedAt, "'a' has a real persisted startedAt");

    // Resume with a fast 'b': 'a' replays from the journal (cache hit), 'b' runs live.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    for (let i = 0; i < 300 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const after = manager.getPersistence().load(runId);
    const replayedA = after?.agents.find((ag) => ag.label === "a");
    assert.ok(replayedA, "replayed 'a' is persisted again");
    assert.equal(
      replayedA?.startedAt,
      originalStartedAt,
      "a replayed agent keeps its ORIGINAL startedAt, not a fabricated resume-time stamp (L4)",
    );
    assert.equal(
      replayedA?.endedAt,
      originalEndedAt,
      "a replayed agent keeps its ORIGINAL endedAt, not a fabricated resume-time stamp (L4)",
    );
  }),
);
