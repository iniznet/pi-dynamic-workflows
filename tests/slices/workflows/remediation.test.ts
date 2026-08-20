/**
 * Slice H2 tests — V2-P06 review→remediation loop.
 *
 * The transform must: wrap the code-review machinery with Remediate /
 * Re-Review / Compliance phases; normalize findings into a deterministic
 * contract; enforce MACHINE-verifiable lifecycle transitions
 * (open → in-progress → fixed → verified → closed, with wontfix accepted);
 * write per-finding lifecycle records into the durable store via putOnce
 * (REPLAY-IDEMPOTENT — a re-executed transition dedupes and never re-appends);
 * and close the verify step with testGate (machine evidence, never an LLM
 * assertion). The embedded normalizers must behave identically to the TS
 * references (parity), and a mid-run resume replays completed steps.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { generateCodeReviewWorkflow } from "../../../src/code-review.js";
import {
  canTransitionFinding,
  DEFAULT_REMEDIATION_ROUNDS,
  FINDING_LIFECYCLE_STATUSES,
  FINDING_TRANSITIONS,
  findingContentId,
  injectRemediationLoop,
  MAX_REMEDIATION_ROUNDS,
  normalizeFindings,
  remediationNormalizersSource,
} from "../../../src/remediation.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

const RUN_ID = "remediation-run";

const DIFF =
  "diff --git a/src/x.js b/src/x.js\nindex 1..2 100644\n--- a/src/x.js\n+++ b/src/x.js\n@@ -1 +1 @@\n-const y = 1;\n+const y = 2;\n";

/** The remediation script under test: plain code-review + the remediation loop. */
const script = injectRemediationLoop({ baseScript: generateCodeReviewWorkflow() });

/** A fake agent that drives one finding to a machine-verified remediation. */
function verifiedRunner(verifyExitCode = 0) {
  return {
    async run(prompt: string) {
      if (prompt.includes("correctness scanner"))
        return {
          candidates: [
            { file: "src/x.js", line: 1, severity: "high", summary: "inverted condition", failure_scenario: "breaks" },
          ],
        };
      if (
        prompt.includes("removed-behavior auditor") ||
        prompt.includes("cross-file call-site tracer") ||
        prompt.includes("reuse finder") ||
        prompt.includes("simplification finder") ||
        prompt.includes("efficiency finder") ||
        prompt.includes("altitude reviewer") ||
        prompt.includes("security auditor")
      )
        return { candidates: [] };
      if (prompt.includes("You are a verifier")) return { verdicts: [{ verdict: "CONFIRMED", reason: "traced" }] };
      if (prompt.includes("senior code reviewer")) return "synthesis report";
      if (prompt.includes("remediation fixer"))
        return {
          change: "fixed the inverted condition",
          files: ["src/x.js"],
          verifyCommand: "grep -q y src/x.js",
          notes: "",
        };
      if (prompt.includes("remediation re-reviewer")) return { confirmed: true, notes: "fix in place" };
      if (prompt.includes("Run the following command with the bash tool"))
        return { exitCode: verifyExitCode, output: "match" };
      return null;
    },
  };
}

// ─── Machine-verifiable lifecycle ─────────────────────────────────────────────

test("FINDING_LIFECYCLE_STATUSES is the closed task vocabulary", () => {
  assert.deepEqual([...FINDING_LIFECYCLE_STATUSES], ["open", "in-progress", "fixed", "wontfix", "verified", "closed"]);
});

test("canTransitionFinding is a machine-verifiable transition predicate", () => {
  // Legal forward chain.
  assert.equal(canTransitionFinding("open", "in-progress"), true);
  assert.equal(canTransitionFinding("in-progress", "fixed"), true);
  assert.equal(canTransitionFinding("fixed", "verified"), true);
  assert.equal(canTransitionFinding("verified", "closed"), true);
  // Accepted side-branch.
  assert.equal(canTransitionFinding("open", "wontfix"), true);
  assert.equal(canTransitionFinding("in-progress", "wontfix"), true);
  assert.equal(canTransitionFinding("wontfix", "closed"), true);
  // Rework: a failed machine gate reopens fixed → in-progress.
  assert.equal(canTransitionFinding("fixed", "in-progress"), true);
  // Illegal jumps are rejected.
  assert.equal(canTransitionFinding("open", "fixed"), false);
  assert.equal(canTransitionFinding("open", "verified"), false);
  assert.equal(canTransitionFinding("open", "closed"), false);
  assert.equal(canTransitionFinding("in-progress", "verified"), false);
  assert.equal(canTransitionFinding("verified", "in-progress"), false);
  assert.equal(canTransitionFinding("closed", "open"), false);
  // The transition table mirrors the predicate.
  for (const from of FINDING_LIFECYCLE_STATUSES) {
    for (const to of FINDING_LIFECYCLE_STATUSES) {
      assert.equal(canTransitionFinding(from, to), FINDING_TRANSITIONS[from].includes(to));
    }
  }
});

test("normalizeFindings enforces the finding contract deterministically", () => {
  const cleaned = normalizeFindings([
    {
      file: "src/x.js",
      line: 1,
      severity: "high",
      summary: "inverted condition",
      angle: "A",
      failure_scenario: "breaks",
    },
    { file: "src/x.js", line: 1, severity: "high", summary: "inverted condition", angle: "A" }, // duplicate dropped
    { file: "src/x.js", line: 2, severity: "low", summary: "nit" },
    { file: "", summary: "no file dropped" },
    { file: "src/y.js", summary: "" }, // no summary dropped
    { file: "src/z.js", summary: "ok", line: "not-a-number", severity: "", angle: 42 },
    "garbage",
    null,
  ]);
  assert.equal(cleaned.length, 3);
  assert.deepEqual(
    cleaned.map((f) => [f.file, f.line]),
    [
      ["src/x.js", 1],
      ["src/x.js", 2],
      ["src/z.js", undefined],
    ],
  );
  assert.deepEqual(cleaned[2].severity, undefined, "a blank severity is dropped");
  assert.equal(normalizeFindings(null).length, 0);
  assert.equal(normalizeFindings("nope").length, 0);
});

test("findingContentId is content-derived and stable", () => {
  const a = { file: "src/x.js", line: 1, severity: "high", summary: "inverted", angle: "A" };
  const b = { file: "src/x.js", line: 1, severity: "high", summary: "inverted", angle: "A" };
  const c = { file: "src/x.js", line: 1, severity: "high", summary: "inverted", angle: "B" };
  assert.equal(findingContentId(a), findingContentId(b), "same finding → same id (cross-run dedupe)");
  assert.notEqual(findingContentId(a), findingContentId(c), "a changed finding → a distinct id");
});

test("the vm-embedded remediation normalizers behave identically to the TS references", () => {
  const embedded = vm.runInNewContext(
    `${remediationNormalizersSource()}\n({ normalizeFindings, canTransitionFinding, findingContentId })`,
  ) as {
    normalizeFindings: (raw: unknown) => unknown;
    canTransitionFinding: (from: string, to: string) => unknown;
    findingContentId: (f: unknown) => unknown;
  };
  const fixtures = [
    [
      { file: "a.ts", summary: "s", line: 1, severity: "high", angle: "A" },
      { file: "a.ts", summary: "s", line: 1, severity: "high", angle: "A" },
      { file: "b.ts", summary: "" },
      "x",
      null,
    ],
    [],
    null,
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(embedded.normalizeFindings(fixture))),
      normalizeFindings(fixture),
      `parity mismatch for ${JSON.stringify(fixture)}`,
    );
  }
  for (const from of FINDING_LIFECYCLE_STATUSES) {
    for (const to of FINDING_LIFECYCLE_STATUSES) {
      assert.equal(embedded.canTransitionFinding(from, to), canTransitionFinding(from, to));
    }
  }
  assert.equal(
    embedded.findingContentId({ file: "a.ts", summary: "s" }),
    findingContentId({ file: "a.ts", summary: "s" }),
  );
});

// ─── Transform surface ────────────────────────────────────────────────────────

test("injectRemediationLoop appends the remediation phases and preserves the review result", () => {
  const { meta, body } = parseWorkflowScript(script);
  assert.equal(meta.name, "code_review");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Find", "Verify", "Report", "Remediate", "Re-Review", "Compliance"],
  );
  assert.ok(body.includes("phase('Remediate')"));
  assert.ok(body.includes("phase('Re-Review')"));
  assert.ok(body.includes("phase('Compliance')"));
  assert.ok(body.includes("const reviewResult = { total: allCandidates.length"));
  assert.ok(body.includes("const remediationFindings = normalizeFindings(reviewResult.findings || [])"));
  assert.ok(body.includes("const compliancePassed = complianceOpen === 0"), "compliance is a machine assertion");
  assert.ok(
    body.includes("durableStore.putOnce('finding:' + id + ':' + record.status"),
    "lifecycle writes use putOnce",
  );
  assert.ok(body.includes("canTransitionFinding"), "transitions are machine-guarded");
});

test("injectRemediationLoop fails loudly on a non-code-review base script", () => {
  // A script that declares phases but lacks the code-review return statement
  // (and the Report-phase list tail) hits the transform's marker guards.
  assert.throws(
    () =>
      injectRemediationLoop({
        baseScript:
          "export const meta = { name: 'x', description: 'd', phases: [{ title: 'Find' }, { title: 'Report' }] }\nreturn { total: 0 };",
      }),
    /marker not found/,
  );
  // A script with no phases at all hits the meta guard first.
  assert.throws(
    () => injectRemediationLoop({ baseScript: "export const meta = { name: 'x', description: 'd' }\nreturn 1" }),
    /meta\.phases/,
  );
});

// ─── Runtime: full remediation lifecycle ─────────────────────────────────────

test("remediation: a finding runs open → in-progress → fixed → verified → closed with testGate evidence", async () => {
  const result = await runWorkflow(script, { agent: verifiedRunner(), persistLogs: false, args: { diff: DIFF } });
  const r = result.result as {
    total?: number;
    remediation?: {
      lifecycle?: Array<{ id: string; status: string; file: string; verifyCommand?: string }>;
      compliance?: { passed: boolean; open: number };
      rounds?: number;
      findings?: unknown[];
    };
  };
  assert.equal(r.total, 1);
  assert.equal(r.remediation?.rounds, DEFAULT_REMEDIATION_ROUNDS);
  const statuses = [...(r.remediation?.lifecycle ?? [])].map((l) => l.status);
  assert.deepEqual(statuses, ["open", "in-progress", "fixed", "verified", "closed"]);
  assert.equal(r.remediation?.compliance?.passed, true);
  assert.equal(r.remediation?.compliance?.open, 0);
  // Every lifecycle record carries the same content-derived finding id.
  const ids = new Set((r.remediation?.lifecycle ?? []).map((l) => l.id));
  assert.equal(ids.size, 1, "one finding, one lifecycle trail");
  // The durable record for the closed status includes the machine verify command.
  const closed = (r.remediation?.lifecycle ?? []).find((l) => l.status === "closed");
  assert.ok(closed?.verifyCommand?.includes("grep -q y"));
});

test("remediation: a failing machine gate keeps the finding fixed-but-unverified and fails compliance", async () => {
  const result = await runWorkflow(script, {
    // The machine test ALWAYS exits 1 — testGate fails closed after the bounded
    // attempts; the finding must NOT move to verified.
    agent: verifiedRunner(1),
    persistLogs: false,
    args: { diff: DIFF },
  });
  const r = result.result as {
    remediation?: { lifecycle?: Array<{ status: string }>; compliance?: { passed: boolean; open: number } };
  };
  const statuses = [...(r.remediation?.lifecycle ?? [])].map((l) => l.status);
  assert.equal(r.remediation?.compliance?.passed, false);
  assert.equal(r.remediation?.compliance?.open, 1);
  // The machine gate never moved the finding to verified.
  assert.ok(statuses.includes("verified") === false, "no verified without machine evidence");
});

test("remediation: a fix with no verify command cannot be machine-verified", async () => {
  const noCommand = {
    async run(prompt: string) {
      if (prompt.includes("correctness scanner"))
        return {
          candidates: [{ file: "src/x.js", line: 1, severity: "medium", summary: "nit", failure_scenario: "x" }],
        };
      if (
        prompt.includes("removed-behavior auditor") ||
        prompt.includes("cross-file call-site tracer") ||
        prompt.includes("reuse finder") ||
        prompt.includes("simplification finder") ||
        prompt.includes("efficiency finder") ||
        prompt.includes("altitude reviewer") ||
        prompt.includes("security auditor")
      )
        return { candidates: [] };
      if (prompt.includes("You are a verifier")) return { verdicts: [{ verdict: "CONFIRMED", reason: "r" }] };
      if (prompt.includes("senior code reviewer")) return "report";
      if (prompt.includes("remediation fixer"))
        return { change: "touched it", files: ["src/x.js"], verifyCommand: "", notes: "" };
      return null;
    },
  };
  const result = await runWorkflow(script, { agent: noCommand, persistLogs: false, args: { diff: DIFF } });
  const r = result.result as {
    remediation?: {
      lifecycle?: Array<{ status: string; verifyCommand?: string }>;
      compliance?: { passed: boolean; open: number };
    };
  };
  const lifecycle = [...(r.remediation?.lifecycle ?? [])];
  assert.equal(lifecycle[lifecycle.length - 1].status, "fixed", "no verify command → no verified");
  assert.equal(lifecycle[lifecycle.length - 1].verifyCommand, undefined);
  assert.equal(r.remediation?.compliance?.passed, false);
  assert.equal(r.remediation?.compliance?.open, 1);
});

// ─── Resume: a mid-pattern run replays completed steps ───────────────────────

test("remediation: a full run replays from the journal without re-calling the agent", async () => {
  const journal = new Map<string, JournalEntry>();
  const options = (capture: boolean) => ({
    agent: verifiedRunner(),
    persistLogs: false,
    runId: RUN_ID,
    args: { diff: DIFF },
    ...(capture
      ? { onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry) }
      : {}),
  });

  const first = await runWorkflow(script, options(true));
  const firstResult = first.result as { remediation?: { compliance?: { passed: boolean } } };
  assert.equal(firstResult.remediation?.compliance?.passed, true);
  assert.ok(journal.size >= 10, "8 finders + verifier + synthesis + fix + re-review + testgate steps journal");

  let calls = 0;
  const replay = await runWorkflow(script, {
    agent: {
      async run(_prompt: string) {
        calls++;
        return null;
      },
    },
    persistLogs: false,
    runId: RUN_ID,
    resumeJournal: journal,
    args: { diff: DIFF },
  });
  assert.equal(calls, 0, "a full prefix replay must not re-call the agent");
  const replayResult = replay.result as { remediation?: { compliance?: { passed: boolean }; lifecycle?: unknown[] } };
  assert.equal(replayResult.remediation?.compliance?.passed, true, "the replayed run reconstructs the same compliance");
  assert.ok((replayResult.remediation?.lifecycle ?? []).length >= 5, "the replayed run reconstructs the lifecycle");
});

// ─── Constants ────────────────────────────────────────────────────────────────

test("remediation round bounds are sane", () => {
  assert.equal(DEFAULT_REMEDIATION_ROUNDS, 2);
  assert.equal(MAX_REMEDIATION_ROUNDS, 4);
  assert.ok(MAX_REMEDIATION_ROUNDS >= DEFAULT_REMEDIATION_ROUNDS);
});
