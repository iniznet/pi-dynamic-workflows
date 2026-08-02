/**
 * Tests for the shared builtin numeric-arg coercion/validation layer
 * (src/builtin-args.ts) and its wiring through every builtin resolver and
 * generated script.
 *
 * Covers (builtins:f1–f5, builtins:i1/i2/i4/i5):
 *  - coerceNumber: missing → default, present falsy (0) preserved, NaN /
 *    Infinity / negatives / out-of-range / non-integers rejected loudly.
 *  - The vm-embeddable coercion source enforces the same rules at runtime.
 *  - Every builtin resolver validates numeric args before a run starts.
 *  - adversarial-review tolerates a null investigation (builtins:f1).
 *  - code-review pre-caps the candidate pool and batches verify calls
 *    (builtins:i2), logs fan-out caps (builtins:i5), and keeps diffTruncated
 *    provenance accurate on every launch path (builtins:i4).
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { generateAdversarialReviewWorkflow } from "../src/adversarial-review.js";
import {
  ADVERSARIAL_REVIEW_NUMERIC_ARGS,
  CODE_REVIEW_NUMERIC_ARGS,
  coerceNumber,
  DEEP_RESEARCH_NUMERIC_ARGS,
  type NumericArgSpec,
  numericArgCoercionSource,
  validateNumericArgs,
} from "../src/builtin-args.js";
import { findBuiltinWorkflow } from "../src/builtin-workflows.js";
import { generateCodeReviewWorkflow } from "../src/code-review.js";
import { generateDeepResearchWorkflow } from "../src/deep-research.js";
import { runWorkflow } from "../src/workflow.js";

// ─── coerceNumber: unit semantics ──────────────────────────────────────────────

test("coerceNumber: missing values fall back to the default, present falsy values are preserved", () => {
  const threshold = { name: "threshold", default: 0.5, min: 0, max: 1 } satisfies NumericArgSpec;
  assert.deepEqual(coerceNumber(undefined, threshold), { value: 0.5 });
  assert.deepEqual(coerceNumber(null, threshold), { value: 0.5 });
  assert.deepEqual(coerceNumber("", threshold), { value: 0.5 });
  // The core f2/f3 regression: a present 0 must NOT silently become the default.
  assert.deepEqual(coerceNumber(0, threshold), { value: 0 });
  assert.deepEqual(coerceNumber("0", threshold), { value: 0 });
});

test("coerceNumber: string numbers are coerced, non-number types are rejected", () => {
  const angles = { name: "angles", default: 4, min: 1, max: 8, integer: true } satisfies NumericArgSpec;
  assert.deepEqual(coerceNumber("6", angles), { value: 6 });
  assert.match(coerceNumber(true, angles).error ?? "", /must be a number/);
  assert.match(coerceNumber({}, angles).error ?? "", /must be a number/);
  assert.match(coerceNumber([], angles).error ?? "", /must be a number/);
});

test("coerceNumber: NaN/Infinity are rejected as non-finite", () => {
  const angles = { name: "angles", default: 4, min: 1, max: 8, integer: true } satisfies NumericArgSpec;
  assert.match(coerceNumber(Number.NaN, angles).error ?? "", /finite/);
  assert.match(coerceNumber(Number.POSITIVE_INFINITY, angles).error ?? "", /finite/);
  assert.match(coerceNumber("not-a-number", angles).error ?? "", /finite/);
});

test("coerceNumber: out-of-range and fractional values are rejected per spec", () => {
  const angles = { name: "angles", default: 4, min: 1, max: 8, integer: true } satisfies NumericArgSpec;
  assert.match(coerceNumber(0, angles).error ?? "", />= 1/); // negative/zero fan-out impossible
  assert.match(coerceNumber(-3, angles).error ?? "", />= 1/);
  assert.match(coerceNumber(9, angles).error ?? "", /<= 8/); // bounds fan-out (builtins:i5)
  assert.match(coerceNumber(2.5, angles).error ?? "", /whole number/);
  // threshold accepts fractions and 0 (it is not an integer count)
  const threshold = { name: "threshold", default: 0.5, min: 0, max: 1 } satisfies NumericArgSpec;
  assert.deepEqual(coerceNumber(0.25, threshold), { value: 0.25 });
  assert.match(coerceNumber(1.5, threshold).error ?? "", /<= 1/);
});

// ─── validateNumericArgs: resolver boundary ────────────────────────────────────

test("validateNumericArgs throws the first error with the pattern and arg name", () => {
  assert.throws(
    () => validateNumericArgs({ angles: 0, minSupport: 2 }, DEEP_RESEARCH_NUMERIC_ARGS, "deep-research"),
    /deep-research.*angles/,
  );
  assert.throws(
    () => validateNumericArgs({ reviewers: 1.5 }, ADVERSARIAL_REVIEW_NUMERIC_ARGS, "adversarial-review"),
    /adversarial-review.*reviewers/,
  );
  assert.throws(
    () => validateNumericArgs({ maxCandidates: 10_000 }, CODE_REVIEW_NUMERIC_ARGS, "code-review"),
    /code-review.*maxCandidates/,
  );
});

test("validateNumericArgs accepts valid and missing numeric args", () => {
  assert.doesNotThrow(() =>
    validateNumericArgs({ question: "q", angles: 4, minSupport: 2 }, DEEP_RESEARCH_NUMERIC_ARGS, "deep-research"),
  );
  assert.doesNotThrow(() => validateNumericArgs({ task: "t" }, ADVERSARIAL_REVIEW_NUMERIC_ARGS, "adversarial-review"));
  assert.doesNotThrow(() =>
    validateNumericArgs({ threshold: 0 }, ADVERSARIAL_REVIEW_NUMERIC_ARGS, "adversarial-review"),
  );
  assert.doesNotThrow(() => validateNumericArgs({ diff: "d" }, CODE_REVIEW_NUMERIC_ARGS, "code-review"));
});

// ─── numericArgCoercionSource: vm-embeddable runtime enforcement ───────────────

function evalCoercion(specs: readonly NumericArgSpec[], args: Record<string, unknown>): Record<string, unknown> {
  const code = numericArgCoercionSource(specs);
  const names = specs.map((s) => s.name).join(", ");
  const context: Record<string, unknown> = { args, __result: undefined };
  new vm.Script(`${code}\n__result = { ${names} }`).runInNewContext(context);
  return context.__result as Record<string, unknown>;
}

test("numericArgCoercionSource applies defaults when args are missing", () => {
  // Spread into a host object: the vm realm's Object prototype fails node's
  // strict reference-equal deepEqual (same issue documented in builtin-workflows.test.ts).
  assert.deepEqual({ ...evalCoercion(DEEP_RESEARCH_NUMERIC_ARGS, {}) }, { angles: 4, minSupport: 2 });
  assert.deepEqual({ ...evalCoercion(CODE_REVIEW_NUMERIC_ARGS, {}) }, { maxCandidates: 30, verifyBatchSize: 5 });
});

test("numericArgCoercionSource preserves a present falsy 0 (no || default mangling)", () => {
  const out = evalCoercion(ADVERSARIAL_REVIEW_NUMERIC_ARGS, { reviewers: 2, threshold: 0, maxFindings: 5 });
  assert.equal(out.reviewers, 2);
  assert.equal(out.threshold, 0);
  assert.equal(out.maxFindings, 5);
});

test("numericArgCoercionSource throws for invalid values exactly like coerceNumber", () => {
  assert.throws(() => evalCoercion(DEEP_RESEARCH_NUMERIC_ARGS, { angles: 0 }), /angles/);
  assert.throws(() => evalCoercion(DEEP_RESEARCH_NUMERIC_ARGS, { angles: 9 }), /angles/);
  assert.throws(() => evalCoercion(DEEP_RESEARCH_NUMERIC_ARGS, { minSupport: Number.NaN }), /minSupport/);
  assert.throws(() => evalCoercion(ADVERSARIAL_REVIEW_NUMERIC_ARGS, { reviewers: 1.5 }), /reviewers/);
  assert.throws(() => evalCoercion(CODE_REVIEW_NUMERIC_ARGS, { verifyBatchSize: 0 }), /verifyBatchSize/);
});

// ─── Resolver wiring (builtin-workflows.ts) ────────────────────────────────────

test("builtin resolvers reject invalid numeric args loudly before a run starts", () => {
  const deepResearch = findBuiltinWorkflow("deep-research");
  const adversarialReview = findBuiltinWorkflow("adversarial-review");
  const codeReview = findBuiltinWorkflow("code-review");
  assert.ok(deepResearch && adversarialReview && codeReview);

  assert.throws(() => deepResearch.resolve("/tmp", { question: "q", angles: 0 }), /angles/);
  assert.throws(() => deepResearch.resolve("/tmp", { question: "q", angles: 9 }), /angles/);
  assert.throws(() => deepResearch.resolve("/tmp", { question: "q", minSupport: 2.5 }), /minSupport/);

  assert.throws(() => adversarialReview.resolve("/tmp", { task: "t", reviewers: 0 }), /reviewers/);
  assert.throws(() => adversarialReview.resolve("/tmp", { task: "t", reviewers: 2.5 }), /reviewers/);
  assert.throws(() => adversarialReview.resolve("/tmp", { task: "t", threshold: 2 }), /threshold/);
  assert.throws(() => adversarialReview.resolve("/tmp", { task: "t", maxFindings: 10_000 }), /maxFindings/);

  assert.throws(() => codeReview.resolve("/tmp", { diff: "d", maxCandidates: 0 }), /maxCandidates/);
  assert.throws(() => codeReview.resolve("/tmp", { diff: "d", maxCandidates: 300 }), /maxCandidates/);
  assert.throws(() => codeReview.resolve("/tmp", { diff: "d", verifyBatchSize: 25 }), /verifyBatchSize/);
});

test("builtin resolvers accept valid numeric args (including a present 0 for threshold)", () => {
  const deepResearch = findBuiltinWorkflow("deep-research");
  const adversarialReview = findBuiltinWorkflow("adversarial-review");
  const codeReview = findBuiltinWorkflow("code-review");
  assert.ok(deepResearch && adversarialReview && codeReview);

  assert.ok(deepResearch.resolve("/tmp", { question: "q", angles: 8, minSupport: 5 }).script);
  assert.ok(deepResearch.resolve("/tmp", { question: "q" }).script); // missing → runtime default
  assert.ok(adversarialReview.resolve("/tmp", { task: "t", reviewers: 2, threshold: 0, maxFindings: 25 }).script);
  assert.ok(codeReview.resolve("/tmp", { diff: "d", maxCandidates: 30, verifyBatchSize: 5 }).script);
});

// ─── Runtime: scripts enforce the same rules (f2–f5/i1) ────────────────────────

test("deep-research script rejects angles: 0 at runtime", async () => {
  const runner = {
    async run(_prompt: string) {
      return null;
    },
  };
  await assert.rejects(
    () =>
      runWorkflow(generateDeepResearchWorkflow(), {
        agent: runner as never,
        persistLogs: false,
        args: { question: "q", angles: 0 },
      }),
    /angles/,
  );
});

test("adversarial-review script rejects reviewers: 0 at runtime", async () => {
  const runner = {
    async run(_prompt: string) {
      return null;
    },
  };
  await assert.rejects(
    () =>
      runWorkflow(generateAdversarialReviewWorkflow(), {
        agent: runner as never,
        persistLogs: false,
        args: { task: "t", reviewers: 0 },
      }),
    /reviewers/,
  );
});

test("code-review script rejects maxCandidates: 0 at runtime", async () => {
  const runner = {
    async run(_prompt: string) {
      return null;
    },
  };
  await assert.rejects(
    () =>
      runWorkflow(generateCodeReviewWorkflow(), {
        agent: runner as never,
        persistLogs: false,
        args: { diff: "d", maxCandidates: 0 },
      }),
    /maxCandidates/,
  );
});

// ─── builtins:f1 — null investigation must degrade, not crash ──────────────────

test("adversarial-review tolerates a null investigation and still produces a degraded report", async () => {
  const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("Investigate the following")) return null; // recoverable failure
        if (prompt.includes("final review report")) return "degraded report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { task: "audit error paths" },
  });
  assert.equal(result.agentCount, 2, "investigate (null) + consensus still run");
  const r = result.result as { total: number; survivors: unknown[]; report: unknown };
  assert.equal(r.total, 0);
  assert.equal(r.survivors.length, 0);
  assert.ok(r.report, "a degraded report should still be produced");
});

// ─── Runtime: threshold 0 preserved + maxFindings cap + refute fan-out ─────────

test("adversarial-review preserves a present threshold: 0 (0 refutes survive unless ratio >= 0)", async () => {
  const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("Investigate the following")) return { findings: ["f1", "f2"] };
        if (prompt.includes("skeptical reviewer")) return { real: false }; // 0/1 real votes
        if (prompt.includes("final review report")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { task: "t", reviewers: 1, threshold: 0, maxFindings: 5 },
  });
  const r = result.result as { total: number; survivors: unknown[] };
  // With threshold: 0 (not the 0.5 default), a 0/1 real ratio survives.
  assert.equal(r.total, 2);
  assert.equal(r.survivors.length, 2);
});

test("adversarial-review caps the refute pool at maxFindings and logs the degradation", async () => {
  let refuteCalls = 0;
  const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("Investigate the following")) return { findings: ["f1", "f2", "f3", "f4", "f5"] };
        if (prompt.includes("skeptical reviewer")) {
          refuteCalls++;
          return { real: true };
        }
        if (prompt.includes("final review report")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { task: "t", reviewers: 2, maxFindings: 2 },
  });
  assert.equal(refuteCalls, 4, "2 capped findings x 2 reviewers — fan-out is bounded");
  assert.equal(result.agentCount, 1 + 4 + 1, "investigate + 4 refutes + consensus");
  assert.ok(
    result.logs.some((l) => l.includes("capping the refute phase")),
    "the cap must be logged, never silent",
  );
});

test("adversarial-review bounds the refute product at MAX_REFUTE_AGENTS by reducing reviewers (i5)", async () => {
  // 50 findings (max) x 8 reviewers (max) = 400 refute agents — 60% over the
  // 250 budget. The refute phase must cut reviewers down to 5 (ceil(250/50))
  // so the product never exceeds the documented ceiling. Logged, never silent.
  let refuteCalls = 0;
  const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("Investigate the following")) {
          return { findings: Array.from({ length: 50 }, (_, i) => `f${i + 1}`) };
        }
        if (prompt.includes("skeptical reviewer")) {
          refuteCalls++;
          return { real: true };
        }
        if (prompt.includes("final review report")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { task: "t", reviewers: 8, maxFindings: 50 },
  });
  assert.equal(refuteCalls, 250, "50 findings x 5 effective reviewers = 250, never over the budget");
  assert.ok(
    result.logs.some((l) => l.includes("exceeding the 250 budget") && l.includes("reducing reviewers to 5")),
    "the reviewer reduction must be logged, never silent",
  );
});

// ─── Runtime: code-review null/partial batch verdicts stay aligned (i1) ────────

test("code-review keeps verdicts aligned when a middle batch is null (i1)", async () => {
  // Pool = first 10 of 84 deduped candidates (A0..A9). verifyBatchSize 3 →
  // 4 batches: b0(A0,A1,A2), b1(A3,A4,A5) NULL, b2(A6,A7,A8), b3(A9). A null
  // middle batch must degrade its candidates to PLAUSIBLE and MUST NOT shift
  // later batches' verdicts onto those slots.
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("line-by-line correctness scanner")) return { candidates: makeCandidates("A") };
        if (prompt.includes("removed-behavior auditor")) return { candidates: [] };
        if (prompt.includes("cross-file call-site tracer")) return { candidates: [] };
        if (prompt.includes("reuse finder")) return { candidates: [] };
        if (prompt.includes("simplification finder")) return { candidates: [] };
        if (prompt.includes("efficiency finder")) return { candidates: [] };
        if (prompt.includes("altitude reviewer")) return { candidates: [] };
        if (prompt.includes("You are a verifier")) {
          const files = [...prompt.matchAll(/File: (A\d+)/g)].map((m) => m[1]);
          if (files.includes("A3")) return null; // middle batch fails
          const verdict = files.includes("A0") ? "REFUTED" : "CONFIRMED";
          return { verdicts: files.map(() => ({ verdict, reason: "ok" })) };
        }
        if (prompt.includes("senior code reviewer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { diff: "d", maxCandidates: 10, verifyBatchSize: 3 },
  });
  const findings = (result.result as { findings: Array<{ file: string; verdict: string }> }).findings;
  const byFile = new Map(findings.map((f) => [f.file, f.verdict]));
  // b0 (A0,A1,A2) REFUTED → filtered out, never present.
  assert.ok(!byFile.has("A0") && !byFile.has("A1") && !byFile.has("A2"), "REFUTED findings are filtered out");
  // b1 (A3,A4,A5) NULL → degrade to PLAUSIBLE exactly on their own candidates.
  assert.equal(byFile.get("A3"), "PLAUSIBLE", "null batch's candidates degrade to PLAUSIBLE");
  assert.equal(byFile.get("A4"), "PLAUSIBLE");
  assert.equal(byFile.get("A5"), "PLAUSIBLE");
  // b2/b3 (A6..A9) CONFIRMED landed on their OWN candidates — not shifted onto A3-A5.
  assert.equal(byFile.get("A6"), "CONFIRMED", "later batches' verdicts land on their own candidates");
  assert.equal(byFile.get("A7"), "CONFIRMED");
  assert.equal(byFile.get("A8"), "CONFIRMED");
  assert.equal(byFile.get("A9"), "CONFIRMED");
});

test("code-review pads a short LLM output with PLAUSIBLE without shifting later batches (i1)", async () => {
  // b1 returns half its verdicts; the missing slots must pad to PLAUSIBLE and
  // b2's verdicts must still land on b2's candidates.
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("line-by-line correctness scanner")) return { candidates: makeCandidates("A") };
        if (prompt.includes("removed-behavior auditor")) return { candidates: [] };
        if (prompt.includes("cross-file call-site tracer")) return { candidates: [] };
        if (prompt.includes("reuse finder")) return { candidates: [] };
        if (prompt.includes("simplification finder")) return { candidates: [] };
        if (prompt.includes("efficiency finder")) return { candidates: [] };
        if (prompt.includes("altitude reviewer")) return { candidates: [] };
        if (prompt.includes("You are a verifier")) {
          const files = [...prompt.matchAll(/File: (A\d+)/g)].map((m) => m[1]);
          if (files.includes("A3")) {
            // B1 should have A3,A4,A5 but returns only one verdict.
            return { verdicts: [{ verdict: "REFUTED", reason: "short" }] };
          }
          if (files.includes("A0")) return { verdicts: files.map(() => ({ verdict: "CONFIRMED", reason: "ok" })) };
          return { verdicts: files.map(() => ({ verdict: "CONFIRMED", reason: "ok" })) };
        }
        if (prompt.includes("senior code reviewer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { diff: "d", maxCandidates: 10, verifyBatchSize: 3 },
  });
  const findings = (result.result as { findings: Array<{ file: string; verdict: string }> }).findings;
  const byFile = new Map(findings.map((f) => [f.file, f.verdict]));
  // A3 REFUTED → filtered; the two missing slots (A4, A5) pad to PLAUSIBLE.
  assert.ok(!byFile.has("A3"), "the one returned short-batch verdict lands on its own candidate");
  assert.equal(byFile.get("A4"), "PLAUSIBLE", "missing short-output slots pad to PLAUSIBLE");
  assert.equal(byFile.get("A5"), "PLAUSIBLE");
  // b2 unaffected: A6,A7,A8 stay CONFIRMED — not shifted into A4/A5.
  assert.equal(byFile.get("A6"), "CONFIRMED");
  assert.equal(byFile.get("A7"), "CONFIRMED");
  assert.equal(byFile.get("A8"), "CONFIRMED");
});

// ─── Runtime: deep-research query cap + default angles (i5/i1) ─────────────────

test("deep-research defaults angles to 4 and logs when the planner's queries are capped", async () => {
  const gatherPrompts: string[] = [];
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning web research")) return { queries: ["q1", "q2", "q3", "q4", "q5"] };
        if (prompt.includes("Research this query")) {
          gatherPrompts.push(prompt);
          return { sources: [] };
        }
        if (prompt.includes("Cross-check these research sources")) return { supported: [] };
        return "report";
      },
    } as never,
    persistLogs: false,
    args: { question: "Q" }, // angles omitted → default 4
  });
  assert.equal(gatherPrompts.length, 4, "default angles = 4 bounds the Gather fan-out");
  assert.ok(
    result.logs.some((l) => l.includes("using the first 4")),
    "the query cap must be logged, never silent",
  );
});

// ─── Runtime: code-review candidate cap + batched verify (i2/i5) ───────────────

function makeCandidates(
  prefix: string,
): Array<{ file: string; line: number; summary: string; failure_scenario: string }> {
  return Array.from({ length: 12 }, (_, i) => ({
    file: `${prefix}${i}`,
    line: i,
    summary: `summary-${i}`,
    failure_scenario: `fails when ${i}`,
  }));
}

test("code-review pre-caps the candidate pool and batches verify calls", async () => {
  let verifyCalls = 0;
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("line-by-line correctness scanner")) return { candidates: makeCandidates("A") };
        if (prompt.includes("removed-behavior auditor")) return { candidates: makeCandidates("B") };
        if (prompt.includes("cross-file call-site tracer")) return { candidates: makeCandidates("C") };
        if (prompt.includes("reuse finder")) return { candidates: makeCandidates("D") };
        if (prompt.includes("simplification finder")) return { candidates: makeCandidates("E") };
        if (prompt.includes("efficiency finder")) return { candidates: makeCandidates("F") };
        if (prompt.includes("altitude reviewer")) return { candidates: makeCandidates("G") };
        if (prompt.includes("You are a verifier")) {
          verifyCalls++;
          const count = (prompt.match(/File: /g) ?? []).length;
          return { verdicts: Array.from({ length: count }, () => ({ verdict: "CONFIRMED", reason: "ok" })) };
        }
        if (prompt.includes("senior code reviewer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { diff: "a small diff", maxCandidates: 10, verifyBatchSize: 5 },
  });
  // 7 finders produce 84 deduped candidates → pool capped at 10 → 2 batches of 5.
  assert.equal(verifyCalls, 2, "ceil(10 / 5) verifier agents, not 10 (one per candidate)");
  assert.equal(result.agentCount, 7 + 2 + 1, "7 finders + 2 verify batches + 1 synthesis");
  const r = result.result as { total: number; verified: number; diffTruncated: boolean };
  assert.equal(r.total, 84, "total still reflects every deduped candidate found");
  assert.equal(r.verified, 10, "verified reflects the pre-capped pool");
  assert.equal(r.diffTruncated, false, "a short diff is not truncated");
  assert.ok(
    result.logs.some((l) => l.includes("capping the verify pass at 10")),
    "the pool cap must be logged, never silent",
  );
});

// ─── Runtime: diffTruncated provenance (i4) ────────────────────────────────────

test("code-review honours args.diffTruncated/diffLength provenance from the slash-command path", async () => {
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("line-by-line correctness scanner")) return { candidates: [] };
        if (prompt.includes("removed-behavior auditor")) return { candidates: [] };
        if (prompt.includes("cross-file call-site tracer")) return { candidates: [] };
        if (prompt.includes("reuse finder")) return { candidates: [] };
        if (prompt.includes("simplification finder")) return { candidates: [] };
        if (prompt.includes("efficiency finder")) return { candidates: [] };
        if (prompt.includes("altitude reviewer")) return { candidates: [] };
        if (prompt.includes("senior code reviewer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    // Simulates the /code-review handler: diff already truncated, provenance flagged.
    args: { diff: "short diff", diffTruncated: true, diffLength: 999 },
  });
  const r = result.result as { diffTruncated: boolean };
  assert.equal(r.diffTruncated, true, "a truncated diff must never report itself as not truncated");
  assert.ok(
    result.logs.some((l) => l.includes("Diff truncated for review") && l.includes("999")),
    "the log should use the original (pre-truncation) length",
  );
});

test("code-review computes diffTruncated itself when provenance args are absent", async () => {
  const hugeDiff = "x".repeat(300_000);
  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("line-by-line correctness scanner")) return { candidates: [] };
        if (prompt.includes("removed-behavior auditor")) return { candidates: [] };
        if (prompt.includes("cross-file call-site tracer")) return { candidates: [] };
        if (prompt.includes("reuse finder")) return { candidates: [] };
        if (prompt.includes("simplification finder")) return { candidates: [] };
        if (prompt.includes("efficiency finder")) return { candidates: [] };
        if (prompt.includes("altitude reviewer")) return { candidates: [] };
        if (prompt.includes("senior code reviewer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { diff: hugeDiff }, // workflow-tool name path: raw diff, no provenance
  });
  const r = result.result as { diffTruncated: boolean };
  assert.equal(r.diffTruncated, true, "an oversized raw diff must be detected as truncated");
});
