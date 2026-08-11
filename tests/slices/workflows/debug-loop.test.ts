/**
 * Slice D1 tests — P03 debug-loop builtin.
 *
 * The pattern must: hypothesize (agent isolates the bug), reproduce (bash-
 * captured subagent relays the command's REAL exit status + output), fix
 * (agent gated on the reproduce evidence), verify (testGate re-runs the
 * command as a MACHINE test — pure-JS exit-code predicate, never an LLM
 * verdict) with bounded rework (maxRounds). Per-step evidence lands in the
 * artifact; a mid-run resume replays completed steps without re-calling the
 * agent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateDebugLoopWorkflow } from "../../../src/debug-loop.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

const RUN_ID = "debug-loop-run";

function makeJournal(): Map<string, JournalEntry> {
  return new Map();
}

/** Build the script-level fake agent driving a debug-loop run. */
function debugAgent(options: {
  /** exitCode the verification re-run reports per round (0 = green). */
  verifyCodes: number[];
  baselineExit?: number;
}) {
  let verifyIndex = 0;
  return {
    async run(prompt: string) {
      if (prompt.includes("debugger isolating a bug")) {
        return {
          symptom: "the parser crashes on empty input",
          rootCauseHypothesis: "parse() dereferences tokens[0] without a length check",
          reproCommand: "node test/parse.test.js",
          expectedBehavior: "exit 0 on empty input",
        };
      }
      if (prompt.includes("Run the reproduction command below")) {
        return {
          exitCode: options.baselineExit ?? 1,
          output: "FAIL: TypeError: Cannot read properties of undefined (reading 'type')",
        };
      }
      if (prompt.includes("Verification re-run")) {
        const code = options.verifyCodes[Math.min(verifyIndex, options.verifyCodes.length - 1)];
        verifyIndex++;
        return { exitCode: code, output: code === 0 ? "PASS" : "FAIL: TypeError" };
      }
      if (prompt.includes("You are a fixer")) {
        return { change: "guard the empty-input case", files: ["src/parse.js"], notes: "added a length check" };
      }
      return null;
    },
  };
}

// ─── Generated script surface ─────────────────────────────────────────────────

test("debug-loop declares the 4 phases and machine-gates the verify via loopUntilDry", () => {
  const { meta, body } = parseWorkflowScript(generateDebugLoopWorkflow());
  assert.equal(meta.name, "debug_loop");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Hypothesize", "Reproduce", "Fix", "Verify"],
  );
  // The verify phase is a MACHINE re-run loop: loopUntilDry rounds each run a
  // bash-captured verification subagent; a pure-JS exit-code predicate decides
  // green (never an LLM verdict).
  assert.match(body, /await loopUntilDry\(/);
  assert.match(body, /const passed = !!\(verify && verify\.exitCode === 0\)/);
  assert.match(body, /consecutiveEmpty: 1/);
  assert.match(body, /maxRounds,/);
  // Per-step evidence: hypothesis + baseline capture + per-round verify evidence.
  assert.match(body, /label: 'hypothesize'/);
  assert.match(body, /label: 'reproduce baseline'/);
  assert.match(body, /label: 'fix ' \+ \(r \+ 1\)/);
  assert.match(body, /label: 'verify ' \+ \(r \+ 1\)/);
  assert.match(body, /const attempts = loop\.items\.map/);
  assert.match(body, /BASELINE REPRODUCTION EVIDENCE/);
});

test("debug-loop reads its inputs from args (bug/reproduce/maxRounds), never interpolated", () => {
  const body = generateDebugLoopWorkflow();
  assert.match(body, /\(args && args\.bug\)/);
  assert.match(body, /\(args && args\.reproduce\)/);
  assert.match(body, /const maxRounds = __coerceArg/);
  // The bug text is registered through the runtime's shared-context pointer.
  assert.match(body, /const bugCtx = ctx\(bug\)/);
});

// ─── Runtime: red → green stops the loop with evidence captured ───────────────

test("debug-loop: a fix that verifies green on round 2 stops the loop and captures per-step evidence", async () => {
  const result = await runWorkflow(generateDebugLoopWorkflow(), {
    agent: debugAgent({ verifyCodes: [1, 0] }),
    persistLogs: false,
    args: { bug: "parser crashes on empty input", maxRounds: 3 },
  });

  const r = result.result as {
    hypothesis?: unknown;
    baseline?: { exitCode?: number };
    fixed?: boolean;
    rounds?: number;
    attempts?: Array<{ attempt: number; passed: boolean; exitCode: number | null }>;
    baselineGreen?: boolean;
    termination?: string;
  };
  assert.ok(r.hypothesis, "hypothesis agent output must be in the artifact");
  assert.equal(
    (r.baseline as { exitCode?: number } | undefined)?.exitCode,
    1,
    "baseline reproduce must capture the red exit code",
  );
  assert.equal(r.baselineGreen, false);
  assert.equal(r.fixed, true, "round 2 turns green");
  assert.equal(r.rounds, 2, "exactly 2 fix/verify rounds");
  assert.equal(r.termination, "green");
  // Per-round evidence: one entry per attempt, with the machine-captured codes.
  assert.deepEqual(
    (r.attempts ?? []).map((a) => ({ attempt: a.attempt, passed: a.passed, exitCode: a.exitCode })),
    [
      { attempt: 1, passed: false, exitCode: 1 },
      { attempt: 2, passed: true, exitCode: 0 },
    ],
    "each round's machine verdict + captured exit code must be in the artifact",
  );
});

test("debug-loop: an unfixed bug fails closed with maxRounds rounds of evidence", async () => {
  const result = await runWorkflow(generateDebugLoopWorkflow(), {
    agent: debugAgent({ verifyCodes: [1, 1, 1] }),
    persistLogs: false,
    args: { bug: "parser crashes on empty input", maxRounds: 3 },
  });
  const r = result.result as {
    fixed?: boolean;
    rounds?: number;
    attempts?: unknown[];
    termination?: string;
  };
  assert.equal(r.fixed, false);
  assert.equal(r.rounds, 3, "all K rounds attempted");
  assert.equal(r.attempts?.length, 3, "every round's evidence is captured (fail-closed)");
  assert.equal(r.termination, "maxRounds");
});

test("debug-loop: a missing repro command degrades into an explicit no-verify result", async () => {
  const result = await runWorkflow(generateDebugLoopWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("debugger isolating a bug")) {
          return { symptom: "s", rootCauseHypothesis: "h", reproCommand: "", expectedBehavior: "ok" };
        }
        return null;
      },
    },
    persistLogs: false,
    args: { bug: "b" },
  });
  const r = result.result as { reproCommand?: string; attempts?: unknown[]; fixed?: boolean };
  assert.equal(r.reproCommand, "");
  assert.equal(r.fixed, false);
  assert.deepEqual([...(r.attempts ?? [])], [], "no fix/verify rounds without a reproduction command");
});

// ─── Token budget: bounded agent calls ────────────────────────────────────────

test("debug-loop: agent calls stay within the 2 + 2×maxRounds budget", async () => {
  let calls = 0;
  const agent = {
    async run(prompt: string) {
      calls++;
      if (prompt.includes("debugger isolating a bug")) {
        return {
          symptom: "s",
          rootCauseHypothesis: "h",
          reproCommand: "node test/t.js",
          expectedBehavior: "ok",
        };
      }
      if (prompt.includes("Run the reproduction command below")) return { exitCode: 1, output: "FAIL" };
      if (prompt.includes("Verification re-run")) return { exitCode: 1, output: "FAIL" };
      if (prompt.includes("You are a fixer")) return { change: "c", files: [], notes: "" };
      return null;
    },
  };
  await runWorkflow(generateDebugLoopWorkflow(), {
    agent,
    persistLogs: false,
    args: { bug: "b", maxRounds: 2 },
  });
  // hypothesize + baseline + 2×(fix + machine verify) = 6.
  assert.equal(calls, 6, "bounded by 2 + 2×maxRounds");
});

// ─── Resume: a mid-pattern run replays completed steps ───────────────────────

test("debug-loop: a full run replays from the journal without re-calling the agent", async () => {
  const journal = makeJournal();
  const options = (capture: boolean) => ({
    agent: debugAgent({ verifyCodes: [1, 0] }),
    persistLogs: false,
    runId: RUN_ID,
    args: { bug: "parser crashes on empty input", maxRounds: 3 },
    ...(capture
      ? { onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry) }
      : {}),
  });

  const first = await runWorkflow(generateDebugLoopWorkflow(), options(true));
  assert.equal((first.result as { fixed?: boolean }).fixed, true);
  assert.ok(journal.size >= 6, "hypothesize + baseline + 2 fix + 2 machine verify journal entries");

  let calls = 0;
  const replay = await runWorkflow(generateDebugLoopWorkflow(), {
    agent: {
      async run(_prompt: string) {
        calls++;
        return null;
      },
    },
    persistLogs: false,
    runId: RUN_ID,
    resumeJournal: journal,
    args: { bug: "parser crashes on empty input", maxRounds: 3 },
  });
  assert.equal(calls, 0, "a full prefix replay must not re-call the agent");
  assert.deepEqual(
    (replay.result as { attempts?: Array<{ attempt: number; passed: boolean }> }).attempts?.map((a) => ({
      attempt: a.attempt,
      passed: a.passed,
    })),
    [
      { attempt: 1, passed: false },
      { attempt: 2, passed: true },
    ],
    "the replayed run reconstructs the same evidence",
  );
});
