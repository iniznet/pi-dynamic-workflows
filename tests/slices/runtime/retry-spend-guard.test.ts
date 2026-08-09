import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../../../src/agent.js";
import { runWorkflow } from "../../../src/workflow.js";

// ─── T2-08: retry spend guard ───────────────────────────────────────────────────
// retryOnlyIfSpendUnder skips ONLY the auto-retry branch when the failed
// attempt's recorded spend exceeds the threshold; the agent settles exhausted
// exactly like a retry-exhausted failure. AGENT_EXHAUSTED /
// failOnExhaustedAgent semantics and the onRetrySpend full-breakdown invariant
// (M26) are untouched; with the guard off, retry behavior is byte-identical.

const SCRIPT = `export const meta = { name: 'retry_guard', description: 'retry spend guard' }
const value = await agent('work', { label: 'a' })
return value`;

/** Failed-attempt usage the double reports via onUsage (components sum to 105). */
const FAILED_USAGE: AgentUsage = { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, total: 105, cost: 0 };

function makeFailingAgent(calls: { count: number }): {
  run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<string>;
} {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      calls.count++;
      options?.onUsage?.(FAILED_USAGE);
      // An empty result raises AGENT_EMPTY_OUTPUT (recoverable) — the retry path.
      return "";
    },
  };
}

function makeBaseOptions(agent: unknown, extra: Record<string, unknown> = {}) {
  return {
    // The double's run() signature is structurally compatible; the workflow
    // layer only calls run(prompt, options) and reads options.onUsage.
    agent: agent as never,
    agentRetries: 2,
    retryBackoffMs: 0,
    persistLogs: false,
    ...extra,
  };
}

test("T2-08: the guard skips auto-retry when the failed attempt spent more than retryOnlyIfSpendUnder (per-call)", async () => {
  const calls = { count: 0 };
  const logs: string[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_guard_call', description: 'per-call guard' }
const value = await agent('work', { label: 'a', retries: 2, retryOnlyIfSpendUnder: 50 })
return value`,
    makeBaseOptions(makeFailingAgent(calls), {
      onLog: (m: string) => logs.push(m),
      // no run-level guard: the per-call override decides
    }),
  );

  assert.equal(calls.count, 1, "the attempt was NOT retried despite retries: 2");
  assert.equal(result.result, null, "the agent settles exhausted (null), like a retry-exhausted failure");
  assert.ok(
    logs.some((m) => m.includes("skipping auto-retry") && m.includes("105") && m.includes("50")),
    "the log explains why the retry was skipped (spend vs threshold)",
  );
});

test("T2-08: a spend UNDER the threshold still retries — and the run-level default applies", async () => {
  const calls = { count: 0 };
  const retrySpends: AgentUsage[] = [];
  const result = await runWorkflow(
    SCRIPT,
    makeBaseOptions(makeFailingAgent(calls), {
      // run-level guard well above the 105-token failed attempt
      retryOnlyIfSpendUnder: 1000,
      onRetrySpend: (spend: AgentUsage) => retrySpends.push(spend),
    }),
  );

  assert.equal(calls.count, 3, "all three attempts ran (2 retries) because 105 < 1000");
  assert.equal(result.result, null, "still exhausted after retries are exhausted");
  assert.equal(retrySpends.length, 2, "both retried attempts reported their FULL usage breakdown (M26 invariant)");
  assert.deepEqual(retrySpends[0], FAILED_USAGE, "the onRetrySpend payload is the full AgentUsage shape");
});

test("T2-08: a run-level guard below the spend skips retries; the per-call override wins over the run level", async () => {
  // Run-level guard skips.
  const calls = { count: 0 };
  await runWorkflow(SCRIPT, makeBaseOptions(makeFailingAgent(calls), { retryOnlyIfSpendUnder: 50 }));
  assert.equal(calls.count, 1, "run-level guard below the spend skips the retry");

  // Per-call override (above the spend) beats the run-level guard.
  const calls2 = { count: 0 };
  await runWorkflow(
    `export const meta = { name: 'retry_guard_override', description: 'per-call wins' }
const value = await agent('work', { label: 'a', retries: 2, retryOnlyIfSpendUnder: 1000 })
return value`,
    makeBaseOptions(makeFailingAgent(calls2), { retryOnlyIfSpendUnder: 50 }),
  );
  assert.equal(calls2.count, 3, "the per-call override (1000 > 105) beats the run-level guard (50)");
});

test("T2-08: no guard (default) keeps today's retry behavior byte-for-byte and onRetrySpend fires", async () => {
  const calls = { count: 0 };
  const retrySpends: AgentUsage[] = [];
  const result = await runWorkflow(
    SCRIPT,
    makeBaseOptions(makeFailingAgent(calls), {
      onRetrySpend: (spend: AgentUsage) => retrySpends.push(spend),
    }),
  );
  assert.equal(calls.count, 3, "retries: 2 → three attempts, exactly as before the guard existed");
  assert.equal(result.result, null);
  assert.equal(retrySpends.length, 2, "onRetrySpend still reports every retried attempt");
});

test("T2-08: a SKIPPED retry does not fire onRetrySpend — the exhausted attempt reports via onAgentEnd", async () => {
  const calls = { count: 0 };
  const retrySpends: AgentUsage[] = [];
  const ended: Array<{ result: unknown; errorCode?: unknown }> = [];
  await runWorkflow(
    `export const meta = { name: 'retry_guard_end', description: 'end surface' }
const value = await agent('work', { label: 'a', retries: 2, retryOnlyIfSpendUnder: 50 })
return value`,
    {
      agent: makeFailingAgent(calls),
      agentRetries: 2,
      retryBackoffMs: 0,
      persistLogs: false,
      onRetrySpend: (spend: AgentUsage) => retrySpends.push(spend),
      onAgentEnd: (info: { result: unknown; errorCode?: unknown }) => ended.push(info),
    },
  );
  assert.equal(calls.count, 1);
  assert.equal(retrySpends.length, 0, "a skipped retry never enters the onRetrySpend channel (it is not retried)");
  assert.equal(ended.length, 1, "the exhausted attempt still reports through onAgentEnd");
  assert.equal(ended[0].result, null);
  assert.equal(ended[0].errorCode, "AGENT_EMPTY_OUTPUT", "the underlying recoverable failure is surfaced unchanged");
});
