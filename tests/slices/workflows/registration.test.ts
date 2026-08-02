/**
 * Slice N tests — registration of the two new builtin workflows
 * (`plan-then-execute`, `spec-generation`) in the shared registry
 * (src/builtin-workflows.ts), the single resolution path both the slash
 * commands and the `workflow` tool's `name` input consult.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_WORKFLOWS, findBuiltinWorkflow } from "../../../src/builtin-workflows.js";
import { generatePlanThenExecuteWorkflow } from "../../../src/plan-then-execute.js";
import { generateSpecGenerationWorkflow } from "../../../src/spec-generation.js";
import { parseWorkflowScript } from "../../../src/workflow.js";

function requireBuiltin(name: string) {
  const found = findBuiltinWorkflow(name);
  assert.ok(found, `${name} should be a known built-in workflow`);
  return found;
}

// ─── Registry shape ────────────────────────────────────────────────────────────

test("plan-then-execute and spec-generation appear in BUILTIN_WORKFLOWS with the required descriptor keys", () => {
  const names = BUILTIN_WORKFLOWS.map((w) => w.name);
  assert.ok(names.includes("plan-then-execute"), "plan-then-execute must be registered");
  assert.ok(names.includes("spec-generation"), "spec-generation must be registered");
  for (const descriptor of BUILTIN_WORKFLOWS.filter((w) => ["plan-then-execute", "spec-generation"].includes(w.name))) {
    assert.equal(typeof descriptor.name, "string");
    assert.ok(descriptor.name.trim().length > 0);
    assert.equal(typeof descriptor.description, "string");
    assert.ok(descriptor.description.trim().length > 0);
    assert.equal(typeof descriptor.resolve, "function");
  }
});

test("findBuiltinWorkflow resolves both new names", () => {
  assert.ok(findBuiltinWorkflow("plan-then-execute"));
  assert.ok(findBuiltinWorkflow("spec-generation"));
});

// ─── Per-pattern resolve(): defaults + parseability ───────────────────────────

test("plan-then-execute resolve() works with only the required objective and no special exec context", () => {
  const invocation = requireBuiltin("plan-then-execute").resolve("/tmp", { objective: "build a thing" });
  assert.equal(invocation.script, generatePlanThenExecuteWorkflow());
  assert.equal(invocation.tools, undefined);
  assert.equal(invocation.toolset, undefined);
  const { meta } = parseWorkflowScript(invocation.script);
  assert.equal(meta.name, "plan_then_execute");
});

test("plan-then-execute resolve() accepts the optional context/maxSteps/execute args", () => {
  const invocation = requireBuiltin("plan-then-execute").resolve("/tmp", {
    objective: "o",
    context: "c",
    maxSteps: 5,
    execute: true,
  });
  assert.equal(invocation.script, generatePlanThenExecuteWorkflow());
});

test("plan-then-execute resolve() rejects missing objective and invalid optional args", () => {
  const resolve = requireBuiltin("plan-then-execute").resolve;
  assert.throws(() => resolve("/tmp", {}), /objective/);
  assert.throws(() => resolve("/tmp", { objective: "   " }), /objective/);
  assert.throws(() => resolve("/tmp", { objective: "o", maxSteps: 0 }), /maxSteps/);
  assert.throws(() => resolve("/tmp", { objective: "o", maxSteps: 100 }), /maxSteps/);
  assert.throws(() => resolve("/tmp", { objective: "o", maxSteps: 2.5 }), /maxSteps/);
  assert.throws(() => resolve("/tmp", { objective: "o", execute: "yes" }), /execute/);
  assert.throws(() => resolve("/tmp", { objective: "o", context: 42 }), /context/);
});

test("spec-generation resolve() works with only the required topic", () => {
  const invocation = requireBuiltin("spec-generation").resolve("/tmp", { topic: "an app" });
  assert.equal(invocation.script, generateSpecGenerationWorkflow());
  assert.equal(invocation.tools, undefined);
  assert.equal(invocation.toolset, undefined);
  const { meta } = parseWorkflowScript(invocation.script);
  assert.equal(meta.name, "spec_generation");
});

test("spec-generation resolve() accepts the optional audience/format args", () => {
  const invocation = requireBuiltin("spec-generation").resolve("/tmp", {
    topic: "t",
    audience: "devs",
    format: "json",
  });
  assert.equal(invocation.script, generateSpecGenerationWorkflow());
});

test("spec-generation resolve() rejects missing topic, non-string audience, and unknown formats", () => {
  const resolve = requireBuiltin("spec-generation").resolve;
  assert.throws(() => resolve("/tmp", {}), /topic/);
  assert.throws(() => resolve("/tmp", { topic: "  " }), /topic/);
  assert.throws(() => resolve("/tmp", { topic: "t", audience: 42 }), /audience/);
  assert.throws(() => resolve("/tmp", { topic: "t", format: "pdf" }), /format/);
  assert.throws(() => resolve("/tmp", { topic: "t", format: 5 }), /format/);
});
