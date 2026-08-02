/**
 * Slice N tests — plan-then-execute builtin workflow.
 *
 * Covers:
 *  - orderStepsByDependencies (unit): dependency ordering, cycle rejection,
 *    duplicate ids, unknown deps, malformed entries — the plan's hard contract.
 *  - Parity: the vm-embedded copy (orderStepsByDependenciesSource, baked into
 *    the generated script) behaves identically to the TS reference.
 *  - Runtime: planner replan loop, per-step verifier gate with bounded rework,
 *    gated execution, maxSteps cap, and degraded results on a cyclic plan.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  generatePlanThenExecuteWorkflow,
  orderStepsByDependencies,
  orderStepsByDependenciesSource,
  PLAN_THEN_EXECUTE_MAX_PLAN_ATTEMPTS,
  PLAN_THEN_EXECUTE_MAX_REWORK_ATTEMPTS,
} from "../../../src/plan-then-execute.js";
import { parseWorkflowScript, runWorkflow } from "../../../src/workflow.js";

/**
 * Convert a vm-realm run result into host-realm plain data. Script results are
 * created inside the vm realm, so their arrays/objects carry the realm's
 * prototypes and fail node's strict deepEqual against host literals.
 */
function toHost<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─── orderStepsByDependencies: unit contract ───────────────────────────────────

test("orderStepsByDependencies returns a dependency-ordered topological sort", () => {
  const out = orderStepsByDependencies([
    { id: "c", title: "C", description: "c", dependsOn: ["a", "b"] },
    { id: "a", title: "A", description: "a", dependsOn: [] },
    { id: "b", title: "B", description: "b", dependsOn: ["a"] },
  ]);
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.steps.map((s) => s.id),
    ["a", "b", "c"],
  );
});

test("orderStepsByDependencies rejects cyclic and self-referential plans", () => {
  const cycle = orderStepsByDependencies([
    { id: "a", title: "A", description: "a", dependsOn: ["b"] },
    { id: "b", title: "B", description: "b", dependsOn: ["a"] },
  ]);
  assert.equal(cycle.ok, false);
  assert.match(cycle.error ?? "", /cycle/);

  const selfLoop = orderStepsByDependencies([{ id: "a", title: "A", description: "a", dependsOn: ["a"] }]);
  assert.equal(selfLoop.ok, false);
  assert.match(selfLoop.error ?? "", /cycle/);
});

test("orderStepsByDependencies rejects duplicate step ids", () => {
  const out = orderStepsByDependencies([
    { id: "a", title: "A", description: "a" },
    { id: "a", title: "A2", description: "a2" },
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /duplicate step id/);
});

test("orderStepsByDependencies rejects dependencies on unknown steps", () => {
  const out = orderStepsByDependencies([{ id: "a", title: "A", description: "a", dependsOn: ["ghost"] }]);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /unknown step ghost/);
});

test("orderStepsByDependencies rejects malformed entries (non-object, blank id/title/description)", () => {
  const nonObject = orderStepsByDependencies([null, 42, "string", []]);
  assert.equal(nonObject.ok, false);
  assert.match(nonObject.error ?? "", /non-empty id, title, and description/);

  const blankId = orderStepsByDependencies([{ id: "   ", title: "T", description: "D" }]);
  assert.equal(blankId.ok, false);

  const missingDescription = orderStepsByDependencies([{ id: "a", title: "T" }]);
  assert.equal(missingDescription.ok, false);
});

test("orderStepsByDependencies tolerates absent or dirty dependsOn and trims ids", () => {
  const out = orderStepsByDependencies([
    { id: "  a  ", title: " A ", description: " d ", dependsOn: "not-an-array" },
    { id: "b", title: "B", description: "b", dependsOn: ["a", 42, null, " ", "a"] },
  ]);
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn })),
    [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
    ],
  );
});

test("orderStepsByDependencies accepts an empty step list (script treats it as degraded)", () => {
  const out = orderStepsByDependencies([]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps, []);
});

// ─── Parity: vm-embedded copy vs TS reference ─────────────────────────────────

test("the vm-embedded orderStepsByDependencies behaves identically to the TS reference", () => {
  const embedded = vm.runInNewContext(`${orderStepsByDependenciesSource()}\norderStepsByDependencies`) as (
    rawSteps: unknown[],
  ) => unknown;
  const fixtures: unknown[][] = [
    [],
    [{ id: "a", title: "A", description: "a" }],
    [
      { id: "c", title: "C", description: "c", dependsOn: ["a", "b"] },
      { id: "a", title: "A", description: "a" },
      { id: "b", title: "B", description: "b", dependsOn: ["a"] },
    ],
    [
      { id: "a", title: "A", description: "a", dependsOn: ["b"] },
      { id: "b", title: "B", description: "b", dependsOn: ["a"] },
    ],
    [{ id: "a", title: "A", description: "a", dependsOn: ["a"] }],
    [
      { id: "a", title: "A", description: "a" },
      { id: "a", title: "A2", description: "a2" },
    ],
    [{ id: "a", title: "A", description: "a", dependsOn: ["ghost"] }],
    [null, 42, {}],
    [{ id: "a", title: "T", dependsOn: ["b", 1, null, "b"] }],
  ];
  for (const fixture of fixtures) {
    // JSON round-trip sidesteps the vm realm's distinct Array/Object prototypes.
    assert.deepEqual(
      JSON.parse(JSON.stringify(embedded(fixture))),
      JSON.parse(JSON.stringify(orderStepsByDependencies(fixture))),
      `parity mismatch for fixture ${JSON.stringify(fixture)}`,
    );
  }
});

test("the generated script embeds the ordering validator (no import needed)", () => {
  const { body } = parseWorkflowScript(generatePlanThenExecuteWorkflow());
  assert.match(body, /const orderStepsByDependencies = /);
});

// ─── Generated script surface ─────────────────────────────────────────────────

test("generatePlanThenExecuteWorkflow declares the 4 phases and runtime args", () => {
  const { meta, body } = parseWorkflowScript(generatePlanThenExecuteWorkflow());
  assert.equal(meta.name, "plan_then_execute");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Plan", "Verify", "Execute", "Report"],
  );
  assert.match(body, /args && args\.objective/);
  assert.match(body, /args && args\.execute/);
  assert.match(body, /args\.maxSteps/);
});

// ─── Runtime: happy path with execution ────────────────────────────────────────

test("plan-then-execute runs plan → verify → execute → report for accepted steps", async () => {
  const prompts: string[] = [];
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        if (prompt.includes("planning agent")) {
          return {
            steps: [
              { id: "setup", title: "Setup", description: "Prepare environment", dependsOn: [] },
              { id: "build", title: "Build", description: "Build the widget", dependsOn: ["setup"] },
            ],
          };
        }
        if (prompt.includes("step verifier")) return { ok: true, feedback: "" };
        if (prompt.includes("implementer")) return `executed ${/"id":"([^"]+)"/.exec(prompt)?.[1] ?? ""}`;
        if (prompt.includes("report writer")) return "report text";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { objective: "build a widget", execute: true, maxSteps: 5 },
  });

  const r = result.result as {
    plan?: Array<{ id: string }>;
    verdicts?: Array<{ id: string; ok: boolean; attempts: number }>;
    results?: Array<{ id: string; value: unknown }>;
    planError?: string;
    report?: string;
  };
  assert.equal(r.planError, "");
  assert.deepEqual(
    toHost(r.plan)?.map((s) => s.id),
    ["setup", "build"],
    "steps must come back dependency-ordered",
  );
  assert.deepEqual(
    toHost(r.verdicts)?.map((v) => ({ id: v.id, ok: v.ok, attempts: v.attempts })),
    [
      { id: "setup", ok: true, attempts: 1 },
      { id: "build", ok: true, attempts: 1 },
    ],
  );
  assert.deepEqual(
    toHost(r.results)?.map((x) => x.id),
    ["setup", "build"],
    "both accepted steps must execute",
  );
  assert.equal(r.report, "report text");
  // The executor of `build` must see its dependency's result, not an empty list.
  const buildPrompt = prompts.find((p) => p.includes("implementer") && p.includes('"id":"build"'));
  assert.ok(
    buildPrompt?.includes("executed setup"),
    "the dependent step's prompt should carry completed dependency results",
  );
});

// ─── Runtime: verifier gate with bounded rework ───────────────────────────────

test("a rejected step is reworked once from verifier feedback, then accepted and executed", async () => {
  let verifierCalls = 0;
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning agent")) {
          return { steps: [{ id: "s1", title: "Step", description: "vague", dependsOn: [] }] };
        }
        if (prompt.includes("step verifier")) {
          verifierCalls++;
          return verifierCalls === 1 ? { ok: false, feedback: "make it testable" } : { ok: true, feedback: "" };
        }
        if (prompt.includes("step rewriter")) {
          return { id: "s1", title: "Step", description: "testable: assert the output shape", dependsOn: [] };
        }
        if (prompt.includes("implementer")) return "done";
        if (prompt.includes("report writer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { objective: "o", execute: true },
  });

  const r = result.result as {
    verdicts?: Array<{ id: string; ok: boolean; attempts: number; step?: { description: string } }>;
    results?: Array<{ id: string }>;
  };
  assert.equal(verifierCalls, 2, "attempt 0 judges the planned step; attempt 1 re-judges the reworked step");
  assert.equal(r.verdicts?.length, 1);
  assert.equal(r.verdicts?.[0]?.ok, true);
  assert.equal(r.verdicts?.[0]?.attempts, 2);
  assert.equal(
    r.verdicts?.[0]?.step?.description,
    "testable: assert the output shape",
    "the verdict should carry the final accepted step",
  );
  assert.deepEqual(
    toHost(r.results)?.map((x) => x.id),
    ["s1"],
    "a reworked-but-accepted step still executes",
  );
});

test("a step rejected through all rework attempts is not executed and the run still completes", async () => {
  let verifierCalls = 0;
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning agent")) {
          return { steps: [{ id: "s1", title: "Step", description: "bad", dependsOn: [] }] };
        }
        if (prompt.includes("step verifier")) {
          verifierCalls++;
          return { ok: false, feedback: "nope" };
        }
        if (prompt.includes("step rewriter")) {
          return { id: "s1", title: "Step", description: "still bad", dependsOn: [] };
        }
        if (prompt.includes("report writer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { objective: "o", execute: true },
  });

  const r = result.result as {
    verdicts?: Array<{ id: string; ok: boolean; attempts: number }>;
    results?: Array<{ id: string }>;
    report?: string;
  };
  assert.equal(
    verifierCalls,
    PLAN_THEN_EXECUTE_MAX_REWORK_ATTEMPTS,
    "the gate must spend its full bounded attempt budget",
  );
  assert.equal(r.verdicts?.[0]?.ok, false);
  assert.equal(r.verdicts?.[0]?.attempts, PLAN_THEN_EXECUTE_MAX_REWORK_ATTEMPTS);
  assert.deepEqual(toHost(r.results) ?? [], [], "a rejected step must never execute");
  assert.equal(r.report, "report", "the report phase still runs and can disclose the rejection");
  assert.ok(
    result.logs.some((l) => l.includes("failed verification after")),
    "the rejection must be logged, not silent",
  );
});

// ─── Runtime: planner replan loop and cycle degradation ────────────────────────

test("a cyclic plan is replanned once with feedback, then degrades into an explicit planError result", async () => {
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning agent")) {
          return {
            steps: [
              { id: "a", title: "A", description: "a", dependsOn: ["b"] },
              { id: "b", title: "B", description: "b", dependsOn: ["a"] },
            ],
          };
        }
        return null;
      },
    } as never,
    persistLogs: false,
    args: { objective: "o" },
  });

  const r = result.result as {
    plan?: unknown[];
    planError?: string;
    verdicts?: unknown[];
    results?: unknown[];
    report?: unknown;
  };
  assert.match(r.planError ?? "", /cycle/, "the rejection reason must reach the result");
  assert.deepEqual(toHost(r.plan), []);
  assert.deepEqual(toHost(r.verdicts), []);
  assert.deepEqual(toHost(r.results), []);
  assert.equal(r.report, null);
  assert.ok(
    result.logs.some((l) => l.includes("plan rejected")),
    "the plan rejection must be logged, not silent",
  );
});

test("a structurally invalid first plan is fixed on the second planner attempt (bounded replan works)", async () => {
  let plannerCalls = 0;
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning agent")) {
          plannerCalls++;
          if (plannerCalls === 1) return { steps: [{ id: "a", title: "A" }] }; // missing description → rejected
          return { steps: [{ id: "a", title: "A", description: "proper" }] };
        }
        if (prompt.includes("step verifier")) return { ok: true, feedback: "" };
        if (prompt.includes("report writer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { objective: "o", execute: false },
  });

  const r = result.result as { plan?: Array<{ id: string }>; planError?: string };
  assert.equal(plannerCalls, PLAN_THEN_EXECUTE_MAX_PLAN_ATTEMPTS, "the replan budget is exactly one retry");
  assert.equal(r.planError, "");
  assert.deepEqual(
    toHost(r.plan)?.map((s) => s.id),
    ["a"],
  );
});

// ─── Runtime: maxSteps cap and execute=false ──────────────────────────────────

test("maxSteps caps how many planned steps are verified/executed, with a logged degradation", async () => {
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning agent")) {
          return {
            steps: [
              { id: "s1", title: "S1", description: "one" },
              { id: "s2", title: "S2", description: "two" },
              { id: "s3", title: "S3", description: "three" },
            ],
          };
        }
        if (prompt.includes("step verifier")) return { ok: true, feedback: "" };
        if (prompt.includes("report writer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { objective: "o", execute: false, maxSteps: 2 },
  });

  const r = result.result as { verdicts?: Array<{ id: string }> };
  assert.equal(r.verdicts?.length, 2, "only the first maxSteps steps in dependency order are touched");
  assert.ok(
    result.logs.some((l) => l.includes("capping verify/execute")),
    "the cap must be logged, not silent",
  );
});

test("execute=false runs no implementer agents and still produces a report", async () => {
  const prompts: string[] = [];
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        if (prompt.includes("planning agent")) {
          return { steps: [{ id: "s1", title: "S1", description: "one" }] };
        }
        if (prompt.includes("step verifier")) return { ok: true, feedback: "" };
        if (prompt.includes("report writer")) return "report";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { objective: "o", execute: false },
  });

  const r = result.result as { results?: unknown[]; report?: string; planError?: string };
  assert.equal(r.planError, "");
  assert.deepEqual(toHost(r.results), [], "no execution without execute: true");
  assert.equal(r.report, "report");
  assert.ok(!prompts.some((p) => p.includes("implementer")), "no implementer prompts should fire");
});

// ─── Runtime: degraded result for a missing objective ─────────────────────────

test("a missing objective degrades into an explicit error result without any agent calls", async () => {
  const result = await runWorkflow(generatePlanThenExecuteWorkflow(), {
    agent: {
      async run() {
        throw new Error("no agent should be called without an objective");
      },
    } as never,
    persistLogs: false,
    args: {},
  });
  const r = result.result as { planError?: string; plan?: unknown[]; report?: unknown };
  assert.match(r.planError ?? "", /objective is required/);
  assert.deepEqual(toHost(r.plan), []);
  assert.equal(r.report, null);
});
