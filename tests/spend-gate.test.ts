/**
 * SLICE C — spend governance (spend-gate).
 *
 * Coverage (slice contract):
 *  1. MEASURED PRICE BOOK — resolveModelPrice/modelPriceForEstimate resolve
 *     real per-1k USD prices (exact spec, :thinking suffix, bare id, tier
 *     fallback, default reference); the pre-flight forecast computes a REAL
 *     USD range (usdMin/usdWorstCase) from the price book and lists unpriced
 *     models.
 *  2. QUOTE-BEFORE-SPEND + TAU GATE — evaluateSpendQuote verdicts; runWorkflow
 *     REFUSES (SPEND_QUOTE_EXCEEDED) an over-budget launch before any agent
 *     runs; warn mode requires human confirmation (deny refuses, approve
 *     launches); tau 0/null or no budget = gate off = current behavior.
 *  3. NO-PROGRESS GUARD (default-on) — a zero-work-evidence success is flagged
 *     (run result carries noProgressFlags + the agent-end event carries the
 *     flag); consecutive zero-evidence successes per label hit the attempt
 *     budget and the run refuses to let the loop continue (NO_PROGRESS); the
 *     guard is a no-op when disabled and a no-op for runners that never report
 *     evidence (feature-detect).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentUsage, WorkEvidence } from "../src/agent.js";
import {
  DEFAULT_MODEL_PRICE_USD,
  DEFAULT_NO_PROGRESS_GUARD,
  DEFAULT_SPEND_QUOTE_GATE,
  DEFAULT_SPEND_TAU,
  MAX_MODEL_PRICE_USD,
  MODEL_PRICE_BOOK,
  modelPriceForEstimate,
  NO_PROGRESS_ZERO_EVIDENCE_CAP,
  resolveModelPrice,
  resolveSpendCeilingUsd,
  TIER_PRICE_DEFAULTS,
} from "../src/config.js";
import {
  estimateWorkflowForecast,
  renderWorkflowEstimate,
  type WorkflowEstimate,
} from "../src/estimate-forecast.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { evaluateSpendQuote, isSpendQuoteArmed } from "../src/spend-quote.js";
import { runWorkflow, type NoProgressFlag } from "../src/workflow.js";

const SPENDY_SCRIPT = `export const meta = { name: 'spendy', description: 'a spendy fan-out' }
const out = await parallel([
  async () => agent('analyze the codebase and report findings in depth', { label: 'a', tier: 'big' }),
  async () => agent('review the architecture and list every risk in detail', { label: 'b', tier: 'big' }),
  async () => agent('critique the diff and propose concrete fixes', { label: 'c', tier: 'big' }),
])
return out`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Measured price book
// ─────────────────────────────────────────────────────────────────────────────

test("price book: real per-1k USD prices resolve by exact spec, :thinking suffix, and bare id", () => {
  const mini = MODEL_PRICE_BOOK["openai/gpt-4.1-mini"];
  assert.deepEqual(resolveModelPrice("openai/gpt-4.1-mini"), mini);
  assert.deepEqual(resolveModelPrice("openai/gpt-4.1-mini:xhigh"), mini, "the :thinking suffix is stripped");
  assert.deepEqual(resolveModelPrice("gpt-4.1-mini"), mini, "a bare model id resolves via the suffix scan");
  // Every book entry is a real positive price pair.
  for (const [spec, price] of Object.entries(MODEL_PRICE_BOOK)) {
    assert.ok(price.inputPer1kUsd > 0 && price.outputPer1kUsd > 0, `${spec} must carry positive prices`);
  }
});

test("price book: tier fallback + default reference + conservative worst case", () => {
  assert.deepEqual(modelPriceForEstimate(undefined, "small"), TIER_PRICE_DEFAULTS.small);
  assert.deepEqual(modelPriceForEstimate(undefined, "big"), TIER_PRICE_DEFAULTS.big);
  assert.deepEqual(modelPriceForEstimate("openai/gpt-4.1-mini", "big"), MODEL_PRICE_BOOK["openai/gpt-4.1-mini"], "an explicit model wins over its tier");
  assert.deepEqual(modelPriceForEstimate(undefined, undefined), DEFAULT_MODEL_PRICE_USD, "unknown → default reference");
  assert.deepEqual(modelPriceForEstimate("no-such/model-here", "medium"), MODEL_PRICE_BOOK["openai/gpt-4.1"], "unpriced model falls back to its tier price");
  assert.ok(
    MAX_MODEL_PRICE_USD.outputPer1kUsd >= MODEL_PRICE_BOOK["anthropic/claude-opus-4"].outputPer1kUsd,
    "the worst-case reference is at least the most expensive book entry",
  );
});

test("estimate: computes a REAL USD range from the price book (min + worst case)", () => {
  const est = estimateWorkflowForecast(SPENDY_SCRIPT);
  assert.ok(est.usdMin > 0, "the USD range is real money, not zero");
  assert.ok(est.usdWorstCase >= est.usdMin, "worst case >= min case");
  // Three big-tier agents; per-agent cost = prompt/1000×in + reply/1000×out.
  const perAgent =
    ((est.promptTokens / est.agentCount) / 1000) * TIER_PRICE_DEFAULTS.big.inputPer1kUsd +
    (2000 / 1000) * TIER_PRICE_DEFAULTS.big.outputPer1kUsd;
  const expectedMin = perAgent * est.agentCount;
  assert.ok(
    Math.abs(est.usdMin - expectedMin) < expectedMin * 1e-6,
    `min USD ${est.usdMin} ≈ computed ${expectedMin}`,
  );
  assert.deepEqual(est.unpricedModels, [], "tier-referenced agents are priced, not unpriced");
});

test("estimate: unpriced explicit models are documented and quote at the default reference", () => {
  const script = `export const meta = { name: 'exotic', description: 'unpriced' }
const out = await agent('scan the repo', { model: 'openai/opaque-model-9' })
return out`;
  const est = estimateWorkflowForecast(script);
  assert.deepEqual(est.unpricedModels, ["openai/opaque-model-9"], "the unknown model is listed");
  assert.ok(est.warnings.some((w) => w.includes("no price-book entry")), "a warning documents the fallback quote");
  // The unpriced agent quotes at the default reference (not the tier).
  const perAgent = (est.promptTokens / 1000) * DEFAULT_MODEL_PRICE_USD.inputPer1kUsd + (2000 / 1000) * DEFAULT_MODEL_PRICE_USD.outputPer1kUsd;
  assert.ok(Math.abs(est.usdMin - perAgent) < 1e-9);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Quote-before-spend + tau gate
// ─────────────────────────────────────────────────────────────────────────────

test("quote: verdicts are off by default and refuse/warn when over the ceiling", () => {
  const est = estimateWorkflowForecast(SPENDY_SCRIPT);
  assert.equal(est.spendCeilingUsd, null, "no budget → no ceiling");
  assert.equal(est.quoteVerdict, "off", "no budget → gate off (current behavior)");
  assert.equal(isSpendQuoteArmed({}), false);
  assert.equal(isSpendQuoteArmed({ spendBudgetUsd: 1 }), true);

  const tight = estimateWorkflowForecast(SPENDY_SCRIPT, { spendBudgetUsd: est.usdWorstCase / 10, spendTau: 1 });
  assert.equal(tight.spendCeilingUsd, est.usdWorstCase / 10);
  assert.equal(tight.quoteVerdict, "warn", "over ceiling + default warn mode → warn (never silent)");
  assert.ok(tight.quoteReason?.includes("EXCEEDS"));
  assert.ok(tight.warnings.some((w) => w.includes("EXCEEDS")), "the over-budget quote is a warning");

  const refused = estimateWorkflowForecast(SPENDY_SCRIPT, {
    spendBudgetUsd: est.usdWorstCase / 10,
    spendQuoteGate: "refuse",
  });
  assert.equal(refused.quoteVerdict, "refuse");

  const ok = estimateWorkflowForecast(SPENDY_SCRIPT, { spendBudgetUsd: est.usdWorstCase * 10 });
  assert.equal(ok.quoteVerdict, "ok");

  // quotedValueUsd overrides budget × tau.
  const valued = estimateWorkflowForecast(SPENDY_SCRIPT, {
    spendBudgetUsd: 0.0000001,
    quotedValueUsd: est.usdWorstCase * 10,
  });
  assert.equal(valued.quoteVerdict, "ok");
});

test("quote: tau semantics — ceiling = budget × tau; tau 0/null disables the gate", () => {
  assert.equal(resolveSpendCeilingUsd(1, undefined, undefined), 1 * DEFAULT_SPEND_TAU, "default tau = budget × 1");
  assert.equal(resolveSpendCeilingUsd(1, undefined, 2), 2, "tau scales the budget ceiling");
  assert.equal(resolveSpendCeilingUsd(1, undefined, 0), null, "tau 0 = gate disabled");
  assert.equal(resolveSpendCeilingUsd(1, undefined, null), null, "tau null = gate disabled");
  assert.equal(resolveSpendCeilingUsd(undefined, undefined, 1), null, "no budget → no ceiling even with tau");

  const est = estimateWorkflowForecast(SPENDY_SCRIPT);
  const tauZero = estimateWorkflowForecast(SPENDY_SCRIPT, { spendBudgetUsd: est.usdWorstCase / 10, spendTau: 0 });
  assert.equal(tauZero.spendCeilingUsd, null);
  assert.equal(tauZero.quoteVerdict, "off", "tau 0 restores current behavior (no quote refusal)");
});

test("quote gate (runWorkflow): refuses an over-budget launch BEFORE any agent runs", async () => {
  const est = estimateWorkflowForecast(SPENDY_SCRIPT);
  const calls: string[] = [];
  const agent = {
    async run(prompt: string): Promise<string> {
      calls.push(prompt);
      return "done";
    },
  };
  await assert.rejects(
    runWorkflow(SPENDY_SCRIPT, {
      agent,
      spendBudgetUsd: est.usdWorstCase / 100,
      spendTau: 1,
      persistLogs: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError, `expected a WorkflowError, got ${String(error)}`);
      assert.equal(error.code, WorkflowErrorCode.SPEND_QUOTE_EXCEEDED);
      assert.match(error.message, /EXCEEDS/i);
      return true;
    },
  );
  assert.deepEqual(calls, [], "the gate refused before a single agent ran");

  // Same script under a generous ceiling launches normally.
  const ok = await runWorkflow(SPENDY_SCRIPT, {
    agent,
    spendBudgetUsd: est.usdWorstCase * 10,
    persistLogs: false,
  });
  assert.equal(Array.isArray(ok.result) ? (ok.result as unknown[]).length : 0, 3, "three fan-out items completed");
});

test("quote gate: warn mode requires human confirmation (deny refuses, approve launches)", async () => {
  const est = estimateWorkflowForecast(SPENDY_SCRIPT);
  const calls: string[] = [];
  const agent = {
    async run(prompt: string): Promise<string> {
      calls.push(prompt);
      return "done";
    },
  };
  // Deny: the confirmation is asked, the launch is refused, nothing ran.
  await assert.rejects(
    runWorkflow(SPENDY_SCRIPT, {
      agent,
      spendBudgetUsd: est.usdWorstCase / 100,
      spendQuoteGate: "warn",
      confirm: async () => false,
      persistLogs: false,
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SPEND_QUOTE_EXCEEDED,
  );
  assert.deepEqual(calls, [], "denied confirmation → nothing launched");

  // Approve: the run proceeds past the gate.
  const approved = await runWorkflow(SPENDY_SCRIPT, {
    agent,
    spendBudgetUsd: est.usdWorstCase / 100,
    spendQuoteGate: "warn",
    confirm: async () => true,
    persistLogs: false,
  });
  assert.equal(Array.isArray(approved.result) ? (approved.result as unknown[]).length : 0, 3, "approved confirmation → the run launched");
});

test("quote gate: tau 0 / no budget = current behavior (no refusal)", async () => {
  const calls: string[] = [];
  const agent = {
    async run(prompt: string): Promise<string> {
      calls.push(prompt);
      return "done";
    },
  };
  // Explicit tau 0 disables the gate even with a tiny budget.
  const result = await runWorkflow(SPENDY_SCRIPT, {
    agent,
    spendBudgetUsd: 0.000001,
    spendTau: 0,
    persistLogs: false,
  });
  assert.equal(Array.isArray(result.result) ? (result.result as unknown[]).length : 0, 3);
  // And with no budget at all — the plain pre-governance path.
  calls.length = 0;
  await runWorkflow(SPENDY_SCRIPT, { agent, persistLogs: false });
  assert.equal(calls.length, 3, "no budget → no gate → current behavior");
});

test("quote: pure evaluator agrees with the estimate's verdict and default mode", () => {
  const est = estimateWorkflowForecast(SPENDY_SCRIPT);
  const over = evaluateSpendQuote(est, { spendBudgetUsd: est.usdWorstCase / 2 });
  assert.equal(over.verdict, "warn", "default mode is warn (require confirmation)");
  assert.equal(over.mode, DEFAULT_SPEND_QUOTE_GATE);
  assert.equal(over.ceilingUsd, (est.usdWorstCase / 2) * DEFAULT_SPEND_TAU);
  const within = evaluateSpendQuote(est, { spendBudgetUsd: est.usdWorstCase * 2 });
  assert.equal(within.verdict, "ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. No-progress guard (default-on)
// ─────────────────────────────────────────────────────────────────────────────

/** A mock runner that reports zero work evidence on every success. */
type EvidenceRunnerOptions = {
  onWorkEvidence?: (evidence: WorkEvidence) => void;
  onUsage?: (usage: AgentUsage) => void;
};

function zeroEvidenceAgent(calls: { count: number }) {
  return {
    async run(prompt: string, options?: EvidenceRunnerOptions): Promise<string> {
      calls.count++;
      options?.onWorkEvidence?.({ toolEvents: 0, editEvents: 0, resultChars: prompt.length } satisfies WorkEvidence);
      return "done";
    },
  };
}

/** A mock runner that reports real work evidence (tool events). */
function workingAgent(calls: { count: number }) {
  return {
    async run(prompt: string, options?: EvidenceRunnerOptions): Promise<string> {
      calls.count++;
      options?.onWorkEvidence?.({ toolEvents: 2, editEvents: 1, resultChars: 40 } satisfies WorkEvidence);
      return "done";
    },
  };
}

const LOOP_SCRIPT = `export const meta = { name: 'loop', description: 'zero-evidence loop' }
for (let i = 0; i < 6; i++) { await agent('tick ' + i, { label: 'looper' }) }
return 'ok'`;

test("no-progress guard is DEFAULT-ON by config and caps a zero-evidence loop", async () => {
  assert.equal(DEFAULT_NO_PROGRESS_GUARD, true, "the guard is default-on");
  const calls = { count: 0 };
  await assert.rejects(
    runWorkflow(LOOP_SCRIPT, {
      agent: zeroEvidenceAgent(calls),
      persistLogs: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError, `expected a WorkflowError, got ${String(error)}`);
      assert.equal(error.code, WorkflowErrorCode.NO_PROGRESS);
      assert.match(error.message, /zero work evidence/);
      assert.match(error.message, /loop silently/);
      return true;
    },
  );
  // 1 (flag) + 2 (flag) + 3 (cap → throw) = 3 attempts, never 6.
  assert.equal(calls.count, NO_PROGRESS_ZERO_EVIDENCE_CAP, "the loop was capped at the attempt budget");
});

test("no-progress guard: flagged successes surface on the run result + agent-end event", async () => {
  const calls = { count: 0 };
  const endEvents: Array<{ label: string; noProgress?: NoProgressFlag }> = [];
  const twoOnly = `export const meta = { name: 'two', description: 'two flags' }
await agent('first', { label: 'quiet' })
await agent('second', { label: 'quiet' })
return 'done'`;
  const result = await runWorkflow(twoOnly, {
    agent: zeroEvidenceAgent(calls),
    onAgentEnd: (event) => endEvents.push(event),
    persistLogs: false,
  });
  assert.equal(calls.count, 2, "two flagged successes under the cap complete");
  assert.equal(result.noProgressFlags?.length, 2, "both zero-evidence successes are flagged");
  assert.deepEqual(
    result.noProgressFlags?.map((f) => f.consecutive),
    [1, 2],
    "consecutive counts are tracked per label",
  );
  assert.equal(result.noProgressFlags?.[0]?.toolEvents, 0);
  assert.equal(endEvents.filter((e) => e.noProgress).length, 2, "the agent-end event carries the flag");
  assert.equal(result.result, "done", "flagged-but-under-cap runs still complete");
});

test("no-progress guard: evidence-bearing agents never flag", async () => {
  const calls = { count: 0 };
  const result = await runWorkflow(LOOP_SCRIPT, {
    agent: workingAgent(calls),
    persistLogs: false,
  });
  assert.equal(result.result, "ok", "a working loop completes");
  assert.equal(calls.count, 6, "all six iterations ran");
  assert.equal(result.noProgressFlags, undefined, "no flags on evidence-bearing agents");
});

test("no-progress guard: disabled (noProgressGuard: false) restores current behavior", async () => {
  const calls = { count: 0 };
  const result = await runWorkflow(LOOP_SCRIPT, {
    agent: zeroEvidenceAgent(calls),
    noProgressGuard: false,
    persistLogs: false,
  });
  assert.equal(result.result, "ok", "a zero-evidence loop completes when the guard is off");
  assert.equal(calls.count, 6);
  assert.equal(result.noProgressFlags, undefined);
});

test("no-progress guard: runners that never report evidence are not guarded (feature-detect)", async () => {
  const calls = { count: 0 };
  const silent = {
    async run(prompt: string): Promise<string> {
      calls.count++;
      return "done";
    },
  };
  const result = await runWorkflow(LOOP_SCRIPT, {
    agent: silent,
    persistLogs: false,
  });
  assert.equal(result.result, "ok", "a non-reporting runner keeps pre-guard behavior");
  assert.equal(calls.count, 6);
  assert.equal(result.noProgressFlags, undefined);
});

test("no-progress guard: a real work-evidence report with zero tool events still flags (README-less pass-through)", async () => {
  // The guard's trigger is "no tool events" — a large prose reply alone is NOT
  // work evidence (the brief: no tool events / edit results / README).
  const calls = { count: 0 };
  const proseOnly = {
    async run(prompt: string, options?: EvidenceRunnerOptions): Promise<string> {
      calls.count++;
      options?.onWorkEvidence?.({ toolEvents: 0, editEvents: 0, resultChars: 5000 } satisfies WorkEvidence);
      return "a long but tool-less reply".repeat(100);
    },
  };
  const twoOnly = `export const meta = { name: 'prose', description: 'tool-less' }
await agent('summarize', { label: 'summarizer' })
await agent('summarize again', { label: 'summarizer' })
return 'done'`;
  const result = await runWorkflow(twoOnly, { agent: proseOnly, persistLogs: false });
  assert.equal(result.noProgressFlags?.length, 2, "tool-less prose replies are flagged as zero evidence");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Pre-flight surface
// ─────────────────────────────────────────────────────────────────────────────

test("render: the estimate renderer shows the real USD range + quote verdict", () => {
  const est = estimateWorkflowForecast(SPENDY_SCRIPT, { spendBudgetUsd: 10, spendTau: 1 });
  const text = renderWorkflowEstimate(est);
  assert.match(text, /Cost: ~\*\*\$\d+\.\d+ – \$\d+\.\d+\*\* \(min – worst case, measured price book\)/);
  assert.match(text, /Quote: within spend ceiling/);
});

test("render: an over-budget estimate renders the warning verdict", () => {
  const est = estimateWorkflowForecast(SPENDY_SCRIPT, { spendBudgetUsd: 0.000001, spendQuoteGate: "refuse" });
  const text = renderWorkflowEstimate(est);
  assert.match(text, /Quote: ✗ over spend ceiling — launch refused/);
  assert.match(text, /EXCEEDS/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. config/estimate defaults stay coherent
// ─────────────────────────────────────────────────────────────────────────────

test("config: spend-gate defaults are sane and documented", () => {
  assert.equal(DEFAULT_SPEND_TAU, 1);
  assert.equal(DEFAULT_SPEND_QUOTE_GATE, "warn");
  assert.ok(NO_PROGRESS_ZERO_EVIDENCE_CAP >= 2, "the attempt budget allows at least one flag before escalation");
  // The price book + tier defaults + default reference are all positive pairs.
  for (const price of [DEFAULT_MODEL_PRICE_USD, MAX_MODEL_PRICE_USD, ...Object.values(TIER_PRICE_DEFAULTS)]) {
    assert.ok(price.inputPer1kUsd > 0 && price.outputPer1kUsd > 0);
  }
});

test("estimate: usd fields are always present on the estimate shape", () => {
  const est: WorkflowEstimate = estimateWorkflowForecast(SPENDY_SCRIPT);
  assert.equal(typeof est.usdMin, "number");
  assert.equal(typeof est.usdWorstCase, "number");
  assert.equal(typeof est.unpricedModels, "object");
  assert.ok(Array.isArray(est.unpricedModels));
});
