import { DEFAULT_TEST_GATE_ATTEMPTS, DEFAULT_TEST_GATE_TOOL } from "./config.js";
import { type ProvenanceEntry, provenanceContentId } from "./durable-store.js";

/**
 * P01 — testGate machine-checked postcondition machinery.
 *
 * The workflow vm context deliberately injects NO host fs/exec (the declared
 * runtimeImplementations are the only globals), so a machine postcondition
 * cannot be run host-side from a new vm global. The mechanism is a SUBAGENT
 * STEP: `agent({ toolNames: ['bash'] | ['grep'], schema })` executes the test
 * command inside a real toolset and reports a structured capture; acceptance
 * is then decided by a PURE JS predicate over that capture (never an LLM
 * verdict). Everything in this module is vm-agnostic and deterministic so the
 * machine-validation surface is unit-testable outside a run.
 */

/** Tool the test subagent may use to run its command. */
export type TestGateTool = "bash" | "grep";

/**
 * Machine-checked acceptance predicates over the captured test output. At
 * least one predicate must be present. `fileContains` checks the captured
 * output (typically produced by `cat <path>` / `grep -n <pattern> <path>`),
 * which is the vm-safe way to assert file content without host fs access.
 */
export interface TestGateAssert {
  /** Expected process exit status of the test command (bash tool only; default 0). */
  exitCode?: number;
  /** Captured output must contain this substring. */
  outputContains?: string;
  /** Captured output must match this regular-expression source. */
  outputMatches?: string;
  /** Captured output must contain this substring (file content via cat/grep). */
  fileContains?: string;
}

/** One machine-checked postcondition test. */
export interface TestGateTest {
  /** Shell command (bash tool) or grep pattern (grep tool) the subagent runs. */
  command: string;
  /** Acceptance predicates; absent defaults to `{ exitCode: 0 }`. */
  assert?: TestGateAssert;
}

/** The captured evidence + machine verdict for one test, surfaced to the script. */
export interface TestGateStepResult {
  command: string;
  passed: boolean;
  /** Human-readable failure detail; "passed" when the test opened. */
  detail: string;
  /** Captured exit status (null when the tool reports none, e.g. grep mode). */
  exitCode: number | null;
  /** Captured output, capped for the result payload. */
  output: string;
}

/** Internal machine verdict: pass/fail + why. */
export interface TestGateOutcome {
  passed: boolean;
  detail: string;
}

/**
 * Structured output schema for the test subagent. `output` is required; the
 * bash tool's real exit status is optional because the grep tool reports
 * matches, not a process status (an `assert.exitCode` in grep mode is
 * rejected at call time by validateTestGateTests).
 */
export const TEST_GATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    exitCode: { type: "number" },
    output: { type: "string" },
  },
  required: ["output"],
} as const;

/** Cap for the captured output copied into the returned result payload. */
const RESULT_OUTPUT_CAP = 4000;
const ELLIPSIS = "…";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Validate the script-supplied tests list and its assertions. Throws a
 * TypeError (a script bug — loud, never silent) on a malformed shape so a
 * broken testGate call cannot silently accept or reject on garbage.
 */
export function validateTestGateTests(tests: unknown, tool: TestGateTool): TestGateTest[] {
  if (!Array.isArray(tests) || tests.length === 0) {
    throw new TypeError("testGate requires a non-empty `tests` array of { command, assert? }");
  }
  return tests.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new TypeError(`testGate tests[${index}] must be an object with a nonblank command`);
    }
    const command = asString(raw.command)?.trim() ?? "";
    if (!command) throw new TypeError(`testGate tests[${index}].command must be a nonblank string`);
    const assert = raw.assert === undefined ? { exitCode: 0 } : raw.assert;
    if (!isRecord(assert)) {
      throw new TypeError(`testGate tests[${index}].assert must be an object`);
    }
    const hasPredicate =
      assert.exitCode !== undefined ||
      assert.outputContains !== undefined ||
      assert.outputMatches !== undefined ||
      assert.fileContains !== undefined;
    if (!hasPredicate) {
      throw new TypeError(
        `testGate tests[${index}].assert needs at least one predicate: exitCode | outputContains | outputMatches | fileContains`,
      );
    }
    if (assert.exitCode !== undefined && (typeof assert.exitCode !== "number" || !Number.isFinite(assert.exitCode))) {
      throw new TypeError(`testGate tests[${index}].assert.exitCode must be a finite number`);
    }
    if (tool === "grep" && assert.exitCode !== undefined) {
      throw new TypeError(
        "testGate assert.exitCode requires the bash tool (the grep tool reports matches, not an exit status)",
      );
    }
    for (const key of ["outputContains", "fileContains"] as const) {
      const value = assert[key];
      if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
        throw new TypeError(`testGate tests[${index}].assert.${key} must be a nonblank string`);
      }
    }
    const matches = assert.outputMatches;
    if (matches !== undefined) {
      if (typeof matches !== "string" || matches.length === 0) {
        throw new TypeError(`testGate tests[${index}].assert.outputMatches must be a nonblank string`);
      }
      try {
        new RegExp(matches);
      } catch {
        throw new TypeError(
          `testGate tests[${index}].assert.outputMatches is not a valid regular expression: ${matches}`,
        );
      }
    }
    return { command, assert: assert as TestGateAssert };
  });
}

/** One predicate evaluation over a captured step; internal. */
interface AssertionCheck {
  key: "exitCode" | "outputContains" | "outputMatches" | "fileContains";
  passed: boolean;
  detail: string;
}

function evaluateAssertion(
  key: AssertionCheck["key"],
  expected: unknown,
  step: { exitCode: unknown; output: string },
): AssertionCheck {
  switch (key) {
    case "exitCode": {
      const expectedCode = Number(expected);
      const actual = step.exitCode;
      if (typeof actual !== "number" || !Number.isFinite(actual)) {
        return { key, passed: false, detail: `expected exit code ${expectedCode} but no exit code was captured` };
      }
      return actual === expectedCode
        ? { key, passed: true, detail: "exit code matched" }
        : { key, passed: false, detail: `exit code ${actual} != expected ${expectedCode}` };
    }
    case "outputContains": {
      const needle = String(expected);
      return step.output.includes(needle)
        ? { key, passed: true, detail: "output contains the expected text" }
        : { key, passed: false, detail: `output does not contain: ${needle}` };
    }
    case "outputMatches": {
      const source = String(expected);
      let matched: boolean;
      try {
        matched = new RegExp(source).test(step.output);
      } catch {
        return { key, passed: false, detail: `outputMatches regex is invalid: ${source}` };
      }
      return matched
        ? { key, passed: true, detail: "output matches the expected pattern" }
        : { key, passed: false, detail: `output does not match: /${source}/` };
    }
    case "fileContains": {
      const needle = String(expected);
      return step.output.includes(needle)
        ? { key, passed: true, detail: "captured output contains the expected file content" }
        : { key, passed: false, detail: `captured output does not contain: ${needle}` };
    }
  }
}

/**
 * The MACHINE verdict over one subagent step: pure JS over the captured
 * `{ exitCode?, output }`. Null/failed steps fail closed with a detail string.
 */
export function machineValidateTest(step: unknown, assert: TestGateAssert | undefined): TestGateOutcome {
  if (step === null || step === undefined) {
    return { passed: false, detail: "test subagent step failed recoverably; no output captured" };
  }
  if (!isRecord(step)) {
    return { passed: false, detail: "test subagent step returned a non-object capture" };
  }
  const output = asString(step.output);
  if (output === null) {
    return { passed: false, detail: "test subagent step returned no string output" };
  }
  const record: { exitCode: unknown; output: string } = { exitCode: step.exitCode, output };
  const active = assert as TestGateAssert;
  const checks: Array<{ key: AssertionCheck["key"]; expected: unknown }> = [
    { key: "exitCode", expected: active.exitCode },
    { key: "outputContains", expected: active.outputContains },
    { key: "outputMatches", expected: active.outputMatches },
    { key: "fileContains", expected: active.fileContains },
  ];
  for (const { key, expected } of checks) {
    if (expected === undefined) continue;
    const result = evaluateAssertion(key, expected, record);
    if (!result.passed) return { passed: false, detail: result.detail };
  }
  return { passed: true, detail: "passed" };
}

/** Cap a captured output for the returned result payload (validation uses the full output). */
export function capTestGateOutput(output: string): string {
  return output.length <= RESULT_OUTPUT_CAP ? output : `${output.slice(0, RESULT_OUTPUT_CAP)}${ELLIPSIS}`;
}

/**
 * Prompt for one test subagent step. The agent runs the command inside its
 * real toolset and MUST report the raw capture — the machine predicate decides
 * acceptance, the model only relays tool evidence.
 */
export function buildTestGatePrompt(test: TestGateTest, tool: TestGateTool): string {
  if (tool === "grep") {
    return `Search the current workspace with the grep tool using the following pattern and report EVERY matched line verbatim (do not summarize, do not omit matches).\n\nPattern:\n\`\`\`\n${test.command}\n\`\`\`\n\nReply with JSON matching the schema: output = a string containing every matched line.`;
  }
  return `Run the following command with the bash tool and report its REAL exit status and FULL standard output verbatim (do not summarize, do not truncate, do not invent output).\n\nCommand:\n\`\`\`\n${test.command}\n\`\`\`\n\nReply with JSON matching the schema: exitCode = the command's actual exit status (number), output = the full standard output (string).`;
}

/** One failed test rendered into rework feedback. */
function renderFailedTest(result: TestGateStepResult): string {
  const excerpt = result.output.length > 300 ? `${result.output.slice(0, 300)}…` : result.output;
  const outputLine = excerpt ? `\n  captured output (excerpt): ${excerpt}` : "";
  return `- \`${result.command}\`: ${result.detail}${outputLine}`;
}

/**
 * Build the feedback string fed into the next thunk attempt (gate()'s bounded
 * rework shape): every failed test's detail + captured excerpt, plus the
 * author's prose postconditions. Returns undefined when every test passed.
 */
export function buildTestGateFeedback(
  results: readonly TestGateStepResult[],
  postconditions: readonly string[] | undefined,
  attempt: number,
): string | undefined {
  const failed = results.filter((result) => !result.passed);
  if (failed.length === 0) return undefined;
  const lines = [`Machine postcondition check failed (attempt ${attempt}):`];
  for (const result of failed) lines.push(renderFailedTest(result));
  if (postconditions && postconditions.length > 0) {
    lines.push("Required postconditions:");
    for (const condition of postconditions) lines.push(`- ${condition}`);
  }
  lines.push("Rework the output so every machine postcondition passes.");
  return lines.join("\n");
}

/** Shared defaults re-exported so the workflow runtime reads one source of truth. */
export { DEFAULT_TEST_GATE_ATTEMPTS, DEFAULT_TEST_GATE_TOOL };

/**
 * V2-N5: one provenance ledger entry per machine-verified test (the FINAL
 * attempt's verdict — the accepted attempt, or the last one when the gate
 * fails closed). Content-derived stable ids: the SAME command + SAME verdict
 * always yield the SAME id, so a replayed gate (cached-prefix replay
 * re-executes the pure machine verdict) dedupes and never re-appends, while a
 * changed verdict produces a distinct entry. The verdict payload rides in
 * `detail`; `file` carries the test command as the entry's evidence subject.
 */
export function testGateVerdictEntries(
  results: readonly TestGateStepResult[],
  phase: string | undefined,
): ProvenanceEntry[] {
  return results.map((result) => ({
    id: provenanceContentId({
      source: "testGate",
      phase,
      command: result.command,
      passed: result.passed,
      exitCode: result.exitCode,
      detail: result.detail,
    }),
    source: "testGate",
    file: result.command,
    phase,
    detail: { passed: result.passed, exitCode: result.exitCode, detail: result.detail },
  }));
}
