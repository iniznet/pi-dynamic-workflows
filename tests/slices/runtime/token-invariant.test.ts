import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../../../src/agent.js";
import { runWorkflow } from "../../../src/workflow.js";
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
  "M26: after retries, the persisted tokenUsage satisfies total === input+output+cacheRead+cacheWrite",
  withTempCwd(async (cwd) => {
    // 'a' fails once (spend {input:40, output:0, total:40}) then succeeds
    // (usage whose reported total 100 disagrees with its breakdown
    // 10+5+5+0=20 — the invariant must discard the reported total). The
    // retried attempt's spend must ALSO land in the persisted breakdown.
    let aAttempts = 0;
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        if (prompt === "a") {
          aAttempts++;
          if (aAttempts === 1) {
            options?.onUsage?.({ input: 40, output: 0, cacheRead: 0, cacheWrite: 0, total: 40, cost: 0 });
            return ""; // empty output -> recoverable -> retried
          }
          options?.onUsage?.({ input: 10, output: 5, cacheRead: 5, cacheWrite: 0, total: 100, cost: 0.1 });
          return "a-result";
        }
        options?.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
        return "b-result";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'invariant_demo', description: 'token invariant' }
const a = await agent('a', { label: 'a' })
const b = await agent('b', { label: 'b' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(script, undefined, { agentRetries: 1, retryBackoffMs: 0 });
    await promise;

    const persisted = manager.getPersistence().load(runId);
    const usage = persisted?.tokenUsage;
    assert.ok(usage, "token breakdown is persisted");
    assert.equal(aAttempts, 2, "the retry actually happened");
    assert.equal(usage?.input, 51, "40 (retried attempt) + 10 (final attempt) + 1 (b)");
    assert.equal(usage?.output, 5);
    assert.equal(usage?.cacheRead, 5);
    assert.equal(usage?.cacheWrite, 0);
    assert.equal(usage?.total, 61, "total is the component sum (51+5+5+0)");
    assert.equal(
      usage?.total,
      (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
      "invariant total === input+output+cacheRead+cacheWrite holds after retries",
    );
  }),
);

test("M26: runWorkflow's aggregate total equals its components even when the provider reports a mismatch", async () => {
  const usage: AgentUsage = { input: 100, output: 40, cacheRead: 50, cacheWrite: 10, total: 140, cost: 0.002 };
  const agent = {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.(usage);
      return "ok";
    },
  };
  const script = `export const meta = { name: 'inv_rt', description: 'runtime invariant' }
await agent('a', { label: 'a' })
await agent('b', { label: 'b' })
return 1`;

  const result = await runWorkflow(script, { agent, persistLogs: false });
  const t = result.tokenUsage;
  assert.equal(t?.total, (t?.input ?? 0) + (t?.output ?? 0) + (t?.cacheRead ?? 0) + (t?.cacheWrite ?? 0));
  assert.equal(t?.total, 400, "components (200) per agent × 2");
});
