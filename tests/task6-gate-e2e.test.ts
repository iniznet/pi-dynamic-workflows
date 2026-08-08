/**
 * task6-gate-e2e.test.ts — the FULL PRD Task 6 visual-review-gate loop on a
 * SHIPPED-workflow shape, exercised over the REAL plannotator SSE bridge.
 *
 * slice-g (tests/task6-gate-flag.test.ts) proved the meta.gate machinery at
 * the runWorkflow level with fake gates. This file closes the loop exactly as
 * the vendored review page does it in production:
 *
 *   1. A SHIPPED gated script (the REAL plan-then-execute generated workflow,
 *      which ships `meta.gate: 'approve'`) runs through runWorkflow with a
 *      real createPlannotatorBridge on an ephemeral port.
 *   2. The gate fires BEFORE any agent work: the plan file appears, the run
 *      is paused with zero agent calls, GET /plan serves the blueprint, and
 *      POST /approve approves it over HTTP.
 *   3. The run proceeds and completes the approved path (plan → verify →
 *      execute → report).
 *   4. Denial over the same bridge (plan file flipped to a non-approved
 *      status, the poll path's only verdict channel) aborts the run cleanly:
 *      result false + a log note, the body never evaluates.
 *   5. Lazy guarantee: a script WITHOUT the gate never materializes the
 *      review bridge, so no server is ever bound for an ungated run.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlannotatorBridge } from "../src/integrations/plannotator.js";
import { generatePlanThenExecuteWorkflow } from "../src/plan-then-execute.js";
import type { CheckpointGate } from "../src/workflow.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";

/** The shipped plan-then-execute script: a top-level run of it fires the gate. */
const SHIPPED_SCRIPT = generatePlanThenExecuteWorkflow();
const SHIPPED_META = parseWorkflowScript(SHIPPED_SCRIPT).meta;

/**
 * Agent runner that satisfies plan-then-execute's JSON-schema agent calls and
 * counts every live agent() invocation (so "zero agent work while the gate
 * waits" and "the approved path ran the body" are both observable).
 */
function planThenExecuteAgent() {
  const prompts: string[] = [];
  return {
    prompts,
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        if (prompt.includes("planning agent")) {
          return {
            steps: [
              { id: "setup", title: "Setup", description: "Prepare environment", dependsOn: [] },
              { id: "build", title: "Build", description: "Build the widget", dependsOn: ["setup"] },
            ],
          };
        }
        if (prompt.includes("step verifier")) return { ok: true, feedback: "" };
        if (prompt.includes("implementer")) return `executed ${/"id":"([^"]+)"/.exec(prompt)?.[1] ?? ""}`;
        if (prompt.includes("report writer")) return "report text";
        return null;
      },
    },
  };
}

async function inTempDir(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "task6-gate-e2e-"));
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
    // File/disk poll: 200ms cadence (5s deadline → 25 fires). The plan file is
    // written once via the bridge's atomic write; the coarser read cadence
    // cannot miss it and avoids overlapping the write window.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("no plan file appeared in time");
}

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

// ─── the full approved loop over HTTP ─────────────────────────────────────────

test("task6 e2e: a shipped gated workflow pauses on the real bridge, GET /plan serves it, POST /approve completes the approved path", async () => {
  await inTempDir(async () => {
    const port = await freePort();
    const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false });
    const { agent, prompts } = planThenExecuteAgent();
    let settled = false;
    try {
      const run = runWorkflow<{ plan?: unknown; verdicts?: unknown; results?: unknown; report?: string }>(
        SHIPPED_SCRIPT,
        {
          agent,
          checkpointGate: bridge,
          persistLogs: false,
          runId: "task6-e2e-shipped",
          args: { objective: "build a widget", execute: true, maxSteps: 5 },
        },
      ).then((result) => {
        settled = true;
        return result;
      });

      // The gate publishes the SHIPPED meta.description as the plan blueprint
      // and pauses BEFORE the body: no plan agent has run yet.
      const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
      const planPath = await waitForPlanFile(plansDir);
      const plan = JSON.parse(await readFile(planPath, "utf-8")) as {
        id: string;
        blueprint?: { prompt?: string; kind?: string; runId?: string; callIndex?: number };
      };
      assert.equal(
        plan.blueprint?.prompt,
        SHIPPED_META.description,
        "the blueprint is the shipped workflow's meta description",
      );
      assert.equal(plan.blueprint?.kind, "confirm");
      assert.equal(plan.blueprint?.runId, "task6-e2e-shipped", "the blueprint carries the run identity");
      assert.equal(plan.blueprint?.callIndex, 0, "the gate's checkpoint is the first journaled call");
      assert.equal(settled, false, "the run is paused while the human reviews");
      assert.equal(prompts.length, 0, "zero agent work happened before the verdict");

      // The human path, exactly as the vendored review page does it:
      // GET /plan (no query) serves the pending plan, then POST /approve.
      const served = await fetch(`http://127.0.0.1:${port}/plan`);
      assert.equal(served.status, 200);
      const servedPlan = (await served.json()) as { plan: { id: string } };
      assert.equal(servedPlan.plan.id, plan.id, "GET /plan serves the pending blueprint to the review page");

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

      // Approval releases the pause: the body runs and completes the approved
      // plan → verify → execute → report path.
      const result = await run;
      const r = result.result ?? {};
      const planResult = JSON.parse(JSON.stringify(r)) as {
        plan?: Array<{ id: string }>;
        results?: Array<{ id: string }>;
        report?: string;
      };
      assert.deepEqual(
        (planResult.plan ?? []).map((s) => s.id),
        ["setup", "build"],
        "the approved run produced the dependency-ordered plan",
      );
      assert.deepEqual(
        (planResult.results ?? []).map((x) => x.id),
        ["setup", "build"],
        "both approved steps executed",
      );
      assert.equal(planResult.report, "report text");
      assert.ok(prompts.length > 0, "the body's agents ran only after the approval");
      assert.equal(settled, true);
    } finally {
      bridge.close();
    }
  });
});

// ─── denial over the same bridge ──────────────────────────────────────────────

test("task6 e2e: a denied shipped workflow aborts cleanly with result false and a note; the body never runs", async () => {
  await inTempDir(async () => {
    const port = await freePort();
    const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false });
    const { agent, prompts } = planThenExecuteAgent();
    try {
      const run = runWorkflow<unknown>(SHIPPED_SCRIPT, {
        agent,
        checkpointGate: bridge,
        persistLogs: false,
        runId: "task6-e2e-denied",
        args: { objective: "build a widget", execute: true, maxSteps: 5 },
      });

      // Wait for the pending plan, then deny it the way the poll path observes
      // a non-approved verdict (the bridge has no POST /deny — any status other
      // than "approved" resolves the wait false, same as a review-page denial).
      const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
      const planPath = await waitForPlanFile(plansDir);
      const plan = JSON.parse(await readFile(planPath, "utf-8")) as { id: string };
      const denied = { ...plan, status: "denied", reviewedAt: new Date().toISOString() };
      await writeFile(planPath, JSON.stringify(denied, null, 2), "utf-8");

      const result = await run;
      assert.equal(result.result, false, "a denied gate completes with result false");
      assert.equal(prompts.length, 0, "the body never evaluated after a denial");
      assert.ok(
        result.logs.some((line) => /approval was denied or timed out/.test(line)),
        "the run logs carry the denial note",
      );
    } finally {
      bridge.close();
    }
  });
});

// ─── lazy guarantee: ungated run ⇒ no server ─────────────────────────────────

test("task6 e2e: an ungated script never materializes the review bridge, so no server is ever bound", async (t) => {
  // The probe's point is RELATIVE behavior: an ungated run must not change the
  // port state, a gated run must bind it. Skip when the port is already taken.
  // PORT-01: this file only PROBES the canonical 3123 (it never binds it); the
  // sibling test files bind their own per-file ports, so the probe only ever
  // skips on a genuinely foreign process holding the port.
  if (await isPortOpen(3123)) {
    t.skip("port 3123 already in use; skipping the bind probe");
    return;
  }
  await inTempDir(async () => {
    let bridge: ReturnType<typeof createPlannotatorBridge> | undefined;
    // Mirrors extensions/workflow.ts:232-252: the bridge materializes on the
    // FIRST submitPlan — an ungated script never reaches it, so no server ever
    // starts for it.
    const lazyGate: CheckpointGate = {
      async submitPlan(blueprint) {
        bridge ??= createPlannotatorBridge({ port: 3123, autoOpenBrowser: false });
        return bridge.submitPlan(blueprint);
      },
      waitForApproval(planId, timeoutMs, signal) {
        if (!bridge) throw new Error("lazy gate is not materialized (submitPlan must run first)");
        return bridge.waitForApproval(planId, timeoutMs, signal);
      },
    };
    try {
      const ungated = `export const meta = { name: 'ungated', description: 'no gate' }
return 'body-ran'`;
      const res = await runWorkflow<string>(ungated, {
        agent: {
          async run() {
            return "ok";
          },
        },
        checkpointGate: lazyGate,
        persistLogs: false,
      });
      assert.equal(res.result, "body-ran");
      assert.equal(bridge, undefined, "an ungated script never materializes the review bridge");
      assert.equal(await isPortOpen(3123), false, "no review server is bound after an ungated run");
    } finally {
      bridge?.close();
    }
  });
});
