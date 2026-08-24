import assert from "node:assert/strict";
import test from "node:test";
import { generatePlanThenExecuteWorkflow } from "../../../src/plan-then-execute.js";
import { SharedStore } from "../../../src/shared-store.js";
import { runWorkflow } from "../../../src/workflow.js";

// ─── T2-07: runtime shared-context ctx() ────────────────────────────────────────
// Dedupe: one store write per distinct blob, per run. Full text emitted into the
// FIRST agent's instructions once; later agents get a store-key note. The blob
// fingerprint is a resume-hash identity input (editing the shared text
// invalidates cached replays). Adoption proof: plan-then-execute.

function ctxScript(body: string): string {
  return `export const meta = { name: 'ctx_test', description: 'shared context' }
${body}`;
}

/** Stub runner for scripts that never call agent() (dedupe tests). */
const stubAgent = {
  async run() {
    throw new Error("no agent() call should be made in this script");
  },
} as never;

/**
 * Captures ctx() blob writes at put() time — the run disposes the injected
 * store at teardown, so snapshotting after runWorkflow would see nothing.
 */
class SpyStore extends SharedStore {
  /** Reserved ctx keys seen at put() time, in write order. */
  readonly ctxPuts: Array<{ key: string; value: unknown }> = [];
  override put(key: string, value: unknown): void {
    if (key.startsWith("wf:ctx:")) this.ctxPuts.push({ key, value });
    super.put(key, value);
  }
}

test("T2-07: ctx() dedupes — repeated calls with the same text store ONE blob and return the same pointer", async () => {
  const store = new SpyStore();
  const result = await runWorkflow(
    ctxScript(`
const p1 = ctx('THE SHARED BLOB')
const p2 = ctx('THE SHARED BLOB')
const p3 = ctx('THE SHARED BLOB')
return { p1, p2, p3 }
`),
    { persistLogs: false, sharedStore: store, agent: stubAgent },
  );
  const r = result.result as { p1: string; p2: string; p3: string };
  assert.equal(r.p1, "[[ctx:0]]", "first registration returns the pointer");
  assert.equal(r.p2, r.p1, "a repeated call returns the SAME pointer");
  assert.equal(r.p3, r.p1, "a repeated call returns the SAME pointer");
  assert.equal(store.ctxPuts.length, 1, "the blob was written to the store exactly ONCE (one blob per run)");
  assert.equal(store.ctxPuts[0].key, "wf:ctx:0");
  assert.equal(store.ctxPuts[0].value, "THE SHARED BLOB", "the store holds the blob text");
});

test("T2-07: distinct ctx() texts register distinct keys and pointers in call order", async () => {
  const store = new SpyStore();
  const result = await runWorkflow(
    ctxScript(`
const a = ctx('BLOB A')
const b = ctx('BLOB B')
return { a, b }
`),
    { persistLogs: false, sharedStore: store, agent: stubAgent },
  );
  const r = result.result as { a: string; b: string };
  assert.equal(r.a, "[[ctx:0]]");
  assert.equal(r.b, "[[ctx:1]]");
  assert.deepEqual(
    store.ctxPuts.map((p) => [p.key, p.value]),
    [
      ["wf:ctx:0", "BLOB A"],
      ["wf:ctx:1", "BLOB B"],
    ],
    "each distinct blob is stored once, in first-call order",
  );
});

test("T2-07: ctx() with empty/absent text is a no-op (no store write, no pointer)", async () => {
  const store = new SpyStore();
  const result = await runWorkflow(
    ctxScript(`
const e1 = ctx('')
const e2 = ctx(undefined)
return { e1, e2 }
`),
    { persistLogs: false, sharedStore: store, agent: stubAgent },
  );
  const r = result.result as { e1: string; e2: string };
  assert.equal(r.e1, "", "empty text returns a no-op pointer");
  assert.equal(r.e2, "", "absent text returns a no-op pointer");
  assert.equal(store.ctxPuts.length, 0, "no blob was stored");
});

test("T2-07: the FULL blob is emitted into the first agent's instructions once; later agents get the store-key note", async () => {
  const instructions: Array<string | undefined> = [];
  await runWorkflow(
    ctxScript(`
const ref = ctx('FULL-BLOB-TEXT-12345')
const one = await agent('first ' + ref, { label: 'one' })
const two = await agent('second ' + ref, { label: 'two' })
return { one, two }
`),
    {
      persistLogs: false,
      agent: {
        async run(_prompt: string, options?: { instructions?: string }) {
          instructions.push(options?.instructions);
          return "ok";
        },
      } as never,
    },
  );
  assert.equal(instructions.length, 2, "both agents ran");
  assert.ok(
    instructions[0]?.includes("FULL-BLOB-TEXT-12345"),
    "the first agent's instructions carry the FULL blob text (emitted once per run)",
  );
  assert.ok(instructions[0]?.includes("[[ctx:0]]"), "the first agent's instructions name the pointer");
  assert.ok(
    !instructions[1]?.includes("FULL-BLOB-TEXT-12345"),
    "later agents do NOT re-receive the full blob (the dedupe that saves tokens)",
  );
  assert.ok(
    instructions[1]?.includes('store_get("wf:ctx:0")'),
    "later agents get the store-key note so the content stays reachable",
  );
});

test("T2-07: scripts without ctx() are byte-identical — no shared-context section in instructions", async () => {
  const instructions: Array<string | undefined> = [];
  await runWorkflow(ctxScript(`return await agent('plain', { label: 'plain' })`), {
    persistLogs: false,
    agent: {
      async run(_prompt: string, options?: { instructions?: string }) {
        instructions.push(options?.instructions);
        return "ok";
      },
    } as never,
  });
  assert.ok(
    instructions[0] === undefined || !instructions[0].includes("Shared run context"),
    "no shared-context section when ctx() is never called",
  );
});

test("T-06: an oversized ctx() blob is capped in the instruction copy but fully readable via store_get", async () => {
  const big = "B".repeat(6000);
  const instructions: Array<string | undefined> = [];
  await runWorkflow(
    ctxScript(`
const ref = ctx(${JSON.stringify(big)})
const one = await agent('first ' + ref, { label: 'one' })
return { one }
`),
    {
      persistLogs: false,
      agent: {
        async run(_prompt: string, options?: { instructions?: string }) {
          instructions.push(options?.instructions);
          return "ok";
        },
      } as never,
    },
  );
  const first = instructions[0];
  assert.ok(first?.includes("[[ctx:0]]"), "the pointer is still named");
  assert.ok(
    first?.includes("characters omitted from this instruction copy") && first?.includes('store_get("wf:ctx:0")'),
    "the instruction copy reports the deterministic 4K cap, the omitted tail, and the store-key escape hatch",
  );
  assert.ok(
    !first?.includes("B".repeat(4001)),
    "the instruction copy never carries more than the capped head of the blob",
  );
});

// ─── T2-07: resume-hash stability ──────────────────────────────────────────────

function hashScript(blobText: string): string {
  return ctxScript(`
const ref = ctx(${JSON.stringify(blobText)})
return await agent('uses ' + ref, { label: 'x' })
`);
}
test("T2-07: an unchanged ctx() blob replays from the resume journal; an edited blob invalidates the cached result", async () => {
  let calls = 0;
  const agent = {
    async run() {
      calls++;
      return "ok";
    },
  };
  const journal = new Map<string, never>();
  const options = () => ({
    agent,
    persistLogs: false,
    runId: "ctx-hash-run",
    onAgentJournal: (entry: { runId?: string; index: number }) =>
      journal.set(`${entry.runId ?? "ctx-hash-run"}:${entry.index}`, entry as never),
  });

  await runWorkflow(hashScript("VERSION-1"), options());
  assert.equal(calls, 1, "first run executes live");

  await runWorkflow(hashScript("VERSION-1"), { ...options(), resumeJournal: journal });
  assert.equal(calls, 1, "the same shared text replays from cache (hash stability)");

  await runWorkflow(hashScript("VERSION-2"), { ...options(), resumeJournal: journal });
  assert.equal(calls, 2, "an edited shared blob invalidates the cached replay downstream of the ctx() call");
});

// ─── T2-07: plan-then-execute adoption (the ~21K-token worst case) ─────────────

test("T2-07: plan-then-execute registers the objective via ctx() instead of re-embedding it", () => {
  const body = generatePlanThenExecuteWorkflow();
  assert.match(body, /const objectiveCtx = ctx\(objective\)/, "the objective is registered once via ctx()");
  assert.match(body, /const contextCtx = context \? ctx\(context\) : ''/, "the optional context is registered too");
  assert.doesNotMatch(body, /'OBJECTIVE: ' \+ objective\b/, "no prompt re-embeds the raw objective text");
  assert.match(body, /'OBJECTIVE: ' \+ objectiveCtx/, "every prompt embeds the compact pointer instead");
});
