import assert from "node:assert/strict";
import test from "node:test";
import { machineValidateTest, validateTestGateTests } from "../../../src/test-gate.js";
import { runWorkflow } from "../../../src/workflow.js";

/**
 * W2 P01 — testGate machine-checked postcondition gate.
 *
 * Each test runs as a SUBAGENT STEP (agent({ toolNames: ['bash'] | ['grep'],
 * schema })) whose structured capture is machine-validated by pure-JS
 * predicates — the fake agent below emulates a bash/grep toolset relaying the
 * captured exit code + output.
 */

/** Extract the command/pattern from a testGate prompt (``` fenced block). */
function commandOf(prompt: string): string {
  const match = /```\n([\s\S]*?)\n```/.exec(prompt);
  return match?.[1] ?? "";
}

interface CapturedCall {
  prompt: string;
  toolNames?: string[];
  label?: string;
  schema?: unknown;
}

const bashAgentFactory = (calls: CapturedCall[]) => ({
  async run(prompt: string, o?: { schema?: unknown; toolNames?: string[]; label?: string }) {
    calls.push({ prompt, toolNames: o?.toolNames, label: o?.label, schema: o?.schema });
    if (!o?.schema) return "ok";
    const command = commandOf(prompt);
    if (command.includes("test-ok")) return { exitCode: 0, output: "all tests passed" };
    if (command.includes("test-bad")) return { exitCode: 1, output: "failure: something went wrong" };
    if (command.includes("test-output")) return { exitCode: 0, output: "line one\nmarker-content-here\nline three" };
    if (command.includes("test-grep")) return { exitCode: 0, output: "src/index.ts:12: marker-content-here" };
    return { exitCode: 0, output: "unknown-command" };
  },
});

test("testGate: passing machine tests open the gate with captured evidence", async () => {
  const calls: CapturedCall[] = [];
  const script = `export const meta = { name: 'tg_ok', description: 'machine gate opens' }
const out = await testGate(() => 'work', {
  tests: [{ command: 'test-ok', assert: { exitCode: 0 } }],
})
return out`;
  const res = await runWorkflow<{
    ok: boolean;
    value: string;
    attempts: number;
    tests: Array<{ command: string; passed: boolean; detail: string; exitCode: number | null; output: string }>;
  }>(script, { agent: bashAgentFactory(calls), persistLogs: false });

  assert.equal(res.result.ok, true);
  assert.equal(res.result.value, "work");
  assert.equal(res.result.attempts, 1, "the first attempt passes immediately");
  assert.equal(res.result.tests.length, 1);
  assert.equal(res.result.tests[0].passed, true);
  assert.equal(res.result.tests[0].exitCode, 0, "exit code is machine-captured");
  assert.equal(res.result.tests[0].output, "all tests passed");
  assert.equal(calls.length, 1, "exactly one subagent step ran");
  assert.deepEqual(calls[0]?.toolNames, ["bash"], "the test step restricts to the bash tool");
  assert.match(calls[0]?.label ?? "", /^testgate 1\.1\.\d+$/, "label carries attempt.test.callSeq");
});

test("testGate: failing postcondition runs bounded rework then fails closed (never silent)", async () => {
  const calls: CapturedCall[] = [];
  const script = `export const meta = { name: 'tg_fail', description: 'machine gate fails closed' }
const seen = []
const out = await testGate((feedback, i) => { seen.push(feedback ?? null); return i }, {
  tests: [{ command: 'test-bad', assert: { exitCode: 0 } }],
  postconditions: ['the output file must contain the summary'],
  attempts: 2,
})
return { ok: out.ok, value: out.value, attempts: out.attempts, seen, tests: out.tests }`;
  const res = await runWorkflow<{
    ok: boolean;
    value: number;
    attempts: number;
    seen: Array<string | null>;
    tests: Array<{ passed: boolean; detail: string; exitCode: number | null }>;
  }>(script, { agent: bashAgentFactory(calls), persistLogs: false });

  assert.equal(res.result.ok, false, "fail-closed after bounded rework");
  assert.equal(res.result.attempts, 2, "both bounded attempts were spent");
  assert.equal(res.result.value, 1, "the last thunk value is returned");
  assert.equal(res.result.tests[0].passed, false);
  assert.match(res.result.tests[0].detail, /exit code 1 != expected 0/, "the machine detail names the mismatch");
  assert.equal(res.result.tests[0].exitCode, 1, "the real exit code is captured even on failure");
  assert.equal(calls.length, 2, "one subagent step per attempt");
  assert.match(res.result.seen[1] ?? "", /exit code 1 != expected 0/, "rework feedback carries the machine detail");
  assert.match(
    res.result.seen[1] ?? "",
    /the output file must contain the summary/,
    "author postconditions are embedded in the feedback",
  );
  assert.ok(
    res.logs.some((line) => line.includes("testGate attempt 1 test 1 FAILED")),
    "failures are logged",
  );
});

test("testGate: feedback-driven rework opens the gate on the next attempt", async () => {
  // Host-side counter models the rework: the command only succeeds after the
  // thunk has seen the machine feedback (attempt 2), mirroring a thunk that
  // fixes the artifact between attempts.
  let attempts = 0;
  const agent = {
    async run(_p: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      attempts++;
      return attempts === 1 ? { exitCode: 1, output: "old" } : { exitCode: 0, output: "reworked ok" };
    },
  };
  const script = `export const meta = { name: 'tg_rework', description: 'rework from feedback' }
let reworked = false
const out = await testGate((feedback, i) => { reworked = feedback !== undefined && feedback.includes('exit code 1'); return i }, {
  tests: [{ command: 'test-bad', assert: { exitCode: 0, outputContains: 'reworked ok' } }],
})
return { ok: out.ok, attempts: out.attempts, reworked }`;
  const res = await runWorkflow<{ ok: boolean; attempts: number; reworked: boolean }>(script, {
    agent,
    persistLogs: false,
  });

  assert.equal(res.result.reworked, true, "the thunk saw the machine feedback before attempt 2");
  assert.equal(res.result.ok, true);
  assert.equal(res.result.attempts, 2);
});

test("testGate: machine assertions over the captured output (contains / matches / fileContains)", async () => {
  const script = `export const meta = { name: 'tg_asserts', description: 'output assertions' }
const out = await testGate(() => 'work', {
  tests: [
    { command: 'test-output', assert: { outputContains: 'marker-content-here' } },
    { command: 'test-output', assert: { outputMatches: '^line one\\n' } },
    { command: 'test-output', assert: { fileContains: 'marker-content-here' } },
  ],
})
return out`;
  const res = await runWorkflow<{ ok: boolean; attempts: number; tests: Array<{ passed: boolean }> }>(script, {
    agent: bashAgentFactory([]),
    persistLogs: false,
  });

  assert.equal(res.result.ok, true);
  assert.equal(res.result.attempts, 1);
  assert.ok(
    res.result.tests.every((t) => t.passed),
    "all three machine predicates pass",
  );
});

test("testGate: a machine assertion miss fails the test with the precise detail", async () => {
  const script = `export const meta = { name: 'tg_miss', description: 'assertion miss' }
const out = await testGate(() => 'work', {
  tests: [
    { command: 'test-output', assert: { outputContains: 'MISSING-SENTINEL' } },
    { command: 'test-output', assert: { outputMatches: '^wrong-start' } },
  ],
})
return out`;
  const res = await runWorkflow<{ ok: boolean; attempts: number; tests: Array<{ passed: boolean; detail: string }> }>(
    script,
    { agent: bashAgentFactory([]), persistLogs: false },
  );

  assert.equal(res.result.ok, false);
  assert.equal(res.result.attempts, 3, "bounded rework default is exhausted");
  assert.match(res.result.tests[0].detail, /output does not contain: MISSING-SENTINEL/);
  assert.match(res.result.tests[1].detail, /output does not match: \/\^wrong-start\//);
});

test("testGate: grep tool mode validates match output", async () => {
  const calls: CapturedCall[] = [];
  const script = `export const meta = { name: 'tg_grep', description: 'grep mode' }
const out = await testGate(() => 'work', {
  tests: [{ command: 'test-grep', assert: { outputContains: 'marker-content-here' } }],
  tool: 'grep',
})
return out`;
  const res = await runWorkflow<{ ok: boolean; attempts: number }>(script, {
    agent: bashAgentFactory(calls),
    persistLogs: false,
  });

  assert.equal(res.result.ok, true);
  assert.equal(res.result.attempts, 1);
  assert.deepEqual(calls[0]?.toolNames, ["grep"], "the test step restricts to the grep tool");
  assert.match(calls[0]?.prompt ?? "", /Search the current workspace with the grep tool/);
});

test("testGate: empty or malformed tests throw a TypeError (loud script bug)", async () => {
  const base = { agent: bashAgentFactory([]), persistLogs: false };
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'tg_empty', description: 'empty tests' }
return await testGate(() => 'x', { tests: [] })`,
      base,
    ),
    TypeError,
  );
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'tg_badcmd', description: 'blank command' }
return await testGate(() => 'x', { tests: [{ command: '  ' }] })`,
      base,
    ),
    TypeError,
  );
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'tg_badassert', description: 'empty assert' }
return await testGate(() => 'x', { tests: [{ command: 'ls', assert: {} }] })`,
      base,
    ),
    TypeError,
  );
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'tg_exitcode_grep', description: 'exitCode needs bash' }
return await testGate(() => 'x', { tests: [{ command: 'p', assert: { exitCode: 0 } }], tool: 'grep' })`,
      base,
    ),
    TypeError,
  );
});

test("testGate: emits control-attempt runtime events with helper testGate", async () => {
  const events: string[] = [];
  const script = `export const meta = { name: 'tg_evt', description: 'events' }
return await testGate(() => 'work', { tests: [{ command: 'test-ok' }] })`;
  await runWorkflow(script, {
    agent: bashAgentFactory([]),
    persistLogs: false,
    onRuntimeEvent: (event) => {
      if (event.type === "control-attempt") events.push(`${event.helper}:${event.attempt}:${event.accepted}`);
    },
  });

  assert.deepEqual(events, ["testGate:1:true"]);
});

test("testGate: a recoverably-failed subagent step fails the test closed", async () => {
  const script = `export const meta = { name: 'tg_null', description: 'null step' }
const out = await testGate(() => 'work', { tests: [{ command: 'boom', assert: { exitCode: 0 } }] })
return out`;
  const res = await runWorkflow<{ ok: boolean; tests: Array<{ passed: boolean; detail: string }> }>(script, {
    agent: {
      async run(_p: string, o?: { schema?: unknown }) {
        return o?.schema ? null : "ok"; // the test step fails recoverably
      },
    },
    persistLogs: false,
  });

  assert.equal(res.result.ok, false, "a null step never opens the gate");
  assert.match(res.result.tests[0].detail, /no output captured/, "fail-closed with a precise detail");
});

// ─── pure machine-validation surface (unit, outside a run) ───────────────────

test("machineValidateTest: validates exit codes, substrings, regex, and null steps", () => {
  const step = { exitCode: 0, output: "alpha beta gamma" };
  assert.equal(machineValidateTest(step, { exitCode: 0 }).passed, true);
  assert.equal(machineValidateTest(step, { exitCode: 1 }).passed, false);
  assert.equal(machineValidateTest(step, { outputContains: "beta" }).passed, true);
  assert.equal(machineValidateTest(step, { outputContains: "zeta" }).passed, false);
  assert.equal(machineValidateTest(step, { outputMatches: "^alpha" }).passed, true);
  assert.equal(machineValidateTest(step, { outputMatches: "nope$" }).passed, false);
  assert.equal(machineValidateTest(step, { fileContains: "beta" }).passed, true);
  assert.equal(machineValidateTest(null, { exitCode: 0 }).passed, false);
  assert.equal(machineValidateTest({ output: 42 }, { outputContains: "x" }).passed, false);
  assert.equal(machineValidateTest({ exitCode: 2, output: "x" }, { exitCode: 0 }).passed, false);
});

test("validateTestGateTests: rejects malformed assertions and validates regexes", () => {
  assert.throws(() => validateTestGateTests([], "bash"), TypeError);
  assert.throws(() => validateTestGateTests([{ command: "" }], "bash"), TypeError);
  assert.throws(() => validateTestGateTests([{ command: "x", assert: {} }], "bash"), TypeError);
  assert.throws(() => validateTestGateTests([{ command: "x", assert: { exitCode: NaN } }], "bash"), TypeError);
  assert.throws(() => validateTestGateTests([{ command: "x", assert: { outputMatches: "[" } }], "bash"), TypeError);
  assert.throws(() => validateTestGateTests([{ command: "x", assert: { exitCode: 0 } }], "grep"), TypeError);
  assert.doesNotThrow(() => validateTestGateTests([{ command: "x", assert: { outputMatches: "^a" } }], "bash"));
});
