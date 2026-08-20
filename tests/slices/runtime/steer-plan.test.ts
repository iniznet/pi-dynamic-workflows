/**
 * V2-P08 — live steering, steer-plan channel (PRIMARY half).
 *
 * The runtime exposes a script-visible `steerPlan` global whose verbs are
 * read() (current plan/phase state snapshot) and submit(revision) (a journaled
 * plan-rescope). This file verifies:
 *
 *  1. read() reports the declared plan/phase state (phases, budgets, phase
 *     spend, current phase, run budget, shared re-plan forecast, applied
 *     revisions) and is a pure function of journal-derived state.
 *  2. submit() applies the rescope (phase ceilings re-base — the phase gate
 *     honors the new ceiling immediately), records the revision in order, and
 *     emits `steer` runtime events.
 *  3. The revision is JOURNALED (callIndex-keyed, fixed-field hash) and a
 *     resume replays the SAME applied revision (stage "replay" event) —
 *     deterministic rescope across pause/resume.
 *  4. A CHANGED revision on resume is a journal miss and re-submits live
 *     (checkpoint() replay contract).
 *  5. The applied revisions persist as `steerRevisions:<runId>` in the run's
 *     durable store and surface in the run report's additive steerRevisions
 *     block.
 *  6. The workflow_control tool's verbs schema + action guard remain
 *     READ-ONLY — exactly the five lifecycle verbs, NO steer verb. Roadmap §4
 *     V2-P08(a) is formally RE-TARGETED to this script-side surface (see the
 *     reconciliation constraint on the steerPlan entry of
 *     WORKFLOW_CAPABILITY_CONTRACT): the journaled plan-rescope contract is
 *     inherently script-visible, and a host-side steer verb would need new
 *     manager→run request plumbing that the deferred in-flight interrupt half
 *     parks for the same reason.
 *  7. The in-flight cooperative interrupt half is explicitly NON-GOAL —
 *     documented in the capability contract (no interrupt-check hook exists;
 *     agent sessions expose only AbortSignal). Steer revisions never join any
 *     agent()/checkpoint() resume identity.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { closeRunDurableStore } from "../../../src/durable-store.js";
import { buildRunReport } from "../../../src/run-report.js";
import type { JournalEntry, SteerPlanRevision } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";
import { WORKFLOW_CAPABILITY_CONTRACT } from "../../../src/workflow-capability-contract.js";
import { createWorkflowControlTool } from "../../../src/workflow-control-tool.js";
import type { WorkflowManager } from "../../../src/workflow-manager.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";

const okAgent = {
  async run(prompt: string) {
    return prompt;
  },
};

const RUN_ID = "steer-run-1";

// ─── read(): current plan/phase state ───────────────────────────────────────

test("steer: read() reports the declared plan/phase state deterministically", async () => {
  const script = `export const meta = { name: 'steer_read', description: 'read the plan' }
phase('a', { budget: 400 })
phase('b', { budget: 300 })
await agent('work', { phase: 'a' })
const snapshot = steerPlan.read()
return {
  currentPhase: snapshot.currentPhase,
  phases: snapshot.phases,
  agentCount: snapshot.agentCount,
  callSeq: snapshot.callSeq,
  budget: snapshot.budget,
  forecast: snapshot.forecast,
  revisions: snapshot.revisions,
}`;
  const res = await runWorkflow<{
    currentPhase: string | null;
    phases: Array<{ title: string; budget: number | null; spend: number }>;
    agentCount: number;
    callSeq: number;
    budget: { limit: number | null; spent: number; remaining: number };
    forecast: { plannedRemaining: number; projectedTotal: number; overBudget: boolean };
    revisions: unknown[];
  }>(script, { agent: okAgent, persistLogs: false, runId: RUN_ID, tokenBudget: 1000 });
  assert.equal(res.result.currentPhase, "b", "the current phase is the last declared phase");
  assert.equal(res.result.phases[0]?.title, "a");
  assert.equal(res.result.phases[0]?.budget, 400);
  assert.ok((res.result.phases[0]?.spend ?? 0) > 0, "the settled agent's spend is attributed to its assigned phase");
  assert.deepEqual(res.result.phases[1], { title: "b", budget: 300, spend: 0 });
  assert.equal(res.result.agentCount, 1, "one agent() call happened before the read");
  assert.equal(res.result.callSeq, 1, "callSeq is the journal position (next call's index)");
  assert.equal(res.result.budget.limit, 1000);
  assert.equal(
    res.result.budget.remaining + res.result.budget.spent,
    1000,
    "remaining + spent = the run's frozen budget ceiling",
  );
  assert.equal(
    res.result.forecast.plannedRemaining,
    700 - (res.result.phases[0]?.spend ?? 0),
    "unspent phase budgets sum the remaining plan (spent phase capacity excluded)",
  );
  assert.equal(res.result.forecast.overBudget, false);
  assert.deepEqual(res.result.revisions, [], "no revision applied yet");
});

test("steer: read() reflects an applied revision's rescope (budgets + revisions list)", async () => {
  const script = `export const meta = { name: 'steer_read_after', description: 'read after rescope' }
phase('a', { budget: 800 })
phase('b', { budget: 800 })
const before = steerPlan.read()
steerPlan.submit({ phases: [{ title: 'a', budget: 100 }, { title: 'b', budget: 100 }], currentPhase: 'b', reason: 'drift' })
const after = steerPlan.read()
return { beforeBudgetA: before.phases[0].budget, afterBudgetA: after.phases[0].budget, afterBudgetB: after.phases[1].budget, currentPhase: after.currentPhase, revisions: after.revisions, forecastProjected: after.forecast.projectedTotal }`;
  const res = await runWorkflow<{
    beforeBudgetA: number | null;
    afterBudgetA: number | null;
    afterBudgetB: number | null;
    currentPhase: string | null;
    revisions: SteerPlanRevision[];
    forecastProjected: number;
  }>(script, { agent: okAgent, persistLogs: false, runId: RUN_ID, tokenBudget: 1000 });
  assert.equal(res.result.beforeBudgetA, 800);
  assert.equal(res.result.afterBudgetA, 100, "submit() re-bases the phase ceiling");
  assert.equal(res.result.afterBudgetB, 100);
  assert.equal(res.result.currentPhase, "b", "currentPhase steers the target phase");
  assert.equal(res.result.revisions.length, 1);
  assert.equal(res.result.revisions[0]?.reason, "drift");
  assert.equal(res.result.forecastProjected, 200, "the shared forecast reflects the rescope");
});

test("steer: the rescoped phase ceiling is honored by the phase budget gate", async () => {
  // Submit shrinks phase 'a' from 800 to 100 BEFORE any agent settles; the
  // first agent's settle charges 400 into phase 'a', so the SECOND agent's
  // pre-call phase gate (phaseSpent 400 >= rescoped 100) must trip
  // TOKEN_BUDGET_EXHAUSTED.
  const script = `export const meta = { name: 'steer_gate', description: 'rescope gates spend' }
phase('a', { budget: 800 })
steerPlan.submit({ phases: [{ title: 'a', budget: 100 }] })
try {
  await agent('expensive', { phase: 'a' })
  await agent('second', { phase: 'a' })
  return { tripped: false }
} catch (error) {
  return { tripped: String(error).includes('sub-budget exhausted') }
}`;
  const spendingAgent = {
    async run(prompt: string, options?: { onUsage?: (usage: unknown) => void }) {
      options?.onUsage?.({ input: 300, output: 100, total: 400, cost: 0, cacheRead: 0, cacheWrite: 0 });
      return prompt;
    },
  };
  const res = await runWorkflow<{ tripped: boolean }>(script, {
    agent: spendingAgent,
    persistLogs: false,
    runId: RUN_ID,
    tokenBudget: 10_000,
  });
  assert.equal(res.result.tripped, true, "the rescoped 100-token ceiling trips the phase gate on the next call");
});

// ─── submit(): journaled + replayed deterministically on resume ─────────────

test("steer: a submitted revision is journaled and replays identically on resume", async () => {
  const journal = new Map<string, JournalEntry>();
  const events: Array<{ type: string; stage?: string; callIndex?: number }> = [];
  const options = {
    agent: okAgent,
    persistLogs: false,
    runId: RUN_ID,
    tokenBudget: 1000,
    onRuntimeEvent: (event: { type: string; stage?: string; callIndex?: number }) => events.push(event),
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  };
  const script = `export const meta = { name: 'steer_journal', description: 'journaled rescope' }
phase('a', { budget: 600 })
const applied = steerPlan.submit({ phases: [{ title: 'a', budget: 200 }], note: 'shrink', reason: 'forecast' })
await agent('work', { phase: 'a' })
const snapshot = steerPlan.read()
return { applied, phases: snapshot.phases, revisions: snapshot.revisions }`;

  const first = await runWorkflow<{
    applied: SteerPlanRevision;
    phases: Array<{ title: string; budget: number | null }>;
    revisions: SteerPlanRevision[];
  }>(script, options);

  // The submit was journaled as a real journal entry (callIndex 0), BEFORE the
  // agent call (callIndex 1).
  assert.equal(journal.size, 2, "the revision + the agent call are both journaled");
  const [revisionEntry, agentEntry] = [...journal.values()].sort((a, b) => a.index - b.index);
  assert.equal(revisionEntry?.index, 0);
  assert.equal(agentEntry?.index, 1);
  assert.deepEqual(revisionEntry?.result, {
    phases: [{ title: "a", budget: 200 }],
    note: "shrink",
    reason: "forecast",
  });
  assert.equal(typeof revisionEntry?.hash, "string");
  assert.ok((revisionEntry?.hash?.length ?? 0) === 64, "sha256 hash");
  const steerSubmitEvents = events.filter((event) => event.type === "steer");
  assert.equal(steerSubmitEvents.length, 1);
  assert.equal(steerSubmitEvents[0]?.stage, "submit");
  assert.equal(steerSubmitEvents[0]?.callIndex, 0);

  // Resume: same script + the journal → the SAME revision replays (cache hit,
  // stage "replay"), never re-submitted live, and the agent call replays too.
  const events2: Array<{ type: string; stage?: string; callIndex?: number }> = [];
  const replayed = await runWorkflow<{
    applied: SteerPlanRevision;
    phases: Array<{ title: string; budget: number | null }>;
    revisions: SteerPlanRevision[];
  }>(script, { ...options, resumeJournal: journal, onRuntimeEvent: (event) => events2.push(event) });

  assert.deepEqual(replayed.result.applied, first.result.applied, "the replay returns the SAME applied revision");
  assert.deepEqual(
    replayed.result.phases.map(({ title, budget }) => ({ title, budget })),
    first.result.phases.map(({ title, budget }) => ({ title, budget })),
    "the rescoped plan ceilings are identical on resume",
  );
  // Note: phases[].spend is LIVE-path attribution (replayed calls charge no
  // tokens — the same phaseSpend behavior the phase gate already relies on), so
  // the replayed prefix reports 0 spend; the report derives authoritative
  // per-phase spend from the persisted agents.
  assert.deepEqual(replayed.result.revisions, first.result.revisions, "the applied revisions list is identical");
  const steerReplayEvents = events2.filter((event) => event.type === "steer");
  assert.equal(steerReplayEvents.length, 1, "one steer event on the replay path");
  assert.equal(steerReplayEvents[0]?.stage, "replay", "the replayed revision is a replay, not a live submit");
  assert.equal(steerReplayEvents[0]?.callIndex, 0);
});

test("steer: a changed revision on resume is a journal miss and re-submits live", async () => {
  const journal = new Map<string, JournalEntry>();
  const options = {
    agent: okAgent,
    persistLogs: false,
    runId: RUN_ID,
    tokenBudget: 1000,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  };
  const original = `export const meta = { name: 'steer_miss', description: 'miss' }
phase('a', { budget: 600 })
const applied = steerPlan.submit({ phases: [{ title: 'a', budget: 200 }] })
return applied`;
  const edited = `export const meta = { name: 'steer_miss', description: 'miss' }
phase('a', { budget: 600 })
const applied = steerPlan.submit({ phases: [{ title: 'a', budget: 450 }] })
return applied`;

  const first = await runWorkflow<SteerPlanRevision>(original, options);
  assert.deepEqual(first.result, { phases: [{ title: "a", budget: 200 }] });

  const events: Array<{ type: string; stage?: string }> = [];
  const second = await runWorkflow<SteerPlanRevision>(edited, {
    ...options,
    resumeJournal: journal,
    onRuntimeEvent: (event: { type: string; stage?: string }) => events.push(event),
  });
  assert.deepEqual(second.result, { phases: [{ title: "a", budget: 450 }] }, "the changed revision applies live");
  const steerEvents = events.filter((event) => event.type === "steer");
  assert.equal(steerEvents.length, 1);
  assert.equal(steerEvents[0]?.stage, "submit", "a changed revision is a live submit (checkpoint miss semantics)");
});

test("steer: submit validation rejects malformed revisions without corrupting the run", async () => {
  const script = `export const meta = { name: 'steer_bad', description: 'bad revision' }
const results = []
for (const bad of [
  'nope',
  { phases: 'nope' },
  { phases: [null] },
  { phases: [{ title: '' }] },
  { phases: [{ title: 'a', budget: -5 }] },
  { phases: [{ title: 'a', budget: Number.NaN }] },
]) {
  try {
    steerPlan.submit(bad)
    results.push('accepted')
  } catch (error) {
    // String(error) carries a "TypeError: " prefix — match the channel name.
    results.push(String(error).includes('steerPlan.submit') ? 'rejected' : 'wrong-error')
  }
}
return results`;
  const res = await runWorkflow<string[]>(script, { agent: okAgent, persistLogs: false, runId: RUN_ID });
  // Spread into a host array (the vm realm's Array is a different realm's
  // object, so cross-realm reference identity differs even for equal values).
  assert.deepEqual([...res.result], ["rejected", "rejected", "rejected", "rejected", "rejected", "rejected"]);
});

// ─── durable persistence + report block ─────────────────────────────────────

test("steer: applied revisions persist as steerRevisions:<runId> and surface in the report", () =>
  withFakeHomeAsync(mkdtempSync(join(tmpdir(), "steer-report-test-")), async () => {
    const cwd = mkdtempSync(join(tmpdir(), "steer-report-cwd-"));
    const runId = "steer-report-run";
    try {
      await runWorkflow(
        `export const meta = { name: 'steer_persist', description: 'persisted rescope' }
phase('a', { budget: 500 })
steerPlan.submit({ phases: [{ title: 'a', budget: 120 }], reason: 'budget' })
await agent('work', { phase: 'a' })
return 'done'`,
        { agent: okAgent, cwd, persistLogs: false, runId },
      );

      const storeDir = join(process.env.HOME ?? "", ".pi", "agent", "durable-store");
      const files = readdirSync(storeDir).filter((f) => f.endsWith(".json") && !f.endsWith(".bak"));
      assert.equal(files.length, 1, "one per-project store file");
      const raw = JSON.parse(readFileSync(join(storeDir, files[0] ?? ""), "utf8")) as {
        entries: Record<string, unknown>;
      };
      const persisted = raw.entries[`steerRevisions:${runId}`];
      assert.ok(
        Array.isArray(persisted) && persisted.length === 1,
        "the revision persists under steerRevisions:<runId>",
      );
      const record = persisted[0] as { revision: SteerPlanRevision; callIndex: number };
      assert.equal(record.callIndex, 0);
      assert.deepEqual(record.revision, { phases: [{ title: "a", budget: 120 }], reason: "budget" });

      // Report: the additive steerRevisions block carries the revision.
      const report = buildRunReport(
        {
          runId,
          workflowName: "steer_persist",
          script: `export const meta = { name: 'steer_persist', description: 'x' }`,
          status: "completed",
          phases: ["a"],
          agents: [{ id: 1, label: "work", prompt: "work", status: "done" }],
          logs: [],
          startedAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T00:00:01.000Z",
        } as Parameters<typeof buildRunReport>[0],
        { durable: { entries: raw.entries, ledger: [] } },
      );
      assert.deepEqual(report.steerRevisions, [
        { phases: [{ title: "a", budget: 120 }], reason: "budget", callIndex: 0 },
      ]);
    } finally {
      closeRunDurableStore(runId);
    }
  }));

// ─── control-tool guard is read-only (no steer verb) ────────────────────────

test("steer: the workflow_control verbs schema + action guard stay read-only (no steer verb)", () => {
  const manager = {
    listRuns: () => [],
    getSnapshot: () => null,
    pause: () => false,
    async resume() {
      return false;
    },
    stop: () => false,
  } as unknown as WorkflowManager;
  const tool = createWorkflowControlTool({ manager });

  // The documented five lifecycle verbs are the ONLY ones the schema admits —
  // "steer" is NOT a control-tool verb in this slice (the steer surface is
  // script-side; the damage-control steer verb needs manager plumbing that is
  // explicitly out of scope — the guard is read-only).
  for (const action of ["list", "status", "pause", "resume", "stop"]) {
    assert.equal(
      Check(tool.parameters, action === "list" ? { action } : { action, runId: "x" }),
      true,
      `${action} is a valid verb`,
    );
  }
  assert.equal(Check(tool.parameters, { action: "steer", runId: "x" }), false, "no steer verb in the control tool");
  assert.equal(Check(tool.parameters, { action: "steerPlan", runId: "x" }), false);

  const prepare = tool.prepareArguments as (value: unknown) => unknown;
  assert.throws(() => prepare({ action: "steer", runId: "x" }), /requires action/);
  assert.throws(() => prepare({ action: "steer", plan: { phases: [] } }), /requires action/);
});

// ─── in-flight interrupt is explicitly non-goal + identity exclusion ────────

test("steer: the in-flight interrupt is explicitly deferred in the capability contract", () => {
  const steerPlan = WORKFLOW_CAPABILITY_CONTRACT.definition.capabilities.find(
    (capability) => capability.id === "workflow.runtime.steerPlan",
  );
  assert.ok(steerPlan, "steerPlan is a declared runtime global");
  assert.ok(
    steerPlan.constraints.some((constraint) => /EXPLICITLY DEFERRED/i.test(constraint)),
    "the contract documents the deferred in-flight interrupt half",
  );
  assert.ok(
    steerPlan.constraints.some((constraint) => /AbortSignal/.test(constraint)),
    "the only abort channel today is AbortSignal (agent.ts) — no interrupt hook",
  );
  assert.ok(
    steerPlan.constraints.some((constraint) => /hashAgentCall/.test(constraint)),
    "steer revisions never join any agent()/checkpoint() resume identity",
  );
  assert.ok(
    steerPlan.constraints.some((constraint) => /replayed deterministically|journaled/.test(constraint)),
    "revisions are journaled and replay deterministically on resume",
  );
});

test("steer: the revision hash never enters hashAgentCall identity", async () => {
  // A run that submits a steer revision and a run that doesn't must produce
  // IDENTICAL agent-call hashes for the same agent prompt — the revision is a
  // journaled delta, not an identity input.
  const journalA = new Map<string, JournalEntry>();
  const journalB = new Map<string, JournalEntry>();
  const scriptA = `export const meta = { name: 'steer_identity', description: 'identity' }
phase('a', { budget: 500 })
steerPlan.submit({ phases: [{ title: 'a', budget: 100 }] })
await agent('same prompt')
return steerPlan.read().revisions.length`;
  const scriptB = `export const meta = { name: 'steer_identity', description: 'identity' }
phase('a', { budget: 500 })
await agent('same prompt')
return 0`;
  await runWorkflow(scriptA, {
    agent: okAgent,
    persistLogs: false,
    runId: RUN_ID,
    tokenBudget: 1000,
    onAgentJournal: (entry) => journalA.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  });
  await runWorkflow(scriptB, {
    agent: okAgent,
    persistLogs: false,
    runId: RUN_ID,
    tokenBudget: 1000,
    onAgentJournal: (entry) => journalB.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  });
  const agentHashA = [...journalA.values()].find((entry) => entry.index === 1)?.hash;
  const agentHashB = [...journalB.values()].find((entry) => entry.index === 0)?.hash;
  assert.equal(agentHashB, agentHashA, "the steer revision did not change the agent() call identity hash");
});
