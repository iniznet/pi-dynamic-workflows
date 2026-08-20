/**
 * Slice D1 tests — P08 impact-scoped work partitioning.
 *
 * impact-scope.ts defines the partition contract (normalizeImpactPartition,
 * parity-tested against its vm-embedded copy) and injectImpactScopePhase, the
 * deterministic transform that adds the impact-analysis phase to a generated
 * script: Impact Analysis is the FIRST phase, the impact agent runs before any
 * fan-out work, every fan-out worker prompt embeds the partition
 * (impactScopeBlock), and the run result exposes the partition. End-to-end
 * runs assert the phase order + partition flow on codebase-audit and
 * code-review; a mid-run resume replays completed steps.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  generateAdversarialReviewWorkflow,
  generateMultiPerspectiveWorkflow,
} from "../../../src/adversarial-review.js";
import { generateCodeReviewWorkflow } from "../../../src/code-review.js";
import { generateCodebaseAuditWorkflow } from "../../../src/deep-research.js";
import {
  ADVERSARIAL_REVIEW_PROMPT_SEAM,
  ADVERSARIAL_REVIEW_RETURN_SEAM,
  CODE_REVIEW_RETURN_SEAM,
  CODEBASE_AUDIT_PROMPT_SEAM,
  CODEBASE_AUDIT_RETURN_SEAM,
  codeReviewImpactSeams,
  injectImpactScopePhase,
  MULTI_PERSPECTIVE_PROMPT_SEAM,
  MULTI_PERSPECTIVE_RETURN_SEAM,
  normalizeImpactPartition,
  normalizeImpactPartitionSource,
  SPEC_CONFORMANCE_PROMPT_SEAM,
  SPEC_CONFORMANCE_RETURN_SEAM,
} from "../../../src/impact-scope.js";
import { generateSpecConformanceWorkflow } from "../../../src/spec-conformance.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

const RUN_ID = "impact-scope-run";

/** The partition a fake impact-analysis agent returns. */
const PARTITION_FIXTURE = {
  summary: "the change ripples through the parser and the CLI",
  partition: {
    slices: [
      {
        name: "parser",
        focus: "tokenizer changes",
        scopedFiles: ["src/parse.js", "src/tokenize.js"],
        testScope: ["tests/parse.test.js"],
      },
      { name: "cli", focus: "CLI flag plumbing", scopedFiles: ["src/cli.js"], testScope: ["tests/cli.test.js"] },
    ],
  },
};

// ─── normalizeImpactPartition reference ───────────────────────────────────────

test("normalizeImpactPartition enforces the partition contract deterministically", () => {
  const clean = normalizeImpactPartition(PARTITION_FIXTURE);
  assert.deepEqual(
    clean.slices.map((s) => s.name),
    ["parser", "cli"],
  );
  assert.deepEqual(clean.slices[0].scopedFiles, ["src/parse.js", "src/tokenize.js"]);
  // Malformed entries are dropped; names are deduped; files/tests are trimmed.
  const messy = normalizeImpactPartition({
    slices: [
      { name: "  a  ", focus: "x", scopedFiles: ["f1", "", "f1", " f2 "], testScope: "not-an-array" },
      { name: "a", focus: "duplicate name dropped" },
      { name: "", focus: "empty name dropped" },
      { name: "b", focus: "" },
      { name: "c", focus: "ok" },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messy)), {
    slices: [
      { name: "a", focus: "x", scopedFiles: ["f1", "f2"], testScope: [] },
      { name: "c", focus: "ok", scopedFiles: [], testScope: [] },
    ],
  });
  // Non-array / null degrade to an empty partition (fan-out proceeds unscoped).
  assert.deepEqual(normalizeImpactPartition(null).slices, []);
  assert.deepEqual(normalizeImpactPartition({ slices: "nope" }).slices, []);
});

test("normalizeImpactPartition caps slices and per-slice file lists", () => {
  const many = normalizeImpactPartition({
    slices: Array.from({ length: 20 }, (_, i) => ({
      name: `s${i}`,
      focus: `f${i}`,
      scopedFiles: Array.from({ length: 30 }, (_, j) => `f${i}/${j}.ts`),
    })),
  });
  assert.equal(many.slices.length, 8, "capped at IMPACT_MAX_SLICES");
  assert.equal(many.slices[0].scopedFiles.length, 16, "per-slice file list capped");
});

test("the vm-embedded normalizeImpactPartition behaves identically to the TS reference", () => {
  const embedded = vm.runInNewContext(`${normalizeImpactPartitionSource()}\nnormalizeImpactPartition`) as (
    value: unknown,
  ) => unknown;
  const fixtures = [
    PARTITION_FIXTURE,
    { slices: [] },
    null,
    { slices: [{ name: "a", focus: "x", scopedFiles: ["f1", "f1"] }] },
    "garbage",
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(embedded(fixture))),
      JSON.parse(JSON.stringify(normalizeImpactPartition(fixture))),
      `parity mismatch for fixture ${JSON.stringify(fixture)}`,
    );
  }
});

// ─── injectImpactScopePhase transform ─────────────────────────────────────────

test("injectImpactScopePhase adds the Impact Analysis phase to codebase-audit and scopes every check", () => {
  const base = generateCodebaseAuditWorkflow("src/", ["security", "performance"]);
  const script = injectImpactScopePhase({
    baseScript: base,
    target: "audit target",
    promptSeams: [CODEBASE_AUDIT_PROMPT_SEAM],
    returnSeam: CODEBASE_AUDIT_RETURN_SEAM,
  });
  const { meta } = parseWorkflowScript(script);
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Impact Analysis", "Individual Checks", "Cross-Validation", "Report"],
  );
  assert.ok(script.includes("label: 'impact analysis'"), "the impact agent runs first");
  assert.ok(script.includes('+ scope + impactScopeBlock(), { label: "security" }'), "every check embeds the partition");
  assert.ok(
    script.includes("return { findings, validated, report, impactPartition };"),
    "the result exposes the partition",
  );
  // The base script still parses as a workflow.
  assert.equal(meta.name, "codebase_audit");
});

test("injectImpactScopePhase adds the Impact Analysis phase to code-review and scopes all 8 finders", () => {
  const base = generateCodeReviewWorkflow();
  const script = injectImpactScopePhase({
    baseScript: base,
    target: "review target",
    promptSeams: codeReviewImpactSeams(),
    returnSeam: CODE_REVIEW_RETURN_SEAM,
  });
  const { meta } = parseWorkflowScript(script);
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Impact Analysis", "Find", "Verify", "Report"],
  );
  assert.ok(script.includes("label: 'impact analysis'"));
  for (const angle of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    assert.ok(
      script.includes(`+ base + shardBlock('${angle}') + impactScopeBlock(),`),
      `finder ${angle} must embed the partition`,
    );
  }
  assert.ok(script.includes("diffTruncated, impactPartition }"), "the result exposes the partition");
});

test("injectImpactScopePhase fails loudly when a seam is missing (generator drift)", () => {
  assert.throws(
    () =>
      injectImpactScopePhase({
        baseScript: generateCodebaseAuditWorkflow("s", ["c"]),
        target: "t",
        promptSeams: [["+ bogusSeam, { label: ", "+ bogusSeam + impactScopeBlock(), { label: "] as const],
        returnSeam: CODEBASE_AUDIT_RETURN_SEAM,
      }),
    /seam not found/,
  );
  assert.throws(
    () =>
      injectImpactScopePhase({
        baseScript: "export const meta = { name: 'x', description: 'd' }\nreturn 1",
        target: "t",
        promptSeams: [],
        returnSeam: CODEBASE_AUDIT_RETURN_SEAM,
      }),
    /meta\.phases/,
  );
});

// ─── E2E: impact-scoped codebase-audit ────────────────────────────────────────

test("impact-scoped audit: the impact agent runs first, the partition scopes every check, and the result carries it", async () => {
  const prompts: string[] = [];
  const result = await runWorkflow(
    injectImpactScopePhase({
      baseScript: generateCodebaseAuditWorkflow("src/", ["security", "performance"]),
      target: "The audit target is the codebase scope: src/ (2 checks)",
      promptSeams: [CODEBASE_AUDIT_PROMPT_SEAM],
      returnSeam: CODEBASE_AUDIT_RETURN_SEAM,
    }),
    {
      agent: {
        async run(prompt: string) {
          prompts.push(prompt);
          if (prompt.includes("impact-analysis planner")) return PARTITION_FIXTURE;
          if (prompt.includes("Audit security across:"))
            return { findings: [{ issue: "injection", severity: "high" }] };
          if (prompt.includes("Audit performance across:"))
            return { findings: [{ issue: "n+1 query", severity: "medium" }] };
          if (prompt.includes("Cross-validate these audit findings")) return "validated findings";
          if (prompt.includes("prioritized audit report")) return "report text";
          return null;
        },
      },
      persistLogs: false,
      args: { scope: "src/", checks: ["security", "performance"] },
    },
  );

  const r = result.result as { findings?: unknown; impactPartition?: { slices: Array<{ name: string }> } };
  // The impact-analysis agent's prompt is the FIRST agent call of the run.
  assert.ok(prompts[0].includes("impact-analysis planner"), "impact analysis runs before any check");
  // Every check prompt embeds the partition block.
  const checkPrompt = prompts.find((p) => p.includes("Audit security across:"));
  assert.ok(checkPrompt?.includes("<impact-partition>"), "the check prompt embeds the partition");
  assert.ok(checkPrompt?.includes("src/parse.js"), "the partition's scoped files reach the check");
  // The run result exposes the normalized partition.
  assert.deepEqual(
    [...((r.impactPartition as { slices: Array<{ name: string }> } | undefined)?.slices ?? [])].map((s) => s.name),
    ["parser", "cli"],
  );
  assert.ok(r.findings, "the audit fan-out still completes");
});

test("impact-scoped audit: a degraded partition (no slices) logs and proceeds unscoped", async () => {
  const result = await runWorkflow(
    injectImpactScopePhase({
      baseScript: generateCodebaseAuditWorkflow("src/", ["security"]),
      target: "t",
      promptSeams: [CODEBASE_AUDIT_PROMPT_SEAM],
      returnSeam: CODEBASE_AUDIT_RETURN_SEAM,
    }),
    {
      agent: {
        async run(prompt: string) {
          if (prompt.includes("impact-analysis planner")) return { summary: "nothing", partition: { slices: [] } };
          if (prompt.includes("Audit security across:")) return { findings: [] };
          if (prompt.includes("Cross-validate")) return "v";
          if (prompt.includes("prioritized audit report")) return "r";
          return null;
        },
      },
      persistLogs: false,
      args: { scope: "src/", checks: ["security"] },
    },
  );
  const r = result.result as { impactPartition?: { slices: unknown[] } };
  assert.deepEqual([...(r.impactPartition?.slices ?? [])], [], "empty partition surfaces in the result");
  assert.ok(
    result.logs?.some((line) => line.includes("no partition slices")),
    "the unscoped degradation is logged, never silent",
  );
});

// ─── E2E: impact-scoped code-review ───────────────────────────────────────────

test("impact-scoped review: the impact agent runs before the 8 finders and scopes their prompts", async () => {
  const prompts: string[] = [];
  const result = await runWorkflow(
    injectImpactScopePhase({
      baseScript: generateCodeReviewWorkflow(),
      target: "review target",
      promptSeams: codeReviewImpactSeams(),
      returnSeam: CODE_REVIEW_RETURN_SEAM,
    }),
    {
      agent: {
        async run(prompt: string) {
          prompts.push(prompt);
          if (prompt.includes("impact-analysis planner")) return PARTITION_FIXTURE;
          if (prompt.includes("line-by-line correctness scanner")) {
            return {
              candidates: [
                {
                  file: "src/parse.js",
                  line: 12,
                  severity: "high",
                  summary: "null deref",
                  failure_scenario: "crashes",
                },
              ],
            };
          }
          if (prompt.includes("You are a verifier")) {
            return { verdicts: [{ verdict: "CONFIRMED", reason: "traceable in the diff" }] };
          }
          if (prompt.includes("senior code reviewer")) return "synthesis report";
          return { candidates: [] };
        },
      },
      persistLogs: false,
      args: {
        diff: "--- a/src/parse.js\n+++ b/src/parse.js\n@@ -10 +10 @@\n-return tokens[0].type\n+return tokens[0]?.type\n",
      },
    },
  );

  // Impact analysis is the first agent call.
  assert.ok(prompts[0].includes("impact-analysis planner"), "impact analysis runs before the finders");
  const finderPrompt = prompts.find((p) => p.includes("line-by-line correctness scanner"));
  assert.ok(finderPrompt?.includes("<impact-partition>"), "the finder prompt embeds the partition");
  const r = result.result as { findings?: unknown; impactPartition?: { slices: unknown[] } };
  assert.ok(r.findings, "the review fan-out completes");
  assert.equal((r.impactPartition as { slices: Array<{ name: string }> } | undefined)?.slices.length, 2);
});

// ─── Resume: a mid-pattern impact-scoped run replays completed steps ─────────

test("impact-scoped audit: a full run replays from the journal without re-calling the agent", async () => {
  const journal = new Map<string, JournalEntry>();
  const script = injectImpactScopePhase({
    baseScript: generateCodebaseAuditWorkflow("src/", ["security"]),
    target: "t",
    promptSeams: [CODEBASE_AUDIT_PROMPT_SEAM],
    returnSeam: CODEBASE_AUDIT_RETURN_SEAM,
  });
  const agent = {
    async run(prompt: string) {
      if (prompt.includes("impact-analysis planner")) return PARTITION_FIXTURE;
      if (prompt.includes("Audit security across:")) return { findings: [{ issue: "x" }] };
      if (prompt.includes("Cross-validate")) return "v";
      if (prompt.includes("prioritized audit report")) return "r";
      return null;
    },
  };
  const options = (capture: boolean) => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    args: { scope: "src/", checks: ["security"] },
    ...(capture
      ? { onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry) }
      : {}),
  });

  const first = await runWorkflow(script, options(true));
  assert.equal((first.result as { impactPartition?: { slices: unknown[] } }).impactPartition?.slices.length, 2);
  assert.ok(journal.size >= 4, "impact + check + validator + report journal entries");

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
    args: { scope: "src/", checks: ["security"] },
  });
  assert.equal(calls, 0, "a full prefix replay must not re-call the agent");
  assert.deepEqual(
    [
      ...((replay.result as { impactPartition?: { slices: Array<{ name: string }> } }).impactPartition?.slices ?? []),
    ].map((s) => s.name),
    ["parser", "cli"],
    "the replayed run reconstructs the same partition",
  );
});

// ─── V2-QW4: impact-scope on spec-conformance + multi-perspective + ───────────
// ─── adversarial-review (seams + E2E flow) ────────────────────────────────────

test("V2-QW4: spec-conformance gains the Impact Analysis phase and scopes every evidence agent", async () => {
  const base = generateSpecConformanceWorkflow();
  const script = injectImpactScopePhase({
    baseScript: base,
    target: "audit target",
    promptSeams: [SPEC_CONFORMANCE_PROMPT_SEAM],
    returnSeam: SPEC_CONFORMANCE_RETURN_SEAM,
  });
  const { meta } = parseWorkflowScript(script);
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Impact Analysis", "Requirements", "Evidence", "Audit", "Report"],
  );
  assert.ok(script.includes("label: 'impact analysis'"));
  assert.ok(script.includes("+ specCtx + impactScopeBlock(),"), "every evidence agent embeds the partition");
  assert.ok(script.includes("report, trend, impactPartition }"), "the result exposes the partition");
});

test("V2-QW4: multi-perspective gains the Impact Analysis phase and scopes every analyst", async () => {
  const base = generateMultiPerspectiveWorkflow("climate policy", ["economic", "environmental"]);
  const script = injectImpactScopePhase({
    baseScript: base,
    target: "analysis target",
    promptSeams: [MULTI_PERSPECTIVE_PROMPT_SEAM],
    returnSeam: MULTI_PERSPECTIVE_RETURN_SEAM,
  });
  const { meta } = parseWorkflowScript(script);
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Impact Analysis", "Perspective Analysis", "Synthesis"],
  );
  assert.ok(script.includes("label: 'impact analysis'"));
  assert.ok(
    script.includes('"Analyze from economic perspective: " + topic + impactScopeBlock(), { label: "economic" }'),
  );
  assert.ok(script.includes("return { analyses, synthesis, impactPartition };"));
});

test("V2-QW4: adversarial-review gains the Impact Analysis phase and scopes every refute reviewer", async () => {
  const base = generateAdversarialReviewWorkflow();
  const script = injectImpactScopePhase({
    baseScript: base,
    target: "review target",
    promptSeams: [ADVERSARIAL_REVIEW_PROMPT_SEAM],
    returnSeam: ADVERSARIAL_REVIEW_RETURN_SEAM,
  });
  const { meta } = parseWorkflowScript(script);
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Impact Analysis", "Investigate", "Refute", "Consensus"],
  );
  assert.ok(script.includes("label: 'impact analysis'"));
  assert.ok(script.includes("'TASK: ' + task + '\\nFINDING: ' + f + impactScopeBlock(),"));
  assert.ok(script.includes("return { total: findings.length, survivors, report, impactPartition }"));
});

test("V2-QW4 E2E: an impact-scoped adversarial-review runs the partition through the refute fan-out", async () => {
  const prompts: string[] = [];
  const result = await runWorkflow(
    injectImpactScopePhase({
      baseScript: generateAdversarialReviewWorkflow(),
      target: "The review target is the task: investigate the parser",
      promptSeams: [ADVERSARIAL_REVIEW_PROMPT_SEAM],
      returnSeam: ADVERSARIAL_REVIEW_RETURN_SEAM,
    }),
    {
      agent: {
        async run(prompt: string) {
          prompts.push(prompt);
          if (prompt.includes("impact-analysis planner")) return PARTITION_FIXTURE;
          if (prompt.includes("Investigate the following")) return { findings: ["finding one", "finding two"] };
          if (prompt.includes("skeptical reviewer")) return { real: true, reason: "confirmed" };
          if (prompt.includes("final review report")) return "consensus report";
          return null;
        },
      },
      persistLogs: false,
      args: { task: "investigate the parser", reviewers: 2 },
    },
  );
  const r = result.result as { survivors?: unknown[]; impactPartition?: { slices: Array<{ name: string }> } };
  assert.ok(prompts[0].includes("impact-analysis planner"), "impact analysis runs before any review work");
  const refutePrompt = prompts.find((p) => p.includes("skeptical reviewer"));
  assert.ok(refutePrompt?.includes("<impact-partition>"), "the refute reviewer embeds the partition");
  assert.ok(refutePrompt?.includes("src/parse.js"), "the partition's scoped files reach the reviewer");
  assert.deepEqual(
    [...((r.impactPartition as { slices: Array<{ name: string }> } | undefined)?.slices ?? [])].map((s) => s.name),
    ["parser", "cli"],
  );
  assert.equal((r.survivors ?? []).length, 2, "both findings survive the threshold with all-real votes");
});
