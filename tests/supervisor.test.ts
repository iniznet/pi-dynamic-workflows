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
import { generateSupervisedRunWorkflow, parseSupervisorVerdict } from "../src/supervisor.js";
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
