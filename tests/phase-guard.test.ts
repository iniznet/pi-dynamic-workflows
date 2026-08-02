/**
 * PhaseGuard activation tests: the persisted phase state machine
 * (WorkflowStateManager/PhaseGuard from phases/state-machine.ts) wired into a
 * workflow run via runWorkflow({ phaseState }). phase() stage declarations
 * drive real persisted transitions; agent() inherits the gate; the
 * PhaseGuard.wrapTool wrapper itself fires on the state transition.
 *
 * Existing live phasing (model routing, phase budgets, onPhase events) is
 * untouched — the integration is strictly additive on top of it.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkflowErrorCode } from "../src/errors.js";
import {
  PHASE_TRANSITION_INVALID,
  PhaseGuard,
  SUBAGENT_SPAWN_BLOCKED,
  WorkflowStateManager,
} from "../src/phases/state-machine.js";
import type { CheckpointGate, JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

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

/**
 * Assert the rejected error carries the expected code on error.code (the
 * WorkflowErrorCode enum member) — NOT only the legacy numeric details.code.
 */
function rejectsWithCode(promise: Promise<unknown>, code: number | WorkflowErrorCode): Promise<void> {
  return assert.rejects(
    () => promise,
    (error: unknown) => {
      const candidate = (error as { code?: unknown }).code;
      return candidate === code;
    },
  );
}

// ─── PhaseGuard class: the gate itself ────────────────────────────────────────

test("PhaseGuard.wrapTool fires: blocks before Phase 3 + approval, passes after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    const guard = new PhaseGuard(stateManager);
    const tool = {
      name: "spawn",
      label: "Spawn",
      description: "spawn a subagent",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    } as unknown as ToolDefinition;
    const wrapped = guard.wrapTool(tool);

    // Fresh state: the gate is closed — the wrapped tool fires SUBAGENT_SPAWN_BLOCKED.
    await rejectsWithCode(wrapped.execute("call-1", {}, undefined, undefined, {} as never), SUBAGENT_SPAWN_BLOCKED);

    // Human approval at Phase 2, then execution at Phase 3 opens the gate.
    await stateManager.transitionTo(1);
    await stateManager.transitionTo(2);
    await stateManager.approvePlan();
    await stateManager.transitionTo(3);
    const result = await wrapped.execute("call-2", {}, undefined, undefined, {} as never);
    assert.deepEqual(result, { content: [{ type: "text", text: "done" }], details: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Integration: phase() drives the persisted machine; agent() inherits the gate ──

test("phase() stage declarations drive real transitions; agent() opens only after Phase 3 + approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-run-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    const script = `export const meta = { name: 'g', description: 'guarded run' }
phase('Plan review', { stage: 2 })
const ok = await checkpoint('Approve plan?', { kind: 'confirm' })
phase('Execute', { stage: 3 })
const r = await agent('work', { label: 'execute' })
return { ok, r }`;
    const res = await runWorkflow<{ ok: boolean; r: string }>(script, {
      agent: noopAgent,
      persistLogs: false,
      checkpointGate: approvedGate(),
      phaseState: { stateManager },
    });
    assert.equal(res.result.ok, true);
    assert.equal(res.result.r, "ok");

    const state = await stateManager.getState();
    assert.equal(state.activePhase, 3, "the run advanced the persisted machine to Phase 3");
    assert.equal(state.humanApproved, true, "the gate-approved checkpoint recorded human approval");
    assert.equal(state.plannotatorSubmitted, true, "the reviewed plan was recorded as submitted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent() is gated (SUBAGENT_SPAWN_BLOCKED) before Phase 3 with human approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-gated-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    const script = `export const meta = { name: 'g', description: 'guarded' }
phase('Plan review', { stage: 2 })
const r = await agent('work')
return r`;
    await rejectsWithCode(
      runWorkflow(script, { agent: noopAgent, persistLogs: false, phaseState: { stateManager } }),
      SUBAGENT_SPAWN_BLOCKED,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a backward stage declaration throws PHASE_TRANSITION_INVALID at the next flush point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-backward-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    const script = `export const meta = { name: 'g', description: 'guarded' }
phase('Execute', { stage: 3 })
phase('Plan review', { stage: 2 })
await checkpoint('x', { kind: 'confirm' })
return 1`;
    await rejectsWithCode(
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        checkpointGate: approvedGate(),
        phaseState: { stateManager },
      }),
      PHASE_TRANSITION_INVALID,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a journaled approved run replays on resume without re-blocking at the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-resume-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    const journal = new Map<string, JournalEntry>();
    const script = `export const meta = { name: 'g', description: 'guarded' }
phase('Plan review', { stage: 2 })
const ok = await checkpoint('Approve plan?', { kind: 'confirm' })
phase('Execute', { stage: 3 })
const r = await agent('work', { label: 'execute' })
return { ok, r }`;
    const first = await runWorkflow<{ ok: boolean; r: string }>(script, {
      agent: noopAgent,
      persistLogs: false,
      checkpointGate: approvedGate(),
      phaseState: { stateManager },
      runId: "guard-resume",
      onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
    });
    assert.equal(first.result.ok, true);
    assert.equal(first.result.r, "ok");

    // Resume against a FRESH (unapproved) state machine: both the checkpoint
    // and the agent cache-hit from the journal, so the gate is never consulted
    // and the run completes despite the fresh machine being at Phase 0.
    const resumedMachine = new WorkflowStateManager(join(dir, "resumed"));
    const second = await runWorkflow<{ ok: boolean; r: string }>(script, {
      agent: noopAgent,
      persistLogs: false,
      checkpointGate: approvedGate(),
      phaseState: { stateManager: resumedMachine },
      runId: "guard-resume",
      resumeJournal: journal,
    });
    assert.equal(second.result.ok, true, "journaled replay bypasses the gate");
    assert.equal(second.result.r, "ok", "journaled replay bypasses the gate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateAgentCalls: false keeps persisted transitions without gating agent()", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-ungated-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    const script = `export const meta = { name: 'g', description: 'guarded' }
phase('Execute', { stage: 3 })
const r = await agent('work')
return r`;
    const res = await runWorkflow<string>(script, {
      agent: noopAgent,
      persistLogs: false,
      phaseState: { stateManager, gateAgentCalls: false },
    });
    assert.equal(res.result, "ok");
    const state = await stateManager.getState();
    assert.equal(state.activePhase, 3, "transitions still persist with gating disabled");
    assert.equal(state.humanApproved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without phaseState the run behaves exactly as before (no gating, no state machine)", async () => {
  const script = `export const meta = { name: 'g', description: 'plain' }
phase('Execute', { stage: 3 })
const r = await agent('work')
return r`;
  const res = await runWorkflow<string>(script, { agent: noopAgent, persistLogs: false });
  assert.equal(res.result, "ok", "stage declarations and agent() are inert without the integration");
});

// ─── error.code inspectability (phases-machinery:f1) ──────────────────────────

test("phase-gate failures are inspectable via error.code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-codes-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    const guard = new PhaseGuard(stateManager);
    const tool = {
      name: "spawn",
      label: "Spawn",
      description: "spawn a subagent",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    } as unknown as ToolDefinition;
    const wrapped = guard.wrapTool(tool);

    // Gate-closed wrapped tool: error.code is the enum member, and the legacy
    // numeric details.code is retained for older callers.
    await assert.rejects(
      () => wrapped.execute("call-1", {}, undefined, undefined, {} as never),
      (error: unknown) => {
        const e = error as { code?: WorkflowErrorCode; details?: { code?: number } };
        assert.equal(e.code, WorkflowErrorCode.SUBAGENT_SPAWN_BLOCKED, "error.code carries the phase code");
        assert.equal(e.details?.code, SUBAGENT_SPAWN_BLOCKED, "legacy numeric details.code is retained");
        return true;
      },
    );

    // Backward transition: PHASE_TRANSITION_INVALID surfaces on error.code.
    await stateManager.transitionTo(1);
    await assert.rejects(
      () => stateManager.transitionTo(0),
      (error: unknown) => {
        assert.equal(
          (error as { code?: WorkflowErrorCode }).code,
          WorkflowErrorCode.PHASE_TRANSITION_INVALID,
          "error.code distinguishes the transition class",
        );
        return true;
      },
    );

    // Approval from a non-Phase-2 state: APPROVAL_REQUIRED on error.code.
    await assert.rejects(
      () => stateManager.approvePlan(),
      (error: unknown) => {
        assert.equal(
          (error as { code?: WorkflowErrorCode }).code,
          WorkflowErrorCode.APPROVAL_REQUIRED,
          "error.code distinguishes the approval class",
        );
        return true;
      },
    );

    // assertCanSpawnSubagents (synchronous gate) also carries the code.
    assert.throws(
      () => stateManager.assertCanSpawnSubagents(),
      (error: unknown) => (error as { code?: WorkflowErrorCode }).code === WorkflowErrorCode.SUBAGENT_SPAWN_BLOCKED,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── prerequisite-enforced transitions (phases-machinery:i2) ──────────────────

test("prerequisite-enforced transitions gate phase entry with the phase code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-prereq-"));
  try {
    const stateManager = new WorkflowStateManager(dir, { enforcePrerequisites: true });

    // Phase 1 requires the Phase 0 wayfinder step.
    await assert.rejects(
      () => stateManager.transitionTo(1),
      (error: unknown) => {
        const e = error as { code?: WorkflowErrorCode; details?: { unmet?: string[] } };
        assert.equal(e.code, WorkflowErrorCode.PHASE_TRANSITION_INVALID);
        assert.ok(e.details?.unmet?.includes("wayfinderComplete"), "unmet flag is reported");
        return true;
      },
    );
    await stateManager.setState({ wayfinderComplete: true });
    await stateManager.transitionTo(1);

    // Phase 2 requires the Phase 1 prewalk step.
    await rejectsWithCode(stateManager.transitionTo(2), WorkflowErrorCode.PHASE_TRANSITION_INVALID);
    await stateManager.setState({ prewalkComplete: true });
    await stateManager.transitionTo(2);

    // Phase 3 requires the plan submission AND human approval; a missing
    // approval is classified APPROVAL_REQUIRED on error.code.
    await assert.rejects(
      () => stateManager.transitionTo(3),
      (error: unknown) => {
        const e = error as { code?: WorkflowErrorCode; details?: { unmet?: string[] } };
        assert.equal(e.code, WorkflowErrorCode.APPROVAL_REQUIRED, "missing approval is APPROVAL_REQUIRED");
        assert.ok(e.details?.unmet?.includes("plannotatorSubmitted"));
        assert.ok(e.details?.unmet?.includes("humanApproved"));
        return true;
      },
    );
    await stateManager.setState({ plannotatorSubmitted: true });
    await assert.rejects(
      () => stateManager.transitionTo(3),
      (error: unknown) => {
        const e = error as { code?: WorkflowErrorCode; details?: { unmet?: string[] } };
        assert.equal(e.code, WorkflowErrorCode.APPROVAL_REQUIRED);
        assert.deepEqual(e.details?.unmet, ["humanApproved"]);
        return true;
      },
    );
    await stateManager.approvePlan();
    await stateManager.transitionTo(3);

    assert.equal((await stateManager.getState()).activePhase, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy transition behavior is preserved by default and via explicit opt-out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-legacy-"));
  try {
    // Default construction keeps legacy behavior: stage jumps need no flags.
    const legacy = new WorkflowStateManager(dir);
    await legacy.transitionTo(3);
    assert.equal((await legacy.getState()).activePhase, 3);

    // An explicit per-call opt-out overrides a gated manager.
    const gated = new WorkflowStateManager(join(dir, "gated"), { enforcePrerequisites: true });
    await gated.transitionTo(3, { enforcePrerequisites: false });
    assert.equal((await gated.getState()).activePhase, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── setState compare-and-swap + temp-file hygiene (phases-machinery:f5) ───────

test("concurrent setState calls lose no updates (compare-and-swap)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-cas-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    await Promise.all([
      stateManager.setState({ wayfinderComplete: true }),
      stateManager.setState({ prewalkComplete: true }),
      stateManager.setState({ plannotatorSubmitted: true }),
      stateManager.setState({ humanApproved: true }),
    ]);
    const state = await stateManager.getState();
    assert.equal(state.wayfinderComplete, true, "field from the first writer survives");
    assert.equal(state.prewalkComplete, true, "field from the second writer survives");
    assert.equal(state.plannotatorSubmitted, true, "field from the third writer survives");
    assert.equal(state.humanApproved, true, "field from the fourth writer survives");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setState leaves no stray temp files behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-tmp-"));
  try {
    const stateManager = new WorkflowStateManager(dir);
    await stateManager.setState({ humanApproved: true });
    await stateManager.setState({ wayfinderComplete: true });
    const files = await readdir(dir);
    assert.deepEqual(files, ["active-state.json"], `unexpected temp files: ${files.join(", ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── sidecar normalization (phases-machinery:i4) ──────────────────────────────

test("a hand-edited stale sidecar degrades to defaults instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phase-guard-sidecar-"));
  try {
    await writeFile(
      join(dir, "active-state.json"),
      JSON.stringify({
        activePhase: "2", // wrong type — must degrade, not corrupt comparisons
        humanApproved: "yes", // wrong type
        wayfinderComplete: true, // valid — preserved
        updatedAt: "not-a-date", // garbage timestamp
      }),
      "utf-8",
    );
    const stateManager = new WorkflowStateManager(dir);
    const state = await stateManager.getState();
    assert.equal(state.activePhase, 0, "non-numeric activePhase degrades to 0");
    assert.equal(state.humanApproved, false, "non-boolean flag degrades to false");
    assert.equal(state.wayfinderComplete, true, "valid fields are preserved");
    assert.ok(!Number.isNaN(Date.parse(state.updatedAt)), "garbage timestamp degrades to a parseable one");

    // The degraded machine still behaves: forward transitions work.
    await stateManager.transitionTo(1);
    assert.equal((await stateManager.getState()).activePhase, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
