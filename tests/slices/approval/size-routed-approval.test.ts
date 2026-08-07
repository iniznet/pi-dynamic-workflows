/**
 * Size-routed approval tests (tasks/approval-size-routing).
 *
 * A BIG plan (executionSteps > STEP_LIMIT OR compact bytes > BYTES_LIMIT)
 * forces the plannotator browser review: the bridge materializes and the run
 * waits for the human verdict. A SMALL plan never materializes the bridge
 * (no HTTP server, port never bound): the plan is written at the runId-named
 * path the CLI /workflows approve verb reads, and waitForApproval polls that
 * file for the verdict.
 *
 * The e2e gate here MIRRORS the production facade (extensions/workflow.ts)
 * using the REAL plan-size module + REAL waitForStatus + REAL plan-dir writes;
 * only the routing glue is replicated (the facade itself lives in the pi
 * extension and is not directly loadable by tests).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import {
  createPlannotatorBridge,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  waitForStatus,
} from "../../../src/integrations/plannotator.js";
import {
  classifyRunPlan,
  ensurePendingRunPlan,
  isPlanBig,
  PLAN_APPROVAL_BYTES_LIMIT_DEFAULT,
  PLAN_APPROVAL_BYTES_LIMIT_ENV,
  PLAN_APPROVAL_STEP_LIMIT_DEFAULT,
  PLAN_APPROVAL_STEP_LIMIT_ENV,
  planSizeMetrics,
  resolveApprovalLimits,
} from "../../../src/plan-size.js";
import type { CheckpointGate } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

const GATED_SCRIPT = `export const meta = { name: 'gated', description: 'Review the execution plan', gate: 'approve' }
return { bodyRan: true }`;

/** ExecutionBlueprint-shaped plan with `steps` steps and optionally fat bytes. */
function blueprint(steps: number, extraBytes = 0): Record<string, unknown> {
  return {
    id: "bp-size",
    title: "plan",
    preconditions: extraBytes > 0 ? ["p".repeat(extraBytes)] : ["precondition ready"],
    executionSteps: Array.from({ length: steps }, (_, i) => ({
      id: `s${i}`,
      description: `step ${i}`,
      action: "do the thing",
      expectedOutcome: "works",
      rollbackProcedure: "undo",
    })),
    failSafeProcedures: [{ kind: "timeout", trigger: "t", fallback: "f" }],
    verificationTests: ["tsc"],
    createdAt: "2025-01-01T00:00:00.000Z",
  };
}

async function inTempDir(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "size-route-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeRunPlan(dir: string, runId: string, plan: unknown): Promise<void> {
  const plansDir = join(dir, ".pi", "workflows", "plans");
  await mkdir(plansDir, { recursive: true });
  await writeFile(join(plansDir, `${runId}.json`), JSON.stringify(plan, null, 2), "utf-8");
}

/** Waits for a plan file to appear and be readable; returns its path. */
async function waitForPlanFile(dir: string, exclude?: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const files = (await readdir(dir).catch(() => [] as string[])).filter(
      // Atomic writes surface a `<id>.json.<uuid>.<pid>.tmp` sibling first;
      // only the final plan file is a complete, readable plan.
      (name) => name.endsWith(".json") && !name.endsWith(".tmp") && name !== exclude,
    );
    if (files.length > 0) return join(dir, files[0]);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no plan file appeared in time");
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

/**
 * True when the port is closed on at least one sample within the window. A
 * sibling test process can hold the shared 3123 port briefly (task6's gated
 * bridge); passing on the first closed sample keeps the no-server assertion
 * deterministic against that interference.
 */
async function isPortStableFree(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await isPortOpen(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
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

/** Set env for the duration of fn, restoring the prior values afterwards. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Mirror of the production size-routed facade (extensions/workflow.ts): real
 * classifyRunPlan/ensurePendingRunPlan/waitForStatus + real plan-dir writes.
 * The bridge slot stays undefined until a BIG (or runId-less) submitPlan.
 */
function createMirrorGate(
  dir: string,
  bridgePort?: number,
): {
  gate: CheckpointGate;
  getBridge: () => ReturnType<typeof createPlannotatorBridge> | undefined;
  getBridgePort: () => number | undefined;
  lastSubmitResult: () => { id: string; reviewUrl?: string } | undefined;
} {
  const plansDir = join(dir, ".pi", "workflows", "plans");
  const smallPlanIds = new Set<string>();
  let bridge: ReturnType<typeof createPlannotatorBridge> | undefined;
  let lastSubmitResult: { id: string; reviewUrl?: string } | undefined;
  return {
    getBridge: () => bridge,
    getBridgePort: () => bridgePort,
    lastSubmitResult: () => lastSubmitResult,
    gate: {
      async submitPlan(blueprint) {
        const payload = blueprint as { runId?: unknown } | null | undefined;
        const runId = typeof payload?.runId === "string" ? payload.runId : undefined;
        if (runId) {
          const classified = await classifyRunPlan({ dir: plansDir, runId, blueprint });
          if (!classified.big) {
            await ensurePendingRunPlan(plansDir, runId, classified.plan);
            smallPlanIds.add(runId);
            lastSubmitResult = { id: runId };
            return lastSubmitResult;
          }
        }
        // Port 0 = OS-assigned (no HTTP assertions needed); an explicit port
        // is passed only when the test drives the real HTTP review surface.
        bridge ??= createPlannotatorBridge({ port: bridgePort ?? 0, autoOpenBrowser: false });
        const plan = await bridge.submitPlan(blueprint);
        lastSubmitResult = { id: plan.id, ...(plan.note !== undefined ? { reviewUrl: plan.note } : {}) };
        return lastSubmitResult;
      },
      waitForApproval(planId, timeoutMs, signal) {
        if (smallPlanIds.has(planId)) {
          return waitForStatus(plansDir, planId, {
            timeoutMs: timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
            signal,
          });
        }
        if (!bridge) throw new Error("mirror gate is not materialized (submitPlan must run first)");
        return bridge.waitForApproval(planId, timeoutMs, signal);
      },
    },
  };
}

// ─── (a) size-rule unit tests ────────────────────────────────────────────────

test("plan-size: a 9-step plan is LARGE via the step dimension (steps > 8)", () => {
  const plan = blueprint(9);
  const metrics = planSizeMetrics(plan);
  assert.equal(metrics.steps, 9);
  assert.ok(metrics.bytes < PLAN_APPROVAL_BYTES_LIMIT_DEFAULT, "bytes stay small for the fixture");
  assert.equal(metrics.big, true);
  assert.equal(isPlanBig(plan), true);
});

test("plan-size: a 2-step plan with >20_000 compact bytes is LARGE via the byte dimension", () => {
  const plan = blueprint(2, 24_000);
  const metrics = planSizeMetrics(plan);
  assert.equal(metrics.steps, 2, "steps stay under the step limit");
  assert.ok(metrics.bytes > PLAN_APPROVAL_BYTES_LIMIT_DEFAULT, "the fat precondition crosses the byte limit");
  assert.equal(metrics.big, true);
});

test("plan-size: a small plan (2 steps, ~1KB) is NOT large", () => {
  const plan = blueprint(2);
  const metrics = planSizeMetrics(plan);
  assert.equal(metrics.big, false);
  assert.equal(isPlanBig(plan), false);
});

test("plan-size: PLAN_APPROVAL_STEP_LIMIT=2 flips a 3-step plan to LARGE; defaults restore", async () => {
  const plan = blueprint(3);
  assert.equal(isPlanBig(plan), false, "baseline default classifies 3 steps small");
  await withEnv({ [PLAN_APPROVAL_STEP_LIMIT_ENV]: "2" }, async () => {
    assert.equal(isPlanBig(plan), true, "the env override tightens the step threshold");
  });
  assert.equal(isPlanBig(plan), false, "env is restored after the test");
});

test("plan-size: explicit overrides beat env", async () => {
  const plan = blueprint(3);
  await withEnv({ [PLAN_APPROVAL_STEP_LIMIT_ENV]: "2" }, async () => {
    assert.equal(isPlanBig(plan, { stepLimit: 5 }), false, "override relaxes past the env threshold");
    assert.equal(isPlanBig(blueprint(6), { stepLimit: 5 }), true, "override still classifies above itself");
  });
});

test("plan-size: invalid env values (NaN, negative, fractional) fall back to defaults", async () => {
  await withEnv({ [PLAN_APPROVAL_STEP_LIMIT_ENV]: "abc" }, async () => {
    assert.equal(resolveApprovalLimits().stepLimit, PLAN_APPROVAL_STEP_LIMIT_DEFAULT);
  });
  await withEnv({ [PLAN_APPROVAL_STEP_LIMIT_ENV]: "-1" }, async () => {
    assert.equal(resolveApprovalLimits().stepLimit, PLAN_APPROVAL_STEP_LIMIT_DEFAULT);
  });
  await withEnv({ [PLAN_APPROVAL_BYTES_LIMIT_ENV]: "4.5" }, async () => {
    assert.equal(resolveApprovalLimits().bytesLimit, PLAN_APPROVAL_BYTES_LIMIT_DEFAULT);
  });
  await withEnv({ [PLAN_APPROVAL_STEP_LIMIT_ENV]: "" }, async () => {
    assert.equal(resolveApprovalLimits().stepLimit, PLAN_APPROVAL_STEP_LIMIT_DEFAULT, "empty string → default");
  });
});

test("plan-size: the byte metric is COMPACT serialization (on-disk indentation irrelevant)", () => {
  const plan = blueprint(2);
  const compact = Buffer.byteLength(JSON.stringify(plan), "utf8");
  assert.equal(planSizeMetrics(plan).bytes, compact);
  // The same plan object parses back from an indented file to identical bytes.
  const indented = JSON.stringify(plan, null, 2);
  assert.equal(planSizeMetrics(JSON.parse(indented)).bytes, compact);
});

test("plan-size: classifyRunPlan precedence — existing runId file wins over the payload", async () => {
  await inTempDir(async () => {
    const dir = join(process.cwd(), ".pi", "workflows", "plans");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prec.json"), JSON.stringify(blueprint(10), null, 2), "utf-8");
    const classified = await classifyRunPlan({ dir, runId: "prec", blueprint: blueprint(2) });
    assert.equal(classified.source, "run-plan");
    assert.equal(classified.big, true, "the on-disk 10-step plan drives the verdict, not the payload");
    assert.equal((classified.plan as { executionSteps?: unknown[] }).executionSteps?.length, 10);
  });
});

test("plan-size: classifyRunPlan — missing file falls back to the payload", async () => {
  await inTempDir(async () => {
    const dir = join(process.cwd(), ".pi", "workflows", "plans");
    await mkdir(dir, { recursive: true });
    const payload = blueprint(2);
    const classified = await classifyRunPlan({ dir, runId: "nope", blueprint: payload });
    assert.equal(classified.source, "blueprint");
    assert.equal(classified.big, false);
    assert.deepEqual(classified.plan, payload);
  });
});

test("plan-size: classifyRunPlan — an unreadable runId file falls back to the payload", async () => {
  await inTempDir(async () => {
    const dir = join(process.cwd(), ".pi", "workflows", "plans");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.json"), "not-json{", "utf-8");
    const payload = blueprint(2);
    const classified = await classifyRunPlan({ dir, runId: "broken", blueprint: payload });
    assert.equal(classified.source, "blueprint", "a corrupt plan file is treated as absent");
    assert.deepEqual(classified.plan, payload);
  });
});

test("plan-size: ensurePendingRunPlan augments a raw prewalk file with status pending, preserving blueprint fields", async () => {
  await inTempDir(async () => {
    const dir = join(process.cwd(), ".pi", "workflows", "plans");
    await mkdir(dir, { recursive: true });
    const raw = blueprint(2);
    await writeFile(join(dir, "raw.json"), JSON.stringify(raw, null, 2), "utf-8");
    const result = await ensurePendingRunPlan(dir, "raw", raw);
    assert.equal(result.wrote, true);
    assert.equal(result.decided, false);
    const onDisk = JSON.parse(await readFile(join(dir, "raw.json"), "utf-8")) as {
      status?: string;
      submittedAt?: string;
      executionSteps?: unknown[];
      id?: string;
    };
    assert.equal(onDisk.status, "pending", "a raw blueprint (no status) becomes pending");
    assert.ok(typeof onDisk.submittedAt === "string", "submittedAt is stamped");
    assert.equal(onDisk.executionSteps?.length, 2, "all blueprint fields survive the augmentation");
    assert.equal(onDisk.id, "bp-size");
  });
});

test("plan-size: the byte metric strips decision bookkeeping — augmentation never flips classification", async () => {
  await inTempDir(async () => {
    const dir = join(process.cwd(), ".pi", "workflows", "plans");
    await mkdir(dir, { recursive: true });
    // A raw plan within the augmentation delta (~60B for status/submittedAt) of
    // the byte limit: submitPlan classifies the RAW file SMALL, then
    // ensurePendingRunPlan augments it — the CLI re-measures the AUGMENTED file,
    // which must still classify SMALL (regression for the review finding: the
    // +60B drift flipped borderline plans to LARGE and the CLI refused what
    // routing had just sent to the CLI path).
    const raw = blueprint(2);
    // The prewalk writer already placed the run's ExecutionBlueprint at the
    // runId-named path (flat shape, no status) — the real pre-condition for
    // the flat augmentation path.
    await writeFile(join(dir, "edge.json"), JSON.stringify(raw, null, 2), "utf-8");
    const rawBytes = planSizeMetrics(raw, { bytesLimit: 0 }).bytes; // exact compact bytes
    const nearLimit = rawBytes + 40; // raw is ~40B under; augmented (+~60B) would cross without the strip
    const classified = await classifyRunPlan({ dir, runId: "edge", blueprint: raw, overrides: { bytesLimit: nearLimit } });
    assert.equal(classified.source, "run-plan", "the prewalk file is the plan under review");
    assert.equal(classified.big, false, "the raw plan is SMALL (under the byte limit)");
    const ensured = await ensurePendingRunPlan(dir, "edge", raw);
    assert.equal(ensured.wrote, true);
    const onDisk = JSON.parse(await readFile(join(dir, "edge.json"), "utf-8")) as { status?: string; submittedAt?: string };
    assert.equal(onDisk.status, "pending", "augmentation stamps pending");
    // The CLI-side re-measurement of the AUGMENTED file with the SAME limits:
    // the strip makes it equal to the raw measurement — classification is stable.
    const reMeasured = planSizeMetrics(onDisk, { bytesLimit: nearLimit });
    assert.equal(reMeasured.big, false, "the augmented plan still classifies SMALL — no drift");
    assert.equal(reMeasured.bytes, classified.bytes, "bookkeeping adds no measurable bytes");
  });
});

test("plan-size: ensurePendingRunPlan is a no-op on an already-decided plan", async () => {
  await inTempDir(async () => {
    const dir = join(process.cwd(), ".pi", "workflows", "plans");
    await mkdir(dir, { recursive: true });
    const decided = { ...blueprint(2), status: "approved", reviewedAt: "2025-01-02T00:00:00.000Z" };
    await writeFile(join(dir, "decided.json"), JSON.stringify(decided, null, 2), "utf-8");
    const result = await ensurePendingRunPlan(dir, "decided", blueprint(9));
    assert.equal(result.wrote, false);
    assert.equal(result.decided, true);
    const onDisk = JSON.parse(await readFile(join(dir, "decided.json"), "utf-8")) as { status?: string };
    assert.equal(onDisk.status, "approved", "a final verdict is never clobbered");
  });
});

test("plan-size: ensurePendingRunPlan writes a payload-shaped pending plan when the file is missing", async () => {
  await inTempDir(async () => {
    const dir = join(process.cwd(), ".pi", "workflows", "plans");
    const payload = { prompt: "Approve?", runId: "fresh", callIndex: 0 };
    const result = await ensurePendingRunPlan(dir, "fresh", payload);
    assert.equal(result.wrote, true);
    assert.equal(result.decided, false);
    const onDisk = JSON.parse(await readFile(join(dir, "fresh.json"), "utf-8")) as {
      status?: string;
      id?: string;
      blueprint?: unknown;
    };
    assert.equal(onDisk.status, "pending");
    assert.equal(onDisk.id, "fresh");
    assert.deepEqual(onDisk.blueprint, payload, "the payload is the plan blueprint");
  });
});

// ─── (b) small gated run: no bridge, CLI approve resolves the checkpoint ─────

test("size-route e2e: a SMALL gated run never materializes the bridge and resolves after the CLI-style approve", async () => {
  await inTempDir(async () => {
    const dir = process.cwd();
    await writeRunPlan(dir, "small-run", blueprint(2));
    const plansDir = join(dir, ".pi", "workflows", "plans");
    const mirror = createMirrorGate(dir);
    // Probe BEFORE the run: if 3123 is already taken by the environment, skip
    // the port assertion (the bridge slot check below is the real invariant).
    const portFreeAtStart = !(await isPortOpen(3123));

    let settled = false;
    const run = runWorkflow<{ bodyRan: boolean }>(GATED_SCRIPT, {
      agent: noopAgent,
      checkpointGate: mirror.gate,
      persistLogs: false,
      runId: "small-run",
    }).then((result) => {
      settled = true;
      return result;
    });

    // The run blocks at the checkpoint: the runId plan file is pending and no
    // bridge (and therefore no HTTP server) exists.
    const deadline = Date.now() + 5000;
    let pendingSeen = false;
    while (Date.now() < deadline) {
      const raw = await readFile(join(plansDir, "small-run.json"), "utf-8").catch(() => null);
      if (raw !== null && (JSON.parse(raw) as { status?: string }).status === "pending") {
        pendingSeen = true;
        break;
      }
      // 50ms: a fast content poll on Windows can hold the file open across the
      // writer's atomic rename (EPERM); the writer retries, and this cadence
      // keeps the collision window negligible.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(pendingSeen, true, "the runId plan file carries status pending while the run waits");
    assert.equal(settled, false, "the run is still waiting for the human verdict");
    assert.equal(mirror.getBridge(), undefined, "a small plan NEVER materializes the review bridge");
    assert.equal(mirror.lastSubmitResult()?.id, "small-run", "the facade returns the runId-named plan id");
    assert.equal(mirror.lastSubmitResult()?.reviewUrl, undefined, "no review URL on the small path");
    if (portFreeAtStart) {
      // The mirror provably holds no bridge (asserted above — the only object
      // that can bind the review port), so an open port right now is a sibling
      // test process's bridge on the shared 3123 port, not ours. Require a
      // stable-free sample so a transient sibling bind does not flake the
      // assertion; the suite treats 3123 as best-effort by design (task6 skips
      // its probe when the port is already in use).
      assert.equal(await isPortStableFree(3123), true, "no review server is bound while a small plan waits");
    }

    // The CLI approve path (workflow-commands.ts decidePlanApproved) flips the
    // runId-named file to approved; the poll observes it and the run proceeds.
    const pending = JSON.parse(await readFile(join(plansDir, "small-run.json"), "utf-8"));
    await writeFile(
      join(plansDir, "small-run.json"),
      JSON.stringify({ ...pending, status: "approved", reviewedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );

    const res = await run;
    assert.equal(res.result.bodyRan, true, "the script body executes after the CLI-style approval");
    assert.equal(settled, true);
  });
});

// ─── (c) big gated run: the bridge materializes and the verdict resolves ─────

test("size-route e2e: a BIG gated run materializes the real bridge and waits for its verdict", async () => {
  await inTempDir(async () => {
    const dir = process.cwd();
    await writeRunPlan(dir, "big-run", blueprint(10));
    const plansDir = join(dir, ".pi", "workflows", "plans");
    const mirror = createMirrorGate(dir);
    let settled = false;
    const run = runWorkflow<{ bodyRan: boolean }>(GATED_SCRIPT, {
      agent: noopAgent,
      checkpointGate: mirror.gate,
      persistLogs: false,
      runId: "big-run",
    }).then((result) => {
      settled = true;
      return result;
    });

    try {
      // Wait for the bridge's uuid-named plan file (submitPlan completed), then
      // assert the routing: a big plan materialized the bridge and the plan is
      // addressed at the bridge's uuid path, not the runId path.
      const planPath = await waitForPlanFile(plansDir, "big-run.json");
      const bridge = mirror.getBridge();
      assert.ok(bridge, "a big plan materializes the review bridge");
      assert.notEqual(planPath, join(plansDir, "big-run.json"));
      const plan = JSON.parse(await readFile(planPath, "utf-8")) as { blueprint?: { prompt?: string } };
      assert.equal(plan.blueprint?.prompt, "Review the execution plan", "the bridge serves the checkpoint payload");
      assert.notEqual(mirror.lastSubmitResult()?.id, "big-run", "the returned plan id is the bridge's uuid");
      assert.equal(
        mirror.lastSubmitResult()?.reviewUrl,
        undefined,
        "autoOpenBrowser disabled → no review URL attached",
      );
      assert.equal(settled, false, "the run waits for the human verdict in the bridge");

      // The browser path: flip the uuid plan to approved (POST /approve writes
      // exactly this), the bridge poll resolves, and the run proceeds.
      const approved = { ...plan, status: "approved", reviewedAt: new Date().toISOString() };
      await writeFile(planPath, JSON.stringify(approved, null, 2), "utf-8");

      const res = await run;
      assert.equal(res.result.bodyRan, true, "the script body executes after the bridge approval");
      assert.equal(settled, true);
    } finally {
      mirror.getBridge()?.close();
    }
  });
});

// ─── (d) headless + big: never auto-approves ─────────────────────────────────

test("size-route e2e: headless + BIG plan aborts with WORKFLOW_ABORTED (never auto-approves)", async () => {
  await inTempDir(async () => {
    const dir = process.cwd();
    await writeRunPlan(dir, "headless-big", blueprint(10));
    const planPath = join(dir, ".pi", "workflows", "plans", "headless-big.json");
    const before = await readFile(planPath, "utf-8");
    await assert.rejects(
      () => runWorkflow(GATED_SCRIPT, { agent: noopAgent, persistLogs: false, runId: "headless-big" }),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.WORKFLOW_ABORTED &&
        /requires browser review/.test(error.message),
      "a big plan without a review gate aborts instead of auto-approving",
    );
    assert.equal(
      await readFile(planPath, "utf-8"),
      before,
      "the plan stays exactly as the prewalk wrote it (still pending, untouched)",
    );
  });
});

test("size-route e2e: headless + SMALL plan still auto-approves (regression guard)", async () => {
  await inTempDir(async () => {
    const dir = process.cwd();
    await writeRunPlan(dir, "headless-small", blueprint(2));
    const res = await runWorkflow<{ bodyRan: boolean }>(GATED_SCRIPT, {
      agent: noopAgent,
      persistLogs: false,
      runId: "headless-small",
    });
    assert.equal(res.result.bodyRan, true, "a small plan keeps the documented headless auto-approve");
  });
});

// ─── (e) real bridge over HTTP still serves the big-plan review ─────────────

test("size-route e2e: a big plan is reviewable over HTTP (GET /plan + POST /approve)", async () => {
  await inTempDir(async () => {
    const dir = process.cwd();
    await writeRunPlan(dir, "http-big", blueprint(10));
    const plansDir = join(dir, ".pi", "workflows", "plans");
    const port = await freePort();
    const mirror = createMirrorGate(dir, port);
    const run = runWorkflow<{ bodyRan: boolean }>(GATED_SCRIPT, {
      agent: noopAgent,
      checkpointGate: mirror.gate,
      persistLogs: false,
      runId: "http-big",
    });

    try {
      // Wait for the bridge's uuid plan file first (submitPlan is async I/O;
      // the bridge slot materializes only after the classify → bridge step).
      const planPath = await waitForPlanFile(plansDir, "http-big.json");
      const bridge = mirror.getBridge();
      assert.ok(bridge, "the big plan materialized the bridge");
      const plan = JSON.parse(await readFile(planPath, "utf-8")) as { id: string };

      // The vendored review page flow: GET /plan serves the pending plan, then
      // POST /approve persists the verdict.
      const served = await fetch(`http://127.0.0.1:${port}/plan`);
      assert.equal(served.status, 200);
      const servedPlan = (await served.json()) as { plan: { id: string } };
      assert.equal(servedPlan.plan.id, plan.id, "GET /plan serves the pending big-plan review");

      const res = await fetch(`http://127.0.0.1:${port}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      assert.equal(res.status, 200, "the bridge accepts the big-plan approval");

      const result = await run;
      assert.equal(result.result.bodyRan, true, "the run proceeds after the HTTP approval");
    } finally {
      mirror.getBridge()?.close();
    }
  });
});

test("size-route: the exported DEFAULT_APPROVAL_TIMEOUT_MS matches the bridge approvalTimeout (300s)", () => {
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 300_000);
});
