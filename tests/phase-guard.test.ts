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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  PhaseGuard,
  PHASE_TRANSITION_INVALID,
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

/** Assert the rejected error carries a numeric details.code. */
function rejectsWithCode(promise: Promise<unknown>, code: number): Promise<void> {
  return assert.rejects(() => promise, (error: unknown) => {
    const details = (error as { details?: { code?: unknown } }).details;
    return details !== undefined && details !== null && details.code === code;
  });
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
    await rejectsWithCode(
      wrapped.execute("call-1", {}, undefined, undefined, {} as never),
      SUBAGENT_SPAWN_BLOCKED,
    );

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
