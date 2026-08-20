/**
 * SLICE H3 — V2-N4 pre-flight cost & duration forecast
 * (`workflow --estimate`).
 *
 * Coverage (slice contract + roadmap-v2.md V2-N4):
 *  1. AST scan shapes — nested parallel/pipeline/loopUntilDry/recursive/
 *     chunked, statically-visible fan-out sizes, phase attribution, meta
 *     phases, dynamic-prompt warnings.
 *  2. Estimate matches a real run within tolerance — a fixture script run
 *     through the real runtime with a usage-reporting mock agent must land
 *     inside the forecast's token range (the scan measures the same static
 *     prompt text the runtime's estimate-only path meters).
 *  3. No side effects (dry) — the forecast never writes anything, never
 *     launches anything; it is a synchronous pure scan.
 *  4. CLI surface renders — the pure renderer text + the extension's
 *     registered `workflow_estimate` tool returns the rendered preview with
 *     the structured details.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentUsage } from "../../src/agent.js";
import {
  ESTIMATE_AGENT_OVERHEAD_MS_DEFAULT,
  ESTIMATE_REPLY_TOKENS_PER_AGENT_DEFAULT,
  ESTIMATE_TIER_COST_WEIGHTS,
  ESTIMATE_TOKENS_PER_SECOND_DEFAULT,
  ESTIMATE_WARNING_BUDGET_FRACTION,
} from "../../src/config.js";
import {
  estimateWorkflowForecast,
  formatEstimateDuration,
  renderWorkflowEstimate,
} from "../../src/estimate-forecast.js";
import { discardWorkflowRuntime, takeWorkflowRuntime } from "../../src/extension-reload.js";
import { estimateTokens, runWorkflow } from "../../src/workflow.js";
import { withFakeHomeAsync } from "../helpers/fake-home.js";
import { rmForce } from "../helpers/rm-force.js";

const SIMPLE_SCRIPT = `export const meta = { name: 'demo', description: 'a demo workflow', phases: [{ title: 'plan' }, { title: 'build' }] }
phase('plan')
const goal = await agent('plan the approach in detail', { label: 'planner', tier: 'small' })
phase('build')
const out = await parallel([
  async () => agent('implement the first module'),
  async () => agent('implement the second module'),
])
await checkpoint('release now?', { kind: 'confirm', default: true })
return { goal, out }`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. AST scan shapes
// ─────────────────────────────────────────────────────────────────────────────

test("estimate: finds agent calls with line, phase, label, tier, and static prompt tokens", () => {
  const est = estimateWorkflowForecast(SIMPLE_SCRIPT);
  assert.equal(est.name, "demo");
  assert.equal(est.description, "a demo workflow");
  assert.deepEqual(est.metaPhases, ["plan", "build"]);
  assert.deepEqual(est.runtimePhases, ["plan", "build"]);
  assert.equal(est.checkpoints, 1);
  assert.equal(est.agentCount, 3, "planner + two implementers across the fan-out tree");

  const planner = est.calls.find((c) => c.kind === "agent" && c.label === "planner");
  assert.ok(planner, "the label option is read statically");
  assert.equal(planner?.phase, "plan");
  assert.equal(planner?.tier, "small");
  assert.ok((planner?.promptTokens ?? 0) > 0, "static prompt tokens are estimated");
  assert.equal(planner?.promptKnown, true);
  const parallel = est.calls.find((c) => c.kind === "parallel");
  assert.ok(parallel, "the fan-out is a top-level call record");
  assert.equal(parallel?.agentCount, 2, "the implementers aggregate into the fan-out record");
  assert.equal(parallel?.phase, "build", "the enclosing phase() attributes fan-out agents");
});

test("estimate: parallel with literal thunks is a statically-visible fan-out", () => {
  const est = estimateWorkflowForecast(SIMPLE_SCRIPT);
  const parallel = est.fanOuts.find((f) => f.kind === "parallel");
  assert.ok(parallel, "the parallel fan-out is reported");
  assert.equal(parallel?.size, 2);
  assert.equal(parallel?.agentCount, 2);
  assert.equal(parallel?.worstCaseAgentCount, 2);
  // Top-level agents = 1 planner + 2 implementers = 3.
  assert.equal(est.agentCount, 3);
  assert.equal(est.worstCaseAgentCount, 3);
});

test("estimate: nested fan-outs compose (parallel inside parallel)", () => {
  const script = `export const meta = { name: 'nested', description: 'nested fan-out' }
const out = await parallel([
  async () => await parallel([
    async () => agent('a1'),
    async () => agent('a2'),
  ]),
  async () => agent('b1'),
])
return out`;
  const est = estimateWorkflowForecast(script);
  assert.equal(est.agentCount, 3, "3 agents statically visible across both levels");
  assert.equal(est.worstCaseAgentCount, 3);
  const outer = est.fanOuts.find((f) => f.kind === "parallel" && f.line === 2);
  assert.equal(outer?.agentCount, 3, "the outer fan-out aggregates the inner one");
  const inner = est.fanOuts.find((f) => f.kind === "parallel" && f.line === 3);
  assert.equal(inner?.size, 2);
});

test("estimate: loopUntilDry worst case = maxRounds, default rounds = 50", () => {
  const withRounds = `export const meta = { name: 'loop', description: 'loop' }
const r = await loopUntilDry({ round: async () => [agent('fetch one')], maxRounds: 4 })
return r`;
  const est = estimateWorkflowForecast(withRounds);
  const loop = est.fanOuts.find((f) => f.kind === "loopUntilDry");
  assert.equal(loop?.maxRounds, 4);
  assert.equal(loop?.agentCount, 1, "minimum: one round");
  assert.equal(loop?.worstCaseAgentCount, 4, "worst case: every round fetches one agent");
  assert.equal(est.worstCaseAgentCount, 4);

  const defaulted = estimateWorkflowForecast(
    `export const meta = { name: 'loop2', description: 'd' }\nconst r = await loopUntilDry({ round: async () => [agent('fetch')] })\nreturn r`,
  );
  const defLoop = defaulted.fanOuts.find((f) => f.kind === "loopUntilDry");
  assert.equal(defLoop?.maxRounds, 50, "the runtime's default round bound is statically knowable");
  assert.notEqual(defLoop?.size, "dynamic", "no dynamic-size warning for the default bound");
});

test("estimate: recursive worst case = maxRoots^maxDepth, capped", () => {
  const script = `export const meta = { name: 'rec', description: 'recursive' }
const out = await recursive([1, 2, 3], {
  split: (items) => items.length > 1 ? [[items[0]], [items[1]]] : [],
  solve: async (items) => agent('solve ' + items.length),
  maxDepth: 2,
  maxRecursiveRoots: 2,
})
return out`;
  const est = estimateWorkflowForecast(script);
  const rec = est.fanOuts.find((f) => f.kind === "recursive");
  assert.equal(rec?.maxDepth, 2);
  assert.equal(rec?.maxRoots, 2);
  assert.equal(rec?.agentCount, 1, "minimum: one leaf solve");
  assert.equal(rec?.worstCaseAgentCount, 4, "worst case: 2^2 leaf solves");
  assert.equal(est.worstCaseAgentCount, 4);
});

test("estimate: pipeline stages run per item", () => {
  const script = `export const meta = { name: 'pipe', description: 'pipeline' }
const items = [1, 2, 3]
const out = await pipeline(items, async (item) => agent('stage1 ' + item), async (prev) => agent('stage2'))
return out`;
  const est = estimateWorkflowForecast(script);
  const pipe = est.fanOuts.find((f) => f.kind === "pipeline");
  assert.equal(pipe?.size, 3);
  assert.equal(pipe?.agentCount, 6, "3 items × 2 stages");
  assert.equal(est.agentCount, 6);
});

test("estimate: chunked maps ceil(items/chunkSize) chunks", () => {
  const script = `export const meta = { name: 'chunk', description: 'chunked' }
const items = [1, 2, 3, 4, 5]
const out = await chunked(items, { chunkSize: 2, mapper: async (chunk) => agent('analyze ' + chunk.length) })
return out`;
  const est = estimateWorkflowForecast(script);
  const chunk = est.fanOuts.find((f) => f.kind === "chunked");
  assert.equal(chunk?.size, 5);
  assert.equal(chunk?.agentCount, 3, "ceil(5/2) chunks");
  assert.equal(est.agentCount, 3);
});

test("estimate: parallel over a statically-sized map callback is statically visible", () => {
  const script = `export const meta = { name: 'map', description: 'map fan-out' }
const topics = ['a', 'b', 'c']
const out = await parallel(topics.map((topic) => async () => agent('research ' + topic)))
return out`;
  const est = estimateWorkflowForecast(script);
  const parallel = est.fanOuts.find((f) => f.kind === "parallel");
  assert.equal(parallel?.size, 3, "the receiver array length is statically visible");
  assert.equal(parallel?.agentCount, 3);
  assert.notEqual(parallel?.size, "dynamic", "no dynamic-size warning");
});

test("estimate: dynamic fan-out and dynamic prompts produce warnings, not crashes", () => {
  const script = `export const meta = { name: 'dyn', description: 'dynamic' }
const topics = args.topics
const out = await parallel(topics.map((topic) => async () => agent('research ' + topic)))
return out`;
  const est = estimateWorkflowForecast(script);
  const parallel = est.fanOuts.find((f) => f.kind === "parallel");
  assert.equal(parallel?.size, "dynamic");
  assert.equal(parallel?.worstCaseAgentCount, est.maxAgents, "dynamic fan-outs bound worst case by maxAgents");
  assert.ok(
    est.warnings.some((w) => w.includes("dynamic size")),
    `the dynamic fan-out is documented; got: ${JSON.stringify(est.warnings)}`,
  );
  assert.ok(
    est.warnings.some((w) => w.includes("dynamic prompts")),
    "the unresolvable prompt is documented",
  );
});

test("estimate: per-phase aggregates sum fan-out agents and tokens", () => {
  const est = estimateWorkflowForecast(SIMPLE_SCRIPT);
  const plan = est.phases.find((p) => p.title === "plan");
  const build = est.phases.find((p) => p.title === "build");
  assert.equal(plan?.agentCount, 1);
  assert.equal(build?.agentCount, 2);
  assert.ok((plan?.promptTokens ?? 0) > 0);
  assert.ok((build?.promptTokens ?? 0) > 0);
});

test("estimate: token budget flags exceedsBudget and nearBudget", () => {
  const noBudget = estimateWorkflowForecast(SIMPLE_SCRIPT);
  assert.equal(noBudget.budget, null);
  assert.equal(noBudget.exceedsBudget, false);
  assert.equal(noBudget.nearBudget, false);

  const tight = estimateWorkflowForecast(SIMPLE_SCRIPT, { tokenBudget: 1 });
  assert.equal(tight.exceedsBudget, true);
  assert.ok(tight.warnings.some((w) => w.includes("EXCEEDS")));

  const near = estimateWorkflowForecast(SIMPLE_SCRIPT, {
    tokenBudget: Math.ceil(noBudget.totalTokens / ESTIMATE_WARNING_BUDGET_FRACTION),
  });
  assert.equal(near.nearBudget, true);
  assert.equal(near.exceedsBudget, false);
});

test("estimate: meta.gate 'approve' is surfaced", () => {
  const est = estimateWorkflowForecast(
    `export const meta = { name: 'gated', description: 'gated', gate: 'approve' }\nconst r = await agent('work')\nreturn r`,
  );
  assert.equal(est.gate, "approve");
});

test("estimate: mutually-recursive helpers expand once without a stack overflow", () => {
  const script = `export const meta = { name: 'mutual', description: 'recursion guard' }
const a = async (n) => n > 0 ? agent('step ' + n) : await b(n)
const b = async (n) => n > 0 ? await a(n - 1) : 'done'
const out = await a(3)
return out`;
  const est = estimateWorkflowForecast(script);
  // The recursion guard stops the expansion at the first re-entry; the agent
  // call is still found and the scan terminates.
  assert.ok(est.agentCount >= 1, "the helper's agent call is counted");
  assert.ok(Number.isFinite(est.totalTokens), "the forecast completes without a stack overflow");
});

test("estimate: local helper definitions are expanded at call sites, not double-counted", () => {
  const script = `export const meta = { name: 'helpers', description: 'call-site expansion' }
const task = (name) => agent('run ' + name)
const a = await task('one')
const b = await task('two')
return { a, b }`;
  const est = estimateWorkflowForecast(script);
  assert.equal(est.agentCount, 2, "two call sites → two agent executions (the definition is not double-counted)");
  assert.equal(est.worstCaseAgentCount, 2, "no dynamic-site inflation from the helper definition");
});

test("estimate: named helpers used as parallel thunks and for-of over static arrays count their items", () => {
  const thunks = `export const meta = { name: 'thunks', description: 'named thunks' }
const work = async () => agent('do work')
const out = await parallel([work, work, work])
return out`;
  const est = estimateWorkflowForecast(thunks);
  assert.equal(est.agentCount, 3);
  assert.equal(est.fanOuts[0]?.size, 3);

  const forOf = `export const meta = { name: 'forof', description: 'for-of' }
const items = [1, 2, 3]
for (const item of items) { await agent('process ' + item) }
return 1`;
  const estForOf = estimateWorkflowForecast(forOf);
  assert.equal(estForOf.agentCount, 3, "for-of over a static array runs its body once per item");
  assert.equal(estForOf.worstCaseAgentCount, 3);
});

test("estimate: workflow() nested with a static script is forecast recursively", () => {
  const script = `export const meta = { name: 'outer', description: 'outer' }
const inner = await workflow("export const meta = { name: 'inner', description: 'inner' }; return await agent('inner work')")
return inner`;
  const est = estimateWorkflowForecast(script);
  assert.equal(est.agentCount, 1, "the outer script only runs the nested workflow (1 agent inside)");
  const workflowRecord = est.calls.find((c) => c.kind === "workflow");
  assert.equal(workflowRecord?.nested?.[0]?.name, "inner");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Estimate matches a real run within tolerance
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_SCRIPT = `export const meta = { name: 'fixture', description: 'tolerance fixture' }
const one = await agent('analyze the requirements document and list open questions', { label: 'one' })
const two = await agent('review the proposed architecture for feasibility risks', { label: 'two' })
const three = await parallel([
  async () => agent('draft the module one implementation notes'),
  async () => agent('draft the module two implementation notes'),
])
return { one, two, three }`;

test("estimate matches a real run's recorded spend within tolerance (fixture)", async () => {
  const REPLY_OUTPUT = 500;
  const agent = {
    async run(prompt: string, options?: { onUsage?: (u: AgentUsage) => void }): Promise<string> {
      const input = estimateTokens(prompt);
      options?.onUsage?.({
        input,
        output: REPLY_OUTPUT,
        cacheRead: 0,
        cacheWrite: 0,
        total: input + REPLY_OUTPUT,
        cost: 0,
      });
      return "fixture result";
    },
  };
  const result = await runWorkflow<unknown>(FIXTURE_SCRIPT, { agent, persistLogs: false });
  const runTotal = result.tokenUsage?.total ?? 0;
  const runAgents = result.agentCount;

  const est = estimateWorkflowForecast(FIXTURE_SCRIPT, { replyTokensPerAgent: REPLY_OUTPUT });

  assert.equal(runAgents, 4, "the run and the scan agree on the statically-visible agent count");
  assert.equal(est.agentCount, runAgents);
  assert.equal(est.promptTokens, runTotal - REPLY_OUTPUT * runAgents, "the scan measures the same static prompt text");
  const delta = Math.abs(est.totalTokens - runTotal);
  assert.ok(
    delta <= est.totalTokens * 0.05,
    `forecast ${est.totalTokens} vs real run ${runTotal} — inside 5% tolerance (delta ${delta})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. No side effects (dry)
// ─────────────────────────────────────────────────────────────────────────────

test("estimate is dry: no fs writes, no execution, synchronous return", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-estimate-dry-"));
  try {
    const started = process.cwd();
    process.chdir(cwd);
    try {
      // A script whose body would write files / touch the host if executed.
      const script = `export const meta = { name: 'evil', description: 'side effects' }
const w = await agent('write a file and run bash')
return w`;
      const est = estimateWorkflowForecast(script);
      assert.equal(typeof est, "object");
      assert.equal(est.name, "evil");
    } finally {
      process.chdir(started);
    }
    assert.deepEqual(readdirSync(cwd), [], "the scan wrote nothing into the working directory");
  } finally {
    rmForce(cwd);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CLI surface renders
// ─────────────────────────────────────────────────────────────────────────────

test("renderWorkflowEstimate renders the human preview line set", () => {
  const est = estimateWorkflowForecast(SIMPLE_SCRIPT, { tokenBudget: 50_000 });
  const text = renderWorkflowEstimate(est);
  assert.match(text, /Workflow estimate: \*\*demo\*\* — a demo workflow/);
  assert.match(text, /Agents: \*\*3\*\* statically visible · worst case: \*\*3\*\*/);
  assert.match(text, /Tokens: ~[\d,]+ prompt \+ ~[\d,]+ reply = ~\*\*[\d,]+\*\* total/);
  assert.match(text, /Duration: ~\d+m \d+s \(worst ~\d+m \d+s\)/);
  assert.match(text, /Phases: plan → build/);
  assert.match(text, /· parallel@\d+ — 2 items → 2 agents \(concurrency \d+\)/);
  assert.match(text, /Gates: 1 human checkpoint\(\) pause/);
  assert.match(text, /Estimate only — best-effort static scan; no run was started, nothing was executed or written\./);
});

test("formatEstimateDuration renders human durations", () => {
  assert.equal(formatEstimateDuration(0), "0s");
  assert.equal(formatEstimateDuration(45_000), "45s");
  assert.equal(formatEstimateDuration(750_000), "12m 30s");
  assert.equal(formatEstimateDuration(7_500_000), "2h 05m");
});

test("config defaults are wired into the forecast model", () => {
  const est = estimateWorkflowForecast(SIMPLE_SCRIPT);
  const planner = est.calls.find((c) => c.kind === "agent" && c.label === "planner");
  const perAgentTokens = (planner?.promptTokens ?? 0) + ESTIMATE_REPLY_TOKENS_PER_AGENT_DEFAULT;
  const expectedDurationMs = Math.ceil(
    (perAgentTokens / ESTIMATE_TOKENS_PER_SECOND_DEFAULT) * 1000 + ESTIMATE_AGENT_OVERHEAD_MS_DEFAULT,
  );
  // The planner runs sequentially first, so its own duration is its per-agent duration.
  assert.ok(
    Math.abs((planner?.durationMs ?? 0) - expectedDurationMs) < 2,
    `planner duration ${planner?.durationMs} ≈ model ${expectedDurationMs}`,
  );
  // Tier weighting: the planner is tier 'small' (0.25×) — the cost proxy is
  // below the raw token total when a small tier is present.
  assert.equal(ESTIMATE_TIER_COST_WEIGHTS.small, 0.25);
  assert.equal(ESTIMATE_TIER_COST_WEIGHTS.medium, 1);
  assert.equal(ESTIMATE_TIER_COST_WEIGHTS.big, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. CLI surface: the extension registers workflow_estimate and it executes
// ─────────────────────────────────────────────────────────────────────────────

interface RegisteredToolDef {
  name: string;
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

test("extension registers the workflow_estimate tool and the tool executes the forecast", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-estimate-cli-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const registeredTools: Array<{ name: string; execute: unknown }> = [];
      const activeTools = ["bash", "read"];
      const handlers: Record<string, Array<(...args: any[]) => any>> = {};
      const pi = {
        registerTool: (tool: { name: string; execute: unknown }) => registeredTools.push(tool),
        registerCommand: () => {},
        getCommands: () => [],
        on: (event: string, handler: (...args: any[]) => any) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
        },
        getActiveTools: () => [...activeTools],
        setActiveTools: (tools: string[]) => {
          activeTools.splice(0, activeTools.length, ...tools);
        },
        sendMessage: () => {},
      } as unknown as ExtensionAPI;
      const { default: installExtension } = await import("../../extensions/workflow.js");
      installExtension(pi);

      // The two runtime tools stay first (registration order is untouched);
      // the new read-only estimate surface is added alongside the query tools.
      assert.equal(registeredTools[0]?.name, "workflow");
      assert.equal(registeredTools[1]?.name, "workflow_control");
      const def = registeredTools.find((t) => t.name === "workflow_estimate");
      assert.ok(def, "workflow_estimate is registered");

      const out = await (def?.execute as RegisteredToolDef["execute"])(
        "estimate-call-1",
        { script: SIMPLE_SCRIPT, tokenBudget: 50_000 },
        undefined,
        undefined,
        {} as never,
      );
      const text = out.content[0]?.text ?? "";
      assert.match(text, /Workflow estimate: \*\*demo\*\*/);
      assert.ok(out.details, "structured details ride along");
      assert.equal(out.details?.name, "demo");
      assert.equal(out.details?.estimate, true);
      assert.ok(typeof out.details?.totalTokens === "number" && (out.details?.totalTokens as number) > 0);

      // A malformed script surfaces a tool error, not a crash.
      const bad = await (def?.execute as RegisteredToolDef["execute"])(
        "estimate-call-2",
        { script: "not a valid script at all" },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal(bad.isError, true);
      assert.match(bad.content[0]?.text ?? "", /workflow_estimate:/);

      handlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime(process.cwd());
      if (staged) discardWorkflowRuntime(process.cwd(), staged);
    });
  } finally {
    await rmForce(fakeHome);
  }
});
