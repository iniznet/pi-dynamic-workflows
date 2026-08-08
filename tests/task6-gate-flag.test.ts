/**
 * meta.gate ("approve") — the per-script PRE-BODY human-approval pause that
 * makes the plannotator review gate fire for SHIPPED workflows (PRD Task 6).
 *
 * A top-level script that declares `gate: "approve"` in its meta has
 * runWorkflow publish meta.description (with the runId) to options.checkpointGate
 * and wait for the human verdict BEFORE the body evaluates; denial or timeout
 * completes the run cleanly with `result: false` and a log note. Scripts without
 * the flag are byte-identical (no plan published, no review server started).
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlannotatorBridge } from "../src/integrations/plannotator.js";
import { generatePlanThenExecuteWorkflow } from "../src/plan-then-execute.js";
import type { CheckpointGate, JournalEntry } from "../src/workflow.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

/** Gate that records every submitted blueprint and resolves a fixed verdict. */
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

/** Agent runner that counts how many agent() calls reached it. */
function countingAgent(): { agent: typeof noopAgent; calls: () => number } {
  let calls = 0;
  return {
    agent: {
      async run() {
        calls++;
        return "ok";
      },
    },
    calls: () => calls,
  };
}

const GATED_SCRIPT = `export const meta = { name: 'gated', description: 'Review the objective and approve before any agent work', gate: 'approve' }
await agent('work')
return 'body-ran'`;

const UNGATED_SCRIPT = `export const meta = { name: 'ungated', description: 'no gate' }
await agent('work')
return 'body-ran'`;

// ─── (a) gated scripts publish a plan and pause until approval ───────────────

test("meta.gate: publishes a plan and pauses the body until the human approves", async () => {
  const { agent, calls } = countingAgent();
  let resolveApproval!: (verdict: boolean) => void;
  const plans: Array<Record<string, unknown>> = [];
  const gate: CheckpointGate = {
    async submitPlan(blueprint) {
      plans.push(blueprint as Record<string, unknown>);
      return { id: "plan-pause" };
    },
    waitForApproval() {
      return new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      });
    },
  };
  let settled = false;
  const run = runWorkflow<string>(GATED_SCRIPT, {
    agent,
    checkpointGate: gate,
    persistLogs: false,
    runId: "gate-flag-pause",
  }).then((result) => {
    settled = true;
    return result;
  });

  // The plan is published with the meta description + run identity...
  // In-memory state poll: 50ms cadence — exactly ≤100 fires within the 5s deadline.
  const deadline = Date.now() + 5000;
  while (plans.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(plans.length, 1, "the gate published exactly one plan");
  assert.equal(plans[0]?.prompt, "Review the objective and approve before any agent work");
  assert.equal(plans[0]?.kind, "confirm");
  assert.equal(plans[0]?.runId, "gate-flag-pause", "the blueprint carries the runId");
  assert.equal(plans[0]?.callIndex, 0, "the gate's checkpoint is the first journaled call");

  // ...but the body is paused: no agent work, no completion until the verdict.
  assert.equal(settled, false, "the run is still waiting for the verdict");
  assert.equal(calls(), 0, "no agent() ran while the gate was waiting");

  resolveApproval(true);
  const res = await run;
  assert.equal(res.result, "body-ran", "the body runs only after approval");
  assert.equal(calls(), 1, "the body's agent ran exactly once after approval");
  assert.equal(settled, true);
});

// ─── (b) denial / timeout aborts cleanly with result false + note ────────────

test("meta.gate: a denied gate aborts cleanly with result false and a note; the body never runs", async () => {
  const { agent, calls } = countingAgent();
  const { gate } = fakeGate(false);
  const res = await runWorkflow<string>(GATED_SCRIPT, { agent, checkpointGate: gate, persistLogs: false });
  assert.equal(res.result, false, "a denied gate completes with result false");
  assert.equal(calls(), 0, "the body never evaluated after a denial");
  assert.ok(
    res.logs.some((line) => /approval was denied or timed out/.test(line)),
    "the run logs carry the denial note",
  );
});

test("meta.gate: a gate that never decides (timeout) aborts cleanly with result false", async () => {
  const { agent, calls } = countingAgent();
  const started = Date.now();
  const gate: CheckpointGate = {
    async submitPlan() {
      return { id: "plan-timeout" };
    },
    async waitForApproval() {
      // Simulate a gate-level deadline: the bridge's waitForApproval resolves
      // false once its approval timeout elapses (see checkpoint-gate.test.ts).
      await new Promise((resolve) => setTimeout(resolve, 200));
      return false;
    },
  };
  const res = await runWorkflow<string>(GATED_SCRIPT, { agent, checkpointGate: gate, persistLogs: false });
  assert.equal(res.result, false, "a timed-out gate completes with result false");
  assert.equal(calls(), 0, "the body never evaluated after a gate timeout");
  assert.ok(Date.now() - started >= 150, "the run actually waited for the gate timeout");
  assert.ok(
    res.logs.some((line) => /approval was denied or timed out/.test(line)),
    "the run logs carry the timeout note",
  );
});

// ─── (c) scripts without the flag publish no plan and start no server ────────

test("meta.gate: a script WITHOUT the flag never contacts the gate", async () => {
  let submissions = 0;
  const spyGate: CheckpointGate = {
    async submitPlan() {
      submissions++;
      throw new Error("the gate must not be contacted for an ungated script");
    },
    async waitForApproval() {
      throw new Error("the gate must not be contacted for an ungated script");
    },
  };
  const res = await runWorkflow<string>(UNGATED_SCRIPT, {
    agent: noopAgent,
    checkpointGate: spyGate,
    persistLogs: false,
  });
  assert.equal(res.result, "body-ran", "an ungated script behaves byte-identically");
  assert.equal(submissions, 0, "no plan was published for an ungated script");
});

/** True when something is listening on 127.0.0.1:port. */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function inTempDir(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "task6-gate-flag-"));
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

// PORT-01: this file binds its OWN review port (3124), never the shared 3123
// the sibling task6-gate-e2e probe uses — per-file ports de-contend the suite.
const PORT_3124 = 3124;

test("meta.gate: the review server (port 3124) starts ONLY for gated scripts", async (t) => {
  // The probe's point is RELATIVE behavior: an ungated run must not change the
  // port state, a gated run must bind it. Skip when the port is already taken.
  if (await isPortOpen(PORT_3124)) {
    t.skip("port 3124 already in use; skipping the bind probe");
    return;
  }
  await inTempDir(async () => {
    let bridge: ReturnType<typeof createPlannotatorBridge> | undefined;
    // Mirrors extensions/workflow.ts:232-252: the bridge materializes on the
    // FIRST submitPlan — an ungated script never reaches it, so no server ever
    // starts for it.
    const lazyGate: CheckpointGate = {
      async submitPlan(blueprint) {
        bridge ??= createPlannotatorBridge({ port: PORT_3124, autoOpenBrowser: false });
        return bridge.submitPlan(blueprint);
      },
      waitForApproval(planId, timeoutMs, signal) {
        if (!bridge) throw new Error("lazy gate is not materialized (submitPlan must run first)");
        return bridge.waitForApproval(planId, timeoutMs, signal);
      },
    };
    try {
      const ungated = await runWorkflow<string>(UNGATED_SCRIPT, {
        agent: noopAgent,
        checkpointGate: lazyGate,
        persistLogs: false,
      });
      assert.equal(ungated.result, "body-ran");
      assert.equal(bridge, undefined, "an ungated script never materializes the review bridge");
      assert.equal(await isPortOpen(PORT_3124), false, "no review server is bound after an ungated run");

      // A gated script DOES materialize the bridge and pauses for the verdict.
      const run = runWorkflow<string>(GATED_SCRIPT, { agent: noopAgent, checkpointGate: lazyGate, persistLogs: false });
      const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
      const planPath = await waitForPlanFile(plansDir);
      assert.equal(await isPortOpen(PORT_3124), true, "the review server is listening while the gate waits");
      const plan = JSON.parse(await readFile(planPath, "utf-8")) as { id: string; blueprint?: { prompt?: string } };
      assert.equal(
        plan.blueprint?.prompt,
        "Review the objective and approve before any agent work",
        "the published blueprint is the script's meta description",
      );
      const approved = { ...plan, status: "approved", reviewedAt: new Date().toISOString() };
      await writeFile(planPath, JSON.stringify(approved, null, 2), "utf-8");

      const res = await run;
      assert.equal(res.result, "body-ran", "the gated script proceeds after the human approves");
    } finally {
      bridge?.close();
    }
  });
});

// ─── headless + resume safety (reuses checkpoint()'s proven machinery) ───────

test("meta.gate: headless (no gate configured) auto-approves so a detached run never hangs", async () => {
  const { agent, calls } = countingAgent();
  const res = await runWorkflow<string>(GATED_SCRIPT, { agent, persistLogs: false });
  assert.equal(res.result, "body-ran", "a gated script without a gate proceeds (checkpoint headless default)");
  assert.equal(calls(), 1);
});

test("meta.gate: the verdict journals and replays on resume without re-contacting the gate", async () => {
  const journal = new Map<string, JournalEntry>();
  const { gate, plans } = fakeGate(true);
  const first = await runWorkflow<string>(GATED_SCRIPT, {
    agent: noopAgent,
    checkpointGate: gate,
    persistLogs: false,
    runId: "gate-flag-resume",
    onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry),
  });
  assert.equal(first.result, "body-ran");
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
  const second = await runWorkflow<string>(GATED_SCRIPT, {
    agent: noopAgent,
    checkpointGate: replayGate,
    persistLogs: false,
    runId: "gate-flag-resume",
    resumeJournal: journal,
  });
  assert.equal(second.result, "body-ran", "the journaled verdict replays unchanged");
  assert.equal(gateContacts, 0, "resume never re-blocks on the gate");
});

// ─── (d) the shipped plan-then-execute builtin declares the flag ─────────────

test("meta.gate: plan-then-execute's shipped meta declares the flag and mentions the pause", () => {
  const { meta } = parseWorkflowScript(generatePlanThenExecuteWorkflow());
  assert.equal(meta.name, "plan_then_execute");
  assert.equal(meta.gate, "approve");
  assert.ok(/human approval/.test(meta.description), "the description mentions the human-approval pause");
});

test("meta.gate: a non-approve gate value is rejected at parse time", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'g', description: 'd', gate: 'deny' }"),
    /meta.gate must be "approve"/,
  );
});
