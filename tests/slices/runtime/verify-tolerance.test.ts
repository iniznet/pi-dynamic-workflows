import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import { runWorkflow } from "../../../src/workflow.js";

test("M4: one SCHEMA_NONCOMPLIANCE vote is omitted, the run survives", async () => {
  let call = 0;
  const reviewer = {
    async run(_prompt: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      call++;
      if (call === 1) {
        throw new WorkflowError("vote could not produce valid output", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
          recoverable: false,
        });
      }
      return { real: call === 2 };
    },
  };
  const script = `export const meta = { name: 'v_tol', description: 'verify tolerance' }
return await verify('claim', { reviewers: 3, threshold: 0.5 })`;

  const res = await runWorkflow<{ real: boolean; total: number; votes: Array<{ real: boolean }> }>(script, {
    agent: reviewer,
    persistLogs: false,
  });
  assert.equal(res.result.total, 2, "the SCHEMA_NONCOMPLIANCE vote is omitted from the denominator");
  assert.equal(res.result.real, true, "one of two surviving votes meets the inclusive 0.5 threshold");
});

test("M4: a non-recoverable budget/limit vote still fails the run", async () => {
  const reviewer = {
    async run(_prompt: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    },
  };
  const script = `export const meta = { name: 'v_fatal', description: 'budget still fatal' }
return await verify('claim', { reviewers: 2 })`;

  await assert.rejects(() => runWorkflow(script, { agent: reviewer, persistLogs: false }), /budget/i);
});

test("M4: judgePanel survives a SCHEMA_NONCOMPLIANCE judge and clamps out-of-range scores (L15)", async () => {
  let call = 0;
  const scorer = {
    async run(_prompt: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      call++;
      if (call === 1) {
        throw new WorkflowError("judge failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
      }
      // call 2 -> score 2.0 (must clamp to 1), call 3 -> score -5 (must clamp to 0)
      return { score: call === 2 ? 2.0 : -5, reason: "x" };
    },
  };
  const script = `export const meta = { name: 'j_tol', description: 'judge tolerance' }
return await judgePanel(['first', 'second'], { judges: 3 })`;

  const res = await runWorkflow<{ index: number; score: number; judgments: Array<{ score: number }> }>(script, {
    agent: scorer,
    persistLogs: false,
  });
  assert.equal(res.result.score, 0.5, "(1.0 + 0.0) / 2 — out-of-range scores clamped, failed judge omitted");
});

test("L14: verify labels are unique across helper invocations", async () => {
  const labels: string[] = [];
  const reviewer = {
    async run(_prompt: string, o?: { schema?: unknown; label?: string }) {
      if (!o?.schema) return "ok";
      labels.push(o?.label ?? "");
      return { real: true };
    },
  };
  const script = `export const meta = { name: 'v_seq', description: 'unique labels' }
const first = await verify('a', { reviewers: 2 })
const second = await verify('b', { reviewers: 2 })
return { first, second }`;

  await runWorkflow(script, { agent: reviewer, persistLogs: false });
  assert.equal(new Set(labels).size, labels.length, "no label is reused across verify invocations");
  assert.match(labels[0] ?? "", /^verify 1\.1$/);
  assert.match(labels[2] ?? "", /^verify 1\.2$/, "the second invocation carries its own counter");
});
