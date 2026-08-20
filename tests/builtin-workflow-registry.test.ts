/**
 * Tests for the shared builtin-workflow registry (src/builtin-workflows.ts) —
 * the single resolution path the `/deep-research`-style slash commands
 * (builtin-commands.ts) and the `workflow` tool's `name` input
 * (workflow-tool.ts) both consult, so a pattern's generator script is written
 * exactly once and both entry points can never drift apart.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "../src/adversarial-review.js";
import {
  BUILTIN_TOOLSET_TOOLS,
  BUILTIN_WORKFLOW_NAMES,
  BUILTIN_WORKFLOWS,
  builtinToolsetTools,
  CODE_DEV_TOOLSET,
  DEFAULT_MULTI_PERSPECTIVES,
  findBuiltinWorkflow,
  resolveWorkflowInvocation,
} from "../src/builtin-workflows.js";
import { generateCodeReviewWorkflow } from "../src/code-review.js";
import { generateDebugLoopWorkflow } from "../src/debug-loop.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "../src/deep-research.js";
import { generateSpecConformanceWorkflow } from "../src/spec-conformance.js";
import { parseWorkflowScript } from "../src/workflow.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { rmForce } from "./helpers/rm-force.js";

/** Look up a built-in descriptor, failing the test clearly if the name is unknown. */
function requireBuiltin(name: string) {
  const found = findBuiltinWorkflow(name);
  assert.ok(found, `${name} should be a known built-in workflow`);
  return found;
}

/** A minimal ToolDefinition whose execute echoes its params as text. */
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `Fake tool (${name})`,
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;
}

function withTempCwd(fn: (cwd: string) => void | Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-registry-"));
    try {
      await fn(cwd);
    } finally {
      await rmForce(cwd);
    }
  };
}

// ─── Registry shape ─────────────────────────────────────────────────────────────

test("BUILTIN_WORKFLOW_NAMES lists exactly the 12 curated patterns", () => {
  assert.deepEqual([...BUILTIN_WORKFLOW_NAMES].sort(), [
    "adversarial-review",
    "code-review",
    "codebase-audit",
    "debug-loop",
    "deep-research",
    "multi-model",
    "multi-perspective",
    "plan-then-execute",
    "review-remediate",
    "spec-conformance",
    "spec-generation",
    "supervised-run",
  ]);
});

test("findBuiltinWorkflow resolves each of the 7 names and rejects unknown names", () => {
  for (const name of BUILTIN_WORKFLOW_NAMES) {
    assert.ok(findBuiltinWorkflow(name), `${name} should be found`);
  }
  assert.equal(findBuiltinWorkflow("not-a-real-pattern"), undefined);
});

// ─── Per-pattern resolve() ──────────────────────────────────────────────────────

test(
  "deep-research resolve() produces the real generator script and the web-research exec context",
  withTempCwd(async (cwd) => {
    const invocation = await requireBuiltin("deep-research").resolve(cwd, { question: "what is pi?" });
    assert.equal(invocation.script, generateDeepResearchWorkflow());
    assert.equal(invocation.toolset, "web-research");
    const tools = invocation.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, "should carry an explicit tool set");
    const toolNames = (tools ?? []).map((t) => t.name);
    assert.ok(
      toolNames.some((n) => /search|fetch|web/i.test(n)),
      `expected web tools among: ${toolNames.join(", ")}`,
    );
  }),
);

test("deep-research resolve() rejects a missing/blank question", async () => {
  const resolve = requireBuiltin("deep-research").resolve;
  await assert.rejects(() => resolve("/tmp", {}), /question/);
  await assert.rejects(() => resolve("/tmp", { question: "   " }), /question/);
});

test("adversarial-review resolve() produces the impact-scoped generator script with its task-fit toolset", async () => {
  const invocation = await requireBuiltin("adversarial-review").resolve("/tmp", { task: "investigate this" });
  // V2-QW4: the resolved script is the generator output WITH the impact-analysis
  // phase injected (Impact Analysis first, every refute reviewer embeds the
  // partition) — never the bare generator output.
  assert.notEqual(invocation.script, generateAdversarialReviewWorkflow());
  assert.ok(invocation.script.includes("{ title: 'Impact Analysis' }"));
  assert.ok(invocation.script.includes("label: 'impact analysis'"));
  assert.ok(invocation.script.includes("'TASK: ' + task + '\\nFINDING: ' + f + impactScopeBlock(),"));
  assert.ok(invocation.script.includes("report, impactPartition }"));
  // T2-06: the pattern no longer inherits the FULL default toolset — it gets
  // the read/grep/find subset (find traces the impact radius — V2-QW4) and the
  // persistable "adversarial-review" tag. With no extension supplier (this
  // test) no captured defs append.
  assert.deepEqual(
    (invocation.tools ?? []).map((t) => t.name),
    ["read", "grep", "find"],
  );
  assert.equal(invocation.toolset, "adversarial-review");
});

test("adversarial-review resolve() rejects a missing task", async () => {
  await assert.rejects(() => requireBuiltin("adversarial-review").resolve("/tmp", {}), /task/);
});

test("code-review resolve() produces the impact-scoped generator script and requires a diff", async () => {
  const invocation = await requireBuiltin("code-review").resolve("/tmp", {
    diff: "some diff",
    diffSource: "git diff",
  });
  // P08: the resolved script is the generator output WITH the impact-analysis
  // phase injected (Impact Analysis first, every finder embeds the partition).
  assert.notEqual(invocation.script, generateCodeReviewWorkflow());
  assert.ok(invocation.script.includes("{ title: 'Impact Analysis' }"));
  assert.ok(invocation.script.includes("label: 'impact analysis'"));
  assert.ok(invocation.script.includes("+ base + shardBlock('A') + impactScopeBlock(),"));
  assert.ok(invocation.script.includes("impactPartition }"));
  await assert.rejects(() => requireBuiltin("code-review").resolve("/tmp", {}), /diff/);
  await assert.rejects(() => requireBuiltin("code-review").resolve("/tmp", { diff: "" }), /diff/);
});

test("multi-perspective resolve() bakes the given topic/perspectives into the impact-scoped generator output", async () => {
  const invocation = await requireBuiltin("multi-perspective").resolve("/tmp", {
    topic: "climate policy",
    perspectives: ["economic", "environmental"],
  });
  // V2-QW4: the resolved script wraps the generator output with the
  // impact-analysis phase (every analyst embeds the partition).
  assert.notEqual(invocation.script, generateMultiPerspectiveWorkflow("climate policy", ["economic", "environmental"]));
  assert.ok(invocation.script.includes("{ title: 'Impact Analysis' }"));
  assert.ok(invocation.script.includes('+ topic + impactScopeBlock(), { label: "economic" }'));
  assert.ok(invocation.script.includes("return { analyses, synthesis, impactPartition };"));
});

test("multi-perspective resolve() falls back to the default perspective set below 2 items", async () => {
  const noPerspectives = await requireBuiltin("multi-perspective").resolve("/tmp", { topic: "topic" });
  const onePerspective = await requireBuiltin("multi-perspective").resolve("/tmp", {
    topic: "topic",
    perspectives: ["only-one"],
  });
  const expected = generateMultiPerspectiveWorkflow("topic", [...DEFAULT_MULTI_PERSPECTIVES]);
  assert.notEqual(noPerspectives.script, expected);
  assert.notEqual(onePerspective.script, expected);
  // Both degrade to the same default perspective set (impact-scoped, so the
  // scripts are identical to each other).
  assert.equal(noPerspectives.script, onePerspective.script);
});

test("multi-perspective resolve() rejects a missing topic", async () => {
  await assert.rejects(
    () => requireBuiltin("multi-perspective").resolve("/tmp", { perspectives: ["a", "b"] }),
    /topic/,
  );
});

// ─── T2-06 per-pattern toolset tags ────────────────────────────────────────────

test("every pattern's resolve() carries its task-fit toolset tag and exact tool subset", async () => {
  // The plan's assignment (plan.md §3 T2-06); deep-research keeps web-research.
  // V2-QW4: adversarial-review + multi-perspective gain find for the
  // impact-analysis phase; V2-P05/V2-P06 add the multi-model + review-remediate
  // patterns with the full work surface.
  const expectedTags: Record<string, { toolset: string; tools: string[] }> = {
    "adversarial-review": { toolset: "adversarial-review", tools: ["read", "grep", "find"] },
    "code-review": { toolset: "code-review", tools: ["read", "grep", "find"] },
    "codebase-audit": { toolset: "codebase-audit", tools: ["read", "grep", "find"] },
    "debug-loop": { toolset: "debug-loop", tools: ["read", "grep", "find", "bash", "write"] },
    "spec-conformance": { toolset: "spec-conformance", tools: ["read", "grep", "find", "bash"] },
    "plan-then-execute": { toolset: "plan-then-execute", tools: ["read", "write", "bash"] },
    "spec-generation": { toolset: "spec-generation", tools: ["read", "bash", "write"] },
    "multi-perspective": { toolset: "multi-perspective", tools: ["read", "grep", "find"] },
    "supervised-run": { toolset: "supervised-run", tools: ["read", "grep", "find", "bash", "write"] },
    "review-remediate": { toolset: "review-remediate", tools: ["read", "grep", "find", "bash", "write"] },
    "multi-model": { toolset: "multi-model", tools: ["read", "grep", "find", "bash", "write"] },
  };
  const validArgs: Record<string, Record<string, unknown>> = {
    "adversarial-review": { task: "t" },
    "code-review": { diff: "d" },
    "codebase-audit": { scope: "s", checks: ["c"] },
    "debug-loop": { bug: "b" },
    "spec-conformance": { spec: { goal: "g", requirements: [{ id: "R1", statement: "s" }] } },
    "plan-then-execute": { objective: "o" },
    "spec-generation": { topic: "t" },
    "multi-perspective": { topic: "t" },
    "supervised-run": { task: "t", criterion: "c" },
    "review-remediate": { diff: "d" },
    "multi-model": { task: "t", models: ["a/b", "c/d"] },
  };
  for (const name of Object.keys(expectedTags)) {
    const { toolset, tools } = expectedTags[name];
    const invocation = await requireBuiltin(name).resolve("/tmp", validArgs[name]);
    assert.equal(invocation.toolset, toolset, `${name} should carry the ${toolset} tag`);
    assert.deepEqual(
      (invocation.tools ?? []).map((t) => t.name),
      tools,
      `${name} should resolve exactly ${tools.join("/")}`,
    );
    // The tag's registered subset (what a resumed run re-resolves) matches the
    // same registry the resolve() output builds from.
    assert.deepEqual(
      [...BUILTIN_TOOLSET_TOOLS[toolset]],
      tools,
      `${name}'s tag must be registered in BUILTIN_TOOLSET_TOOLS`,
    );
  }
});

test("BUILTIN_TOOLSET_TOOLS covers the 11 toolset-tagged patterns plus the code-dev superset (P04)", async () => {
  assert.deepEqual([...Object.keys(BUILTIN_TOOLSET_TOOLS)].sort(), [
    "adversarial-review",
    "code-dev",
    "code-review",
    "codebase-audit",
    "debug-loop",
    "multi-model",
    "multi-perspective",
    "plan-then-execute",
    "review-remediate",
    "spec-conformance",
    "spec-generation",
    "supervised-run",
  ]);
  // deep-research is unchanged: it already resolves tools + the web-research tag.
  const dr = await requireBuiltin("deep-research").resolve("/tmp", { question: "q" });
  assert.equal(dr.toolset, "web-research");
  // The code-dev superset = the union of every pattern's task-fit subset.
  assert.deepEqual([...BUILTIN_TOOLSET_TOOLS[CODE_DEV_TOOLSET]].sort(), ["bash", "find", "grep", "read", "write"]);
});

test("code-dev superset toolset appends the captured extension research defs (P04)", async () => {
  const extensionTools = () => [fakeTool("codegraph_search"), fakeTool("web_fetch_md"), fakeTool("describe_image")];
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-code-dev-"));
  try {
    // Without a supplier the superset carries the base coding surface only.
    const base = await builtinToolsetTools(cwd, CODE_DEV_TOOLSET);
    const baseNames = base.map((t) => t.name);
    assert.ok(baseNames.includes("read") && baseNames.includes("bash"), "the coding subset is present");
    assert.ok(
      !baseNames.some((n) => n === "codegraph_search" || n === "web_fetch_md"),
      "no captured defs without the supplier (the setting-gate side)",
    );
    // WITH the supplier, the captured defs append — pattern agents get the
    // codegraph_*/web/vision research surface (the corrected P04 mechanism).
    const withCaptured = await builtinToolsetTools(cwd, CODE_DEV_TOOLSET, extensionTools);
    const names = withCaptured.map((t) => t.name);
    assert.ok(names.includes("codegraph_search"), "captured codegraph def appends");
    assert.ok(names.includes("web_fetch_md"), "captured web def appends");
    assert.ok(names.includes("describe_image"), "captured vision def appends");
    assert.ok(names.includes("read") && names.includes("bash"), "the coding subset stays intact");
  } finally {
    await rmForce(cwd);
  }
});

test("pattern toolsets append captured defs when the supplier yields them (P04)", async () => {
  const extensionTools = () => [fakeTool("codegraph_search"), fakeTool("web_fetch_md")];
  const invocation = await requireBuiltin("code-review").resolve("/tmp", { diff: "d" }, { extensionTools });
  assert.equal(invocation.toolset, "code-review");
  const names = (invocation.tools ?? []).map((t) => t.name);
  assert.deepEqual(
    names,
    ["read", "grep", "find", "codegraph_search", "web_fetch_md"],
    "task-fit subset + captured defs append in registry order (first-wins dedupe)",
  );
});

test("codebase-audit resolve() bakes the given scope/checks into the impact-scoped generator output", async () => {
  const invocation = await requireBuiltin("codebase-audit").resolve("/tmp", {
    scope: "src/",
    checks: ["security", "performance"],
  });
  // P08: the resolved script is the generator output WITH the impact-analysis
  // phase injected (Impact Analysis first, every check embeds the partition).
  assert.notEqual(invocation.script, generateCodebaseAuditWorkflow("src/", ["security", "performance"]));
  assert.ok(invocation.script.includes("{ title: 'Impact Analysis' }"));
  assert.ok(invocation.script.includes("label: 'impact analysis'"));
  assert.ok(invocation.script.includes('+ scope + impactScopeBlock(), { label: "security" }'));
  assert.ok(invocation.script.includes("return { findings, validated, report, impactPartition };"));
});

test("debug-loop resolve() carries its task-fit toolset and rejects invalid args", async () => {
  const invocation = await requireBuiltin("debug-loop").resolve("/tmp", { bug: "b", maxRounds: 2 });
  assert.equal(invocation.script, generateDebugLoopWorkflow());
  assert.equal(invocation.toolset, "debug-loop");
  assert.deepEqual(
    (invocation.tools ?? []).map((t) => t.name),
    ["read", "grep", "find", "bash", "write"],
  );
  const resolve = requireBuiltin("debug-loop").resolve;
  await assert.rejects(() => resolve("/tmp", {}), /bug/);
  await assert.rejects(() => resolve("/tmp", { bug: "   " }), /bug/);
  await assert.rejects(() => resolve("/tmp", { bug: "b", maxRounds: 0 }), /maxRounds/);
  await assert.rejects(() => resolve("/tmp", { bug: "b", maxRounds: 7 }), /maxRounds/);
  await assert.rejects(() => resolve("/tmp", { bug: "b", reproduce: 42 }), /reproduce/);
});

test("spec-conformance resolve() carries its task-fit toolset and rejects invalid args", async () => {
  const spec = { goal: "g", requirements: [{ id: "R1", statement: "s" }] };
  const invocation = await requireBuiltin("spec-conformance").resolve("/tmp", { spec });
  // V2-QW4: the resolved script wraps the generator output with the
  // impact-analysis phase (every evidence agent embeds the partition).
  assert.notEqual(invocation.script, generateSpecConformanceWorkflow());
  assert.ok(invocation.script.includes("{ title: 'Impact Analysis' }"));
  assert.ok(invocation.script.includes("label: 'impact analysis'"));
  assert.ok(invocation.script.includes("report, trend, impactPartition }"));
  assert.equal(invocation.toolset, "spec-conformance");
  assert.deepEqual(
    (invocation.tools ?? []).map((t) => t.name),
    ["read", "grep", "find", "bash"],
  );
  const resolve = requireBuiltin("spec-conformance").resolve;
  await assert.rejects(() => resolve("/tmp", {}), /spec/);
  await assert.rejects(() => resolve("/tmp", { spec: "   " }), /spec/);
  await assert.rejects(() => resolve("/tmp", { spec, maxRequirements: 0 }), /maxRequirements/);
  await assert.rejects(() => resolve("/tmp", { spec, maxRequirements: 31 }), /maxRequirements/);
  await assert.rejects(() => resolve("/tmp", { spec, workspace: 42 }), /workspace/);
  // A spec-generation run result (with .spec) is a valid spec input.
  const runResult = await requireBuiltin("spec-conformance").resolve("/tmp", {
    spec: { spec, artifact: "x", error: "" },
  });
  assert.ok(runResult.script.length > 0);
});

test("codebase-audit resolve() rejects a missing scope or empty checks", async () => {
  const resolve = requireBuiltin("codebase-audit").resolve;
  await assert.rejects(() => resolve("/tmp", { checks: ["a"] }), /scope/);
  await assert.rejects(() => resolve("/tmp", { scope: "src/", checks: [] }), /checks/);
  await assert.rejects(() => resolve("/tmp", { scope: "src/" }), /checks/);
});

// ─── resolveWorkflowInvocation: precedence and fallback ────────────────────────

test(
  "resolveWorkflowInvocation falls back to the built-in pattern when nothing is saved",
  withTempCwd(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const resolved = await resolveWorkflowInvocation("deep-research", { question: "q" }, { storage, cwd });
    assert.ok(resolved);
    assert.equal(resolved.script, generateDeepResearchWorkflow());
    assert.equal(resolved.toolset, "web-research");
  }),
);

test(
  "resolveWorkflowInvocation prefers a project/user saved workflow over a built-in of the same name",
  withTempCwd(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const customScript = "export const meta = { name: 'custom_deep_research', description: 'override' }\nreturn 1";
    storage.save({ name: "deep-research", description: "custom override", script: customScript, location: "project" });

    const resolved = await resolveWorkflowInvocation("deep-research", { question: "q" }, { storage, cwd });
    assert.ok(resolved);
    assert.equal(resolved.script, customScript);
    // The saved workflow wins outright — it does not carry the built-in's
    // web-research exec context, since it is a wholly different script.
    assert.equal(resolved.toolset, undefined);
    assert.equal(parseWorkflowScript(resolved.script).meta.name, "custom_deep_research");
  }),
);

test(
  "resolveWorkflowInvocation returns undefined for a name that is neither saved nor built-in",
  withTempCwd(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.equal(await resolveWorkflowInvocation("not-a-real-workflow", {}, { storage, cwd }), undefined);
  }),
);

// ─── Every registered script actually parses ───────────────────────────────────

test("every built-in pattern's resolve() output is a parseable workflow script", async () => {
  const validArgsByName: Record<string, unknown> = {
    "deep-research": { question: "q" },
    "adversarial-review": { task: "t" },
    "code-review": { diff: "d" },
    "multi-perspective": { topic: "t" },
    "codebase-audit": { scope: "s", checks: ["c"] },
    "plan-then-execute": { objective: "o" },
    "spec-generation": { topic: "t" },
    "debug-loop": { bug: "b" },
    "spec-conformance": { spec: { goal: "g", requirements: [{ id: "R1", statement: "s" }] } },
    "supervised-run": { task: "t", criterion: "c" },
    "review-remediate": { diff: "d" },
    "multi-model": { task: "t", models: ["a/b", "c/d"] },
  };
  for (const descriptor of BUILTIN_WORKFLOWS) {
    const { script } = await descriptor.resolve("/tmp", validArgsByName[descriptor.name]);
    const { meta } = parseWorkflowScript(script);
    assert.ok(meta.name, `${descriptor.name} script should declare export const meta.name`);
  }
});
