import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeRunDurableStore, DURABLE_STORE_SCHEMA_VERSION } from "../../../src/durable-store.js";
import type { JournalEntry } from "../../../src/workflow.js";
import { runWorkflow } from "../../../src/workflow.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";

const okAgent = {
  async run(prompt: string) {
    return prompt;
  },
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recursive-test-"));
}

type RecursiveOutcome = {
  result: unknown;
  depth: number;
  completedBranches: number;
  failedBranches: number;
  totalBranches: number;
};

// A 2-ary splitter that reduces any non-singleton partition into halves —
// deterministic, pure, and it keeps shrinking until singletons (leaves).
const SCRIPT = `export const meta = { name: 'r_tree', description: 'recursive tree' }
const out = await recursive([1, 2, 3, 4, 5], {
  maxDepth: 3,
  split: (items, depth) => (items.length > 1 ? [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))] : []),
  solve: async (items, depth, meta) => ({ items, depth, budget: meta.branchBudget, text: await agent('solve ' + depth + ': ' + JSON.stringify(items)) }),
  merge: (results, meta) => ({ children: results, depth: meta.depth, failed: meta.failed.length }),
})
return out`;

test("recursive: decomposes a partition tree to leaves with a bounded depth", async () => {
  const res = await runWorkflow<RecursiveOutcome>(SCRIPT, { agent: okAgent, persistLogs: false });
  const out = res.result.result as { children: unknown[]; depth: number; failed: number };
  assert.equal(out.depth, 0, "the root merge runs at depth 0");
  assert.equal(out.failed, 0);
  assert.equal(res.result.depth, 3, "the deepest leaf is at maxDepth");
  assert.equal(res.result.totalBranches, 5, "five singleton leaves are visited");
  assert.equal(res.result.completedBranches, 5);
  assert.equal(res.result.failedBranches, 0);
});

test("recursive: budget inheritance shrinks the branch budget with depth", async () => {
  const script = `export const meta = { name: 'r_budget', description: 'budget inheritance' }
const budgets = []
await recursive([1, 2, 3], {
  maxDepth: 2,
  split: (items) => (items.length > 1 ? [[items[0]], items.slice(1)] : []),
  solve: async (items, depth, meta) => { budgets.push({ depth, budget: meta.branchBudget }); return await agent('solve ' + depth) },
  merge: (results) => results,
})
return budgets`;
  const res = await runWorkflow<Array<{ depth: number; budget: number }>>(script, {
    agent: okAgent,
    persistLogs: false,
    tokenBudget: 1000,
  });
  // [1,2,3] → [1] (d1) + [2,3] (d1) → [2] (d2) + [3] (d2): ONE leaf at d1 and
  // two at d2. Root budget = 1000; leaves inherit 1000/2^depth.
  const byDepth = new Map<number, number[]>();
  for (const entry of res.result) {
    byDepth.set(entry.depth, [...(byDepth.get(entry.depth) ?? []), entry.budget]);
  }
  assert.deepEqual(byDepth.get(1), [500], "the depth-1 leaf inherits half the run budget");
  assert.deepEqual(byDepth.get(2), [250, 250], "depth-2 leaves inherit a quarter");
});

test("recursive: maxDepth 1 solves each child directly (no further splitting)", async () => {
  const script = `export const meta = { name: 'r_flat', description: 'flat recursion' }
const out = await recursive([1, 2, 3], {
  maxDepth: 1,
  split: (items) => items.map((item) => [item]),
  solve: async (items, depth, meta) => ({ depth, text: await agent('solve ' + depth + ': ' + JSON.stringify(items)) }),
})
return out`;
  const res = await runWorkflow<RecursiveOutcome>(script, { agent: okAgent, persistLogs: false });
  assert.equal(res.result.depth, 1, "every child is a leaf at maxDepth 1");
  assert.equal(res.result.totalBranches, 3);
  assert.equal(res.result.completedBranches, 3);
});

test("recursive: an empty or single-identical-part split treats the branch as a leaf", async () => {
  const script = `export const meta = { name: 'r_nosplit', description: 'no-op split' }
const out = await recursive([1, 2], {
  maxDepth: 3,
  split: (items) => (items.length > 2 ? [items.slice(0, 1), items.slice(1)] : []),
  solve: async (items, depth, meta) => ({ depth, text: await agent('solve ' + depth + ': ' + JSON.stringify(items)) }),
})
return out`;
  const res = await runWorkflow<RecursiveOutcome>(script, { agent: okAgent, persistLogs: false });
  assert.equal(res.result.depth, 0, "the unsplittable root is solved as a leaf at depth 0");
  assert.equal(res.result.totalBranches, 1);
  assert.equal(res.result.completedBranches, 1);
});

test("recursive: an all-failed batch stops the branch wholesale (N03) without calling merge", async () => {
  const script = `export const meta = { name: 'r_allfail', description: 'all-failed batch' }
let mergeCalls = 0
const out = await recursive([1, 2], {
  maxDepth: 2,
  split: (items) => (items.length > 1 ? [[items[0]], items.slice(1)] : []),
  solve: async (items, depth) => { await agent('solve ' + JSON.stringify(items)); return null },
  merge: (results, meta) => { mergeCalls++; return results },
})
return { out, mergeCalls }`;
  const res = await runWorkflow<{ out: RecursiveOutcome; mergeCalls: number }>(script, {
    agent: okAgent,
    persistLogs: false,
  });
  assert.equal(res.result.out.result, null, "the root fails wholesale when every child failed");
  assert.equal(res.result.out.failedBranches, 2, "two failed leaves");
  assert.equal(res.result.out.completedBranches, 0);
  assert.equal(res.result.mergeCalls, 0, "the all-failed batch never reaches merge");
});

test("recursive: partial failures pass through to merge with the failed list", async () => {
  const script = `export const meta = { name: 'r_partial', description: 'partial failure' }
const out = await recursive([1, 2], {
  maxDepth: 2,
  split: (items) => (items.length > 1 ? [[items[0]], items.slice(1)] : []),
  solve: async (items, depth, meta) => {
    if (JSON.stringify(items) === '[2]') { await agent('fail ' + JSON.stringify(items)); return null }
    return { text: await agent('solve ' + JSON.stringify(items)) }
  },
  merge: (results, meta) => ({ results, failed: meta.failed }),
})
return out`;
  const res = await runWorkflow<{
    result: { results: Array<unknown | null>; failed: Array<{ path: string; depth: number }> };
  }>(script, { agent: okAgent, persistLogs: false });
  const merged = res.result.result as {
    results: Array<unknown | null>;
    failed: Array<{ path: string; depth: number }>;
  };
  assert.equal(merged.results.length, 2);
  assert.equal(merged.results[1], null, "the failing leaf stays null in the merge input");
  assert.deepEqual(
    Array.from(merged.failed, (f) => f.path),
    ["0/1"],
    "the failed leaf's positional path is reported",
  );
});

test("recursive: wave width (maxRecursiveRoots) does not change the tree semantics", async () => {
  const runWith = async (maxRoots: number) => {
    const script = `export const meta = { name: 'r_waves', description: 'wave width' }
const out = await recursive([1, 2, 3, 4, 5], {
  maxDepth: 1,
  maxRecursiveRoots: ${maxRoots},
  split: (items) => items.map((item) => [item]),
  solve: async (items, depth, meta) => ({ path: meta.path, text: await agent('solve ' + JSON.stringify(items)) }),
  merge: (results, meta) => ({ results, paths: meta.failed }),
})
return out`;
    return runWorkflow<RecursiveOutcome & { result: { results: Array<{ path: string }> } }>(script, {
      agent: okAgent,
      persistLogs: false,
    });
  };
  const narrow = await runWith(1);
  const wide = await runWith(16);
  const pathsOf = (
    outcome: RecursiveOutcome & { result: { results: Array<{ path: string }> } },
  ): Array<string | null> => Array.from(outcome.result.results, (r) => (r ? r.path : null));
  assert.deepEqual(
    pathsOf(narrow.result),
    ["0/0", "0/1", "0/2", "0/3", "0/4"],
    "children keep their positional paths in waves",
  );
  assert.deepEqual(
    pathsOf(wide.result),
    ["0/0", "0/1", "0/2", "0/3", "0/4"],
    "wave width never changes result order or paths",
  );
  assert.equal(narrow.result.totalBranches, wide.result.totalBranches);
});

test("recursive: resume replays the same tree with zero live agent calls", async () => {
  const RUN_ID = "recursive-resume";
  let calls = 0;
  const countingAgent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = new Map<string, JournalEntry>();
  const options = {
    agent: countingAgent,
    persistLogs: false,
    runId: RUN_ID,
    onAgentJournal: (entry: JournalEntry) => journal.set(`${entry.runId ?? RUN_ID}:${entry.index}`, entry),
  };

  const first = await runWorkflow<RecursiveOutcome>(SCRIPT, options);
  const liveCalls = calls;

  await runWorkflow(SCRIPT, { ...options, resumeJournal: journal });
  assert.equal(calls, liveCalls, "a resumed run replays every recursive leaf from the journal");
  const replayed = await runWorkflow<RecursiveOutcome>(SCRIPT, { ...options, resumeJournal: journal });
  assert.equal(replayed.result.totalBranches, first.result.totalBranches, "the replayed tree has the same shape");
});

test("recursive: durable bindings persist the partition spec and per-branch coverage", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const runId = "recursive-durable";
    const script = `export const meta = { name: 'r_durable', description: 'durable bindings' }
const out = await recursive([1, 2, 3], {
  maxDepth: 1,
  split: (items) => items.map((item) => [item]),
  solve: async (items, depth, meta) => ({ path: meta.path, text: await agent('solve ' + JSON.stringify(items)) }),
  merge: (results) => results,
})
return out`;
    try {
      await runWorkflow(script, { agent: okAgent, cwd, persistLogs: false, runId });
      const agentDir = join(process.env.HOME ?? "", ".pi", "agent");
      const files = readdirSync(join(agentDir, "durable-store")).filter(
        (f) => f.endsWith(".json") && !f.endsWith(".bak"),
      );
      assert.equal(files.length, 1, "one per-project store file");
      const raw = JSON.parse(readFileSync(join(agentDir, "durable-store", files[0] ?? ""), "utf-8")) as {
        version: number;
        entries: Record<string, unknown>;
      };
      assert.equal(raw.version, DURABLE_STORE_SCHEMA_VERSION);
      assert.ok(raw.entries[`recursive:root:${runId}`], "the root partition spec is persisted");
      assert.deepEqual((raw.entries[`recursive:root:${runId}`] as { maxDepth: number }).maxDepth, 1);
      // Three singleton leaves at path 0/0..0/2 → three branch records.
      for (const path of ["0/0", "0/1", "0/2"]) {
        assert.ok(raw.entries[`recursive:branches:${runId}:${path}`], `branch coverage persisted for ${path}`);
      }
      // Re-run with the SAME runId: put/putOnce writes are idempotent — the
      // store file stays byte-identical (replay determinism).
      const before = readFileSync(join(agentDir, "durable-store", files[0] ?? ""), "utf-8");
      await runWorkflow(script, { agent: okAgent, cwd, persistLogs: false, runId });
      const after = readFileSync(join(agentDir, "durable-store", files[0] ?? ""), "utf-8");
      assert.equal(after, before, "replaying the same run leaves the durable store byte-identical");
    } finally {
      closeRunDurableStore(runId);
    }
  }));

test("recursive: maxDepth beyond MAX_RECURSIVE_DEPTH is clamped (not a TypeError)", async () => {
  const script = `export const meta = { name: 'r_clamp', description: 'clamped depth' }
const out = await recursive([1], {
  maxDepth: 999,
  split: () => [],
  solve: async (items, depth, meta) => await agent('solve ' + depth),
})
return out`;
  const res = await runWorkflow<RecursiveOutcome>(script, { agent: okAgent, persistLogs: false });
  assert.equal(res.result.totalBranches, 1, "the clamped maxDepth still solves the root");
  assert.equal(res.result.result, "solve 0");
});
