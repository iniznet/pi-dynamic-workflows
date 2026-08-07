/**
 * Checkpoint-through-gate tests: with a checkpointGate configured (a visual
 * approve/deny surface such as the plannotator SSE bridge), checkpoint()
 * publishes its payload to the gate and resolves the human verdict. Without a
 * gate the behavior is byte-for-byte unchanged — that path is covered by
 * tests/checkpoint.test.ts, which stays green untouched.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlannotatorBridge } from "../src/integrations/plannotator.js";
import { WorkflowStateManager } from "../src/phases/state-machine.js";
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

// ─── core-02: browser approval advances the machine to Phase 3 ───────────────

const approvedGate = (): CheckpointGate => ({
  async submitPlan() {
    return { id: "plan-1" };
  },
  async waitForApproval() {
    return true;
  },
});

test("core-02: a browser-approved checkpoint advances the machine to Phase 3 so a later agent() is not blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-gate-ph3-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    // The persisted machine sits at Phase 2 with the Phase 0/1 prerequisites
    // recorded, exactly as the wayfinder→prewalk pipeline leaves it.
    await stateManager.setState({ activePhase: 2, wayfinderComplete: true, prewalkComplete: true });
    const script = `export const meta = { name: 'g', description: 'gate' }
const approved = await checkpoint('Approve the plan?', { kind: 'confirm' })
const result = await agent('execute the approved plan', { label: 'execute' })
return { approved, result }`;
    // No stage-3 declaration in the script: the approval itself must open the
    // agent() spawn gate (recordGateVerdict's tolerant transitionTo(3)). Before
    // core-02 the machine stayed at Phase 2 and the agent() threw
    // SUBAGENT_SPAWN_BLOCKED — the gate was wedged for exactly the big plans
    // that must be approved through the browser channel.
    const res = await runWorkflow<{ approved: boolean; result: string }>(script, {
      agent: noopAgent,
      checkpointGate: approvedGate(),
      phaseState: { stateManager },
      persistLogs: false,
    });
    assert.equal(res.result.approved, true);
    assert.equal(res.result.result, "ok", "agent() is NOT blocked after the browser approval");
    const state = await stateManager.getState();
    assert.equal(state.activePhase, 3, "the approval advanced the machine to Phase 3");
    assert.equal(state.humanApproved, true, "the verdict recorded human approval");
    assert.equal(state.plannotatorSubmitted, true, "the reviewed plan was recorded as submitted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    const files = (await readdir(dir).catch(() => [] as string[])).filter(
      // Atomic writes surface a `<id>.json.<uuid>.<pid>.tmp` sibling first;
      // only the final plan file is a complete, readable plan.
      (name) => name.endsWith(".json") && !name.endsWith(".tmp"),
    );
    if (files.length > 0) return join(dir, files[0]);
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

/** Reserves an OS-assigned port, frees it, and returns it for a deterministic bind. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("unable to allocate a port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("checkpoint(): approves over HTTP POST /approve (browser-style) end-to-end", async () => {
  await inTempDir(async () => {
    const port = await freePort();
    const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false });
    try {
      const script = `export const meta = { name: 'g', description: 'gate' }
return await checkpoint('Approve plan?', { kind: 'confirm' })`;
      const run = runWorkflow<boolean>(script, { agent: noopAgent, checkpointGate: bridge, persistLogs: false });

      // The human path: wait for the pending plan, then POST the verdict the
      // exact way the vendored review page does (GET /plan → POST /approve).
      const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
      const planPath = await waitForPlanFile(plansDir);
      const plan = JSON.parse(await readFile(planPath, "utf-8")) as { id: string };

      const served = await fetch(`http://127.0.0.1:${port}/plan`);
      assert.equal(served.status, 200);
      const servedPlan = (await served.json()) as { plan: { id: string } };
      assert.equal(servedPlan.plan.id, plan.id, "GET /plan serves the pending plan to the review page");

      let res: Response | undefined;
      for (let attempt = 0; attempt < 50 && !res; attempt++) {
        try {
          res = await fetch(`http://127.0.0.1:${port}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId: plan.id }),
          });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(res, "the bridge accepted the approval request");
      assert.equal(res.status, 200);

      const result = await run;
      assert.equal(result.result, true, "the checkpoint resolves true after the browser-style approval");
    } finally {
      bridge.close();
    }
  });
});
