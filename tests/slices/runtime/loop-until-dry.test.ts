import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../../../src/workflow.js";

const okAgent = {
  async run() {
    return "ok";
  },
};

type LoopResult = { items: unknown[]; termination: string; failedRounds: number };

test("M3: a null round is FAILED, never dry", async () => {
  const script = `export const meta = { name: 'l_failed', description: 'null round is failed' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [{ id: 'a' }]
    return null  // recoverable-exhausted agent round
  },
  consecutiveEmpty: 2,
})
return out`;

  const res = await runWorkflow<LoopResult>(script, { agent: okAgent, persistLogs: false });
  assert.deepEqual(
    Array.from(res.result.items as Array<{ id: string }>, ({ id }) => ({ id })),
    [{ id: "a" }],
    "partial items preserved",
  );
  assert.equal(res.result.termination, "failed", "a null round terminates as failed, NOT dry");
  assert.equal(res.result.failedRounds, 1);
});

test("M3: consecutive successful EMPTY rounds terminate as dry", async () => {
  const script = `export const meta = { name: 'l_dry', description: 'dry rounds' }
const out = await loopUntilDry({
  round: (r) => (r === 0 ? [1] : []),
  consecutiveEmpty: 2,
})
return out`;

  const res = await runWorkflow<LoopResult>(script, { agent: okAgent, persistLogs: false });
  assert.deepEqual([...res.result.items], [1]);
  assert.equal(res.result.termination, "dry");
  assert.equal(res.result.failedRounds, 0);
});

test("M3: hitting maxRounds reports maxRounds", async () => {
  const script = `export const meta = { name: 'l_cap', description: 'round cap' }
const out = await loopUntilDry({
  round: (r) => [r],
  maxRounds: 3,
})
return out`;

  const res = await runWorkflow<LoopResult>(script, { agent: okAgent, persistLogs: false });
  assert.deepEqual([...res.result.items], [0, 1, 2]);
  assert.equal(res.result.termination, "maxRounds");
});

test("M3: capacity exhaustion reports capacity with the partial items", async () => {
  const script = `export const meta = { name: 'l_capacity', description: 'budget hit' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return ['x']
    throw { code: 'TOKEN_BUDGET_EXHAUSTED' }
  },
})
return out`;

  const res = await runWorkflow<LoopResult>(script, { agent: okAgent, persistLogs: false });
  assert.deepEqual([...res.result.items], ["x"]);
  assert.equal(res.result.termination, "capacity");
});

test("L13: non-finite maxRounds/consecutiveEmpty throw a TypeError", async () => {
  for (const bad of [Infinity, NaN]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'l_nf', description: 'non-finite bound' }
return await loopUntilDry({ round: () => [], maxRounds: ${JSON.stringify(bad)} })`,
          { agent: okAgent, persistLogs: false },
        ),
      TypeError,
    );
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'l_nf2', description: 'non-finite bound' }
return await loopUntilDry({ round: () => [], consecutiveEmpty: ${JSON.stringify(bad)} })`,
          { agent: okAgent, persistLogs: false },
        ),
      TypeError,
    );
  }
});

test("L13: retry()/gate() reject non-finite attempts with a TypeError", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'r_nf', description: 'non-finite attempts' }
return await retry(() => 1, { attempts: Infinity })`,
        { agent: okAgent, persistLogs: false },
      ),
    TypeError,
  );
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'g_nf', description: 'non-finite attempts' }
return await gate(() => 1, () => ({ ok: true }), { attempts: NaN })`,
        { agent: okAgent, persistLogs: false },
      ),
    TypeError,
  );
});

test("L13: fractional bounds are floored and clamped", async () => {
  const script = `export const meta = { name: 'l_floor', description: 'floor bounds' }
const out = await loopUntilDry({ round: (r) => (r === 0 ? [1] : []), consecutiveEmpty: 1.9, maxRounds: 1.9 })
return out`;
  const res = await runWorkflow<LoopResult>(script, { agent: okAgent, persistLogs: false });
  assert.deepEqual([...res.result.items], [1], "maxRounds 1.9 floors to 1");
});
