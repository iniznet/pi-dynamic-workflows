/**
 * Fixture-level tests for the Phase 0/1 pipeline wiring (G4 + G2): the
 * run-entry hook in runWorkflow({ pipeline }) assesses the task prompt with
 * the wayfinder fog heuristic, persists a decision map for foggy prompts,
 * gates prewalk on wayfinderComplete, and — once wayfinder completes —
 * generates the "1986 Aircraft Manual" blueprint at
 * .pi/workflows/plans/<runId>.json and flips prewalkComplete so the Phase 2
 * gate opens.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WorkflowErrorCode } from "../src/errors.js";
import { runPrewalkStage, validateBlueprint } from "../src/phases/prewalk.js";
import { PHASE_PREREQUISITES, WorkflowStateManager } from "../src/phases/state-machine.js";
import {
  type DecisionMap,
  type FrontierMapper,
  isMapFogResolved,
  runWayfinderStage,
  TicketType,
} from "../src/phases/wayfinder.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

const CLEAR_PROMPT = "Add a /health endpoint returning JSON status with uptime and latency metrics";
const FOGGY_PROMPT = "maybe build some kind of feature, not sure how, etc";

/** Trivial workflow body: the pipeline runs before it, so it only returns. */
const TRIVIAL_SCRIPT = `export const meta = { name: 'p', description: 'pipeline fixture' }
return 'ok'`;

/** Mapper seam emitting one ticket per wayfinder type (research/prototype/grilling/task). */
const fourTypeMapper: FrontierMapper = (prompt) => ({
  rootQuestion: prompt,
  tickets: [
    {
      id: "r1",
      type: TicketType.RESEARCH,
      title: "Look up docs",
      description: "doc lookup",
      claims: [{ statement: "docs read", source: "research" }],
    },
    {
      id: "p1",
      type: TicketType.PROTOTYPE,
      title: "Prototype the UI",
      description: "hitl stub",
      claims: [{ statement: "prototype exists", source: "assumption" }],
    },
    {
      id: "g1",
      type: TicketType.GRILLING,
      title: "Confirm the UX direction",
      description: "hitl interview",
      question: "Which UX direction?",
      claims: [{ statement: "direction confirmed", source: "grilling" }],
    },
    {
      id: "t1",
      type: TicketType.TASK,
      title: "Implement",
      description: "the work",
      blockedBy: ["r1", "g1"],
      claims: [{ statement: "parents answered", source: "assumption" }],
    },
  ],
});

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

async function readState(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "active-state.json"), "utf-8")) as Record<string, unknown>;
}

async function listPlans(dir: string): Promise<string[]> {
  try {
    return await readdir(join(dir, ".pi", "workflows", "plans"));
  } catch {
    return [];
  }
}

// ─── fog-dissolution semantics (the wayfinder completion rule) ────────────────

describe("isMapFogResolved", () => {
  const map = (tickets: DecisionMap["tickets"]): DecisionMap => ({
    tickets,
    rootQuestion: "q",
    updatedAt: new Date().toISOString(),
  });
  const ticket = (
    id: string,
    type: TicketType,
    status: DecisionMap["tickets"][number]["status"],
  ): DecisionMap["tickets"][number] => ({
    id,
    type,
    title: "t",
    description: "",
    status,
    claims: [],
    blocks: [],
    blockedBy: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("is false while any decision ticket (research/prototype/grilling) is unresolved", () => {
    assert.equal(
      isMapFogResolved(
        map([
          ticket("r1", TicketType.RESEARCH, "open"),
          ticket("g1", TicketType.GRILLING, "resolved"),
          ticket("p1", TicketType.PROTOTYPE, "in-progress"),
        ]),
      ),
      false,
    );
  });

  it("is true when every decision ticket is resolved", () => {
    assert.equal(
      isMapFogResolved(
        map([
          ticket("r1", TicketType.RESEARCH, "resolved"),
          ticket("g1", TicketType.GRILLING, "resolved"),
          ticket("p1", TicketType.PROTOTYPE, "resolved"),
        ]),
      ),
      true,
    );
  });

  it("ignores task tickets — implementation work never gates the wayfinder's own completion", () => {
    assert.equal(isMapFogResolved(map([ticket("t1", TicketType.TASK, "open")])), true);
  });
});

// ─── Phase 0 stage semantics ──────────────────────────────────────────────────

describe("runWayfinderStage", () => {
  it("persists a fresh map for a foggy prompt and stays incomplete; a clear prompt completes", async () => {
    const dir = await tempDir("pipeline-stage-");
    const stateManager = new WorkflowStateManager(dir);

    const foggy = await runWayfinderStage({ stateManager, prompt: FOGGY_PROMPT, dir, mapper: fourTypeMapper });
    assert.equal(foggy.savedMap, true, "a foggy prompt writes the decision map");
    assert.equal(foggy.completed, false, "open decision tickets keep the wayfinder incomplete");
    assert.equal((await stateManager.getState()).wayfinderComplete, false);

    const clear = await runWayfinderStage({ stateManager, prompt: CLEAR_PROMPT, dir });
    assert.equal(clear.completed, true, "a clear prompt has no fog to dissolve");
    assert.equal((await stateManager.getState()).wayfinderComplete, true);
  });
});

// ─── fixture: vague prompt → map on disk, prewalk blocked ─────────────────────

describe("runWorkflow pipeline wiring (G4 + G2)", () => {
  it("a vague prompt produces a 4-type decision map on disk and leaves prewalk blocked", async () => {
    const dir = await tempDir("pipeline-foggy-");
    const stateManager = new WorkflowStateManager(dir);
    const res = await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd: dir,
      persistLogs: false,
      runId: "foggy-run",
      pipeline: { stateManager, prompt: FOGGY_PROMPT, mapper: fourTypeMapper },
    });
    assert.equal(res.runId, "foggy-run");

    const map = JSON.parse(await readFile(join(dir, ".pi", "workflows", "map.json"), "utf-8")) as DecisionMap;
    assert.deepEqual(
      [...new Set(map.tickets.map((t) => t.type))].sort(),
      [TicketType.GRILLING, TicketType.PROTOTYPE, TicketType.RESEARCH, TicketType.TASK],
      "the decision map carries all four ticket types",
    );
    const md = await readFile(join(dir, ".pi", "workflows", "map.md"), "utf-8");
    assert.ok(md.includes("# Wayfinder Map"), "the markdown index is written");

    // A blocked wayfinder performs no transition, so no state file exists yet;
    // the manager normalizes a missing file to the Phase 0 defaults, which is
    // exactly the gating truth this test asserts.
    const state = await stateManager.getState();
    assert.equal(state.wayfinderComplete, false, "fog remains — the wayfinder must not complete");
    assert.equal(state.prewalkComplete, false, "prewalk stays blocked");
    assert.equal(state.activePhase, 0, "no forward transition before the wayfinder completes");
    assert.deepEqual(await listPlans(dir), [], "no blueprint may exist while prewalk is blocked");
  });

  it("prewalk is blocked until wayfinderComplete, then writes the blueprint and flips the flag", async () => {
    const dir = await tempDir("pipeline-gate-");
    const stateManager = new WorkflowStateManager(dir);
    const options = {
      stateManager,
      task: CLEAR_PROMPT,
      codebaseSummary: "typescript project with vitest",
      dir,
      runId: "gate-run",
    };

    await assert.rejects(
      () => runPrewalkStage(options),
      (error: unknown) => {
        const e = error as { code?: WorkflowErrorCode; details?: { unmet?: string[] } };
        assert.equal(e.code, WorkflowErrorCode.PHASE_TRANSITION_INVALID, "the gate failure carries the phase code");
        assert.deepEqual(e.details?.unmet, ["wayfinderComplete"]);
        return true;
      },
    );
    assert.deepEqual(await listPlans(dir), [], "no blueprint before the gate opens");

    await stateManager.markWayfinderComplete();
    const blueprint = await runPrewalkStage(options);
    assert.equal(validateBlueprint(blueprint).valid, true, "the persisted blueprint is fully specified");
    const onDisk = JSON.parse(await readFile(join(dir, ".pi", "workflows", "plans", "gate-run.json"), "utf-8"));
    assert.equal(onDisk.title, CLEAR_PROMPT);
    assert.equal(
      (await stateManager.getState()).prewalkComplete,
      true,
      "prewalkComplete flips once the blueprint lands",
    );
  });

  it("a completed wayfinder produces a blueprint file and opens the Phase 2 gate", async () => {
    const dir = await tempDir("pipeline-clear-");
    const stateManager = new WorkflowStateManager(dir);
    const res = await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd: dir,
      persistLogs: false,
      runId: "clear-run",
      pipeline: { stateManager, prompt: CLEAR_PROMPT },
    });
    assert.equal(res.runId, "clear-run");

    const blueprint = JSON.parse(
      await readFile(join(dir, ".pi", "workflows", "plans", "clear-run.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(blueprint.title, CLEAR_PROMPT);
    assert.equal(validateBlueprint(blueprint as unknown as Parameters<typeof validateBlueprint>[0]).valid, true);

    const state = await readState(dir);
    assert.equal(state.wayfinderComplete, true);
    assert.equal(state.prewalkComplete, true);
    assert.equal(state.activePhase, 2, "the pipeline transitioned into Phase 2 (plannotator review)");
    assert.equal(
      PHASE_PREREQUISITES[2].every((prerequisite) => state[prerequisite.flag] === true),
      true,
      "every Phase 2 prerequisite is satisfied — the gate is open",
    );
  });

  it("a foggy prompt whose decision tickets were resolved in earlier sessions completes the wayfinder (session-by-session)", async () => {
    const dir = await tempDir("pipeline-resolved-");
    const workflowsDir = join(dir, ".pi", "workflows");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      join(workflowsDir, "map.json"),
      JSON.stringify({
        rootQuestion: FOGGY_PROMPT,
        tickets: [
          {
            id: "r1",
            type: "research",
            title: "Look up docs",
            description: "",
            status: "resolved",
            claims: [],
            blocks: [],
            blockedBy: [],
          },
          {
            id: "g1",
            type: "grilling",
            title: "Ask user",
            description: "",
            status: "resolved",
            claims: [],
            blocks: [],
            blockedBy: [],
          },
        ],
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const stateManager = new WorkflowStateManager(dir);
    await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd: dir,
      persistLogs: false,
      runId: "resolved-run",
      pipeline: { stateManager, prompt: FOGGY_PROMPT, mapper: fourTypeMapper },
    });

    const state = await readState(dir);
    assert.equal(state.wayfinderComplete, true, "resolved decision tickets dissolve the fog");
    assert.equal(state.prewalkComplete, true);
    assert.deepEqual(await listPlans(dir), ["resolved-run.json"], "the blueprint lands once the wayfinder completes");
  });

  it("falls back to phaseState.stateManager when the pipeline carries no manager of its own", async () => {
    const dir = await tempDir("pipeline-fallback-");
    const stateManager = new WorkflowStateManager(dir);
    await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd: dir,
      persistLogs: false,
      runId: "fallback-run",
      phaseState: { stateManager },
      pipeline: { prompt: CLEAR_PROMPT },
    });

    const state = await readState(dir);
    assert.equal(state.wayfinderComplete, true);
    assert.equal(state.prewalkComplete, true);
    assert.deepEqual(await listPlans(dir), ["fallback-run.json"]);
  });

  it("without pipeline configuration the run writes no phase artifacts (regression guard)", async () => {
    const dir = await tempDir("pipeline-absent-");
    await runWorkflow(TRIVIAL_SCRIPT, {
      agent: noopAgent,
      cwd: dir,
      persistLogs: false,
      runId: "none-run",
    });
    const entries = await readdir(dir);
    assert.equal(
      entries.some((e) => e === ".pi"),
      false,
      "no phase artifacts without the pipeline opt-in",
    );
  });

  it("core-06: a rejected queued transition does not poison later valid stage declarations", async () => {
    const dir = await tempDir("pipeline-chain-");
    const stateManager = new WorkflowStateManager(dir);
    // Stage 2 → backward 1 (rejects, swallowed) → forward 3: the OLD
    // phaseStateChain.then() wiring would skip the stage-3 transition forever
    // (poisoned chain) and fail the run at the flush point; the fix lets each
    // later declaration run, so the machine lands on the valid final stage and
    // the agent gate opens.
    const script = `export const meta = { name: 'g', description: 'chain recovery' }
phase('Plan review', { stage: 2 })
phase('Revisit plan', { stage: 1 })
phase('Execute', { stage: 3 })
const r = await agent('work', { label: 'execute' })
return r`;
    const res = await runWorkflow(script, {
      agent: noopAgent,
      cwd: dir,
      persistLogs: false,
      phaseState: { stateManager },
    });
    assert.equal(res.result, "ok", "the run survives the one bad transition and the agent is not blocked");
    const state = await readState(dir);
    assert.equal(state.activePhase, 3, "the later valid stage-3 declaration still applied");
  });

  it("core-06: a backward declaration as the LAST queued transition still fails at the flush point", async () => {
    const dir = await tempDir("pipeline-chain-backward-");
    const stateManager = new WorkflowStateManager(dir);
    const script = `export const meta = { name: 'g', description: 'chain recovery' }
phase('Execute', { stage: 3 })
phase('Plan review', { stage: 2 })
const r = await agent('work', { label: 'execute' })
return r`;
    await assert.rejects(
      () =>
        runWorkflow(script, {
          agent: noopAgent,
          cwd: dir,
          persistLogs: false,
          phaseState: { stateManager },
        }),
      (error: unknown) => (error as { code?: unknown }).code === WorkflowErrorCode.PHASE_TRANSITION_INVALID,
    );
  });
});
