/**
 * prd-runtime-activation.test.ts — behavioral tests for the runtime wiring
 * (audit ACTIONS REQUIRED 1+2): the run-entry Phase 0/1 pipeline
 * (wayfinder → prewalk) and the PhaseGuard agent()-gate, exercised through
 * the exact option shape the extension layer will pass on every run —
 * `pipeline` + `phaseState` (per-cwd WorkflowStateManager,
 * `gateAgentCalls: false` so default runs stay ungated) — plus the legacy
 * byte-identical path and the tool/manager seam that forwards the options.
 *
 * Seam under test: runWorkflow({ pipeline, phaseState }) directly (mirroring
 * WorkflowManager.executeRun → runWorkflow), the WorkflowToolOptions /
 * ExecOptions forwarding surface, and WorkflowManager.getSnapshot.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { WorkflowAgent } from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { validateBlueprint } from "../src/phases/prewalk.js";
import { WorkflowStateManager } from "../src/phases/state-machine.js";
import type { CheckpointGate } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import type { ExecOptions } from "../src/workflow-manager.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import type { WorkflowToolOptions } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

function approvedGate(): CheckpointGate {
  return {
    async submitPlan() {
      return { id: "plan-1" };
    },
    async waitForApproval() {
      return true;
    },
  };
}

const CLEAR_PROMPT = "Add a /health endpoint returning JSON status with uptime and latency metrics";

/** Trivial workflow body: the pipeline runs before it, so it only returns. */
const TRIVIAL_SCRIPT = `export const meta = { name: 'w', description: 'wired fixture' }
return 'ok'`;

/** Script whose body calls agent() — proves the pipeline fires before the body and the gate stays open. */
const WIRED_SCRIPT = `export const meta = { name: 'w', description: 'wired fixture' }
const r = await agent('work', { label: 'execute' })
return r`;

// ─── temp-dir harness ─────────────────────────────────────────────────────────

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The per-cwd `.pi/workflows` layout the extension wires up. */
function workflowsDir(cwd: string): string {
  return join(cwd, ".pi", "workflows");
}

async function readActiveState(cwd: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(workflowsDir(cwd), "active-state.json"), "utf-8")) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list every file under root; an empty array means zero artifacts. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else out.push(full);
    }
  };
  try {
    await visit(root);
  } catch {
    // root missing — nothing was written
  }
  return out;
}

// ─── wired run: the wayfinder/prewalk firing proof (audit action 1) ───────────

describe("wired run (pipeline + phaseState): wayfinder + prewalk fire", () => {
  it("a top-level run writes map.md + map.json + a prewalk plan and advances active-state.json to Phase 2", async () => {
    const cwd = await tempDir("prd-wired-");
    const stateManager = new WorkflowStateManager(workflowsDir(cwd));
    const res = await runWorkflow<string>(WIRED_SCRIPT, {
      agent: noopAgent,
      cwd,
      persistLogs: false,
      runId: "wired-run",
      pipeline: { stateManager, dir: cwd, prompt: CLEAR_PROMPT },
      phaseState: { stateManager, gateAgentCalls: false },
    });
    assert.equal(res.runId, "wired-run");
    assert.equal(res.result, "ok", "the script body ran after the pipeline stages");

    // Phase 0: the wayfinder persisted the decision map (markdown index + json sidecar).
    const map = JSON.parse(await readFile(join(workflowsDir(cwd), "map.json"), "utf-8")) as {
      rootQuestion: string;
    };
    assert.equal(map.rootQuestion, CLEAR_PROMPT, "map.json is keyed to the assessed prompt");
    const md = await readFile(join(workflowsDir(cwd), "map.md"), "utf-8");
    assert.ok(md.includes("# Wayfinder Map"), "map.md is the human-facing index");

    // Phase 1: the prewalk blueprint landed at the plannotator path.
    const blueprint = JSON.parse(
      await readFile(join(workflowsDir(cwd), "plans", "wired-run.json"), "utf-8"),
    ) as Parameters<typeof validateBlueprint>[0];
    assert.equal(validateBlueprint(blueprint).valid, true, "the persisted blueprint is fully specified");

    // Phase 2: active-state.json advanced through wayfinderComplete → prewalkComplete.
    const state = await readActiveState(cwd);
    assert.equal(state.wayfinderComplete, true, "Phase 0 completed");
    assert.equal(state.prewalkComplete, true, "Phase 1 completed");
    assert.equal(state.activePhase, 2, "the pipeline transitioned into Phase 2 (plannotator review)");

    // The agent()-gate was consulted but stayed open (gateAgentCalls: false).
    assert.equal(
      (await stateManager.getState()).humanApproved,
      false,
      "no approval was required for the ungated agent()",
    );
  });

  it("pipeline dir defaults to the run cwd when omitted (extension shape without dir)", async () => {
    const cwd = await tempDir("prd-wired-default-");
    const stateManager = new WorkflowStateManager(workflowsDir(cwd));
    await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd,
      persistLogs: false,
      runId: "default-dir-run",
      pipeline: { stateManager, prompt: CLEAR_PROMPT },
      phaseState: { stateManager, gateAgentCalls: false },
    });

    const state = await readActiveState(cwd);
    assert.equal(state.activePhase, 2, "artifacts land under cwd/.pi/workflows by default");
    assert.ok(await exists(join(workflowsDir(cwd), "map.json")), "map.json resolved under the run cwd");
    assert.ok(
      await exists(join(workflowsDir(cwd), "plans", "default-dir-run.json")),
      "the plan resolved under the run cwd",
    );
  });
});

// ─── legacy path: byte-identical when the new options are absent ──────────────

describe("legacy path: no pipeline/phaseState → zero state artifacts", () => {
  it("a run without the new options writes nothing under cwd", async () => {
    const cwd = await tempDir("prd-legacy-");
    const res = await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd,
      persistLogs: false,
      runId: "legacy-run",
    });
    assert.equal(res.result, "ok");
    assert.deepEqual(await walkFiles(cwd), [], "no .pi, no active-state.json, no logs — the run wrote zero artifacts");
  });

  it("the same script with the options writes artifacts — the delta is only the opt-in", async () => {
    const cwd = await tempDir("prd-legacy-delta-");
    const stateManager = new WorkflowStateManager(workflowsDir(cwd));
    await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd,
      persistLogs: false,
      runId: "delta-run",
      pipeline: { stateManager, prompt: CLEAR_PROMPT },
      phaseState: { stateManager, gateAgentCalls: false },
    });
    assert.ok((await walkFiles(cwd)).length > 0, "the opt-in path writes its artifacts");
  });
});

// ─── gated script (checkpoint()) with phaseState wired (audit action 2) ───────

describe("gated script (checkpoint()) with phaseState wired", () => {
  it("agent() stays ungated with gateAgentCalls: false even before approval (no regression for unphased scripts)", async () => {
    const cwd = await tempDir("prd-gate-off-");
    const stateManager = new WorkflowStateManager(workflowsDir(cwd));
    const script = `export const meta = { name: 'g', description: 'ungated' }
phase('Plan review', { stage: 2 })
const r = await agent('work')
return r`;
    const res = await runWorkflow<string>(script, {
      agent: noopAgent,
      persistLogs: false,
      phaseState: { stateManager, gateAgentCalls: false },
    });
    assert.equal(res.result, "ok", "the agent()-gate must not block an ungated run parked at Phase 2");
    const state = await stateManager.getState();
    assert.equal(state.activePhase, 2, "persisted transitions still apply with gating disabled");
    assert.equal(state.humanApproved, false, "no approval happened — the gate was consulted, not bypassed");
  });

  it("checkpoint() + phase() + agent() records approval and completes with the gate disabled", async () => {
    const cwd = await tempDir("prd-gate-checkpoint-");
    const stateManager = new WorkflowStateManager(workflowsDir(cwd));
    const script = `export const meta = { name: 'g', description: 'gated flow' }
phase('Plan review', { stage: 2 })
const ok = await checkpoint('Approve plan?', { kind: 'confirm' })
phase('Execute', { stage: 3 })
const r = await agent('work', { label: 'execute' })
return { ok, r }`;
    const res = await runWorkflow<{ ok: boolean; r: string }>(script, {
      agent: noopAgent,
      persistLogs: false,
      checkpointGate: approvedGate(),
      phaseState: { stateManager, gateAgentCalls: false },
    });
    assert.equal(res.result.ok, true);
    assert.equal(res.result.r, "ok");
    const state = await stateManager.getState();
    assert.equal(state.activePhase, 3, "stage jumps work on the default (non-enforcing) machine");
    assert.equal(state.plannotatorSubmitted, true, "the checkpoint recorded the plan submission");
    assert.equal(state.humanApproved, true, "the approved checkpoint recorded human approval");
  });

  it("the gate consults the machine the pipeline produced (SUBAGENT_SPAWN_BLOCKED at Phase 2 when enabled)", async () => {
    const cwd = await tempDir("prd-gate-pipeline-");
    const stateManager = new WorkflowStateManager(workflowsDir(cwd));
    const script = `export const meta = { name: 'g', description: 'gated' }
const r = await agent('work')
return r`;
    await assert.rejects(
      () =>
        runWorkflow(script, {
          agent: noopAgent,
          cwd,
          persistLogs: false,
          pipeline: { stateManager, prompt: CLEAR_PROMPT },
          phaseState: { stateManager }, // gateAgentCalls defaults to true when the integration is provided
        }),
      (error: unknown) => (error as { code?: WorkflowErrorCode }).code === WorkflowErrorCode.SUBAGENT_SPAWN_BLOCKED,
      "the gate must fire on the machine the pipeline advanced to Phase 2",
    );
    const state = await stateManager.getState();
    assert.equal(state.activePhase, 2, "the pipeline advanced the machine before the gate fired");
  });
});

// ─── tool/manager seam (wiring B): options accepted + forwarded ───────────────

describe("tool/manager seam accepts and forwards pipeline/phaseState", () => {
  it("WorkflowToolOptions and ExecOptions accept pipeline/phaseState (type-level check)", async () => {
    const cwd = await tempDir("prd-typed-");
    const stateManager = new WorkflowStateManager(workflowsDir(cwd));
    // These object literals only compile because both option surfaces carry
    // the new fields — excess-property checking guards against a regression
    // in the threading seam (compile-time proof).
    const toolOptions: WorkflowToolOptions = {
      cwd,
      pipeline: { stateManager, dir: cwd, prompt: CLEAR_PROMPT },
      phaseState: { stateManager, gateAgentCalls: false },
    };
    const execOptions: ExecOptions = {
      pipeline: { stateManager, dir: cwd, prompt: CLEAR_PROMPT },
      phaseState: { stateManager, gateAgentCalls: false },
    };
    assert.equal(toolOptions.pipeline?.dir, cwd);
    assert.equal(toolOptions.phaseState?.gateAgentCalls, false);
    assert.equal(execOptions.pipeline?.dir, cwd);
    assert.equal(execOptions.phaseState?.gateAgentCalls, false);
  });

  it("manager-level: runSync forwards the options and getSnapshot queries the run", async () => {
    const cwd = await tempDir("prd-manager-");
    const fakeHome = await tempDir("prd-manager-home-");
    await withFakeHomeAsync(fakeHome, async () => {
      const stateManager = new WorkflowStateManager(workflowsDir(cwd));
      const manager = new WorkflowManager({ cwd, agent: noopAgent as unknown as Pick<WorkflowAgent, "run"> });
      const res = await manager.runSync(
        TRIVIAL_SCRIPT,
        {},
        {
          pipeline: { stateManager, prompt: CLEAR_PROMPT },
          phaseState: { stateManager, gateAgentCalls: false },
        },
      );
      const runId = res.runId;
      assert.ok(runId, "the manager assigned a run id");

      const snapshot = manager.getSnapshot(runId);
      assert.ok(snapshot, "getSnapshot resolves a run through the manager seam");
      assert.equal(snapshot.name, "w", "the snapshot carries the script's meta name");
      assert.equal(snapshot.agentCount, 0);

      const state = await readActiveState(cwd);
      assert.equal(state.activePhase, 2, "the pipeline fired through the manager seam too");
      assert.ok(
        await exists(join(workflowsDir(cwd), "plans", `${runId}.json`)),
        "the blueprint landed via the manager path",
      );
    });
  });
});
