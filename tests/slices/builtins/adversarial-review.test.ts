/**
 * Slice D tests — adversarial-review builtin fixes (H6 + M22).
 *
 * H6: a null agent result (recoverable failure) counts as a FAILED refute vote
 * — logged, never a crash, and it shrinks the survival ratio.
 * M22: reviewers >= 2 (a lone reviewer cannot be cross-checked) and the 0.66
 * default agreement threshold — a 1-of-2 split (0.5 < 0.66) never survives.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { generateAdversarialReviewWorkflow } from "../../../src/adversarial-review.js";
import { ADVERSARIAL_REVIEW_NUMERIC_ARGS, numericArgCoercionSource } from "../../../src/builtin-args.js";
import { findBuiltinWorkflow } from "../../../src/builtin-workflows.js";
import { runWorkflow } from "../../../src/workflow.js";

// ─── M22 constants ─────────────────────────────────────────────────────────────

test("adversarial-review requires reviewers >= 2 and defaults threshold to 0.66 (M22)", () => {
  const reviewers = ADVERSARIAL_REVIEW_NUMERIC_ARGS.find((s) => s.name === "reviewers");
  const threshold = ADVERSARIAL_REVIEW_NUMERIC_ARGS.find((s) => s.name === "threshold");
  assert.ok(reviewers && threshold);
  assert.equal(reviewers.min, 2, "a lone reviewer can never be cross-checked");
  assert.equal(threshold.default, 0.66, "1-of-2 = 0.5 < 0.66 must never survive");
});

test("adversarial-review resolver rejects reviewers: 1 and the script enforces it at runtime", async () => {
  const pattern = findBuiltinWorkflow("adversarial-review");
  assert.ok(pattern);
  assert.throws(() => pattern.resolve("/tmp", { task: "t", reviewers: 1 }), /reviewers/);

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
        args: { task: "t", reviewers: 1 },
      }),
    /reviewers/,
  );
});

test("coercion source bakes the 0.66 default and the reviewers >= 2 floor", () => {
  const code = numericArgCoercionSource(ADVERSARIAL_REVIEW_NUMERIC_ARGS);
  assert.match(code, /0\.66/);
  assert.match(code, /if \(min !== undefined && n < min\)/);
  const out = new vm.Script(`${code}\n__result = { reviewers, threshold, maxFindings }`).runInNewContext({
    args: {},
    __result: undefined,
  }) as Record<string, unknown>;
  assert.deepEqual({ ...out }, { reviewers: 2, threshold: 0.66, maxFindings: 25 });
});

// ─── H6 null votes + M22 threshold at runtime ──────────────────────────────────

/** Fake runner whose refute votes follow a per-prompt sequence. */
function refuteRunner(voteSequence: ReadonlyArray<{ real: boolean } | null>) {
  const voteCounts = new Map<string, number>();
  return {
    async run(prompt: string) {
      if (prompt.includes("Investigate the following")) return { findings: ["f1"] };
      if (prompt.includes("skeptical reviewer")) {
        const n = (voteCounts.get(prompt) ?? 0) + 1;
        voteCounts.set(prompt, n);
        return voteSequence[(n - 1) % voteSequence.length];
      }
      if (prompt.includes("final review report")) return "consensus report";
      return null;
    },
  };
}

async function runRefute(voteSequence: ReadonlyArray<{ real: boolean } | null>) {
  return runWorkflow(generateAdversarialReviewWorkflow(), {
    agent: refuteRunner(voteSequence) as never,
    persistLogs: false,
    args: { task: "t" }, // defaults: reviewers 2, threshold 0.66
  });
}

test("adversarial-review: a 1-of-2 split (0.5 < 0.66) does NOT survive (M22)", async () => {
  const result = await runRefute([{ real: true }, { real: false }]);
  const r = result.result as { total: number; survivors: unknown[] };
  assert.equal(r.total, 1);
  assert.equal(r.survivors.length, 0, "1-of-2 = 0.5 is below the 0.66 threshold");
});

test("adversarial-review: a 2-of-2 agreement survives", async () => {
  const result = await runRefute([{ real: true }, { real: true }]);
  const r = result.result as { total: number; survivors: unknown[] };
  assert.equal(r.total, 1);
  assert.equal(r.survivors.length, 1, "unanimous 2-of-2 survives");
});

test("adversarial-review: null refute votes are failed votes — no crash, finding dropped, logged (H6)", async () => {
  const result = await runRefute([null, null]);
  const r = result.result as { total: number; survivors: unknown[] };
  assert.equal(r.total, 1);
  assert.equal(r.survivors.length, 0, "0 real of 2 votes (both failed) must not survive");
  assert.ok(
    result.logs.some((l) => l.includes("refute vote(s)") && l.includes("failed and count as real=false")),
    "failed votes should be logged, not silent",
  );
});

test("adversarial-review: a mixed null + real vote counts the null as failed (1-of-2 rejected)", async () => {
  const result = await runRefute([null, { real: true }]);
  const r = result.result as { total: number; survivors: unknown[] };
  // 1 real of 2 occupied slots = 0.5 — below 0.66 even though the surviving
  // reviewer said real; the failed vote still occupies a reviewer slot (H6).
  assert.equal(r.survivors.length, 0);
});
