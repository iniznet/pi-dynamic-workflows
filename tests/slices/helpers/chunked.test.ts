import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowErrorCode } from "../../../src/errors.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";

// Echo agent returns the prompt so tests can inspect what each chunk call saw.
const echoAgent = {
  async run(prompt: string) {
    return prompt;
  },
};

test("chunked: partitions by chunkSize and preserves order", async () => {
  const script = `export const meta = { name: 'c_part', description: 'partitioning' }
const out = await chunked([1, 2, 3, 4, 5, 6, 7], {
  chunkSize: 3,
  mapper: async (chunk, index) => ({ index, chunk, text: await agent('chunk ' + index + ': ' + JSON.stringify(chunk)) }),
})
return out`;
  const res = await runWorkflow<{
    results: Array<{ index: number; chunk: number[]; text: string } | null>;
    failed: unknown[];
    chunkCount: number;
  }>(script, { agent: echoAgent, persistLogs: false });

  assert.equal(res.result.chunkCount, 3);
  assert.deepEqual(
    Array.from(res.result.results, (r) => (r ? [r.index, Array.from(r.chunk)] : null)),
    [
      [0, [1, 2, 3]],
      [1, [4, 5, 6]],
      [2, [7]],
    ],
  );
  assert.equal(res.result.failed.length, 0);
  // The agent prompt embeds chunk content + chunkIndex — the resume-hash material.
  assert.equal(res.result.results[0]?.text, "chunk 0: [1,2,3]");
});

test("chunked: recoverable-null chunk results stay in results and are listed in failed", async () => {
  let n = 0;
  const flaky = {
    async run() {
      n++;
      if (n === 2) return null; // chunk 1's work failed recoverably
      return "ok";
    },
  };
  const script = `export const meta = { name: 'c_fail', description: 'failed chunk' }
const out = await chunked(['a', 'b', 'c', 'd', 'e'], {
  chunkSize: 2,
  mapper: async (chunk) => agent('work ' + JSON.stringify(chunk)),
})
return out`;
  const res = await runWorkflow<{
    results: Array<string | null>;
    failed: Array<{ index: number; chunk: string[] }>;
    chunkCount: number;
  }>(script, { agent: flaky, persistLogs: false });

  assert.deepEqual(Array.from(res.result.results), ["ok", null, "ok"], "null stays in place for positional integrity");
  assert.deepEqual(
    Array.from(res.result.failed, ({ index, chunk }) => ({ index, chunk: Array.from(chunk) })),
    [{ index: 1, chunk: ["c", "d"] }],
    "failed records the stable index + chunk",
  );
  assert.equal(res.result.chunkCount, 3);
});

test("chunked: a plain mapper error rethrows instead of becoming a null (M2 semantics)", async () => {
  const script = `export const meta = { name: 'c_bug', description: 'mapper bug' }
const out = await chunked([1, 2, 3, 4], {
  chunkSize: 2,
  mapper: async (chunk, index) => {
    if (index === 1) throw new Error('mapper boom')
    return agent('work ' + index)
  },
})
return out`;
  await assert.rejects(runWorkflow(script, { agent: echoAgent, persistLogs: false }), /mapper boom/);
});

test("chunked: non-recoverable budget exhaustion rethrows", async () => {
  const script = `export const meta = { name: 'c_budget', description: 'budget' }
return await chunked([1, 2], {
  chunkSize: 1,
  mapper: async (chunk) => agent('work ' + JSON.stringify(chunk)),
})`;
  await assert.rejects(
    runWorkflow(script, { agent: echoAgent, persistLogs: false, tokenBudget: 0 }),
    (error: unknown) => (error as { code?: string }).code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
  );
});

test("chunked: synthesizer output replaces the default result shape", async () => {
  const script = `export const meta = { name: 'c_synth', description: 'synthesizer' }
const out = await chunked([1, 2, 3, 4, 5], {
  chunkSize: 2,
  mapper: async (chunk, index) => ({ index, count: chunk.length }),
  synthesizer: async (results, meta) => ({
    total: results.reduce((sum, r) => sum + r.count, 0),
    chunkCount: meta.chunkCount,
    failedCount: meta.failed.length,
  }),
})
return out`;
  const res = await runWorkflow<{ total: number; chunkCount: number; failedCount: number }>(script, {
    agent: echoAgent,
    persistLogs: false,
  });

  assert.equal(res.result.total, 5);
  assert.equal(res.result.chunkCount, 3);
  assert.equal(res.result.failedCount, 0);
});

test("chunked: empty items produce zero chunks and no agent calls", async () => {
  const script = `export const meta = { name: 'c_empty', description: 'empty' }
return await chunked([], { chunkSize: 4, mapper: async (chunk, index) => agent('x ' + index) })`;
  const res = await runWorkflow<{ results: unknown[]; failed: unknown[]; chunkCount: number }>(script, {
    agent: echoAgent,
    persistLogs: false,
  });

  assert.equal(res.result.results.length, 0);
  assert.equal(res.result.failed.length, 0);
  assert.equal(res.result.chunkCount, 0);
  assert.equal(res.agentCount, 0);
});

test("chunked: non-finite chunkSize throws a TypeError", async () => {
  const script = `export const meta = { name: 'c_ty', description: 'chunkSize validation' }
return await chunked([1, 2, 3], { chunkSize: Infinity, mapper: async (chunk, index) => agent('x') })`;
  await assert.rejects(runWorkflow(script, { agent: echoAgent, persistLogs: false }), TypeError);
});

test("chunked: per-chunk hashes depend only on chunk content + stable index (resume-friendly)", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const RUN_ID = "chunked-resume";
  const journal = new Map<string, JournalEntry>();
  const makeScript = (items: string) => `export const meta = { name: 'c_resume', description: 'resume' }
return await chunked(${items}, {
  chunkSize: 3,
  mapper: async (chunk, index) => agent('summarize ' + index + ' ' + JSON.stringify(chunk)),
})`;
  const base = {
    agent,
    persistLogs: false,
    runId: RUN_ID,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  };

  await runWorkflow(makeScript("[1, 2, 3, 4, 5, 6, 7]"), base);
  assert.equal(calls, 3, "first run executes one agent per chunk");

  await runWorkflow(makeScript("[1, 2, 3, 4, 5, 6, 7]"), { ...base, resumeJournal: journal });
  assert.equal(calls, 3, "identical items + chunkSize replay every chunk from the journal");

  // Appending an item changes only the last chunk ([7] -> [7,8]): the last
  // chunk's hash misses and re-executes; the first two chunks still replay.
  await runWorkflow(makeScript("[1, 2, 3, 4, 5, 6, 7, 8]"), { ...base, resumeJournal: journal });
  assert.equal(calls, 4, "only the changed last chunk re-executes on resume");
});
