import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage, WorkflowAgent } from "../src/agent.js";
import { BUILTIN_WORKFLOW_NAMES } from "../src/builtin-workflows.js";
import { MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "../src/config.js";
import { createWorkflowSnapshot, recomputeWorkflowSnapshot } from "../src/display.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import {
  backgroundStartedText,
  createWorkflowTool,
  formatCompletedResultText,
  WORKFLOW_GATE_GUIDELINE,
  type WorkflowToolInput,
} from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

/** Minimal fake ModelRegistry, matching the shape used by workflow manager tests. */
function fakeRegistry(models: Array<{ provider: string; id: string }>) {
  return {
    getAvailable: () => models,
    find: () => undefined,
    getAll: () => models,
  } as any;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parameterDescription(tool: ReturnType<typeof createWorkflowTool>, name: string): string {
  const parameters = tool.parameters;
  const properties = isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : {};
  const parameter = properties[name];
  return isRecord(parameter) && typeof parameter.description === "string" ? parameter.description : "";
}

// ─── backgroundStartedText ─────────────────────────────────────────────────────

test("backgroundStartedText tells the user it auto-continues and they can wait", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  assert.match(text, /wait here/i);
  assert.match(text, /continues automatically|resume the conversation/i);
  assert.match(text, /other things/i);
  assert.match(text, /\/workflows status abc-123/);
});

// ─── formatCompletedResultText ─────────────────────────────────────────────────

test("formatCompletedResultText truncates oversized result dumps with a pointer to the full value", () => {
  const big = { findings: [{ text: "x".repeat(5_000) }] };
  const result = {
    meta: { name: "fanout", description: "d" },
    result: big,
    logs: [],
    phases: [],
    agentCount: 3,
    durationMs: 120,
    runId: "fanout-1",
    tokenUsage: { input: 10, output: 5, total: 15, cost: 0 },
  };
  const text = formatCompletedResultText(result);
  assert.ok(text.includes("result truncated"), "truncation must be announced");
  assert.ok(text.includes("/workflows status fanout-1"), "truncation note points at the persisted run");
  assert.ok(text.length < 8_000, "the inline dump must not carry the whole oversized result");
});

test("formatCompletedResultText maps legacy numeric failure codes to their names", () => {
  const result = {
    meta: { name: "fanout", description: "d" },
    result: { ok: true },
    logs: [],
    phases: [],
    agentCount: 1,
    durationMs: 120,
    runId: "fanout-1",
    failedAgents: [{ label: "a1", error: "blocked", errorCode: WorkflowErrorCode.APPROVAL_REQUIRED }],
    tokenUsage: { input: 10, output: 5, total: 15, cost: 0 },
  };
  const text = formatCompletedResultText(result);
  assert.ok(!text.includes("-31003"), "raw numeric code must not leak into the failure row");
  assert.ok(text.includes("APPROVAL_REQUIRED (human approval required)"), "numeric code renders as its label");
});

test("formatCompletedResultText keeps the legacy completion lead for snapshot-less callers", () => {
  const result = {
    meta: { name: "fanout", description: "d" },
    result: { ok: true },
    logs: [],
    phases: [],
    agentCount: 3,
    durationMs: 120,
    runId: "fanout-1",
    tokenUsage: { input: 10, output: 5, total: 15, cost: 0 },
  };
  const text = formatCompletedResultText(result);
  assert.ok(text.startsWith("Workflow **fanout** completed with **3** agent(s)."), "legacy lead must be preserved");
});

test("formatCompletedResultText leads with the canonical status block when a snapshot is provided", () => {
  const result = {
    meta: { name: "fanout", description: "d" },
    result: { ok: true },
    logs: [],
    phases: ["Research", "Build"],
    agentCount: 2,
    durationMs: 125_000,
    runId: "fanout-1",
    tokenUsage: { input: 500, output: 300, total: 800, cost: 0 },
  };
  const snapshot = recomputeWorkflowSnapshot(
    createWorkflowSnapshot({ name: "fanout", description: "d", phases: [{ title: "Research" }, { title: "Build" }] }),
  );
  snapshot.startedAtMs = Date.now() - 125_000;
  snapshot.tokenBudget = 2000;
  snapshot.tokenUsage = { input: 500, output: 300, total: 800, cost: 0 };
  snapshot.agents = [
    { id: 1, label: "r-agent", status: "done", phase: "Research", prompt: "x" },
    { id: 2, label: "b-agent", status: "done", phase: "Build", prompt: "x" },
  ] as never[];
  const text = formatCompletedResultText(result, recomputeWorkflowSnapshot(snapshot));
  // Canonical word + glyph lead the header, with elapsed and the budget bar.
  assert.match(text, /^Workflow completed ✓: fanout \(2\/2 done/, `block header, got: ${text.split("\n")[0]}`);
  assert.match(text, /· 2m 05s/, "elapsed survives in the final header");
  assert.ok(text.includes("[████░░░░░░] 40%"), "budget bar renders when a tokenBudget is present");
  // Phase checklist with per-phase counts, then the result sections.
  assert.match(text, /✓ Research 1\/1/, "phase line with per-phase counts");
  assert.ok(text.includes("## Result"), "result section follows the block");
  assert.ok(!text.includes("completed with **"), "legacy lead must not duplicate the block header");
});

test("formatCompletedResultText uses the live snapshot's counts in the final block header", () => {
  const result = {
    meta: { name: "fanout", description: "d" },
    result: { ok: true },
    logs: [],
    phases: [],
    agentCount: 1,
    durationMs: 0,
    runId: "fanout-1",
    tokenUsage: undefined,
  };
  const snapshot = createWorkflowSnapshot({ name: "fanout", description: "d" });
  snapshot.agents = [{ id: 1, label: "a1", status: "running", phase: "Research", prompt: "x" }] as never[];
  const text = formatCompletedResultText(result, recomputeWorkflowSnapshot(snapshot));
  assert.match(text, /Workflow completed ✓: fanout \(0\/1 done, 1 running\)/, "block header names the true counts");
  assert.ok(text.includes("## Result"), "result section still follows");
});

// ─── createWorkflowTool ────────────────────────────────────────────────────────

test("createWorkflowTool has correct name and label", () => {
  const tool = createWorkflowTool();
  assert.equal(tool.name, "workflow");
  assert.equal(tool.label, "Workflow");
});

test("createWorkflowTool description states its delegation capability", () => {
  const description = createWorkflowTool().description;

  assert.match(description, /JavaScript workflow.*delegates work to subagents/i);
  assert.match(description, /agent\(\).*optionally composing calls.*parallel\(\).*pipeline\(\)/i);
  assert.doesNotMatch(description, /deterministic|required raw JavaScript|export const meta/i);
});

test("createWorkflowTool has parameters defined", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.parameters, "should have parameters schema");
});

test("createWorkflowTool has execute function", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWorkflowTool has renderCall and renderResult", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("createWorkflowTool promptSnippet describes delegation and optional composition", () => {
  const snippet = createWorkflowTool().promptSnippet ?? "";

  assert.match(snippet, /delegate substantive .* work to subagents/i);
  assert.match(snippet, /optionally composing agent calls/i);
  assert.match(snippet, /parallel\(\)/);
  assert.match(snippet, /pipeline\(\)/);
  assert.match(snippet, /or both/i);
  assert.doesNotMatch(snippet, /required script header|export const meta/i);
});

test("createWorkflowTool keeps permanent guidance to the single upstream gate", () => {
  const guidance = createWorkflowTool().promptGuidelines;

  assert.deepEqual(guidance, [WORKFLOW_GATE_GUIDELINE]);
  assert.match(guidance[0], /ONLY call it when the user explicitly opts in/i);
  assert.match(guidance[0], /you may briefly offer it \(with a rough cost\)/i);
  assert.doesNotMatch(guidance[0], /export const meta|parallel\(\) requires functions/i);
});

test("createWorkflowTool permanent guidance omits conditional catalogs and recipes", () => {
  const all = (createWorkflowTool().promptGuidelines ?? []).join(" ");

  assert.doesNotMatch(all, /Available agentTypes:/i);
  assert.doesNotMatch(all, /currently available models/i);
  assert.doesNotMatch(all, /verify\(|judgePanel\(|loopUntilDry\(|completenessCheck\(/i);
  assert.doesNotMatch(all, /tokenBudget|agentTimeoutMs|agentRetries/i);
});

test("createWorkflowTool keeps script syntax in the parameter schema", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "script");

  assert.match(description, /raw JavaScript workflow script.*no Markdown fences/i);
  assert.match(description, /First statement: export const meta = \{ name:.*description:.*\}\. Add phases:/i);
  assert.doesNotMatch(
    description,
    /First statement: export const meta = \{ name: '[^']+', description: '[^']+', phases:/i,
  );
  assert.match(description, /phases.*only when.*named phases.*declare only phases it will use/i);
  assert.match(description, /multiple phases.*phase\('Exact Title'\).*agent options/i);
  assert.match(description, /await workflow\(savedName, childArgs\).*saved workflow inline/i);
  assert.match(description, /nesting.*one level.*parent run's concurrency, agent, and token limits/i);
  assert.match(
    description,
    /Optional helpers.*verify\(\), judgePanel\(\), loopUntilDry\(\), completenessCheck\(\).*retry\(\), gate\(\).*budget.*workflow-authoring skill/i,
  );
  assert.match(description, /optional `agentType` option.*named user or project definition/i);
  assert.match(description, /bind tools, a model, and role instructions/i);
  assert.match(description, /name and purpose.*provided in context/i);
  assert.match(description, /bound model overrides `tier`.*explicit `model` overrides both/i);
  assert.match(description, /plain JavaScript only.*imports.*require\(\).*filesystem modules/i);
  assert.match(description, /Date\.now\(\).*Math\.random\(\).*new Date\(\).*unavailable/i);
  assert.match(description, /args, cwd, process\.cwd\(\), and budget/i);
  assert.match(description, /must call agent\(\) at least once/i);
  assert.match(description, /parallel\(\) requires functions, not promises.*results in input order/i);
  assert.match(description, /pipeline\(items, \.\.\.stages\).*stages sequentially.*items proceed concurrently/i);
  assert.match(description, /each stage receives.*previousValue.*originalItem.*index/i);

  const guidance = (tool.promptGuidelines ?? []).join(" ");
  assert.doesNotMatch(guidance, /Markdown fences|First statement: export const meta/i);
  assert.doesNotMatch(guidance, /Date\.now\(\)|Math\.random\(\)|new Date\(\)/i);
  assert.doesNotMatch(guidance, /parallel\(\) requires functions, not promises|results in input order/i);
  assert.doesNotMatch(guidance, /each stage receives.*previousValue.*originalItem.*index/i);
});

test("createWorkflowTool declares `args` as an explicitly typed object, not a typeless Type.Any() schema", () => {
  // Regression test: `args` used to be `Type.Any()`, which compiles to a
  // schema with no "type" keyword at all (just `{ description }`). At least
  // one MCP/tool-calling bridge does not treat a typeless property as
  // "accept any JSON value" — it coerces/flattens the value before the
  // handler ever sees it, so every named built-in pattern's required args
  // field (e.g. `args.scope` for codebase-audit, `args.question` for
  // deep-research) silently arrives as `undefined`, regardless of what the
  // caller actually sent — making name-based invocation of every built-in
  // pattern fail on that bridge. Every built-in pattern's `args` is a JSON
  // object at the top level, so it must be declared `type: "object"`.
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties: Record<string, unknown> };
  const argsSchema = parameters.properties.args as Record<string, unknown> | undefined;

  assert.ok(argsSchema, "tool.parameters.properties.args should exist");
  assert.equal(argsSchema?.type, "object", "args schema must declare an explicit object type");
  assert.equal(
    typeof argsSchema?.description,
    "string",
    "args schema should keep its description alongside the explicit type",
  );
});

test("createWorkflowTool keeps background behavior in the parameter schema", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "background");

  assert.match(description, /Default: true/i);
  assert.match(description, /result is delivered back.*when it finishes/i);
  assert.match(description, /false only when.*result inline.*same turn/i);
  assert.doesNotMatch((tool.promptGuidelines ?? []).join(" "), /runs are background by default/i);
});

test("createWorkflowTool schema describes the configured or unbounded timeout", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "agentTimeoutMs");

  assert.match(description, /Omit to use configured `defaultAgentTimeoutMs`/i);
  assert.match(description, /without one.*no hard timeout/i);
  assert.match(description, /only when the user asks/i);
});

test("createWorkflowTool schema uses the agreed token-budget wording exactly", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "tokenBudget");

  assert.equal(
    description,
    "Optional user-requested soft spend gate, not a planning target. Do not set `tokenBudget` unless the user explicitly supplies a cap or asks you to choose one; never infer or invent one from task size. If omitted, the configured `defaultTokenBudget` applies; without one, the run is unlimited. Reaching the gate blocks later `agent()` calls; concurrent in-flight work can overshoot.",
  );
});

test("createWorkflowTool schema exposes resource controls and large-fan-out authority", () => {
  const tool = createWorkflowTool();

  assert.match(parameterDescription(tool, "concurrency"), /Maximum concurrent agents/i);
  assert.match(parameterDescription(tool, "agentRetries"), /Retry attempts/i);
  assert.match(parameterDescription(tool, "maxAgents"), /1000.*safety ceiling, not a target/i);
  assert.match(parameterDescription(tool, "maxAgents"), /lower limit.*dynamic or exploratory fan-out/i);
  assert.match(parameterDescription(tool, "maxAgents"), /large fan-outs.*explicit user intent/i);
});

test("createWorkflowTool invalid args throws descriptive error", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    assert.throws(() => prepare({ script: 123 }), /script.*string/);
    assert.throws(() => prepare("not-an-object"), /object argument/);
    assert.throws(() => prepare({}), /script.*name/i, "neither `script` nor `name` should throw clearly");
    // A malformed `script` alongside `name` must not be silently coerced away
    // — it should throw the same way a malformed script-only call does.
    assert.throws(() => prepare({ name: "deep-research", script: 123 }), /script.*string/i);
  }
});

test("createWorkflowTool with custom cwd creates tool", () => {
  const tool = createWorkflowTool({ cwd: "/tmp" });
  assert.equal(tool.name, "workflow");
});

test("createWorkflowTool does not add configured model IDs to permanent guidance", () => {
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "private-model" }]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });

  assert.doesNotMatch((tool.promptGuidelines ?? []).join(" "), /router\/private-model/);

  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "later-private-model" }]));
  assert.doesNotMatch((tool.promptGuidelines ?? []).join(" "), /router\/later-private-model/);
});

// ─── prepareArguments / normalizeWorkflowScript ─────────────────────────────────

test("createWorkflowTool prepareArguments strips markdown fences from script", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```js\nconst x = 1\n```",
    });
    assert.equal(result.script, "const x = 1");
  }
});

test("createWorkflowTool prepareArguments strips javascript fences", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```\nexport const meta = { name: 't', description: 't' }\n```",
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
  }
});

test("createWorkflowTool prepareArguments passes through args", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => {
      script: string;
      args?: unknown;
      maxAgents?: number;
      concurrency?: number;
      agentRetries?: number;
    };
    const result = prepare({
      script: "export const meta = { name: 't', description: 't' }",
      args: { question: "test" },
      maxAgents: 5,
      concurrency: 2,
      agentRetries: 1,
      retryBackoffMs: 0,
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
    assert.deepEqual(result.args, { question: "test" });
    assert.equal(result.maxAgents, 5);
    assert.equal(result.concurrency, 2);
    assert.equal(result.agentRetries, 1);
  }
});

// ─── resumeFromRunId (edited-script iteration) ─────────────────────────────────

const resumeToolScript = `export const meta = { name: 'resume_tool', description: 'one agent' }
const a = await agent('do it', { label: 'a' })
return { a }`;

function toolFakeAgent(result: unknown = "ok") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return result;
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

function deferredToolAgent() {
  let resolveFn: ((v: unknown) => void) | null = null;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  return {
    resolve: (v: unknown = "done") => resolveFn?.(v),
    runner: {
      async run() {
        return promise;
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

/** Fake agent that hangs until its abort signal fires, then rejects. */
function abortableToolAgent() {
  return {
    async run(_prompt: string, options?: { signal?: AbortSignal }) {
      return new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}

function withToolTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tool-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-tool-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

test("workflowToolSchema exposes resumeFromRunId, script, and name as optional at the schema level", () => {
  const tool = createWorkflowTool();
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.resumeFromRunId, "resumeFromRunId should be a schema property");
  assert.ok(schema.properties.name, "name should be a schema property");
  // Neither `script` nor `name` is in the schema's `required` list — exactly one
  // is required at runtime (normalizeWorkflowToolArgs enforces it), because
  // TypeBox's flat object schema can't express an either/or constraint.
  assert.ok(!(schema.required ?? []).includes("script"), "script is schema-optional (name is the alternative)");
  assert.ok(!(schema.required ?? []).includes("name"), "name is schema-optional (script is the alternative)");
  assert.ok(!(schema.required ?? []).includes("resumeFromRunId"), "resumeFromRunId is optional");
});

test(
  "workflow tool: resumeFromRunId pointing at a nonexistent run errors and creates no new run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "t1",
          { script: resumeToolScript, resumeFromRunId: "no-such-run" },
          undefined,
          undefined,
          {} as never,
        ),
      /no run with that ID|not found/i,
    );
    assert.equal(manager.listRuns().length, 0, "no new run should be created on a failed resume");
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a completed run errors clearly",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    // Create + complete a run.
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await promise;
    assert.equal(manager.getRun(runId)?.status, "completed");
    await assert.rejects(
      () => tool.execute("t2", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, {} as never),
      /already completed/i,
    );
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a running run errors clearly",
  withToolTempCwd(async (cwd) => {
    const da = deferredToolAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.getRun(runId)?.status, "running");
    await assert.rejects(
      () => tool.execute("t3", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, {} as never),
      /still running/i,
    );
    da.resolve("ok");
    await promise.catch(() => {});
  }),
);

test(
  "workflow tool: omitting resumeFromRunId preserves new-run background behavior",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute("t4", { script: resumeToolScript }, undefined, undefined, {} as never);
    const details = res.details as { runId?: string; background?: boolean; resumedFrom?: string };
    assert.ok(details.runId, "a new run id should be returned");
    assert.equal(details.background, true);
    assert.equal(details.resumedFrom, undefined, "a fresh run is not a resume");
    assert.equal(manager.listRuns().length, 1, "exactly one new run created");
    // M18: a just-started background run is not resumable, so the background
    // text must NOT advertise the resumeFromRunId iterate path — only paused/
    // failed runs are resumable (their hint comes from the error/result paths).
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.doesNotMatch(text, /resumeFromRunId/, "background text must not advertise resume (M18)");
  }),
);

test(
  "workflow tool: resumeFromRunId resumes a paused run with the edited script",
  withToolTempCwd(async (cwd) => {
    const seen: string[] = [];
    let failSecond = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          seen.push(prompt);
          if (prompt.includes("SECOND-ORIG") && failSecond) {
            throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
              recoverable: false,
              resetHint: "soon",
            });
          }
          return `ran:${prompt}`;
        },
      } as unknown as Pick<WorkflowAgent, "run">,
    });
    manager.on("paused", () => {});
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });

    const v1 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-ORIG', { label: 'second' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(v1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    failSecond = false;
    const v2 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-EDITED', { label: 'second' })
return { a, b }`;
    const seenBefore = seen.length;
    const res = await tool.execute("t5", { script: v2, resumeFromRunId: runId }, undefined, undefined, {} as never);
    const details = res.details as { runId?: string; resumedFrom?: string };
    assert.equal(details.runId, runId, "resumed run keeps the same run id");
    assert.equal(details.resumedFrom, runId);
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, new RegExp(`resumed from run ${runId}`), "text names the resumed run");

    await new Promise((r) => setTimeout(r, 80));
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal((finalRun?.result?.result as { b?: string } | undefined)?.b, "ran:SECOND-EDITED");
    const during = seen.slice(seenBefore);
    assert.ok(!during.includes("FIRST"), "unchanged agent 1 replays from journal");
    assert.ok(during.includes("SECOND-EDITED"), "edited agent 2 re-runs live");
    // No extra run created — resume reuses the same id.
    assert.equal(manager.listRuns().length, 1, "resume does not create a second run");
  }),
);

test(
  "workflow tool: resumeFromRunId forwards run knobs (tokenBudget) to the resumed execution",
  withToolTempCwd(async (cwd) => {
    // 'first' spends 100 (journaled), 'second' hangs on its first attempt
    // (pause point) then spends 60 post-resume, 'third' spends 1 — total 161.
    // The run STARTS at tokenBudget 150, so the persisted cap would block
    // 'third' on resume and fail the run. Passing tokenBudget: 1000 through
    // the tool's resumeFromRunId call must override the cap and complete —
    // proving the tool forwards the knob and the manager honors the override.
    let secondAttempts = 0;
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const agent = {
      async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
        if (prompt === "first") {
          options?.onUsage?.({ ...zeroUsage, total: 100 });
          return "first-result";
        }
        if (prompt === "second") {
          if (++secondAttempts === 1) return new Promise(() => {}); // hang until paused
          options?.onUsage?.({ ...zeroUsage, total: 60 });
          return "second-result";
        }
        options?.onUsage?.({ ...zeroUsage, total: 1 });
        return "third-result";
      },
    } as unknown as Pick<WorkflowAgent, "run">;
    const manager = new WorkflowManager({ cwd, agent });
    manager.on("paused", () => {});
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });

    const script = `export const meta = { name: 'override_tool', description: 'knob override via tool resume' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
const c = await agent('third', { label: 'third' })
return { a, b, c }`;
    const { runId, promise } = manager.startInBackground(script, undefined, { tokenBudget: 150 });
    promise.catch(() => {});
    for (let i = 0; i < 200 && secondAttempts === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(secondAttempts, 1, "'second' should be in flight before pausing");
    assert.equal(manager.pause(runId), true);

    const res = await tool.execute(
      "t-override",
      { script, resumeFromRunId: runId, tokenBudget: 1000 },
      undefined,
      undefined,
      {} as never,
    );
    const details = res.details as { runId?: string };
    assert.equal(details.runId, runId, "resumed run keeps the same run id");

    for (let i = 0; i < 200 && manager.getRun(runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "tool-forwarded tokenBudget override lets the run finish (161 < 1000)");
    assert.equal(
      manager.getPersistence().load(runId)?.tokenBudget,
      1000,
      "the overridden budget is the run's new persisted cap",
    );
  }),
);

// ─── `name`: reach a saved or built-in workflow without writing a script ───────

const validArgsByBuiltinName: Record<string, unknown> = {
  "deep-research": { question: "what is pi?" },
  "adversarial-review": { task: "investigate this" },
  "code-review": { diff: "some diff" },
  "multi-perspective": { topic: "a topic" },
  "codebase-audit": { scope: "src/", checks: ["security"] },
  "plan-then-execute": { objective: "do the thing" },
  "spec-generation": { topic: "a topic" },
};

test(
  "workflow tool: `name` resolves each of the 7 built-in patterns and starts a run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });

    for (const name of BUILTIN_WORKFLOW_NAMES) {
      const res = await tool.execute(
        `name-${name}`,
        { name, args: validArgsByBuiltinName[name] },
        undefined,
        undefined,
        {} as never,
      );
      const details = res.details as { runId?: string; background?: boolean };
      const runId = details.runId;
      assert.ok(runId, `${name} should start a run`);
      assert.equal(details.background, true);
      const managed = manager.getRun(runId);
      assert.ok(managed, `${name} run should be tracked by the manager`);
    }
    // Let the fire-and-forget background runs settle before the test tears down.
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: `name` carries deep-research's web-research exec context through the run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute(
      "name-deep-research",
      { name: "deep-research", args: { question: "what is pi?" } },
      undefined,
      undefined,
      {} as never,
    );
    const details = res.details as { runId?: string };
    const runId = details.runId;
    assert.ok(runId, "deep-research should start a run");
    const managed = manager.getRun(runId);
    assert.equal(managed?.toolset, "web-research", "the run should carry the web-research toolset tag");
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: a saved workflow of the same name takes precedence over a built-in",
  withToolTempCwd(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const customScript = "export const meta = { name: 'custom_deep_research', description: 'override' }\nreturn 1";
    storage.save({ name: "deep-research", description: "custom override", script: customScript, location: "project" });
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, storage });

    const res = await tool.execute(
      "name-precedence",
      { name: "deep-research", args: { question: "irrelevant here" } },
      undefined,
      undefined,
      {} as never,
    );
    const details = res.details as { runId?: string };
    const runId = details.runId;
    assert.ok(runId, "the run should start");
    const managed = manager.getRun(runId);
    assert.equal(managed?.snapshot.name, "custom_deep_research", "the saved workflow should win, not the built-in");
    assert.equal(managed?.toolset, undefined, "the saved workflow does not carry the built-in's exec context");
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: an unknown `name` throws a clear error naming the built-ins",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("bad-name", { name: "not-a-real-workflow" }, undefined, undefined, {} as never),
      /no saved or built-in workflow named "not-a-real-workflow"/,
    );
  }),
);

test(
  "workflow tool: invalid args for a built-in surface a descriptive error",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("bad-args", { name: "deep-research", args: {} }, undefined, undefined, {} as never),
      /question/,
    );
  }),
);

test(
  "workflow tool: `name` cannot be combined with `resumeFromRunId`",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "bad-combo",
          { name: "deep-research", args: { question: "q" }, resumeFromRunId: "some-run" },
          undefined,
          undefined,
          {} as never,
        ),
      /cannot be combined with `resumeFromRunId`/,
    );
  }),
);

test(
  "workflow tool: `name` cannot be combined with `script`",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "bad-combo-2",
          { name: "deep-research", script: resumeToolScript, args: { question: "q" } },
          undefined,
          undefined,
          {} as never,
        ),
      /cannot be combined with `script`/,
    );
    // The rejected call must not have started any run.
    assert.equal(manager.listRuns().length, 0);
  }),
);

// ─── dryRun (validate without launching) ──────────────────────────────────────

test(
  "workflow tool: dryRun validates a script and launches no run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute(
      "dry-1",
      { script: resumeToolScript, dryRun: true },
      undefined,
      undefined,
      {} as never,
    );
    const details = res.details as { dryRun?: boolean; name?: string; phases?: string[] };
    assert.equal(details.dryRun, true);
    assert.equal(details.name, "resume_tool");
    assert.deepEqual(details.phases, []);
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, /validated/);
    assert.equal(manager.listRuns().length, 0, "dryRun must not create a run");
  }),
);

test(
  "workflow tool: dryRun validates a named workflow and launches no run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute(
      "dry-2",
      { name: "deep-research", args: { question: "what is pi?" }, dryRun: true },
      undefined,
      undefined,
      {} as never,
    );
    const details = res.details as { dryRun?: boolean; name?: string };
    assert.equal(details.dryRun, true);
    assert.equal(details.name, "deep_research");
    assert.equal(manager.listRuns().length, 0, "dryRun must not create a run");
  }),
);

test(
  "workflow tool: dryRun cannot be combined with resumeFromRunId",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "dry-3",
          { script: resumeToolScript, dryRun: true, resumeFromRunId: "some-run" },
          undefined,
          undefined,
          {} as never,
        ),
      /dryRun.*resumeFromRunId|resumeFromRunId.*dryRun/,
    );
  }),
);

// ─── scriptPath (file-based script source) ────────────────────────────────────

const scriptPathScript = `export const meta = { name: 'file_script', description: 'read from disk' }
const a = await agent('do it', { label: 'a' })
return { a }`;

function writeScriptFile(cwd: string, rel: string, content: string): string {
  const absolute = join(cwd, rel);
  mkdirSync(join(cwd, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return absolute;
}

test("workflow tool schema exposes scriptPath as an optional property", () => {
  const tool = createWorkflowTool();
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.scriptPath, "scriptPath should be a schema property");
  assert.ok(!(schema.required ?? []).includes("scriptPath"), "scriptPath is optional");
  const parameter = schema.properties.scriptPath as { description?: string };
  assert.match(parameter.description ?? "", /cwd/);
  assert.match(parameter.description ?? "", /Mutually exclusive/);
});

test("workflow tool prepareArguments passes scriptPath through and rejects non-strings", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => WorkflowToolInput;
    const result = prepare({ scriptPath: "scripts/wf.mjs" });
    assert.equal(result.scriptPath, "scripts/wf.mjs");
    assert.throws(() => prepare({ scriptPath: 42 }), /scriptPath.*must be a string/);
    assert.throws(() => prepare({ name: "deep-research", scriptPath: 42 }), /scriptPath.*must be a string/);
  }
});

test(
  "workflow tool: scriptPath dryRun reads the file and validates without launching",
  withToolTempCwd(async (cwd) => {
    writeScriptFile(cwd, "scripts/wf.mjs", scriptPathScript);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute(
      "file-1",
      { scriptPath: "scripts/wf.mjs", dryRun: true },
      undefined,
      undefined,
      {} as never,
    );
    const details = res.details as { dryRun?: boolean; name?: string };
    assert.equal(details.dryRun, true);
    assert.equal(details.name, "file_script");
    assert.equal(manager.listRuns().length, 0, "dryRun must not create a run");
  }),
);

test(
  "workflow tool: scriptPath resolves absolute paths as-is",
  withToolTempCwd(async (cwd) => {
    const absolute = writeScriptFile(cwd, "abs-script.mjs", scriptPathScript);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute("file-2", { scriptPath: absolute, dryRun: true }, undefined, undefined, {} as never);
    assert.equal((res.details as { name?: string }).name, "file_script");
  }),
);

test(
  "workflow tool: scriptPath starts a background run with the file content as the script",
  withToolTempCwd(async (cwd) => {
    writeScriptFile(cwd, "scripts/wf.mjs", scriptPathScript);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute("file-3", { scriptPath: "scripts/wf.mjs" }, undefined, undefined, {} as never);
    const details = res.details as { runId?: string; background?: boolean };
    assert.ok(details.runId, "a run id should be returned");
    assert.equal(details.background, true);
    const run = manager.getRun(details.runId);
    assert.equal(run?.script, scriptPathScript, "the run script should be the file content");
    await new Promise((r) => setTimeout(r, 20));
  }),
);

test(
  "workflow tool: scriptPath pointing at a missing file rejects with the resolved path",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("file-4", { scriptPath: "nope/wf.mjs" }, undefined, undefined, {} as never),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /cannot read scriptPath/);
        assert.match(message, /nope.wf.mjs/);
        assert.match(message, /cwd/);
        return true;
      },
    );
    assert.equal(manager.listRuns().length, 0, "no run on a read failure");
  }),
);

test(
  "workflow tool: scriptPath pointing at an empty file rejects",
  withToolTempCwd(async (cwd) => {
    writeScriptFile(cwd, "empty.mjs", "   \n  ");
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("file-5", { scriptPath: "empty.mjs" }, undefined, undefined, {} as never),
      /which is empty/,
    );
  }),
);

test(
  "workflow tool: scriptPath cannot be combined with script or name",
  withToolTempCwd(async (cwd) => {
    writeScriptFile(cwd, "wf.mjs", scriptPathScript);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () =>
        tool.execute("file-6", { scriptPath: "wf.mjs", script: scriptPathScript }, undefined, undefined, {} as never),
      /script.*cannot be combined.*scriptPath|scriptPath.*cannot be combined.*script/,
    );
    await assert.rejects(
      () => tool.execute("file-7", { scriptPath: "wf.mjs", name: "deep-research" }, undefined, undefined, {} as never),
      /name.*cannot be combined.*scriptPath|scriptPath.*cannot be combined.*name/,
    );
    assert.equal(manager.listRuns().length, 0, "conflicting inputs must not launch a run");
  }),
);

test("workflow tool: neither script, scriptPath, nor name rejects with all three named", () => {
  const tool = createWorkflowTool();
  const prepare = tool.prepareArguments as (args: unknown) => WorkflowToolInput;
  assert.throws(() => prepare({}), /script.*scriptPath.*name/);
});

// ─── schema numeric bounds (reject malformed model calls early) ───────────────

test("workflow tool schema bounds numeric parameters", () => {
  const tool = createWorkflowTool();
  const properties = (tool.parameters as { properties: Record<string, any> }).properties;

  assert.equal(properties.maxAgents.minimum, 1);
  assert.equal(properties.maxAgents.maximum, MAX_AGENTS_PER_RUN);
  assert.equal(properties.concurrency.minimum, 1);
  assert.equal(properties.concurrency.maximum, MAX_CONCURRENCY);
  assert.equal(properties.agentRetries.minimum, 0);
  assert.equal(properties.agentRetries.maximum, MAX_AGENT_RETRIES);
  assert.equal(properties.agentTimeoutMs.minimum, 1);
  assert.equal(properties.tokenBudget.minimum, 1);
});

// ─── saved workflows: typed args (coerce/validate against declared schema) ────

const typedArgsScript = "export const meta = { name: 'typed_args', description: 'typed' }\nreturn 1";

function saveTypedWorkflow(cwd: string) {
  const storage = createWorkflowStorage(cwd);
  storage.save({
    name: "typed",
    description: "typed args",
    script: typedArgsScript,
    parameters: {
      count: { type: "integer", required: true, description: "how many" },
      tag: { type: "string", default: "default-tag" },
      verbose: { type: "boolean", default: false },
    },
    location: "project",
  });
  return storage;
}

test(
  "workflow tool: a saved workflow coerces args against its declared parameter schema",
  withToolTempCwd(async (cwd) => {
    const storage = saveTypedWorkflow(cwd);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, storage });

    // CLI-ish string values are coerced to the declared types before launch.
    const res = await tool.execute(
      "typed-1",
      { name: "typed", args: { count: "42", verbose: "true" } },
      undefined,
      undefined,
      {} as never,
    );
    const runId = (res.details as { runId?: string }).runId;
    assert.ok(runId, "run should start");
    const run = manager.getRun(runId);
    assert.deepEqual(run?.args, { count: 42, tag: "default-tag", verbose: true });
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: a saved workflow's missing required arg fails before launch",
  withToolTempCwd(async (cwd) => {
    const storage = saveTypedWorkflow(cwd);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager, storage });
    await assert.rejects(
      () => tool.execute("typed-2", { name: "typed", args: {} }, undefined, undefined, {} as never),
      /Missing required argument: count/,
    );
    assert.equal(manager.listRuns().length, 0, "validation failure must not create a run");
  }),
);

test(
  "workflow tool: a saved workflow's mistyped arg fails before launch",
  withToolTempCwd(async (cwd) => {
    const storage = saveTypedWorkflow(cwd);
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager, storage });
    await assert.rejects(
      () =>
        tool.execute("typed-3", { name: "typed", args: { count: "not-a-number" } }, undefined, undefined, {} as never),
      /args\.count must be an integer/,
    );
    assert.equal(manager.listRuns().length, 0, "validation failure must not create a run");
  }),
);

// ─── background: false — synchronous (blocking) execute path ──────────────────

const noAgentScript = "export const meta = { name: 'no_agents', description: 'none' }\nreturn { ok: true }";

test(
  "workflow tool: background:false runs synchronously and returns the blocking result",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute(
      "sync-1",
      { script: resumeToolScript, background: false },
      undefined,
      undefined,
      {} as never,
    );
    const details = res.details as { runId?: string; agentCount?: number; result?: unknown };
    assert.ok(details.runId, "sync run should produce a run id");
    assert.equal(details.agentCount, 1, "the blocking result reports the agent count");
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    // The final text leads with the canonical single-glance status block —
    // canonical glyph + word + counts (the engine's token segment may follow)
    // — instead of the old wordy lead line.
    assert.match(text, /^Workflow completed ✓: resume_tool \(1\/1 done/, "completed block leads the final text");
    assert.match(text, /## Result/, "result section follows the block");
    assert.match(text, /"a": "ok"/, "result dump survives");
    const runId = details.runId;
    assert.ok(runId);
    assert.equal(manager.getRun(runId)?.status, "completed", "sync run is tracked and completes");
  }),
);

test(
  "workflow tool: background:false aborts when the external signal aborts",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: abortableToolAgent() });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const controller = new AbortController();
    const execution = tool.execute(
      "sync-2",
      { script: resumeToolScript, background: false },
      controller.signal,
      undefined,
      {} as never,
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => execution, /Workflow was aborted/);
  }),
);

test(
  "workflow tool: background:false throws when the workflow never calls agent()",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("sync-3", { script: noAgentScript, background: false }, undefined, undefined, {} as never),
      /must call agent\(\) at least once/,
    );
  }),
);
