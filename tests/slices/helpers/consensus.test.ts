import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../../../src/workflow.js";

test("consensus: majority group above the threshold agrees", async () => {
  let n = 0;
  const panel = {
    async run(_p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      n++;
      return { verdict: n !== 1, reasoning: `vote ${n}` };
    },
  };
  const script = `export const meta = { name: 'k_maj', description: 'majority' }
return await consensus('the sky is blue', { panelists: 3 })`;
  const res = await runWorkflow<{
    agreed: boolean;
    verdict: boolean | null;
    count: number;
    total: number;
    rounds: number;
    omitted: number;
  }>(script, { agent: panel, persistLogs: false });

  assert.equal(res.result.agreed, true);
  assert.equal(res.result.verdict, true);
  assert.equal(res.result.count, 2, "the largest agreeing group covers 2 votes");
  assert.equal(res.result.total, 3);
  assert.equal(res.result.rounds, 1, "agreement reached in round 1");
  assert.equal(res.result.omitted, 0);
});

test("consensus: a recoverable-null vote shrinks the denominator (logged)", async () => {
  let n = 0;
  const panel = {
    async run(_p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      n++;
      if (n === 2) return null; // this panelist failed recoverably
      return { verdict: true };
    },
  };
  const script = `export const meta = { name: 'k_null', description: 'null vote' }
return await consensus('agree?', { panelists: 3 })`;
  const res = await runWorkflow<{
    agreed: boolean;
    count: number;
    total: number;
    omitted: number;
    votes: Array<{ verdict: boolean } | null>;
  }>(script, { agent: panel, persistLogs: false });

  assert.equal(res.result.agreed, true, "both surviving votes agree -> 2/2 clears the gate");
  assert.equal(res.result.count, 2);
  assert.equal(res.result.total, 2, "the null vote is omitted from the denominator");
  assert.equal(res.result.omitted, 1);
  assert.equal(res.result.votes.length, 3, "raw votes keep positional integrity");
  assert.equal(res.result.votes[1], null);
  assert.ok(
    res.logs.some((line) => line.includes("denominator shrinks to 2")),
    "the omission is logged",
  );
});

test("consensus: bounded rounds re-poll until the gate passes", async () => {
  let n = 0;
  const panel = {
    async run(_p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      n++;
      // Round 1: false, true, true -> 2/3 (< 0.9). Round 2: all true -> 3/3.
      return { verdict: n <= 3 ? n !== 1 : true };
    },
  };
  const script = `export const meta = { name: 'k_rounds', description: 'bounded rounds' }
return await consensus('agree?', { panelists: 3, rounds: 3, agreeThreshold: 0.9 })`;
  const res = await runWorkflow<{ agreed: boolean; count: number; total: number; rounds: number }>(script, {
    agent: panel,
    persistLogs: false,
  });

  assert.equal(res.result.agreed, true);
  assert.equal(res.result.rounds, 2, "round 2's unanimous poll clears the gate");
  assert.equal(res.result.count, 3);
  assert.equal(res.result.total, 3);
});

test("consensus: arbitrator decides after the round budget", async () => {
  let n = 0;
  const panel = {
    async run(prompt: string, o: { schema?: unknown }) {
      if (!o?.schema) return prompt; // the arbitrator's unschema'd call echoes
      n++;
      // Never unanimous: both rounds land 2/3, and the threshold is 1.0.
      return { verdict: n % 2 === 1 };
    },
  };
  const script = `export const meta = { name: 'k_arb', description: 'arbitration' }
const out = await consensus('split decision?', {
  panelists: 3,
  rounds: 2,
  agreeThreshold: 1,
  arbitrator: async (ctx) => agent('arbitrate: ' + ctx.question),
})
return out`;
  const res = await runWorkflow<{ agreed: boolean; rounds: number; arbitration: unknown }>(script, {
    agent: panel,
    persistLogs: false,
  });

  assert.equal(res.result.agreed, false, "the panel never reached the gate");
  assert.equal(res.result.rounds, 2, "both bounded rounds were spent");
  assert.match(String(res.result.arbitration), /arbitrate: split decision\?/);
});

test("consensus: no agreement and no arbitrator returns the disagreement honestly", async () => {
  let n = 0;
  const panel = {
    async run(_p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      n++;
      return { verdict: n % 2 === 1 };
    },
  };
  const script = `export const meta = { name: 'k_split', description: 'split panel' }
return await consensus('split?', { panelists: 3, rounds: 1, agreeThreshold: 1 })`;
  const res = await runWorkflow<{
    agreed: boolean;
    verdict: boolean | null;
    count: number;
    total: number;
    rounds: number;
    arbitration: unknown;
  }>(script, { agent: panel, persistLogs: false });

  assert.equal(res.result.agreed, false);
  assert.equal(res.result.verdict, null);
  assert.equal(res.result.count, 0);
  assert.equal(res.result.total, 3);
  assert.equal(res.result.rounds, 1);
  assert.equal(res.result.arbitration, undefined);
});

test("consensus: emits quality start/end runtime events", async () => {
  const yesAgent = {
    async run(_p: string, o: { schema?: unknown }) {
      return o?.schema ? { verdict: true } : "ok";
    },
  };
  const events: string[] = [];
  const script = `export const meta = { name: 'k_evt', description: 'events' }
return await consensus('yes?', { panelists: 2 })`;
  await runWorkflow(script, {
    agent: yesAgent,
    persistLogs: false,
    onRuntimeEvent: (event) => {
      if (event.type === "quality") events.push(`${event.helper}:${event.stage}`);
    },
  });

  assert.deepEqual(events, ["consensus:start", "consensus:end"]);
});

test("consensus: non-finite panelists throws a TypeError", async () => {
  const script = `export const meta = { name: 'k_ty', description: 'validation' }
return await consensus('q', { panelists: Infinity })`;
  await assert.rejects(
    runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      persistLogs: false,
    }),
    TypeError,
  );
});
