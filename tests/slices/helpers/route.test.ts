import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../../../src/workflow.js";

test("route: classification key maps to the matching case", async () => {
  const classifier = {
    async run(prompt: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      // Pick the category embedded in the serialized value.
      return { key: /"kind":"(\w+)"/.exec(prompt)?.[1] ?? "none" };
    },
  };
  const script = `export const meta = { name: 'r_map', description: 'dispatch' }
const out = await route({ kind: 'fix' }, {
  cases: [
    { key: 'fix', run: (v) => ({ handled: v.kind, mode: 'fix' }) },
    { key: 'review', run: (v) => ({ handled: v.kind, mode: 'review' }) },
  ],
  fallback: (v, ctx) => ({ reason: ctx.reason }),
})
return out`;
  const res = await runWorkflow<{
    key: string;
    result: { handled: string; mode: string };
    fallback: boolean;
    reason: string;
  }>(script, { agent: classifier, persistLogs: false });

  assert.equal(res.result.key, "fix");
  assert.equal(res.result.fallback, false);
  assert.equal(res.result.reason, "none");
  assert.deepEqual({ ...res.result.result }, { handled: "fix", mode: "fix" });
});

test("route: an out-of-enum classification key dispatches the fallback with reason unknown", async () => {
  const rogue = {
    async run(_p: string, o: { schema?: unknown }) {
      return o?.schema ? { key: "nonexistent" } : "ok";
    },
  };
  const script = `export const meta = { name: 'r_unknown', description: 'unknown key' }
const out = await route({ kind: 'x' }, {
  cases: [{ key: 'a', run: (v) => 'A:' + v.kind }],
  fallback: (v, ctx) => 'FB:' + ctx.reason + ':' + ctx.classification,
})
return out`;
  const res = await runWorkflow<{ key: string | null; result: string; fallback: boolean; reason: string }>(script, {
    agent: rogue,
    persistLogs: false,
  });

  assert.equal(res.result.key, null);
  assert.equal(res.result.fallback, true);
  assert.equal(res.result.reason, "unknown");
  assert.equal(res.result.result, "FB:unknown:nonexistent");
});

test("route: a recoverable-null classification dispatches the fallback with reason classification-failed", async () => {
  const exhausted = {
    async run() {
      return null; // recoverable exhaustion — agent() resolves null
    },
  };
  const script = `export const meta = { name: 'r_failed', description: 'failed classification' }
const out = await route({ kind: 'x' }, {
  cases: [{ key: 'a', run: (v) => 'A:' + v.kind }],
  fallback: (v, ctx) => 'FB:' + ctx.reason,
})
return out`;
  const res = await runWorkflow<{ key: string | null; result: string; reason: string }>(script, {
    agent: exhausted,
    persistLogs: false,
  });

  assert.equal(res.result.key, null);
  assert.equal(res.result.reason, "classification-failed");
  assert.equal(res.result.result, "FB:classification-failed");
});

test("route: when() guards filter the classification enum and prompt", async () => {
  const prompts: string[] = [];
  const classifier = {
    async run(prompt: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      prompts.push(prompt);
      return { key: "a" };
    },
  };
  const script = `export const meta = { name: 'r_when', description: 'guards' }
const out = await route({ kind: 'x' }, {
  cases: [
    { key: 'a', when: (v) => v.kind === 'x', run: (v) => 'A:' + v.kind },
    { key: 'b', when: (v) => v.kind === 'y', run: (v) => 'B:' + v.kind },
  ],
  fallback: (v, ctx) => 'FB:' + ctx.reason,
})
return out`;
  const res = await runWorkflow<{ key: string; result: string }>(script, { agent: classifier, persistLogs: false });

  assert.equal(res.result.key, "a");
  assert.equal(res.result.result, "A:x");
  assert.match(prompts[0] ?? "", /categories: a\./);
  assert.doesNotMatch(prompts[0] ?? "", /categories: a, b/);
});

test("route: no eligible case runs the fallback without spending an agent", async () => {
  const script = `export const meta = { name: 'r_none', description: 'no eligible case' }
const out = await route({ kind: 'x' }, {
  cases: [
    { key: 'a', when: () => false, run: (v) => 'A' },
    { key: 'b', when: () => false, run: (v) => 'B' },
  ],
  fallback: (v, ctx) => 'FB:' + ctx.reason,
})
return out`;
  const res = await runWorkflow<{ key: string | null; result: string; reason: string }>(script, {
    agent: {
      async run() {
        throw new Error("classifier must not run when no case is eligible");
      },
    },
    persistLogs: false,
  });

  assert.equal(res.agentCount, 0, "no agent() call happens on the all-guards-fail path");
  assert.equal(res.result.reason, "no-eligible-case");
  assert.equal(res.result.result, "FB:no-eligible-case");
});

test("route: duplicate case keys throw a TypeError", async () => {
  const script = `export const meta = { name: 'r_dup', description: 'duplicate keys' }
return await route('v', {
  cases: [
    { key: 'a', run: () => 1 },
    { key: 'a', run: () => 2 },
  ],
  fallback: () => 0,
})`;
  await assert.rejects(
    runWorkflow(script, {
      agent: {
        async run() {
          return "ok";
        },
      },
      persistLogs: false,
    }),
    /duplicate case key/,
  );
});
