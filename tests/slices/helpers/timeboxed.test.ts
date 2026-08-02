import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../../../src/workflow.js";

const echoAgent = {
  async run(prompt: string) {
    return prompt;
  },
};

test("timeboxed: expiry returns partial results with timedOut true", async () => {
  const script = `export const meta = { name: 't_out', description: 'expiry' }
const out = await timeboxed(async (ctx) => {
  const partial = { done: 1, total: 3 }
  if (ctx.expired()) return partial // maxElapsedMs 0 -> already expired
  await agent('finish the rest')
  return { done: 3, total: 3 }
}, { maxElapsedMs: 0 })
return out`;
  const res = await runWorkflow<{
    result: { done: number; total: number };
    timedOut: boolean;
    elapsedMs: number;
    maxElapsedMs: number;
  }>(script, { agent: echoAgent, persistLogs: false });

  assert.equal(res.result.timedOut, true);
  assert.equal(res.result.result.done, 1, "fn returned its partial state on expiry");
  assert.equal(res.result.result.total, 3);
  assert.equal(res.result.maxElapsedMs, 0);
  assert.equal(res.result.elapsedMs >= 0, true);
  assert.equal(res.agentCount, 0, "the early-return path never spawned an agent");
});

test("timeboxed: a generous budget completes without timing out", async () => {
  const script = `export const meta = { name: 't_ok', description: 'within budget' }
const out = await timeboxed(async (ctx) => {
  const r = await agent('work')
  return { result: r, remainingNonNegative: ctx.remaining() >= 0 }
}, { maxElapsedMs: 60_000 })
return out`;
  const res = await runWorkflow<{ result: unknown; timedOut: boolean; remainingNonNegative: boolean }>(script, {
    agent: echoAgent,
    persistLogs: false,
  });

  assert.equal(res.result.timedOut, false);
  assert.equal(res.result.result.remainingNonNegative, true);
});

test("elapsedMs(): monotonic non-negative global, stable across the run", async () => {
  const script = `export const meta = { name: 'e_ms', description: 'elapsed' }
const a = elapsedMs()
await agent('work')
const b = elapsedMs()
return { a, b, monotonic: b >= a && a >= 0 }`;
  const res = await runWorkflow<{ a: number; b: number; monotonic: boolean }>(script, {
    agent: echoAgent,
    persistLogs: false,
  });

  assert.equal(res.result.monotonic, true);
});

test("timeboxed: non-finite maxElapsedMs throws a TypeError", async () => {
  const script = `export const meta = { name: 't_ty', description: 'validation' }
return await timeboxed(async () => 'done', { maxElapsedMs: Infinity })`;
  await assert.rejects(runWorkflow(script, { agent: echoAgent, persistLogs: false }), TypeError);
});
