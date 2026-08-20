/**
 * P02 run-scoped supervisor: `supervisedRun` runtime global + `supervised-run`
 * builtin pattern. Covers the contract checkpoints:
 *  1. the settle-path tap fires after each agent settle (event ordering);
 *  2. on drift/stall exactly ONE corrective agent is injected per turn;
 *  3. declared done when the supervisor verdict says the criterion is met;
 *  4. supervisor turns count against the run budget (budget-exhausted stop);
 *  5. resume replays supervisor turns identically (full cache hit = 0 live
 *     calls; an edited criterion re-runs the affected calls live);
 *  6. degraded supervisor votes (SCHEMA_NONCOMPLIANCE) become empty rounds;
 *  7. the generated supervised-run script parses, guards its args, and runs
 *     end-to-end through the registry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { findBuiltinWorkflow } from "../src/builtin-workflows.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  buildTaskPrompt,
  describeCriterion,
  generateSupervisedRunWorkflow,
  normalizeMachineFunctionVerdict,
  parseSupervisorVerdict,
  resolveSupervisedRunCriterion,
} from "../src/supervisor.js";
import { type JournalEntry, parseWorkflowScript, runWorkflow } from "../src/workflow.js";

const supervisedScript = `export const meta = { name: 'supervised_demo', description: 'supervised' }
const outcome = await supervisedRun({
  task: 'Implement the widget',
  criterion: 'All tests pass and the widget is wired into the entry',
  maxRounds: 5,
})
return outcome`;

/**
 * Fake runner scripting the happy supervised loop:
 *  task(0) → supervisor(1) continue+correction → corrective(2) → supervisor(3) done.
 */
function supervisedFake() {
  const state = { calls: 0, supervisorPrompts: 0, labels: [] as string[] };
  return {
    state,
    runner: {
      async run(prompt: string, options?: { label?: string }) {
        state.calls++;
        if (options?.label) state.labels.push(options.label);
        if (prompt.includes("You are the delegated work agent")) return "task done partially";
        if (prompt.includes("You are the supervisor")) {
          state.supervisorPrompts++;
          if (state.supervisorPrompts === 1) {
            return { status: "continue", reason: "stalled", correction: "Finish the wiring" };
          }
          return { status: "done", reason: "criterion met", correction: null };
        }
        if (prompt.includes("corrective work agent")) return "wiring finished";
        return "unexpected";
      },
    },
  };
}

/** Fake runner reporting per-call usage (for budget accounting). */
function usageFake(usage: { input: number; output: number; total: number }) {
  return {
    async run(
      prompt: string,
      options?: {
        onUsage?: (u: {
          input: number;
          output: number;
          total: number;
          cost: number;
          cacheRead: number;
          cacheWrite: number;
        }) => void;
      },
    ) {
      options?.onUsage?.({
        input: usage.input,
        output: usage.output,
        total: usage.total,
        cost: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      if (prompt.includes("You are the supervisor")) {
        return { status: "continue", reason: "stall", correction: "Fix it" };
      }
      return "ok";
    },
  };
}

test("supervisedRun: the supervisor tap fires after each settle (event ordering)", async () => {
  const fake = supervisedFake();
  const events: string[] = [];
  const result = await runWorkflow(supervisedScript, {
    agent: fake.runner,
    persistLogs: false,
    onAgentEnd: (event) => {
      if (event.label === "task") events.push("task-settled");
    },
    onRuntimeEvent: (event) => {
      if (event.type === "supervisor") events.push(`supervisor-${event.stage}-${event.round}`);
    },
  });
  // The supervisor turn is a journaled agent() call that runs AFTER the work
  // agent settles (never before), and a second turn after the corrective agent.
  assert.deepEqual(events, [
    "task-settled",
    "supervisor-start-1",
    "supervisor-end-1",
    "supervisor-start-2",
    "supervisor-end-2",
  ]);
  const outcome = result.result as {
    supervisor: { rounds: number; declaredDone: boolean; corrections: number; observations: unknown[] };
  };
  assert.equal(outcome.supervisor.rounds, 2);
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.corrections, 1);
  assert.ok(outcome.supervisor.observations.length >= 6, "task + supervisor + corrective settles observed");
});

test("supervisedRun: injects exactly ONE corrective agent per continue-with-correction turn", async () => {
  const fake = supervisedFake();
  const result = await runWorkflow(supervisedScript, { agent: fake.runner, persistLogs: false });
  const outcome = result.result as {
    result: string;
    supervisor: {
      rounds: number;
      corrections: number;
      declaredDone: boolean;
      termination: string;
      verdicts: Array<{ status: string; correction: string | null }>;
    };
  };
  assert.equal(outcome.result, "wiring finished", "the corrective agent's result is the final work result");
  assert.equal(outcome.supervisor.rounds, 2);
  assert.equal(outcome.supervisor.corrections, 1, "one correction injected on the first continue turn");
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.termination, "declared-done");
  assert.deepEqual(
    outcome.supervisor.verdicts.map((v) => v.status),
    ["continue", "done"],
  );
  assert.deepEqual(
    outcome.supervisor.verdicts.map((v) => v.correction),
    ["Finish the wiring", null],
  );
  assert.deepEqual(fake.state.labels, ["task", "supervisor 1", "corrective 1", "supervisor 2"]);
});

test("supervisedRun: declares done when the criterion is verified met on the first check", async () => {
  const runner = {
    async run(prompt: string) {
      if (prompt.includes("You are the delegated work agent")) return "complete";
      if (prompt.includes("You are the supervisor")) {
        return { status: "done", reason: "criterion verified", correction: null };
      }
      return "unexpected";
    },
  };
  const result = await runWorkflow(supervisedScript, { agent: runner, persistLogs: false });
  const outcome = result.result as {
    supervisor: { rounds: number; corrections: number; declaredDone: boolean; termination: string };
  };
  assert.equal(outcome.supervisor.rounds, 1);
  assert.equal(outcome.supervisor.corrections, 0);
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.termination, "declared-done");
});

test("supervisedRun: a continue verdict without a correction is a bounded empty round (max-rounds)", async () => {
  const runner = {
    async run(prompt: string) {
      if (prompt.includes("You are the delegated work agent")) return "partial";
      return { status: "continue", reason: "no progress signal", correction: null };
    },
  };
  const script = supervisedScript.replace("maxRounds: 5", "maxRounds: 3");
  const result = await runWorkflow(script, { agent: runner, persistLogs: false });
  const outcome = result.result as {
    supervisor: { rounds: number; corrections: number; declaredDone: boolean; termination: string };
  };
  assert.equal(outcome.supervisor.rounds, 3, "all bounded rounds ran without a correction");
  assert.equal(outcome.supervisor.corrections, 0);
  assert.equal(outcome.supervisor.declaredDone, false);
  assert.equal(outcome.supervisor.termination, "max-rounds");
});

test("supervisedRun: a non-compliant supervisor vote degrades to an empty round, never fails the run", async () => {
  let supervisorCalls = 0;
  const runner = {
    async run(prompt: string) {
      if (prompt.includes("You are the delegated work agent")) return "partial";
      supervisorCalls++;
      throw new WorkflowError("schema wall", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    },
  };
  const script = supervisedScript.replace("maxRounds: 5", "maxRounds: 2");
  const result = await runWorkflow(script, { agent: runner, persistLogs: false });
  assert.equal(supervisorCalls, 2);
  const outcome = result.result as { supervisor: { rounds: number; declaredDone: boolean; termination: string } };
  assert.equal(outcome.supervisor.rounds, 2, "degraded turns still count as rounds");
  assert.equal(outcome.supervisor.declaredDone, false);
  assert.equal(outcome.supervisor.termination, "max-rounds");
});

test("supervisedRun: supervisor turns count against the run token budget (budget-exhausted stop)", async () => {
  // 10 (task) + 10 (supervisor) + 10 (corrective) = 30 > 25 → the round-2 guard
  // stops the loop; every turn's spend is folded into the run aggregate.
  const result = await runWorkflow(supervisedScript, {
    agent: usageFake({ input: 5, output: 5, total: 10 }),
    persistLogs: false,
    tokenBudget: 25,
  });
  const outcome = result.result as { supervisor: { rounds: number; corrections: number; termination: string } };
  assert.equal(outcome.supervisor.rounds, 1, "the second supervisor turn is gated by the exhausted budget");
  assert.equal(outcome.supervisor.corrections, 1);
  assert.equal(outcome.supervisor.termination, "budget-exhausted");
  assert.equal(result.tokenUsage?.total, 30, "task + supervisor + corrective turns all counted against the budget");
});

test("supervisedRun: a budget already spent by the task agent stops supervision immediately", async () => {
  const result = await runWorkflow(supervisedScript, {
    agent: usageFake({ input: 5, output: 5, total: 10 }),
    persistLogs: false,
    tokenBudget: 10,
  });
  const outcome = result.result as { supervisor: { rounds: number; termination: string; declaredDone: boolean } };
  assert.equal(outcome.supervisor.rounds, 0, "no supervisor turn can start on an exhausted budget");
  assert.equal(outcome.supervisor.termination, "budget-exhausted");
  assert.equal(outcome.supervisor.declaredDone, false);
  assert.equal(result.tokenUsage?.total, 10);
});

test("supervisedRun: resume replays supervisor turns identically (full cache hit)", async () => {
  const journal: JournalEntry[] = [];
  const first = supervisedFake();
  const r1 = await runWorkflow(supervisedScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "sup-resume-full",
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(first.state.calls, 4, "task + supervisor + corrective + supervisor");
  assert.deepEqual(
    journal.map((entry) => entry.index),
    [0, 1, 2, 3],
    "every supervisor turn is a journaled positional call",
  );

  const second = supervisedFake();
  const r2 = await runWorkflow(supervisedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "sup-resume-full",
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(second.state.calls, 0, "a full cache hit replays every supervisor turn — zero live calls");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("supervisedRun: an edited criterion invalidates the supervisor turns downstream of the task", async () => {
  const journal: JournalEntry[] = [];
  const first = supervisedFake();
  await runWorkflow(supervisedScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "sup-resume-edit",
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(first.state.calls, 4);

  // The criterion is embedded in the task prompt (so the work agent knows the
  // target) AND in every supervisor/corrective prompt — editing it must re-run
  // the supervisor loop live instead of serving a stale journaled verdict.
  const edited = supervisedScript.replace(
    "All tests pass and the widget is wired into the entry",
    "The widget is exposed via the public entry only",
  );
  const second = supervisedFake();
  await runWorkflow(edited, {
    agent: second.runner,
    persistLogs: false,
    runId: "sup-resume-edit",
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(second.state.calls, 4, "an edited criterion re-runs the whole supervised loop live");
});

test("supervisedRun: parseSupervisorVerdict is total and deterministic over any raw result", () => {
  assert.deepEqual(parseSupervisorVerdict({ status: "done", reason: "r", correction: null }), {
    status: "done",
    reason: "r",
    correction: null,
  });
  assert.deepEqual(parseSupervisorVerdict({ status: "continue", reason: "r", correction: "fix" }), {
    status: "continue",
    reason: "r",
    correction: "fix",
  });
  assert.deepEqual(parseSupervisorVerdict({ status: "continue", reason: "r", correction: "   " }), {
    status: "continue",
    reason: "r",
    correction: null,
  });
  for (const garbage of [null, undefined, "string", 42, [], {}, { status: "nope" }]) {
    const verdict = parseSupervisorVerdict(garbage);
    assert.equal(verdict.status, "continue");
    assert.equal(verdict.correction, null);
  }
});

// ─── supervised-run builtin (registry + generated script) ─────────────────────

test("generateSupervisedRunWorkflow produces a parseable, supervisedRun-driving script", () => {
  const { meta, body } = parseWorkflowScript(generateSupervisedRunWorkflow());
  assert.equal(meta.name, "supervised_run");
  assert.deepEqual(
    meta.phases?.map((phase) => phase.title),
    ["Execute"],
  );
  assert.match(body, /supervisedRun\(/);
  assert.match(body, /args\.criterion/);
  assert.match(body, /maxRounds/);
});

test("supervised-run builtin: registry descriptor resolves with validation and a work toolset", async () => {
  const builtin = findBuiltinWorkflow("supervised-run");
  assert.ok(builtin, "registry contains supervised-run");
  await assert.rejects(
    builtin.resolve(process.cwd(), { task: "", criterion: "x" }),
    /task/,
    "a missing task fails loudly before a run starts",
  );
  await assert.rejects(
    builtin.resolve(process.cwd(), { task: "x", criterion: "" }),
    /criterion/,
    "a missing criterion fails loudly before a run starts",
  );
  await assert.rejects(
    builtin.resolve(process.cwd(), { task: "x", criterion: "y", maxRounds: 0 }),
    /maxRounds/,
    "an out-of-range maxRounds fails loudly",
  );
  const invocation = await builtin.resolve(process.cwd(), {
    task: "Implement the widget",
    criterion: "All tests pass",
    maxRounds: 3,
  });
  assert.equal(invocation.toolset, "supervised-run");
  assert.match(invocation.script, /supervisedRun\(/);
});

test("supervised-run builtin: generated script runs end-to-end through runWorkflow(args)", async () => {
  const journal: JournalEntry[] = [];
  const fake = supervisedFake();
  const script = generateSupervisedRunWorkflow();
  const args = {
    task: "Implement the widget",
    criterion: "All tests pass and the widget is wired into the entry",
    maxRounds: 5,
  };
  const result = await runWorkflow(script, {
    agent: fake.runner,
    persistLogs: false,
    args,
    onAgentJournal: (entry) => journal.push(entry),
  });
  const outcome = result.result as {
    supervisor: { rounds: number; declaredDone: boolean; corrections: number; termination: string };
    result: string;
  };
  assert.equal(outcome.supervisor.rounds, 2);
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.corrections, 1);
  assert.equal(outcome.result, "wiring finished");
  assert.equal(journal.length, 4, "task + supervisor + corrective + supervisor all journaled");

  // Resume the generated script: full cache hit — zero live calls.
  const replayed = supervisedFake();
  const r2 = await runWorkflow(script, {
    agent: replayed.runner,
    persistLogs: false,
    args,
    runId: result.runId,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(replayed.state.calls, 0, "generated supervised-run script replays identically on resume");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(result.result));
});

test("supervised-run builtin: generated script guards missing args", async () => {
  const runner = {
    async run() {
      return "never";
    },
  };
  const result = await runWorkflow(generateSupervisedRunWorkflow(), {
    agent: runner,
    persistLogs: false,
    args: { task: "", criterion: "" },
  });
  const out = result.result as { error: string; outcome: null };
  assert.match(out.error, /task and criterion are required/);
  assert.equal(out.outcome, null);
});

// ─── V2-N1 machine completion criteria ─────────────────────────────────────────

const machineFunctionDoneScript = `export const meta = { name: 'sup_machine_done', description: 'x' }
const outcome = await supervisedRun({
  task: 'Implement the widget',
  criterion: (observations) => observations.some((o) => o.kind === 'end' && o.label === 'task' && o.result === 'complete'),
  maxRounds: 3,
})
return outcome`;

const machineCorrectionScript = `export const meta = { name: 'sup_machine_corr', description: 'x' }
const outcome = await supervisedRun({
  task: 'Implement the widget',
  criterion: (observations) => {
    const wired = observations.some((o) => o.kind === 'end' && o.label === 'corrective 1' && String(o.result).includes('wired'))
    return wired ? { status: 'done', reason: 'wired into the entry' } : { status: 'continue', correction: 'Wire the widget into the entry' }
  },
  maxRounds: 3,
})
return outcome`;

const machineTestScript = `export const meta = { name: 'sup_machine_test', description: 'x' }
const outcome = await supervisedRun({
  task: 'Implement the widget',
  criterion: { tool: 'bash', args: 'npx tsc --noEmit', assert: { exitCode: 0 } },
  maxRounds: 3,
})
return outcome`;

/** Fake runner scripting machine-test mode: fail once, then pass after the correction. */
function machineTestFake() {
  const state = { calls: 0, labels: [] as string[], testCalls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string, options?: { label?: string }) {
        state.calls++;
        if (options?.label) state.labels.push(options.label);
        if (prompt.includes("You are the delegated work agent")) return "partial";
        if (prompt.includes("Run the following command")) {
          state.testCalls++;
          return state.testCalls === 1 ? { exitCode: 1, output: "ERROR: type mismatch" } : { exitCode: 0, output: "" };
        }
        if (prompt.includes("corrective work agent")) return "wired into the entry";
        return "unexpected";
      },
    },
  };
}

test("supervisedRun machine-function criterion: a pure predicate replaces the LLM supervisor turn (done on first check)", async () => {
  const state = { calls: 0, supervisorPrompts: 0 };
  const runner = {
    async run(prompt: string) {
      state.calls++;
      if (prompt.includes("You are the supervisor")) state.supervisorPrompts++;
      return "complete";
    },
  };
  const result = await runWorkflow(machineFunctionDoneScript, { agent: runner, persistLogs: false });
  const outcome = result.result as {
    supervisor: {
      rounds: number;
      mode: string;
      declaredDone: boolean;
      termination: string;
      corrections: number;
    };
  };
  assert.equal(state.calls, 1, "only the task agent runs — the supervisor agent() call is skipped");
  assert.equal(state.supervisorPrompts, 0, "no LLM supervisor turn ever runs");
  assert.equal(outcome.supervisor.rounds, 1);
  assert.equal(outcome.supervisor.mode, "machine-function");
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.termination, "declared-done");
  assert.equal(outcome.supervisor.corrections, 0);
});

test("supervisedRun machine-function criterion: a verdict correction injects exactly one corrective agent (deterministic)", async () => {
  const state = { calls: 0, correctivePrompts: 0 };
  const runner = {
    async run(prompt: string) {
      state.calls++;
      if (prompt.includes("You are the delegated work agent")) return "partial";
      if (prompt.includes("corrective work agent")) {
        state.correctivePrompts++;
        return "wired into the entry";
      }
      return "unexpected";
    },
  };
  const result = await runWorkflow(machineCorrectionScript, { agent: runner, persistLogs: false });
  const outcome = result.result as {
    result: string;
    supervisor: {
      rounds: number;
      mode: string;
      declaredDone: boolean;
      corrections: number;
      termination: string;
    };
  };
  assert.equal(state.calls, 2, "task + one corrective agent — no LLM supervisor turn");
  assert.equal(state.correctivePrompts, 1, "the script's deterministic correction is honored");
  assert.equal(outcome.supervisor.rounds, 2);
  assert.equal(outcome.supervisor.mode, "machine-function");
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.corrections, 1);
  assert.equal(outcome.result, "wired into the entry");
});

test("supervisedRun machine-function criterion: an unsatisfied predicate is a bounded empty-round loop (max-rounds)", async () => {
  const state = { calls: 0 };
  const runner = {
    async run(_prompt: string) {
      state.calls++;
      return "partial";
    },
  };
  const script = `export const meta = { name: 'sup_machine_stall', description: 'x' }
const outcome = await supervisedRun({
  task: 'Implement the widget',
  criterion: () => false,
  maxRounds: 3,
})
return outcome`;
  const result = await runWorkflow(script, { agent: runner, persistLogs: false });
  const outcome = result.result as {
    supervisor: { rounds: number; mode: string; declaredDone: boolean; termination: string; corrections: number };
  };
  assert.equal(state.calls, 1, "only the task agent — machine rounds spend no agent calls");
  assert.equal(outcome.supervisor.rounds, 3, "all bounded rounds evaluated the machine predicate");
  assert.equal(outcome.supervisor.mode, "machine-function");
  assert.equal(outcome.supervisor.declaredDone, false);
  assert.equal(outcome.supervisor.termination, "max-rounds");
  assert.equal(outcome.supervisor.corrections, 0);
});

test("supervisedRun machine-test criterion: a passing postcondition declares done without any LLM turn", async () => {
  const state = { calls: 0, supervisorPrompts: 0 };
  const runner = {
    async run(prompt: string) {
      state.calls++;
      if (prompt.includes("You are the supervisor")) state.supervisorPrompts++;
      if (prompt.includes("Run the following command")) return { exitCode: 0, output: "" };
      return "done";
    },
  };
  const result = await runWorkflow(machineTestScript, { agent: runner, persistLogs: false });
  const outcome = result.result as {
    supervisor: { rounds: number; mode: string; declaredDone: boolean; termination: string; corrections: number };
  };
  assert.equal(state.calls, 2, "task + one machine-test subagent step");
  assert.equal(state.supervisorPrompts, 0, "the machine test replaced the LLM supervisor turn");
  assert.equal(outcome.supervisor.rounds, 1);
  assert.equal(outcome.supervisor.mode, "machine-test");
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.termination, "declared-done");
});

test("supervisedRun machine-test criterion: a failed postcondition injects one corrective agent, then re-checks", async () => {
  const fake = machineTestFake();
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(machineTestScript, {
    agent: fake.runner,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  const outcome = result.result as {
    result: string;
    supervisor: {
      rounds: number;
      mode: string;
      declaredDone: boolean;
      corrections: number;
      finalVerdict: { status: string; correction: string | null };
      verdicts: Array<{ status: string; correction: string | null }>;
    };
  };
  assert.equal(fake.state.calls, 4, "task + test(fail) + corrective + test(pass)");
  assert.deepEqual(fake.state.labels, ["task", "supervisor test 1", "corrective 1", "supervisor test 2"]);
  assert.equal(outcome.supervisor.rounds, 2);
  assert.equal(outcome.supervisor.mode, "machine-test");
  assert.equal(outcome.supervisor.declaredDone, true);
  assert.equal(outcome.supervisor.corrections, 1);
  assert.equal(outcome.result, "wired into the entry");
  assert.ok(
    outcome.supervisor.verdicts[0].correction?.includes("exit code 1"),
    "the corrective instruction carries the deterministic machine failure detail",
  );
  assert.deepEqual(
    journal.map((entry) => entry.index),
    [0, 1, 2, 3],
    "every machine-test step and corrective agent is a journaled positional call",
  );
});

test("supervisedRun machine criteria: resume replays identically (full cache hit = zero live calls)", async () => {
  // Function mode: the journal holds only the task call — the skipped
  // supervisor call keeps call indices deterministic across resume.
  const fnJournal: JournalEntry[] = [];
  const firstFn = {
    async run() {
      return "complete";
    },
  };
  const r1 = await runWorkflow(machineFunctionDoneScript, {
    agent: firstFn,
    persistLogs: false,
    runId: "sup-machine-fn-resume",
    onAgentJournal: (entry) => fnJournal.push(entry),
  });
  assert.deepEqual(
    fnJournal.map((entry) => entry.index),
    [0],
    "machine-function mode journals only the task call",
  );
  const secondFn = {
    async run() {
      throw new Error("live call on a full cache hit");
    },
  };
  const r2 = await runWorkflow(machineFunctionDoneScript, {
    agent: secondFn,
    persistLogs: false,
    runId: "sup-machine-fn-resume",
    resumeJournal: new Map(fnJournal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));

  // Test mode: the machine-test steps are journaled agent() calls too.
  const testJournal: JournalEntry[] = [];
  const first = machineTestFake();
  const firstTestResult = await runWorkflow(machineTestScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "sup-machine-test-resume",
    onAgentJournal: (entry) => testJournal.push(entry),
  });
  assert.equal(first.state.calls, 4);
  const replayed = machineTestFake();
  const r3 = await runWorkflow(machineTestScript, {
    agent: replayed.runner,
    persistLogs: false,
    runId: "sup-machine-test-resume",
    resumeJournal: new Map(testJournal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(replayed.state.calls, 0, "a full cache hit replays task + test steps + corrective — zero live calls");
  assert.equal(JSON.stringify(r3.result), JSON.stringify(firstTestResult.result));
});

test("supervisedRun machine criteria: editing the test args invalidates the cached machine-test step", async () => {
  const journal: JournalEntry[] = [];
  const first = machineTestFake();
  await runWorkflow(machineTestScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "sup-machine-test-edit",
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(first.state.calls, 4);

  const edited = machineTestScript.replace("npx tsc --noEmit", "npm test -- --filter widget");
  const replayed = machineTestFake();
  await runWorkflow(edited, {
    agent: replayed.runner,
    persistLogs: false,
    runId: "sup-machine-test-edit",
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(replayed.state.calls, 4, "an edited args re-runs the machine-test loop live");
});

test("resolveSupervisedRunCriterion classifies + validates the criterion union", () => {
  assert.equal(resolveSupervisedRunCriterion("all tests pass").mode, "llm");
  assert.equal(resolveSupervisedRunCriterion(() => true).mode, "machine-function");
  assert.equal(
    resolveSupervisedRunCriterion({ args: "npx tsc --noEmit", assert: { exitCode: 0 } }).mode,
    "machine-test",
  );
  assert.equal(
    resolveSupervisedRunCriterion({ args: "pattern" }).mode,
    "machine-test",
    "assert defaults to exitCode 0",
  );
  for (const garbage of [
    "",
    "   ",
    null,
    42,
    {},
    { args: "" },
    { args: "x", tool: "fish" },
    { args: "x", assert: {} },
  ]) {
    assert.throws(
      () => resolveSupervisedRunCriterion(garbage),
      TypeError,
      `garbage criterion rejected: ${String(garbage)}`,
    );
  }
});

test("normalizeMachineFunctionVerdict is total and deterministic over any raw result", () => {
  assert.deepEqual(normalizeMachineFunctionVerdict(true), {
    status: "done",
    reason: "machine completion criterion satisfied",
    correction: null,
  });
  assert.deepEqual(normalizeMachineFunctionVerdict(false), {
    status: "continue",
    reason: "machine completion criterion not yet satisfied",
    correction: null,
  });
  assert.deepEqual(normalizeMachineFunctionVerdict({ status: "done", reason: "r" }), {
    status: "done",
    reason: "r",
    correction: null,
  });
  assert.deepEqual(normalizeMachineFunctionVerdict({ status: "continue", correction: "fix it" }), {
    status: "continue",
    reason: "",
    correction: "fix it",
  });
  assert.deepEqual(normalizeMachineFunctionVerdict({ status: "continue", correction: "   " }), {
    status: "continue",
    reason: "",
    correction: null,
  });
  for (const garbage of [null, undefined, "string", 42, [], {}, { status: "nope" }]) {
    assert.equal(normalizeMachineFunctionVerdict(garbage).status, "continue");
  }
});

test("describeCriterion renders machine criteria deterministically (never the function body)", () => {
  const text = describeCriterion("all tests pass");
  assert.ok(text.includes("all tests pass"));
  const fn = describeCriterion(() => true);
  assert.ok(fn.includes("script-side pure predicate"), "function criteria render a fixed label, not source");
  assert.ok(!fn.includes("=>"), "the function body never leaks into a prompt hash");
  const spec = describeCriterion({ tool: "bash", args: "npx tsc --noEmit", assert: { exitCode: 0 } });
  assert.ok(spec.includes("npx tsc --noEmit"));
  assert.ok(spec.includes('"exitCode":0'));
  // The task prompt embeds the deterministic description for machine modes.
  const taskPrompt = buildTaskPrompt("Implement the widget", () => false);
  assert.ok(taskPrompt.includes("script-side pure predicate"));
  assert.ok(taskPrompt.includes("Implement the widget"));
});
