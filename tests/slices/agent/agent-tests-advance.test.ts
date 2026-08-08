import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentRunOptions, AgentUsage } from "../../../src/agent.js";
import { usageFromStats, WorkflowAgent } from "../../../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import { createProviderPoolFromConfig, type ProviderPool } from "../../../src/gateway/provider-pool.js";
import { runWorkflow } from "../../../src/workflow.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";
import { rmForce } from "../../helpers/rm-force.js";

// Private methods used for testing - cast to this type to access them without `any`
type WorkflowAgentPrivates = {
  buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string;
  lastAssistantText(messages: unknown[]): string;
  finalAssistantText(messages: unknown[]): string;
  createSessionManager(): { isPersisted(): boolean; getCwd(): string };
};

// ═══════════════════════════════════════════════════════════════════════════
// buildPrompt — verifies that the agent's internal prompt assembly is correct
// ═══════════════════════════════════════════════════════════════════════════

test("buildPrompt includes base instructions, task label, and user prompt", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a helper." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "analyze this",
    { label: "analyzer" },
    false,
  );
  assert.ok(built.includes("You are a helper."), "should include base instructions");
  assert.ok(built.includes("Task label: analyzer"), "should include task label");
  assert.ok(built.includes("analyze this"), "should include user prompt");
});

test("buildPrompt includes per-call instructions when provided", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Base." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "do it",
    { label: "x", instructions: "Extra." },
    false,
  );
  assert.ok(built.includes("Base."), "base instructions");
  assert.ok(built.includes("Extra."), "per-call instructions");
  assert.ok(built.includes("do it"), "user prompt");
});

test("buildPrompt injects structured output contract when schema is used", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("return result", { label: "t" }, true);
  assert.ok(built.includes("structured_output"), "should mention structured_output");
  assert.ok(built.includes("Final output contract:"), "should include contract header");
  assert.ok(built.includes("Do not emit a prose final answer"), "should discourage prose");
  assert.ok(built.includes("call structured_output exactly once"), "should enforce single call");
});

test("buildPrompt works without base instructions", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", { label: "greeter" }, false);
  assert.ok(built.includes("Task label: greeter"), "should contain Task label: greeter");
  assert.ok(built.includes("hello"), "should contain hello");
});

test("buildPrompt works without label", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Help." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", {}, false);
  assert.ok(built.includes("Help."), "should contain Help.");
  assert.ok(built.includes("hello"), "should contain hello");
  assert.ok(!built.includes("Task label:"), "no label when omitted");
});

test("buildPrompt includes both instructions when both base and per-call are set", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a code reviewer." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "check this file",
    { label: "reviewer", instructions: "Focus on security." },
    true,
  );
  // Order: base instructions, per-call instructions, label, prompt, structured contract
  assert.ok(built.indexOf("You are a code reviewer.") < built.indexOf("Focus on security."), "base before per-call");
  assert.ok(built.indexOf("Focus on security.") < built.indexOf("Task label: reviewer"), "per-call before label");
  assert.ok(built.indexOf("Task label: reviewer") < built.indexOf("check this file"), "label before prompt");
  assert.ok(
    built.indexOf("check this file") < built.indexOf("Final output contract:"),
    "prompt before structured contract",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// lastAssistantText — verifies text extraction from session messages
// ═══════════════════════════════════════════════════════════════════════════

test("lastAssistantText extracts last assistant text content", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "hi there");
});

test("lastAssistantText joins multiple text parts", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "part1part2");
});

test("lastAssistantText skips non-text content parts", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1" },
        { type: "text", text: "result" },
      ],
    },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "result");
});

test("lastAssistantText returns empty string when no assistant text", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText([]);
  assert.equal(text, "");
});

test("lastAssistantText returns empty for non-assistant messages", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "");
});

test("lastAssistantText picks the last assistant message, not first", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "final");
});

// ═══════════════════════════════════════════════════════════════════════════
// Full agent() pipeline inside runWorkflow — verifies the agent() function
// in workflow.ts correctly invokes the runner with all options.
// ═══════════════════════════════════════════════════════════════════════════

/** A smart mock agent runner that records every call and validates options shape. */
class CallRecordingAgent {
  calls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];

  result: unknown = "mock-result";

  async run(prompt: string, options: any) {
    this.calls.push({ prompt, options: { ...options } });
    // Fire callbacks with synthetic data to test the full pipeline
    options.onUsage?.({
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
      cost: 0.001,
    } satisfies AgentUsage);
    options.onModelResolved?.("openai/gpt-4.1-mini");
    return this.result;
  }
}

test("agent() in workflow passes prompt and label to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze this', { label: 'analyzer' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].prompt, "analyze this");
});

test("agent() in workflow forwards modelRegistry to the runner", async () => {
  const rec = new CallRecordingAgent();
  const fakeRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't' })
     return r`,
    { agent: rec, persistLogs: false, modelRegistry: fakeRegistry },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: any }).modelRegistry, fakeRegistry);
});

test("agent() in workflow passes model spec to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model");
});

test("agent() in workflow forwards modelRegistry for CLI-style model parsing", async () => {
  const rec = new CallRecordingAgent();
  const modelRegistry = { getAll: () => [] };
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model:xhigh' })
     return r`,
    { agent: rec, modelRegistry: modelRegistry as never, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: unknown }).modelRegistry, modelRegistry);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model:xhigh");
});

test("agent() in workflow fires onAgentStart and onAgentEnd callbacks", async () => {
  const rec = new CallRecordingAgent();
  const events: string[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => events.push(`start:${e.label}`),
      onAgentEnd: (e) => events.push(`end:${e.label}`),
    },
  );
  assert.deepEqual(events, ["start:greeter", "end:greeter"]);
});

test("agent() in workflow forwards compact subagent history snapshots", async () => {
  const historyRunner = {
    async run(_prompt: string, options: any) {
      options.onHistory?.([{ role: "assistant", kind: "text", text: "working" }]);
      return "done";
    },
  };
  const histories: Array<{ label: string; history: Array<{ text: string }> }> = [];

  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: historyRunner,
      persistLogs: false,
      onAgentHistory: (event) => histories.push(event),
    },
  );

  assert.equal(histories.length, 1);
  assert.equal(histories[0].label, "greeter");
  assert.equal(histories[0].history[0].text, "working");
});

test("agent() in workflow fires onAgentStart with phase info", async () => {
  const rec = new CallRecordingAgent();
  const starts: Array<{ label: string; phase?: string }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't', phases: [{ title: 'Phase1' }] }
     phase('Phase1')
     await agent('work', { label: 'w' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => starts.push({ label: e.label, phase: e.phase }),
    },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].phase, "Phase1");
});

test("agent() in workflow returns runner result", async () => {
  const rec = new CallRecordingAgent();
  rec.result = { findings: ["issue1"] };
  const result = await runWorkflow<{ findings: string[] }>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze', { label: 'a' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.deepEqual(result.result, { findings: ["issue1"] });
});

test("agent() in workflow returns null for recoverable errors", async () => {
  const failer = {
    async run() {
      throw new Error("recoverable agent error");
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('failing task', { label: 'f' })
     return r`,
    { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );
  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "recoverable agent error");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow treats empty text output as a recoverable failure", async () => {
  const rec = new CallRecordingAgent();
  rec.result = "   ";
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('empty task', { label: 'empty' })
     return r`,
    { agent: rec, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );

  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "Subagent produced no assistant output");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(end?.recoverable, true);
});

// ═══════════════════════════════════════════════════════════════════
// AGENT_EMPTY_OUTPUT recovery — same-session nudge + truncation (#135)
// ═══════════════════════════════════════════════════════════════════

/** Run a REAL WorkflowAgent against a faux (no-network) provider. */
async function fauxAgentRun(
  core: ReturnType<typeof createFauxCore>,
  prompt: string,
  options: AgentRunOptions<any> = {},
): Promise<unknown> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-empty-nudge-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-empty-nudge-cwd-"));
  try {
    let outcome: unknown;
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider(core.provider, {
        name: "Faux Test",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      const registry = new ModelRegistry(runtime);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      outcome = await agent.run(prompt, options);
    });
    return outcome;
  } finally {
    await rmForce(home, cwd);
  }
}

test("WorkflowAgent.run(): silently truncated output (stopReason length) is CONTEXT_OVERFLOW, never nudged", async () => {
  const core = createFauxCore({
    provider: "fauxtest-trunc",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  // ONE queued response: if the runner nudged (or retried) after the truncation,
  // the second prompt would consume a missing response and fail differently.
  core.setResponses([fauxAssistantMessage("", { stopReason: "length" })]);

  await assert.rejects(
    () => fauxAgentRun(core, "task", { label: "trunc" }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.CONTEXT_OVERFLOW &&
      error.recoverable === false &&
      /truncated at max tokens/.test(error.message),
    "truncated output must settle CONTEXT_OVERFLOW (non-recoverable), not AGENT_EMPTY_OUTPUT",
  );
  assert.equal(core.state.callCount, 1, "no nudge prompt may fire after a truncation — the wall is identical");
});

test("WorkflowAgent.run(): a 'length' stop that still holds a complete answer returns it, never CONTEXT_OVERFLOW", async () => {
  const core = createFauxCore({
    provider: "fauxtest-trunc-answered",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  // ONE queued response: the model finished with a complete answer but hit the
  // max-token ceiling; the answer is usable, so no replay and no nudge may fire.
  core.setResponses([fauxAssistantMessage("complete final answer", { stopReason: "length" })]);

  const result = await fauxAgentRun(core, "task", { label: "trunc-answered" });
  assert.equal(result, "complete final answer");
  assert.equal(core.state.callCount, 1, "a complete answer on a length stop must not trigger a nudge or replay");
});

test("WorkflowAgent.run(): empty final text recovers via one same-session nudge when the model then answers", async () => {
  const core = createFauxCore({
    provider: "fauxtest-nudge",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  core.setResponses([
    fauxAssistantMessage("", { stopReason: "stop" }),
    fauxAssistantMessage("nudged final answer", { stopReason: "stop" }),
  ]);

  const result = await fauxAgentRun(core, "task", { label: "nudge-ok" });
  assert.equal(result, "nudged final answer");
  assert.equal(core.state.callCount, 2, "exactly one nudge prompt on top of the original turn");
});

test("WorkflowAgent.run(): an empty nudge still throws AGENT_EMPTY_OUTPUT (recoverable)", async () => {
  const core = createFauxCore({
    provider: "fauxtest-nudge-empty",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  core.setResponses([
    fauxAssistantMessage("", { stopReason: "stop" }),
    fauxAssistantMessage("", { stopReason: "stop" }),
  ]);

  await assert.rejects(
    () => fauxAgentRun(core, "task", { label: "nudge-still-empty" }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT &&
      error.recoverable === true,
    "an empty nudge must surface AGENT_EMPTY_OUTPUT exactly as before",
  );
  assert.equal(core.state.callCount, 2, "the nudge ran once and was itself empty");
});

test("WorkflowAgent.run(): emptyOutputNudge:false pins the legacy immediate-throw behavior", async () => {
  const core = createFauxCore({
    provider: "fauxtest-nudge-off",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  core.setResponses([fauxAssistantMessage("", { stopReason: "stop" })]);

  await assert.rejects(
    () => fauxAgentRun(core, "task", { label: "nudge-off", emptyOutputNudge: false }),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT &&
      error.recoverable === true,
    "emptyOutputNudge:false must throw AGENT_EMPTY_OUTPUT without a follow-up prompt",
  );
  assert.equal(core.state.callCount, 1, "no nudge prompt may fire with emptyOutputNudge:false");
});

test("agent() in workflow reports non-recoverable errors before throwing", async () => {
  const failer = {
    async run() {
      throw new WorkflowError("schema failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;

  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         await agent('schema task', { label: 'schema' })
         return 1`,
        { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (err) => err instanceof WorkflowError && err.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  );

  assert.equal(end?.result, null);
  assert.equal(end?.error, "schema failed");
  assert.equal(end?.errorCode, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
  assert.equal(end?.recoverable, false);
});

test("agent() in workflow fires onTokenUsage after run", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ input: number; output: number; total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ input: u.input, output: u.output, total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "should fire onTokenUsage once");
  assert.equal(usageEvents[0].total, 30, "should accumulate from agent usage");
});

test("agent() passes onModelResolved callback for display model updates", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't', model: 'some/model' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentEnd: (e) => {
        assert.equal(e.model, "openai/gpt-4.1-mini");
      },
    },
  );
  assert.ok(rec.calls.length > 0, "rec.calls should not be empty");
});

test("agent() accumulates usage across multiple agents", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('first', { label: 'a' })
     await agent('second', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "one final usage event");
  assert.equal(usageEvents[0].total, 60, "two agents × 30 tokens each");
});

test("agent() with timeout should handle gracefully (timeout returns null)", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 50));
      return "slow";
    },
  };
  let errorMessage = "";
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     let val = null
     try { val = await agent('slow', { label: 's', timeoutMs: 5 }) } catch (e) { val = 'error:' + (e && e.message || e) }
     return { val }`,
    {
      agent: slow,
      persistLogs: false,
      onAgentEnd: (event) => {
        if (event.error) errorMessage = event.error;
      },
    },
  );
  const r = result.result as { val: unknown };
  // agent() catches timeout internally (recoverable) and returns null
  assert.equal(r.val, null, "timeout agent should return null (recoverable)");
  assert.match(errorMessage, /timed out after 5ms/);
  assert.match(errorMessage, /raise or omit timeoutMs\/agentTimeoutMs/);
});

test("agent() default timeout is unbounded", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's' })
     return { val }`,
    { agent: slow, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() timeoutMs null overrides a run-level timeout", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's', timeoutMs: null })
     return { val }`,
    { agent: slow, agentTimeoutMs: 5, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() with parallel invokes all agents", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await parallel(['a','b','c'].map(p => () => agent(p, { label: p })))
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 3);
  const prompts = rec.calls.map((c) => c.prompt).sort();
  assert.deepEqual(prompts, ["a", "b", "c"]);
});

test("agent() with pipeline invokes agent per stage per item", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await pipeline(['x','y'],
       item => agent('stage1 ' + item, { label: 's1-' + item }),
       result => agent('stage2 ' + result, { label: 's2-' + result }),
     )
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 4); // 2 items × 2 stages
});

test("agent() monitors agent count and calls onAgentStart/End for each", async () => {
  const rec = new CallRecordingAgent();
  const counts: number[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('a', { label: 'a' })
     await agent('b', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: () => {},
      onAgentEnd: (e) => counts.push(e.tokens ?? 0),
    },
  );
  assert.equal(counts.length, 2);
  assert.ok(counts[0] > 0, "first agent tokens");
  assert.ok(counts[1] > 0, "second agent tokens");
});

// ═══════════════════════════════════════════════════════════════════════════
// usageFromStats — the guard between session stats and the onUsage callback.
// ═══════════════════════════════════════════════════════════════════════════

test("usageFromStats maps real stats to an AgentUsage", () => {
  const usage = usageFromStats({
    tokens: { input: 100, output: 50, cacheRead: 900, cacheWrite: 30, total: 1080 },
    cost: 0.42,
  });
  assert.deepEqual(usage, { input: 100, output: 50, cacheRead: 900, cacheWrite: 30, total: 1080, cost: 0.42 });
});

test("usageFromStats returns undefined for all-zero stats (provider reported nothing)", () => {
  const usage = usageFromStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  });
  assert.equal(usage, undefined);
});

test("usageFromStats keeps cost-only stats (billed but tokens unreported)", () => {
  const usage = usageFromStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0.01,
  });
  assert.equal(usage?.cost, 0.01);
});

// ═══════════════════════════════════════════════════════════════════════
// worktree-isolation:f2 — runWorkflow teardown finalizes agent edits and
// honors the keepWorktree opt-in; the default mode discards the finalized
// branch + worktree instead of silently destroying uncommitted edits.
// ═══════════════════════════════════════════════════════════════════════

function initWorktreeTestRepo(): { repo: string; git: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-wt-int-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repo, git };
}

/** Fake subagent that simulates agent edits by writing into its isolated worktree cwd. */
const worktreeEditingAgent = {
  async run(_prompt: string, options: { cwd?: string }) {
    if (options.cwd) writeFileSync(join(options.cwd, "agent-file.txt"), "agent edit\n");
    return "done";
  },
};

function branchForWorktree(wtPath: string): string {
  const id = wtPath.split(/[\\/]/).pop() ?? "";
  return `pi/wf/${id}`;
}

test("workflow teardown removes the worktree + branch after an isolated agent (default mode)", async () => {
  const { repo, git } = initWorktreeTestRepo();
  try {
    let wtPath: string | undefined;
    // onAgentEnd fires before teardown, so existence must be captured there —
    // after runWorkflow resolves the default-mode finally has already removed it.
    let existedDuringRun = false;
    const result = await runWorkflow(
      `export const meta = { name: 'test', description: 't' }
       const r = await agent('edit', { label: 'edit', isolation: 'worktree' })
       return r`,
      {
        agent: worktreeEditingAgent,
        cwd: repo,
        persistLogs: false,
        onAgentEnd: (e) => {
          wtPath = e.worktree;
          if (e.worktree) existedDuringRun = existsSync(e.worktree);
        },
      },
    );

    assert.equal(result.result, "done");
    assert.ok(wtPath, "agent ran in an isolated worktree");
    assert.equal(existedDuringRun, true, "worktree existed during the run");
    assert.ok(!existsSync(wtPath as string), "worktree dir removed after the run");
    assert.equal(git("branch", "--list", branchForWorktree(wtPath as string)), "", "branch deleted after the run");
  } finally {
    await rmForce(repo);
  }
});

test("workflow keepWorktree retains the branch + path with finalized agent edits", async () => {
  const { repo, git } = initWorktreeTestRepo();
  try {
    let wtPath: string | undefined;
    const result = await runWorkflow(
      `export const meta = { name: 'test', description: 't' }
       const r = await agent('edit', { label: 'edit', isolation: 'worktree', keepWorktree: true })
       return r`,
      {
        agent: worktreeEditingAgent,
        cwd: repo,
        persistLogs: false,
        onAgentEnd: (e) => {
          wtPath = e.worktree;
        },
      },
    );

    assert.equal(result.result, "done");
    assert.ok(wtPath, "agent ran in an isolated worktree");
    assert.ok(existsSync(wtPath as string), "keepWorktree retains the worktree dir for inspection");
    const branch = branchForWorktree(wtPath as string);
    assert.ok(git("branch", "--list", branch).includes(branch), "keepWorktree retains the branch");
    // finalizeWorktree committed the agent edit onto the retained branch.
    assert.equal(git("show", `${branch}:agent-file.txt`), "agent edit");
  } finally {
    await rmForce(repo);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Context-window overflow: a subagent whose SDK throws (or whose session
// records) an overflow must surface as CONTEXT_OVERFLOW (non-recoverable) —
// never as a silent null that lets the run "complete" with a missing result.
// The thrown path (wrapError defense) is exercised end-to-end here; the
// buried-message path (throwIfContextOverflow) is unit-tested in
// schema-resolution.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

test("runWorkflow surfaces a thrown context-overflow as CONTEXT_OVERFLOW (non-recoverable), not a silent null", async () => {
  const overflowAgent = {
    async run(_prompt: string, options?: { label?: string; onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      throw new Error("prompt is too long: 213462 tokens > 200000 maximum");
    },
  };
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'overflow_demo', description: 'context overflow' }
         const r = await agent('analyze', { label: 'a' })
         return r`,
        { agent: overflowAgent, persistLogs: false },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.CONTEXT_OVERFLOW);
      assert.equal(error.recoverable, false, "overflow is a hard failure, never a checkpoint");
      assert.equal(error.agentLabel, "a");
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider outages (5xx): a thrown 503 is pause-worthy (PROVIDER_OVERLOADED);
// a thrown 500 is recoverable (PROVIDER_UNAVAILABLE) and retried with backoff.
// ═══════════════════════════════════════════════════════════════════════════

test("runWorkflow surfaces a thrown 503 as PROVIDER_OVERLOADED (pause-worthy), not a silent null", async () => {
  const overloadedAgent = {
    async run(_prompt: string, options?: { label?: string; onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      throw new Error("503 status code (no body)");
    },
  };
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'overload_demo', description: 'provider outage' }
         const r = await agent('analyze', { label: 'a' })
         return r`,
        { agent: overloadedAgent, persistLogs: false, agentRetries: 2, retryBackoffMs: 0 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.PROVIDER_OVERLOADED);
      assert.equal(error.recoverable, false, "an outage is a checkpoint, never retried into the same dead endpoint");
      assert.equal(error.agentLabel, "a");
      return true;
    },
  );
});

test("runWorkflow retries a thrown 500 (PROVIDER_UNAVAILABLE) with backoff, then succeeds", async () => {
  let calls = 0;
  const flakyAgent = {
    async run(_prompt: string, options?: { label?: string; onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      calls++;
      if (calls === 1) throw new Error("500 status code (no body)");
      return "ok";
    },
  };
  const result = await runWorkflow(
    `export const meta = { name: 'retry_500_demo', description: 'transient outage' }
     const r = await agent('analyze', { label: 'a' })
     return r`,
    { agent: flakyAgent, persistLogs: false, agentRetries: 1, retryBackoffMs: 0 },
  );
  assert.equal(result.result, "ok");
  assert.equal(calls, 2, "the 500 attempt must be retried, not swallowed as a null");
});

// ═══════════════════════════════════════════════════════════════════════
// Provider pool — runner-level routing (tasks/provider-load-balance)
// ═══════════════════════════════════════════════════════════════════════

type FauxPoolCore = ReturnType<typeof createFauxCore>;

/**
 * Poll a predicate every ~5ms until it passes or the deadline (ms) elapses.
 * Throws on timeout so a stalled pool acquire fails loudly, not by hang.
 */
async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  deadlineMs = 5_000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    // In-memory state poll: 25ms cadence; default 5s deadline leaves ~200 fires.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Runner-level harness for the provider pool: two faux providers ("pool-a",
 * "pool-b") serve the SAME logical model id "faux-model" on ONE runtime, each
 * capped at 1 concurrent run, behind a single ProviderPool. Which provider
 * served a run is observable via each core's `state.callCount`; which provider
 * holds a slot via `pool.snapshot()`. Acquires wait FIFO when saturated and
 * time out after `saturationWaitTimeoutMs` so a wrongly-blocked run fails fast.
 */
async function fauxPoolHarness(
  run: (h: {
    cwd: string;
    coreA: FauxPoolCore;
    coreB: FauxPoolCore;
    registry: ModelRegistry;
    pool: ProviderPool;
    agent: WorkflowAgent;
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-pool-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-pool-cwd-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      const coreA = createFauxCore({
        provider: "pool-a",
        models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
      });
      const coreB = createFauxCore({
        provider: "pool-b",
        models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
      });
      for (const core of [coreA, coreB]) {
        runtime.registerProvider(core.provider, {
          name: "Faux Test",
          baseUrl: "http://127.0.0.1:9/faux",
          apiKey: "faux-dummy-key-not-used",
          api: core.api,
          streamSimple: core.streamSimple as never,
          models: core.models.map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            reasoning: false,
            input: ["text"] as ("text" | "image")[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.contextWindow ?? 128000,
            maxTokens: m.maxTokens ?? 4096,
          })),
        });
      }
      const registry = new ModelRegistry(runtime);
      const pool = createProviderPoolFromConfig(
        {
          enabled: true,
          whenSaturated: "wait",
          saturationWaitTimeoutMs: 2_000,
          models: {
            "faux-model": {
              "pool-a": { concurrency: 1, weight: 1 },
              "pool-b": { concurrency: 1, weight: 1 },
            },
          },
        },
        registry,
      );
      assert.ok(pool, "the two-provider pool must be constructible");
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      await run({ cwd, coreA, coreB, registry, pool, agent });
    });
  } finally {
    await rmForce(home, cwd);
  }
}

test("provider pool: cap-1 two-provider pool spreads parallel agents across both providers", async () => {
  await fauxPoolHarness(async ({ cwd, coreA, coreB, pool, registry }) => {
    // Two parallel agents = two WorkflowAgent instances sharing the pool (the
    // real parallel() fan-out shape). Hold pool-a mid-run via a gated response
    // so agent 1 provably holds its slot (active=1, still streaming) when
    // agent 2 starts; agent 2 must take the only free provider (pool-b)
    // instead of piling onto the capped one.
    const agent1 = new WorkflowAgent({ cwd, modelRegistry: registry });
    const agent2 = new WorkflowAgent({ cwd, modelRegistry: registry });
    let releaseAgentOne!: () => void;
    const agentOneGate = new Promise<void>((resolve) => (releaseAgentOne = resolve));
    coreA.setResponses([
      async () => {
        await agentOneGate;
        return fauxAssistantMessage("pool-a-answer", { stopReason: "stop" });
      },
    ]);
    coreB.setResponses([fauxAssistantMessage("pool-b-answer", { stopReason: "stop" })]);

    const first = agent1.run("task", { label: "spread-1", model: "pool-a/faux-model", providerPool: pool });
    await pollUntil(
      () => pool.snapshot().entries.some((entry) => entry.provider === "pool-a" && entry.active > 0),
      5_000,
      "agent 1 to acquire its provider slot",
    );

    const second = await agent2.run("task", { label: "spread-2", model: "pool-a/faux-model", providerPool: pool });
    assert.equal(second, "pool-b-answer", "agent 2 must be routed to the only free provider");
    assert.equal(coreB.state.callCount, 1, "agent 2 was served by pool-b");
    // coreA's count is 1 here — agent 1's OWN request is still in-flight on the
    // gated response (faux callCount increments at stream start, not at stream
    // end). The guard is that agent 2 added nothing on top of it.
    assert.equal(coreA.state.callCount, 1, "agent 2 must not pile onto the capped provider");

    releaseAgentOne();
    const firstResult = await first;
    assert.equal(firstResult, "pool-a-answer", "agent 1 was served by pool-a");
    assert.equal(coreA.state.callCount, 1);
    assert.equal(coreB.state.callCount, 1, "the two-agent burst spread one run per provider");
  });
});

test("provider pool: sticky retry (same poolStickyKey) re-acquires the SAME provider", async () => {
  await fauxPoolHarness(async ({ coreA, coreB, pool, agent }) => {
    coreA.setResponses([
      fauxAssistantMessage("sticky-first", { stopReason: "stop" }),
      fauxAssistantMessage("sticky-retry", { stopReason: "stop" }),
    ]);
    coreB.setResponses([fauxAssistantMessage("other-agent", { stopReason: "stop" })]);

    const resolved: string[] = [];
    const first = await agent.run("task", {
      label: "sticky-1",
      model: "pool-a/faux-model",
      providerPool: pool,
      poolStickyKey: "sticky-run-1",
      onModelResolved: (spec) => resolved.push(spec),
    });
    assert.equal(first, "sticky-first");
    assert.ok(resolved[0].startsWith("pool-a/"), "first attempt pins pool-a");
    // agent.run() does NOT release (the workflow layer settles at the final
    // attempt), so the reservation still holds pool-a's slot after this run.

    const other = await agent.run("task", {
      label: "sticky-other",
      model: "pool-a/faux-model",
      providerPool: pool,
    });
    assert.equal(other, "other-agent");
    assert.equal(coreB.state.callCount, 1);
    assert.equal(coreA.state.callCount, 1, "the interleaved agent must route around the pinned provider");

    const retry = await agent.run("task", {
      label: "sticky-retry",
      model: "pool-a/faux-model",
      providerPool: pool,
      poolStickyKey: "sticky-run-1",
      onModelResolved: (spec) => resolved.push(spec),
    });
    assert.equal(retry, "sticky-retry");
    assert.equal(coreA.state.callCount, 2, "the retry was served by the SAME provider (pool-a)");
    assert.ok(resolved[1].startsWith("pool-a/"), "sticky re-acquire keeps the pinned provider");
    assert.equal(coreB.state.callCount, 1, "pool-b stays reserved for other runs only");

    const held = pool.snapshot().entries.find((entry) => entry.provider === "pool-a");
    assert.equal(held?.active, 1, "sticky re-acquire must not re-count the held slot");
  });
});

test("provider pool: handoff-session continuation bypasses the pool", async () => {
  await fauxPoolHarness(async ({ cwd, coreA, coreB, registry, pool }) => {
    const handoffAgent = new WorkflowAgent({ cwd, modelRegistry: registry, sessionHandoff: true });
    try {
      coreA.setResponses([
        fauxAssistantMessage("handoff-first", { stopReason: "stop" }),
        fauxAssistantMessage("handoff-continue", { stopReason: "stop" }),
      ]);
      coreB.setResponses([fauxAssistantMessage("handoff-wrong", { stopReason: "stop" })]);

      // Root of the chain: NOT a continuation → consults the pool → pool-a;
      // its reservation (poolStickyKey) keeps pool-a capped afterwards.
      const first = await handoffAgent.run("task", {
        label: "handoff-1",
        model: "pool-a/faux-model",
        handoff: true,
        providerPool: pool,
        poolStickyKey: "handoff-chain",
      });
      assert.equal(first, "handoff-first");
      assert.equal(coreA.state.callCount, 1);

      // A recorded 429/limit event cools pool-a down. If the continuation
      // consulted the pool, its sticky re-acquire would wait out the cooldown
      // and hit the saturation timeout; the bypass must proceed untouched on
      // the already-bound provider.
      pool.recordLimitEvent("pool-a");
      const started = Date.now();
      const second = await handoffAgent.run("task", {
        label: "handoff-2",
        model: "pool-a/faux-model",
        handoff: true,
        providerPool: pool,
        poolStickyKey: "handoff-chain",
      });
      const elapsed = Date.now() - started;
      assert.equal(second, "handoff-continue");
      assert.ok(elapsed < 1_500, `continuation must not wait on the pool cooldown (took ${elapsed}ms)`);
      assert.equal(coreA.state.callCount, 2, "continuation stays on the already-bound provider");
      assert.equal(coreB.state.callCount, 0, "pool-b is never consulted for a handoff continuation");
    } finally {
      handoffAgent.close();
    }
  });
});
