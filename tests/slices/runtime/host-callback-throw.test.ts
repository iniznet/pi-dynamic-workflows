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

test("M1: a throwing onAgentEnd must not null a successful agent nor double-count tokens", async () => {
  const usage: AgentUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0 };
  const agent = {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.(usage);
      return "ok";
    },
  };
  const script = `export const meta = { name: 'cb', description: 'callback firewall' }
const r = await agent('x', { label: 'a' })
return r`;

  let endCalls = 0;
  const result = await runWorkflow<string>(script, {
    agent,
    persistLogs: false,
    onAgentStart: () => {
      throw new Error("host start listener exploded");
    },
    onAgentEnd: () => {
      endCalls++;
      throw new Error("host end listener exploded");
    },
    onAgentJournal: () => {
      throw new Error("host journal listener exploded");
    },
  });

  assert.equal(result.result, "ok", "a throwing host callback must not null the successful agent result");
  assert.equal(endCalls, 1, "onAgentEnd fired exactly once (no retry-loop re-entry)");
  assert.equal(result.tokenUsage?.total, 15, "tokens counted exactly once — no double-count from a caught throw");
  assert.equal(result.tokenUsage?.input, 10);
  assert.equal(result.tokenUsage?.output, 5);
  assert.equal(result.agentCount, 1);
});

test("M1: a throwing onTokenUsage must not fail a completing run", async () => {
  const agent = {
    async run() {
      return "ok";
    },
  };
  const script = `export const meta = { name: 'cb2', description: 'final usage callback' }
return await agent('x')`;

  const result = await runWorkflow(script, {
    agent,
    persistLogs: false,
    onTokenUsage: () => {
      throw new Error("host usage listener exploded");
    },
  });
  assert.equal(result.result, "ok", "the final onTokenUsage throw is contained");
});

test(
  "M1: a throwing manager EventEmitter listener does not abort the execution",
  withTempCwd(async (cwd) => {
    const agent = {
      async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }): Promise<any> {
        options?.onUsage?.({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 });
        return "ok";
      },
    };
    const manager = new WorkflowManager({ cwd, agent });
    // A listener that throws on every event (task-panel style renderer mid-crash).
    for (const event of ["agentStart", "agentEnd", "log", "phase", "complete"]) {
      manager.on(event, () => {
        throw new Error(`host ${event} listener exploded`);
      });
    }

    const script = `export const meta = { name: 'mgr_cb', description: 'listener firewall' }
phase('P')
const r = await agent('x', { label: 'a' })
log('done')
return r`;

    const result = await manager.runSync(script, undefined, { onProgress: () => {} });
    assert.equal(result.result, "ok", "throwing emitLive listeners must not abort the run");
    assert.equal(manager.getPersistence().load(result.runId ?? "")?.status, "completed");
  }),
);
