import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_NESTED_WORKFLOW_DEPTH } from "../src/config.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { typecheckWorkflowScript } from "../src/typecheck.js";
import { runWorkflow } from "../src/workflow.js";

/** Minimal agent runner that echoes a per-call result (no real subagent spawn). */
function echoAgent() {
  return {
    async run(prompt: string) {
      return `ran:${prompt}`;
    },
  };
}

// ─── Recursion guard (vm wrapper depth cap) ─────────────────────────────────

const selfRecursive = `export const meta = { name: 'self_recursive', description: 'recurses forever' }
return await workflow('self_recursive')`;

/** Run a workflow that is expected to reject; returns the rejection reason. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the run to reject, but it resolved");
}

test("runaway workflow() recursion hits the vm wrapper depth cap and errors clearly", async () => {
  const err = await rejectionOf(
    runWorkflow(selfRecursive, {
      agent: echoAgent(),
      persistLogs: false,
      // Raise the policy cap above the runaway ceiling so the vm wrapper — not
      // the one-level policy — is what stops the recursion.
      maxNestedWorkflowDepth: MAX_NESTED_WORKFLOW_DEPTH,
      loadSavedWorkflow: () => selfRecursive,
    }),
  );
  assert.ok(err instanceof WorkflowError, `expected a WorkflowError, got ${String(err)}`);
  assert.match(err.message, /recursion depth exceeded/);
  assert.match(err.message, /max 8/);
  assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
});

test("runaway recursion with default options still fails at the documented one-level policy", async () => {
  // With the option off (default), behavior is unchanged: the first nested
  // workflow() call is rejected with the long-standing one-level-deep error.
  const err = await rejectionOf(
    runWorkflow(selfRecursive, {
      agent: echoAgent(),
      persistLogs: false,
      loadSavedWorkflow: () => selfRecursive,
    }),
  );
  assert.ok(err instanceof WorkflowError);
  assert.match(err.message, /one level deep/);
  assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
});

const nestingChain: Record<string, string> = {
  leaf: `export const meta = { name: 'leaf', description: 'l' }
return 'leaf'`,
  d: `export const meta = { name: 'd', description: 'd' }
return await workflow('leaf')`,
  c: `export const meta = { name: 'c', description: 'c' }
return await workflow('d')`,
  b: `export const meta = { name: 'b', description: 'b' }
return await workflow('c')`,
};
const chainParent = `export const meta = { name: 'chain_parent', description: 'p' }
return await workflow('b')`;

test("maxNestedWorkflowDepth allows bounded nesting and fails at the policy cap", async () => {
  // parent(0) -> b(1) -> c(2) -> d(3) -> leaf(blocked at depth 3 with cap 3).
  const err = await rejectionOf(
    runWorkflow(chainParent, {
      agent: echoAgent(),
      persistLogs: false,
      maxNestedWorkflowDepth: 3,
      loadSavedWorkflow: (name) => nestingChain[name],
    }),
  );
  assert.ok(err instanceof WorkflowError);
  assert.match(err.message, /nesting depth exceeded \(max 3\)/);
  assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
});

test("raising maxNestedWorkflowDepth lets a bounded nesting chain run", async () => {
  const result = await runWorkflow(chainParent, {
    agent: echoAgent(),
    persistLogs: false,
    maxNestedWorkflowDepth: 4,
    loadSavedWorkflow: (name) => nestingChain[name],
  });
  assert.equal(result.result, "leaf");
});

// ─── Optional pre-run typecheck (opt-in, soft-fail) ─────────────────────────

const typeBrokenScript = `export const meta = { name: 'type_broken', description: 'has a type error' }
// JS-valid (the vm runs it fine) but tsc flags the number-as-prompt type mismatch.
const result = await agent(123, { label: 'typed' })
return result`;

test("preRunTypecheck off (default): a type-broken script runs with no typecheck warning", async () => {
  const result = await runWorkflow(typeBrokenScript, { agent: echoAgent(), persistLogs: false });
  assert.equal(result.result, "ran:123");
  assert.equal(
    result.logs.some((line) => line.includes("pre-run typecheck")),
    false,
    "the default path must not emit typecheck warnings",
  );
});

test("preRunTypecheck on: a type-broken script logs a warning and still executes", async () => {
  const result = await runWorkflow(typeBrokenScript, {
    agent: echoAgent(),
    persistLogs: false,
    preRunTypecheck: true,
  });
  // Soft-fail: the type error never blocks execution.
  assert.equal(result.result, "ran:123");
  const warning = result.logs.find((line) => line.includes("pre-run typecheck"));
  assert.ok(warning, "expected a pre-run typecheck warning in the run logs");
  assert.match(warning, /continuing anyway/);
  assert.match(warning, /TS2345/, "the warning should carry tsc's actual diagnostic");
});

test("preRunTypecheck on: a clean script passes silently", async () => {
  const cleanScript = `export const meta = { name: 'clean', description: 'c' }
const a = await agent('hi', { label: 'l' })
return a`;
  const result = await runWorkflow(cleanScript, {
    agent: echoAgent(),
    persistLogs: false,
    preRunTypecheck: true,
  });
  assert.equal(result.result, "ran:hi");
  assert.equal(
    result.logs.some((line) => line.includes("pre-run typecheck")),
    false,
    "a clean script must not log a typecheck warning",
  );
});

test("typecheckWorkflowScript soft-fails when no TypeScript toolchain exists", async () => {
  const input = { meta: { name: "x", description: "y" }, body: "return 1" };

  // No toolchain at all: never throws, never blocks, reports unavailable.
  const missing = await typecheckWorkflowScript(input, { binPath: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.unavailable, true);
  assert.match(missing.detail, /toolchain not found/);

  // A bin path that cannot run: same soft-fail contract, diagnostics captured.
  const bogus = await typecheckWorkflowScript(input, { binPath: join(tmpdir(), "no-such-tsc-bin.js") });
  assert.equal(bogus.ok, false);
  assert.ok(bogus.detail.length > 0, "the soft-fail outcome should explain what happened");
});
