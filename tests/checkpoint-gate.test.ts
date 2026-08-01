/**
 * Checkpoint-through-gate tests: with a checkpointGate configured (a visual
 * approve/deny surface such as the plannotator SSE bridge), checkpoint()
 * publishes its payload to the gate and resolves the human verdict. Without a
 * gate the behavior is byte-for-byte unchanged — that path is covered by
 * tests/checkpoint.test.ts, which stays green untouched.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlannotatorBridge } from "../src/integrations/plannotator.js";
import type { CheckpointGate, JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

/** In-memory gate: records every submitted blueprint, resolves a fixed verdict. */
function fakeGate(verdict: boolean): { gate: CheckpointGate; plans: Array<Record<string, unknown>> } {
  const plans: Array<Record<string, unknown>> = [];
  return {
    plans,
    gate: {
      async submitPlan(blueprint) {
        plans.push(blueprint as Record<string, unknown>);
        return { id: `plan-${plans.length}` };
      },
      async waitForApproval() {
        return verdict;
      },
    },
  };
}

test("checkpoint(): with a gate configured, publishes the payload and returns the human-approved value", async () => {
  const { gate, plans } = fakeGate(true);
  const script = `export const meta = { name: 'g', description: 'gate' }
return await checkpoint('Approve plan?', { kind: 'confirm' })`;
  const res = await runWorkflow<boolean>(script, { agent: noopAgent, checkpointGate: gate, persistLogs: false });
  assert.equal(res.result, true);
  assert.equal(plans.length, 1, "the checkpoint published exactly one payload");
  assert.equal(plans[0]?.prompt, "Approve plan?");
  assert.equal(plans[0]?.kind, "confirm");
  assert.equal(plans[0]?.runId, res.runId);
  assert.equal(plans[0]?.callIndex, 0);
});

test("checkpoint(): a denied gate resolves false", async () => {
  const { gate, plans } = fakeGate(false);
  const script = `export const meta = { name: 'g', description: 'gate' }
return await checkpoint('Approve?', { kind: 'confirm' })`;
  const res = await runWorkflow<boolean>(script, { agent: noopAgent, checkpointGate: gate, persistLogs: false });
  assert.equal(res.result, false);
  assert.equal(plans.length, 1);
});

test("checkpoint(): input kind through the gate resolves the declared default on approval", async () => {
  const { gate } = fakeGate(true);
  const script = `export const meta = { name: 'g', description: 'gate' }
return await checkpoint('Pick a name', { kind: 'input', default: 'fallback' })`;
  const res = await runWorkflow<string>(script, { agent: noopAgent, checkpointGate: gate, persistLogs: false });
  assert.equal(res.result, "fallback", "approval of an input checkpoint takes the declared default payload");
});

test("checkpoint(): the journaled verdict replays on resume without re-contacting the gate", async () => {
  const journal = new Map<string, JournalEntry>();
  const { gate, plans } = fakeGate(true);
  const script = `export const meta = { name: 'g', description: 'gate' }
const r = await checkpoint('Approve?')
return { r }`;
  const first = await runWorkflow<{ r: boolean }>(script, {
    agent: noopAgent,
    checkpointGate: gate,
    persistLogs: false,
    runId: "gate-resume-run",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.equal(first.result.r, true);
  assert.equal(plans.length, 1);

  let gateContacts = 0;
  const replayGate: CheckpointGate = {
    async submitPlan() {
      gateContacts++;
      throw new Error("gate must not be contacted on replay");
    },
    async waitForApproval() {
      gateContacts++;
      throw new Error("gate must not be contacted on replay");
    },
  };
  const second = await runWorkflow<{ r: boolean }>(script, {
    agent: noopAgent,
    checkpointGate: replayGate,
    persistLogs: false,
    runId: "gate-resume-run",
    resumeJournal: journal,
  });
  assert.equal(second.result.r, true, "the journaled verdict replays unchanged");
  assert.equal(gateContacts, 0, "resume never re-blocks on the gate");
});

// ─── Real plannotator SSE bridge end-to-end ───────────────────────────────────

async function inTempDir(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-gate-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Waits for the bridge to persist a plan file, returns its path. */
async function waitForPlanFile(dir: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const files = await readdir(dir).catch(() => [] as string[]);
    if (files.length > 0) return join(dir, files[0]!);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no plan file appeared in time");
}

test("checkpoint(): publishes a plan to the plannotator bridge and resolves the human approval end-to-end", async () => {
  await inTempDir(async () => {
    const bridge = createPlannotatorBridge({ port: 0, autoOpenBrowser: false });
    try {
      const updates: Array<{ id: string; status: string }> = [];
      const unsubscribe = bridge.onStatusChange?.((plan) => updates.push(plan));
      const script = `export const meta = { name: 'g', description: 'gate' }
return await checkpoint('Approve plan?')`;

      const run = runWorkflow<boolean>(script, { agent: noopAgent, checkpointGate: bridge, persistLogs: false });

      // Simulate the human: wait for the pending plan, then approve it on disk
      // the way the browser gate does.
      const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
      const planPath = await waitForPlanFile(plansDir);
      const plan = JSON.parse(await readFile(planPath, "utf-8")) as {
        id: string;
        blueprint?: { prompt?: string };
      };
      assert.equal(plan.blueprint?.prompt, "Approve plan?", "the checkpoint payload is the published blueprint");
      const approved = { ...plan, status: "approved", reviewedAt: new Date().toISOString() };
      await writeFile(planPath, JSON.stringify(approved, null, 2), "utf-8");

      const res = await run;
      assert.equal(res.result, true, "the checkpoint resolves the human-approved verdict");
      assert.ok(
        updates.some((update) => update.status === "approved"),
        "an SSE update fired for the approval while the checkpoint was waiting",
      );
      unsubscribe?.();
    } finally {
      bridge.close();
    }
  });
});

test("checkpoint(): a gate that never decides resolves false after the checkpoint timeout", async () => {
  await inTempDir(async () => {
    const bridge = createPlannotatorBridge({ port: 0, autoOpenBrowser: false });
    try {
      const script = `export const meta = { name: 'g', description: 'gate' }
return await checkpoint('Approve?', { timeoutMs: 300 })`;
      const started = Date.now();
      const res = await runWorkflow<boolean>(script, { agent: noopAgent, checkpointGate: bridge, persistLogs: false });
      assert.equal(res.result, false, "a timed-out gate resolves false (deny by default)");
      assert.ok(Date.now() - started >= 250, "the run actually waited for the gate timeout");
    } finally {
      bridge.close();
    }
  });
});
