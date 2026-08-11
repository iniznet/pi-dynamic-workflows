import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../../../src/agent.js";
import { WorkflowErrorCode } from "../../../src/errors.js";
import { type JournalEntry, runWorkflow } from "../../../src/workflow.js";
import { formatCompletedResultText } from "../../../src/workflow-tool.js";

/** Fake runner that reports a fixed usage via onUsage (drives shared.spent). */
function spendingAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const okAgent = {
  async run(_prompt: string, _options?: unknown) {
    return "ok";
  },
};

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── N05: concurrency knob ───────────────────────────────────────────────────

test("N05: parallel({ concurrency }) invokes at most N thunks concurrently and preserves input order", async () => {
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const release = createDeferred<void>();
  const runner = {
    async run(prompt: string) {
      started.push(prompt);
      active++;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'n05_conc', description: 'fanout concurrency' }
const xs = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('t' + i, { label: 't' + i })), { concurrency: 3, autoApproved: true })
return xs`;

  const run = runWorkflow(script, { agent: runner, persistLogs: false });
  // Give the pool time to over-invoke if the knob were ignored.
  while (started.length < 3) await sleep(0);
  await sleep(20);
  assert.equal(started.length, 3, "exactly 3 thunks are invoked with concurrency 3");
  release.resolve();
  const res = await run;
  assert.equal(maxActive, 3);
  assert.deepEqual(
    res.result,
    Array.from({ length: 10 }, (_, i) => `ok:t${i}`),
    "input order is preserved",
  );
});

test("N05: pipeline({ concurrency }) caps concurrent item processing", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'n05_pipe', description: 'pipeline concurrency' }
const xs = await pipeline(
  Array.from({ length: 9 }, (_, i) => i),
  (n) => agent('p' + n, { label: 'p' + n }),
  { concurrency: 2, autoApproved: true },
)
return xs`;

  const run = runWorkflow(script, { agent: runner, persistLogs: false });
  while (maxActive < 2) await sleep(0);
  await sleep(20);
  assert.equal(maxActive, 2, "at most 2 items in flight with pipeline concurrency 2");
  release.resolve();
  const res = await run;
  assert.deepEqual(
    res.result,
    Array.from({ length: 9 }, (_, i) => `ok:p${i}`),
    "pipeline order preserved",
  );
});

test("N05: concurrency is scheduling-only — journal hashes are identical across knob values", async () => {
  const script = (concurrency: number) => `export const meta = { name: 'n05_hash', description: 'hash stable' }
const xs = await parallel(
  Array.from({ length: 10 }, (_, i) => () => agent('h' + i, { label: 'h' + i })),
  { concurrency: ${concurrency}, autoApproved: true },
)
return xs`;

  const hashesOf = async (concurrency: number) => {
    const journal: JournalEntry[] = [];
    await runWorkflow(script(concurrency), {
      agent: okAgent,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    });
    return journal.map((entry) => entry.hash).sort();
  };

  const a = await hashesOf(2);
  const b = await hashesOf(5);
  assert.equal(a.length, 10);
  assert.deepEqual(a, b, "a resume with a different concurrency replays the same cached calls");
});

test("N05: fan-out concurrency default does not change the run limiter's cap (16 invokes, limiter still gates)", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'n05_default', description: 'default fanout conc' }
const xs = await parallel(Array.from({ length: 6 }, (_, i) => () => agent('d' + i, { label: 'd' + i })), { autoApproved: true })
return xs`;
  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (maxActive < 2) await sleep(0);
  await sleep(20);
  assert.equal(maxActive, 2, "run-level concurrency (2) still caps real agent parallelism");
  release.resolve();
  const res = await run;
  assert.deepEqual(res.result, ["ok:d0", "ok:d1", "ok:d2", "ok:d3", "ok:d4", "ok:d5"]);
});

// ─── N03: loopUntilDry maxRoundCost ──────────────────────────────────────────

test("N03: a zero-new-items round whose spend exceeds maxRoundCost terminates costSaturated", async () => {
  // Each round burns 2 tokens (2 agents x 1 token); maxRoundCost 1 → round 1
  // (zero new items) saturates immediately instead of grinding to dry.
  const script = `export const meta = { name: 'n03_sat', description: 'cost saturation' }
const out = await loopUntilDry({
  round: async (r) => {
    await agent('r' + r + 'a', { label: 'burn' });
    await agent('r' + r + 'b', { label: 'burn' });
    return ['item'];
  },
  maxRoundCost: 1,
  maxRounds: 50,
})
return out`;
  const res = await runWorkflow<{ items: unknown[]; termination: string; failedRounds: number }>(script, {
    agent: spendingAgent({ total: 1 }),
    persistLogs: false,
  });
  assert.deepEqual(res.result.items, ["item"], "round 0's item is kept");
  assert.equal(res.result.termination, "costSaturated");
  assert.equal(res.result.failedRounds, 0);
});

test("N03: below maxRoundCost keeps the existing dry termination", async () => {
  const script = `export const meta = { name: 'n03_dry', description: 'below cost cap' }
const out = await loopUntilDry({
  round: async (r) => {
    await agent('r' + r, { label: 'burn' });
    return ['item'];
  },
  maxRoundCost: 100,
  consecutiveEmpty: 2,
  maxRounds: 50,
})
return out`;
  const res = await runWorkflow<{ items: unknown[]; termination: string }>(script, {
    agent: spendingAgent({ total: 1 }),
    persistLogs: false,
  });
  assert.deepEqual(res.result.items, ["item"]);
  assert.equal(res.result.termination, "dry", "a cheap zero-new round still counts toward consecutiveEmpty");
});

test("N03: a round that produces new items never saturates, even over the cap", async () => {
  const script = `export const meta = { name: 'n03_new', description: 'new items win' }
const out = await loopUntilDry({
  round: async (r) => {
    await agent('r' + r + 'a', { label: 'burn' });
    await agent('r' + r + 'b', { label: 'burn' });
    return r < 2 ? ['item' + r] : [];
  },
  maxRoundCost: 1,
  maxRounds: 50,
})
return out`;
  const res = await runWorkflow<{ items: string[]; termination: string }>(script, {
    agent: spendingAgent({ total: 1 }),
    persistLogs: false,
  });
  assert.deepEqual(res.result.items, ["item0", "item1"], "round 1 produced item1 despite overspending");
  assert.equal(res.result.termination, "costSaturated", "round 2 (zero new, overspent) saturates");
});

// ─── P12: large fan-out approval gate ────────────────────────────────────────

const NINE_ITEM_SCRIPT = (
  extraOptions: string,
) => `export const meta = { name: 'p12_gate', description: 'fanout approval' }
const xs = await parallel(Array.from({ length: 9 }, (_, i) => () => agent('g' + i, { label: 'g' + i }))${extraOptions})
return xs`;

test("P12: TUI-confirm run pauses for approval and proceeds when approved", async () => {
  const prompts: string[] = [];
  const res = await runWorkflow<unknown[]>(NINE_ITEM_SCRIPT(", { autoApproved: false }"), {
    agent: okAgent,
    persistLogs: false,
    confirm: async (promptText: string) => {
      prompts.push(promptText);
      return true;
    },
  });
  assert.equal(res.result?.length, 9, "approved fan-out runs");
  assert.equal(prompts.length, 1, "the gate paused exactly once");
  assert.match(prompts[0], /9 items/, "the plan shows the item count");
  assert.match(prompts[0], /threshold \(8\)/, "the plan shows the threshold");
});

test("P12: TUI-confirm denial throws WORKFLOW_ABORTED before any agent runs", async () => {
  let agentRuns = 0;
  const runner = {
    async run(prompt: string) {
      agentRuns++;
      return `ok:${prompt}`;
    },
  };
  await assert.rejects(
    () =>
      runWorkflow(NINE_ITEM_SCRIPT(""), {
        agent: runner,
        persistLogs: false,
        confirm: async () => false,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    },
  );
  assert.equal(agentRuns, 0, "no agent ran after a denied fan-out");
});

test("P12: headless big fan-out aborts with WORKFLOW_ABORTED (never pauses)", async () => {
  // No confirm threaded → the checkpoint's headless="abort" branch throws
  // WORKFLOW_ABORTED before any human reply could exist.
  await assert.rejects(
    () =>
      runWorkflow(NINE_ITEM_SCRIPT(""), {
        agent: okAgent,
        persistLogs: false,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    },
  );
});

test("P12: autoApproved: true skips the gate for deliberate headless automations", async () => {
  const res = await runWorkflow<unknown[]>(NINE_ITEM_SCRIPT(", { autoApproved: true }"), {
    agent: okAgent,
    persistLogs: false,
  });
  assert.equal(res.result?.length, 9, "autoApproved big fan-out runs headless without a pause");
});

test("P12: small fan-outs (at or under the threshold) never pause", async () => {
  let confirmCalls = 0;
  const script = `export const meta = { name: 'p12_small', description: 'small fanout' }
const xs = await parallel(Array.from({ length: 8 }, (_, i) => () => agent('s' + i, { label: 's' + i })))
return xs`;
  const res = await runWorkflow<unknown[]>(script, {
    agent: okAgent,
    persistLogs: false,
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(res.result?.length, 8);
  assert.equal(confirmCalls, 0, "an 8-item fan-out equals the threshold — no approval pause");
});

test("P12: a null run threshold disables the gate (existing headless automations)", async () => {
  const res = await runWorkflow<unknown[]>(NINE_ITEM_SCRIPT(""), {
    agent: okAgent,
    persistLogs: false,
    fanOutApprovalThreshold: null,
  });
  assert.equal(res.result?.length, 9, "a disabled gate never aborts a headless big fan-out");
});

test("P12: pipeline() big fan-out gates the same way (headless abort)", async () => {
  const script = `export const meta = { name: 'p12_pipe', description: 'pipeline gate' }
const xs = await pipeline(Array.from({ length: 9 }, (_, i) => i), (n) => agent('q' + n, { label: 'q' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: okAgent,
        persistLogs: false,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    },
  );
});

test("P12: the approval reply is journaled — a resumed run replays it without re-asking", async () => {
  // First run: human approves; the checkpoint reply journals at callIndex 0
  // (runId fixed so the resume resolves the same journal namespace).
  const journal: JournalEntry[] = [];
  const res1 = await runWorkflow<unknown[]>(NINE_ITEM_SCRIPT(", { autoApproved: false }"), {
    agent: okAgent,
    persistLogs: false,
    runId: "p12-approval-run",
    confirm: async () => true,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(res1.result?.length, 9);
  assert.equal(journal.length, 10, "1 approval checkpoint + 9 agent calls");
  const checkpointEntry = journal.find((e) => typeof e.result === "boolean");
  assert.equal(checkpointEntry?.result, true);

  // Resume the SAME script with the journal: the approval replays (cache hit)
  // so the human is never re-asked, and the 9 agents replay too.
  const replayJournal = new Map(journal.map((e) => [`${e.runId}:${e.index}`, e]));
  let confirmCalls = 0;
  const res2 = await runWorkflow<unknown[]>(NINE_ITEM_SCRIPT(", { autoApproved: false }"), {
    agent: okAgent,
    persistLogs: false,
    runId: "p12-approval-run",
    resumeJournal: replayJournal,
    confirm: async () => {
      confirmCalls++;
      return false; // would deny — but the journaled approval replays first
    },
  });
  assert.equal(res2.result?.length, 9, "the journaled approval replays; the fan-out proceeds");
  assert.equal(confirmCalls, 0, "no re-ask on resume — the approval reply was journaled");
});

// ─── QW4: structured-output warnings in the run summary ──────────────────────

test("QW4: a schema agent that never calls structured_output surfaces a recovery warning", async () => {
  const res = await runWorkflow<{ ok: boolean }>(
    `export const meta = { name: 'qw4_warn', description: 'prose recovery' }
const v = await agent('answer', { label: 'proser', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
return v`,
    {
      // The fake runner returns a schema-shaped value but never reports a
      // structured_output operation — the prose-recovery near-miss.
      agent: {
        async run() {
          return { ok: true };
        },
      } as never,
      persistLogs: false,
    },
  );
  assert.deepEqual(res.result, { ok: true });
  assert.equal(res.structuredOutputWarnings?.length, 1);
  assert.equal(res.structuredOutputWarnings?.[0].label, "proser");
  assert.match(res.structuredOutputWarnings?.[0].warning ?? "", /structured_output/);
});

test("QW4: a schema agent that DID call structured_output gets no warning", async () => {
  const res = await runWorkflow<{ ok: boolean }>(
    `export const meta = { name: 'qw4_clean', description: 'clean tool call' }
const v = await agent('answer', { label: 'clean', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
return v`,
    {
      agent: {
        async run(_prompt: string, options: { onOperations?: (ops: unknown[]) => void }) {
          options.onOperations?.([{ line: 0, op: "structured_output", outcome: "ok" }]);
          return { ok: true };
        },
      } as never,
      persistLogs: false,
    },
  );
  assert.deepEqual(res.result, { ok: true });
  assert.equal(res.structuredOutputWarnings, undefined, "a clean structured_output call is not a near-miss");
});

test("QW4: non-schema agents never warn, and warnings are deduped by label", async () => {
  const res = await runWorkflow<unknown[]>(
    `export const meta = { name: 'qw4_noschema', description: 'no schema no warn' }
const xs = await parallel([
  () => agent('plain', { label: 'same' }),
  () => agent('plain2', { label: 'same' }),
], { autoApproved: true })
return xs`,
    {
      agent: {
        async run() {
          return "text";
        },
      } as never,
      persistLogs: false,
    },
  );
  assert.equal(res.structuredOutputWarnings, undefined, "plain-text agents have no schema near-miss");
});

test("QW4: formatCompletedResultText renders the recovery-warning section", async () => {
  const result = {
    meta: { name: "w", description: "d", phases: [] },
    result: { ok: true },
    logs: [],
    phases: [],
    agentCount: 1,
    durationMs: 5,
    structuredOutputWarnings: [
      {
        label: "proser",
        warning:
          "structured output was recovered without a structured_output tool call (repair nudges or prose extraction); prefer a tool-reliable model",
      },
    ],
  };
  const text = formatCompletedResultText(result as never);
  assert.match(text, /Structured-output recovery warnings/);
  assert.match(text, /proser/);
  assert.match(text, /prefer a tool-reliable model/);
});

test("QW4: a clean run renders no recovery-warning section", async () => {
  const result = {
    meta: { name: "w", description: "d", phases: [] },
    result: { ok: true },
    logs: [],
    phases: [],
    agentCount: 1,
    durationMs: 5,
  };
  const text = formatCompletedResultText(result as never);
  assert.doesNotMatch(text, /Structured-output recovery warnings/);
});
