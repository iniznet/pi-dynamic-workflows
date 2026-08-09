import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow } from "../src/workflow.js";

// Fake agents return a schema-shaped object when a schema is requested.
const yesAgent = {
  async run(_p: string, o?: { schema?: unknown }) {
    return o?.schema ? { real: true } : "ok";
  },
};

test("verify(): parallel reviewers + threshold → real", async () => {
  const script = `export const meta = { name: 'v', description: 'verify' }
const r = await verify('the sky is blue', { reviewers: 3 })
return r`;
  const res = await runWorkflow<{ real: boolean; total: number }>(script, { agent: yesAgent, persistLogs: false });
  assert.equal(res.result.real, true);
  assert.equal(res.result.total, 3, "all three reviewers voted");
});

test("verify(): below threshold → not real", async () => {
  // 1 yes / 2 no with threshold 0.75 → not real.
  let n = 0;
  const mixed = {
    async run(_p: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      n++;
      return { real: n === 1 };
    },
  };
  const script = `export const meta = { name: 'v', description: 'verify' }
return await verify('claim', { reviewers: 3, threshold: 0.75 })`;
  const res = await runWorkflow<{ real: boolean; realCount: number }>(script, { agent: mixed, persistLogs: false });
  assert.equal(res.result.realCount, 1);
  assert.equal(res.result.real, false);
});

test("verify(): options control lenses and successful votes form the denominator", async () => {
  const prompts: string[] = [];
  let call = 0;
  const reviewers = {
    async run(prompt: string) {
      prompts.push(prompt);
      call++;
      if (call === 3) {
        throw new Error("review unavailable");
      }
      return { real: call === 1, reason: `vote-${call}` };
    },
  };
  const script = `export const meta = { name: 'verify_contract', description: 'exact verify contract' }
return await verify('claim', { reviewers: 3, threshold: 0.5, lens: ['source', 'logic'] })`;
  const res = await runWorkflow<{
    real: boolean;
    realCount: number;
    total: number;
    votes: Array<{ real: boolean; reason: string }>;
  }>(script, { agent: reviewers, persistLogs: false });

  assert.equal(res.result.real, true, "one of two successful votes meets the inclusive 0.5 threshold");
  assert.equal(res.result.realCount, 1);
  assert.equal(res.result.total, 2, "failed reviewers are omitted from the denominator");
  assert.deepEqual(
    Array.from(res.result.votes, ({ real, reason }) => ({ real, reason })),
    [
      { real: true, reason: "vote-1" },
      { real: false, reason: "vote-2" },
    ],
  );
  assert.match(prompts[0] ?? "", /Focus lens: source/);
  assert.match(prompts[1] ?? "", /Focus lens: logic/);
  assert.match(prompts[2] ?? "", /Focus lens: source/);
});

test("judgePanel(): picks the highest-mean-score attempt", async () => {
  const scorer = {
    async run(p: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      return { score: /WIN/.test(p) ? 0.9 : 0.1 };
    },
  };
  const script = `export const meta = { name: 'j', description: 'judge' }
const r = await judgePanel(['lose one', 'WIN candidate', 'lose two'], { judges: 2 })
return { index: r.index, score: r.score }`;
  const res = await runWorkflow<{ index: number; score: number }>(script, { agent: scorer, persistLogs: false });
  assert.equal(res.result.index, 1, "the WIN candidate wins");
});

test("judgePanel(): returns the exact winner shape, stable ties, and undefined for empty input", async () => {
  const prompts: string[] = [];
  const scorer = {
    async run(prompt: string) {
      prompts.push(prompt);
      return { score: 0.5, reason: "tie" };
    },
  };
  const script = `export const meta = { name: 'judge_contract', description: 'exact judge contract' }
const winner = await judgePanel(['first', 'second'], { judges: 2, rubric: 'source quality' })
const empty = await judgePanel([])
return { winner, empty: empty ?? null }`;
  const res = await runWorkflow<{
    winner: { index: number; attempt: string; score: number; judgments: Array<{ score: number }> };
    empty: null;
  }>(script, { agent: scorer, persistLogs: false });

  assert.equal(prompts.length, 4);
  assert.ok(prompts.every((prompt) => prompt.includes("source quality")));
  assert.equal(res.result.winner.index, 0);
  assert.equal(res.result.winner.attempt, "first");
  assert.equal(res.result.winner.score, 0.5);
  assert.equal(res.result.winner.judgments.length, 2);
  assert.equal(res.result.empty, null);
});

test("loopUntilDry(): dedupes by key and stops after K empty rounds", async () => {
  const script = `export const meta = { name: 'l', description: 'loop' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1, 2]
    if (r === 1) return [2, 3]
    return []
  },
  consecutiveEmpty: 2,
})
return out`;
  const res = await runWorkflow<{ items: number[]; termination: string; failedRounds: number }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.deepEqual([...res.result.items], [1, 2, 3], "deduped union across rounds");
  assert.equal(res.result.termination, "dry", "two consecutive successful empty rounds end the loop as dry");
  assert.equal(res.result.failedRounds, 0);
});

test("loopUntilDry(): returns partial results when a round hits the budget", async () => {
  const script = `export const meta = { name: 'lp', description: 'loop partial' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1]
    throw { code: 'TOKEN_BUDGET_EXHAUSTED' }
  },
})
return out`;
  const res = await runWorkflow<{ items: number[]; termination: string; failedRounds: number }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.deepEqual([...res.result.items], [1], "partial result returned, not an abort");
  assert.equal(res.result.termination, "capacity", "budget exhaustion reports capacity, not dryness");
});

test("loopUntilDry(): returns indistinguishable partial data for capacity exhaustion", async () => {
  for (const code of ["TOKEN_BUDGET_EXHAUSTED", "AGENT_LIMIT_EXCEEDED"]) {
    const script = `export const meta = { name: 'loop_capacity', description: 'partial capacity result' }
return await loopUntilDry({
  round: (index) => {
    if (index === 0) return [{ id: 'alpha' }]
    throw { code: '${code}' }
  },
  maxRounds: 4,
})`;
    const res = await runWorkflow<{ items: Array<{ id: string }>; termination: string }>(script, {
      agent: yesAgent,
      persistLogs: false,
    });
    assert.deepEqual(
      Array.from(res.result.items, ({ id }) => ({ id })),
      [{ id: "alpha" }],
    );
    assert.equal(res.result.termination, "capacity");
  }

  await assert.rejects(() =>
    runWorkflow(
      `export const meta = { name: 'loop_error', description: 'unrelated errors escape' }
return await loopUntilDry({ round: () => { throw new Error('author bug') } })`,
      { agent: yesAgent, persistLogs: false },
    ),
  );
});

test("completenessCheck(): returns the critic's structured verdict", async () => {
  const critic = {
    async run(_p: string, o?: { schema?: unknown }) {
      return o?.schema ? { complete: false, missing: ["x"] } : "ok";
    },
  };
  const script = `export const meta = { name: 'c', description: 'critic' }
return await completenessCheck({ task: 1 }, [{ done: true }])`;
  const res = await runWorkflow<{ complete: boolean; missing: string[] }>(script, {
    agent: critic,
    persistLogs: false,
  });
  assert.equal(res.result.complete, false);
  assert.deepEqual([...res.result.missing], ["x"]);
});

test("completenessCheck(): truncates result evidence and can return null", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const critic = {
    async run(prompt: string) {
      prompts.push(prompt);
      calls++;
      if (calls === 2) {
        throw new Error("critic unavailable");
      }
      return { complete: true };
    },
  };
  const script = `export const meta = { name: 'critic_contract', description: 'exact critic contract' }
const first = await completenessCheck({ taskMarker: 'TASK-TAIL' }, { head: '${"x".repeat(4100)}', tail: 'RESULT-TAIL' })
const second = await completenessCheck({ taskMarker: 'TASK-TAIL' }, { small: true })
return { first, second }`;
  const res = await runWorkflow<{ first: { complete: boolean; missing?: string[] }; second: null }>(script, {
    agent: critic,
    persistLogs: false,
  });

  assert.equal(res.result.first.complete, true);
  assert.equal(res.result.first.missing, undefined);
  assert.equal(res.result.second, null);
  assert.match(prompts[0] ?? "", /TASK-TAIL/);
  assert.doesNotMatch(prompts[0] ?? "", /RESULT-TAIL/);
});

test("retry(): stops when until() is satisfied, else returns the last after exhausting", async () => {
  const script = `export const meta = { name: 'r', description: 'retry' }
let n = 0
const ok = await retry(() => { n++; return n }, { until: (r) => r >= 2, attempts: 5 })
let m = 0
const ex = await retry(() => { m++; return m }, { until: (r) => r > 99, attempts: 3 })
return { ok, n, ex, m }`;
  const res = await runWorkflow<{ ok: number; n: number; ex: number; m: number }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.equal(res.result.ok, 2, "stopped as soon as until() held");
  assert.equal(res.result.n, 2);
  assert.equal(res.result.ex, 3, "returned the last result after exhausting attempts");
  assert.equal(res.result.m, 3);
});

test("retry(): uses zero-based attempts, accepts immediately without until, and does not await until", async () => {
  const script = `export const meta = { name: 'retry_contract', description: 'exact retry contract' }
const omittedSeen = []
const omitted = await retry((attempt) => { omittedSeen.push(attempt); return attempt }, { attempts: 3 })
const syncSeen = []
const sync = await retry((attempt) => { syncSeen.push(attempt); return attempt }, { attempts: 3, until: value => value === 1 })
const asyncSeen = []
const asyncPredicate = await retry((attempt) => { asyncSeen.push(attempt); return attempt }, { attempts: 3, until: async () => false })
return { omitted, omittedSeen, sync, syncSeen, asyncPredicate, asyncSeen }`;
  const res = await runWorkflow<{
    omitted: number;
    omittedSeen: number[];
    sync: number;
    syncSeen: number[];
    asyncPredicate: number;
    asyncSeen: number[];
  }>(script, { agent: yesAgent, persistLogs: false });

  assert.equal(res.result.omitted, 0);
  assert.deepEqual([...res.result.omittedSeen], [0]);
  assert.equal(res.result.sync, 1);
  assert.deepEqual([...res.result.syncSeen], [0, 1]);
  assert.equal(res.result.asyncPredicate, 0, "a Promise is truthy because until is synchronous");
  assert.deepEqual([...res.result.asyncSeen], [0]);
});

test("gate(): passes the validator and feeds feedback into the next attempt", async () => {
  const script = `export const meta = { name: 'g', description: 'gate' }
const seen = []
const res = await gate(
  (feedback, i) => { seen.push(feedback ?? 'none'); return i },
  (r) => (r >= 1 ? { ok: true } : { ok: false, feedback: 'try higher' }),
  { attempts: 3 },
)
const legacyTruthy = await gate(() => 'legacy', () => ({ ok: 1 }), { attempts: 2 })
return { ok: res.ok, value: res.value, attempts: res.attempts, seen, legacyTruthy }`;
  const res = await runWorkflow<{
    ok: boolean;
    value: number;
    attempts: number;
    seen: string[];
    legacyTruthy: { ok: boolean; value: string; attempts: number };
  }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.value, 1);
  assert.equal(res.result.attempts, 2);
  assert.deepEqual([...res.result.seen], ["none", "try higher"], "validator feedback is fed into the next attempt");
  assert.deepEqual(
    { ...res.result.legacyTruthy },
    { ok: true, value: "legacy", attempts: 1 },
    "legacy truthy validator verdicts remain accepted",
  );
});

// ─── T1-08: quality-helper votes carry toolNames: [] (schema tool only) ───────

test("quality-helper votes pass toolNames: [] while default agents keep the full toolset (T1-08)", async () => {
  const seenToolNames: Array<string[] | undefined> = [];
  const capturing = {
    async run(_p: string, o?: { schema?: unknown; toolNames?: string[] }) {
      seenToolNames.push(o?.toolNames);
      if (o?.schema) return { real: true, score: 1, verdict: true, complete: true, key: "a" } as never;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'toolset_resolution', description: 'T1-08 toolset resolution' }
await agent('plain', { label: 'plain' })
await agent('restricted', { label: 'restricted', toolNames: ['read'] })
await verify('claim', { reviewers: 1 })
await judgePanel(['candidate'], { judges: 1 })
await consensus('statement', { panelists: 1, rounds: 1 })
await completenessCheck({ task: 1 }, [{ done: true }])
await route({ kind: 'x' }, { cases: [{ key: 'a', run: () => 'ran' }], fallback: () => 'fb' })
return {}`;
  await runWorkflow(script, { agent: capturing, persistLogs: false });

  // agent() with no toolNames → undefined (full toolset); explicit list forwarded as-is.
  assert.equal(seenToolNames[0], undefined, "default agent keeps the full toolset");
  assert.deepEqual([...(seenToolNames[1] ?? [])], ["read"], "explicit per-call toolNames forwarded to the runner");
  // Every quality-helper vote restricts to the schema tool only (structured_output auto-added).
  for (let i = 2; i < seenToolNames.length; i++) {
    assert.deepEqual(seenToolNames[i], [], `quality-helper vote ${i} must pass toolNames: []`);
  }
});

// ─── T1-03: capEmbedded — boundary, marker, and log line ──────────────────────

test("verify() maxChars caps the embedded claim with an ellipsis marker and a log line (T1-03)", async () => {
  const prompts: string[] = [];
  const critic = {
    async run(prompt: string, o?: { schema?: unknown }) {
      prompts.push(prompt);
      return o?.schema ? { real: true } : "ok";
    },
  };
  const longClaim = "x".repeat(4500);
  const script = `export const meta = { name: 'cap_embedded', description: 'T1-03 cap' }
const capped = await verify('${longClaim}', { reviewers: 1, maxChars: 4000 })
const tail = await verify('TAIL-CLAIM', { reviewers: 1, maxChars: 4000 })
return { capped, tail }`;
  const res = await runWorkflow<{ capped: { real: boolean }; tail: { real: boolean } }>(script, {
    agent: critic,
    persistLogs: false,
  });
  assert.equal(res.result.capped.real, true);
  assert.equal(res.result.tail.real, true);
  // The long claim is sliced to 4000 chars + a one-char ellipsis marker; the
  // short claim passes through byte-identical (no marker).
  assert.match(prompts[0] ?? "", /…$/);
  assert.ok((prompts[0] ?? "").includes("x".repeat(4000)), "the first 4000 claim chars survive");
  assert.doesNotMatch(prompts[0] ?? "", /x{4500}/, "the claim tail beyond 4000 chars is cut");
  assert.doesNotMatch(prompts[1] ?? "", /…$/);
  assert.ok((prompts[1] ?? "").includes("TAIL-CLAIM"));
  assert.ok(
    res.logs.some((l) => l.includes("embedded payload capped at 4000 chars") && l.includes("4500")),
    "the truncation must be logged, never silent",
  );
});

test("judgePanel() and consensus() cap oversized embedded payloads at the default 4000 chars (T1-03)", async () => {
  const prompts: string[] = [];
  const scorer = {
    async run(prompt: string, o?: { schema?: unknown }) {
      prompts.push(prompt);
      return o?.schema ? { score: 0.5, verdict: true } : "ok";
    },
  };
  const big = "y".repeat(4100);
  const script = `export const meta = { name: 'cap_default', description: 'T1-03 default caps' }
const w = await judgePanel(['${big}'], { judges: 1 })
const c = await consensus('statement ${big} tail', { panelists: 1, rounds: 1 })
return { w, c }`;
  const res = await runWorkflow<{ w: { index: number }; c: { agreed: boolean } }>(script, {
    agent: scorer,
    persistLogs: false,
  });
  assert.equal(res.result.w.index, 0);
  assert.equal(res.result.c.agreed, true);
  assert.match(prompts[0] ?? "", /…$/);
  assert.match(prompts[1] ?? "", /…$/);
  assert.ok(
    res.logs.some((l) => l.includes("embedded payload capped at 4000 chars")),
    "default-cap truncations must be logged",
  );
});

// ─── T2-04: quality helpers bind votes to an economy tier ─────────────────────

test("T2-04: verify/judgePanel/consensus/completenessCheck/route default their votes to tier small", async () => {
  const tiers: Array<string | undefined> = [];
  const capturing = {
    async run(_p: string, o?: { schema?: unknown; tier?: string }) {
      if (o?.schema) tiers.push(o.tier);
      return o?.schema ? { real: true, score: 0.9, verdict: true, key: "a" } : "ok";
    },
  };
  const script = `export const meta = { name: 't4', description: 'helper tiers' }
const v = await verify('claim', { reviewers: 2 })
const j = await judgePanel(['candidate'], { judges: 1 })
const c = await consensus('statement', { panelists: 1, rounds: 1 })
const cc = await completenessCheck({ task: 1 }, [{ done: true }])
const r = await route({ kind: 'x' }, { cases: [{ key: 'a', run: () => 'ran' }], fallback: () => 'fb' })
return { v, j, c, cc, r }`;
  await runWorkflow(script, { agent: capturing, persistLogs: false });
  assert.ok(tiers.length >= 6, `expected >=6 tiered votes, got ${tiers.length}`);
  assert.ok(
    tiers.every((t) => t === "small"),
    `every helper vote defaults to the economy tier, got: ${JSON.stringify(tiers)}`,
  );
});

test("T2-04: opts.tier passthrough overrides the helper economy default", async () => {
  const tiers: Array<string | undefined> = [];
  const capturing = {
    async run(_p: string, o?: { schema?: unknown; tier?: string }) {
      if (o?.schema) tiers.push(o.tier);
      return o?.schema ? { real: true, score: 0.9, verdict: true, key: "a" } : "ok";
    },
  };
  const script = `export const meta = { name: 't4b', description: 'helper tier override' }
const v = await verify('claim', { reviewers: 1, tier: 'medium' })
const j = await judgePanel(['candidate'], { judges: 1, tier: 'big' })
const c = await consensus('statement', { panelists: 1, rounds: 1, tier: 'medium' })
const r = await route({ kind: 'x' }, { cases: [{ key: 'a', run: () => 'ran' }], fallback: () => 'fb', tier: 'big' })
return { v, j, c, r }`;
  await runWorkflow(script, { agent: capturing, persistLogs: false });
  assert.deepEqual(tiers, ["medium", "big", "medium", "big"], "opts.tier must win over the small default");
});

test("T2-04: a tiered vote that hits the schema wall still yields null, never a run failure", async () => {
  let call = 0;
  const reviewer = {
    async run(_p: string, o?: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      call++;
      if (call === 1) {
        throw new WorkflowError("vote could not produce valid output", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
          recoverable: false,
        });
      }
      return { real: true };
    },
  };
  const script = `export const meta = { name: 't4c', description: 'helper tier tolerance' }
return await verify('claim', { reviewers: 2, tier: 'small' })`;
  const res = await runWorkflow<{ real: boolean; total: number }>(script, { agent: reviewer, persistLogs: false });
  assert.equal(res.result.total, 1, "the SCHEMA_NONCOMPLIANCE vote is omitted from the denominator");
  assert.equal(res.result.real, true, "the surviving vote still decides");
});
