/**
 * P1-1 — Typed operation traces ({line, op, outcome}).
 *
 * Covers test plan B:
 *   1. schema test for operations[] entries,
 *   2. golden path: a mid-script tool failure reports the failing operation
 *      with the correct line number,
 *   3. backward compat: old journals without operations[] replay cleanly.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type OperationTrace, WorkflowAgent } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

/**
 * Build a WorkflowAgent backed by a faux (no-network) provider so tool calls
 * really execute inside the pi-ai session. Mirrors tests/agent.test.ts.
 */
async function makeFauxAgent(
  cwd: string,
  opts: { provider?: string; tools?: ToolDefinition[]; mainModel?: string } = {},
): Promise<{ agent: WorkflowAgent; core: ReturnType<typeof createFauxCore> }> {
  const provider = opts.provider ?? "fauxtrace";
  const core = createFauxCore({
    provider,
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
  runtime.registerProvider(provider, {
    name: "Faux Trace",
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
  return { agent: new WorkflowAgent({ cwd, modelRegistry: registry, tools: opts.tools }), core };
}

/** Minimal ToolDefinition-compatible custom tool (loose cast is fine for tests). */
function customTool(name: string, execute: () => Promise<unknown>): ToolDefinition {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: Type.Object({}),
    execute: (async () => execute()) as unknown as ToolDefinition["execute"],
  } as ToolDefinition;
}

// ═══════════════════════════════════════════════════════════════════════════
// B1 — schema test: every operations[] entry carries line, op, outcome
// ═══════════════════════════════════════════════════════════════════════════

test("operations[] entries carry line, op, and outcome for a real session's tool calls", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ops-schema-"));
  try {
    await withFakeHomeAsync(cwd, async () => {
      const { agent, core } = await makeFauxAgent(cwd, {
        tools: [customTool("my_ok_tool", async () => ({ ok: true }))],
      });
      core.setResponses([
        fauxAssistantMessage([fauxToolCall("my_ok_tool", {}), fauxToolCall("structured_output", { verdict: "ok" })], {
          stopReason: "toolUse",
        }),
      ]);
      let traces: OperationTrace[] | undefined;
      const result = await agent.run("collect traces", {
        label: "schema",
        scriptLine: 7,
        schema: Type.Object({ verdict: Type.String() }),
        onOperations: (ops) => {
          traces = ops;
        },
      });
      assert.deepEqual(result, { verdict: "ok" });
      assert.ok(traces, "onOperations must fire when the session made tool calls");
      assert.ok(traces.length >= 2, `expected ≥2 tool traces, got ${traces.length}`);
      for (const trace of traces) {
        assert.equal(typeof trace.line, "number", "line must be a number");
        assert.equal(typeof trace.op, "string", "op must be a string");
        assert.equal(typeof trace.outcome, "string", "outcome must be a string");
        assert.equal(trace.line, 7, "trace line must be the owning call's script line");
      }
      const ok = traces.filter((t) => t.outcome === "ok");
      assert.equal(ok.length, 2, "both executed tools should report ok");
    });
  } finally {
    await rmForce(cwd);
  }
});

test("operations[] marks a failed tool call with an error outcome", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ops-error-"));
  try {
    await withFakeHomeAsync(cwd, async () => {
      const { agent, core } = await makeFauxAgent(cwd, {
        tools: [
          customTool("boom_tool", async () => {
            throw new Error("kaboom");
          }),
        ],
      });
      core.setResponses([
        fauxAssistantMessage(fauxToolCall("boom_tool", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("recovered", { stopReason: "stop" }),
      ]);
      let traces: OperationTrace[] | undefined;
      const result = await agent.run("trigger failure", {
        label: "boom",
        scriptLine: 11,
        onOperations: (ops) => {
          traces = ops;
        },
      });
      assert.equal(result, "recovered");
      assert.ok(traces);
      assert.equal(traces.length, 1);
      assert.equal(traces[0].op, "boom_tool");
      assert.ok(traces[0].outcome.startsWith("error:"), `outcome should be error, got: ${traces[0].outcome}`);
      assert.ok(traces[0].outcome.includes("kaboom"), "error outcome should carry the tool's failure reason");
      assert.equal(traces[0].line, 11);
    });
  } finally {
    await rmForce(cwd);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B2 — golden path: a mid-script tool failure reports line + op + outcome
// ═══════════════════════════════════════════════════════════════════════════

const failingTraceScript = `export const meta = { name: 'trace_fail', description: 'failing trace' }
const plan = await agent('plan', { label: 'planner' })
const result = await agent('execute', { label: 'implementer' })
return result`;

test("a mid-script tool failure reports the failing operation with the correct script line", async () => {
  const failing = { line: 3, op: "write", outcome: "error: EACCES" } as const;
  const endEvents: Array<Record<string, unknown>> = [];
  let sawScriptLine = false;
  const runner = {
    async run(prompt: string, options: { scriptLine?: number; onOperations?: (ops: OperationTrace[]) => void }) {
      if (prompt === "execute") {
        assert.equal(options.scriptLine, 3, "the runner must receive the script line of the failing agent() call");
        sawScriptLine = true;
        options.onOperations?.([{ ...failing, line: options.scriptLine ?? 0 }]);
        throw new WorkflowError("write failed", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
      }
      return "plan-ok";
    },
  };
  await assert.rejects(
    runWorkflow(failingTraceScript, {
      agent: runner,
      persistLogs: false,
      onAgentEnd: (e) => endEvents.push(e as unknown as Record<string, unknown>),
    }),
    (err: unknown) => err instanceof WorkflowError && err.message === "write failed",
  );
  assert.equal(sawScriptLine, true);
  const failed = endEvents.find((e) => e.error !== undefined);
  assert.ok(failed, "the failing agent must emit an onAgentEnd error event");
  assert.deepEqual(failed.failingOperation, failing, "the failing operation must carry line+op+outcome");
});

test("successful runs journal operations alongside callHash/storeDelta", async () => {
  const journal: JournalEntry[] = [];
  const runner = {
    async run(prompt: string, options: { scriptLine?: number; onOperations?: (ops: OperationTrace[]) => void }) {
      if (prompt === "work") {
        options.onOperations?.([{ line: options.scriptLine ?? 0, op: "read", outcome: "ok" }]);
      }
      return "done";
    },
  };
  const script = `export const meta = { name: 'trace_ok', description: 'ok trace' }
const a = await agent('work', { label: 'a' })
return a`;
  const result = await runWorkflow(script, {
    agent: runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(result.result, "done");
  assert.equal(journal.length, 1);
  assert.ok(Array.isArray(journal[0].operations));
  assert.deepEqual(journal[0].operations, [{ line: 2, op: "read", outcome: "ok" }]);
});

test("workflow-manager surfaces the failing operation in error reporting and persisted state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ops-mgr-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-ops-mgr-home-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      const failingAgent = {
        async run(_prompt: string, options: { onOperations?: (ops: OperationTrace[]) => void }) {
          options.onOperations?.([{ line: 2, op: "edit", outcome: "error: ENOENT" }]);
          throw new WorkflowError("edit failed", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        },
      };
      const manager = new WorkflowManager({ cwd, agent: failingAgent });
      const errorEvents: Array<Record<string, unknown>> = [];
      manager.on("error", (e) => errorEvents.push(e as Record<string, unknown>));
      const script = `export const meta = { name: 'trace_mgr', description: 'mgr trace' }
const a = await agent('work', { label: 'a' })
return a`;
      await assert.rejects(manager.runSync(script, undefined), /edit failed/);

      const persisted = manager.listRuns().find((r) => r.workflowName === "trace_mgr");
      const failedAgent = persisted?.agents.find((a) => a.error !== undefined);
      assert.deepEqual(
        failedAgent?.failingOperation,
        { line: 2, op: "edit", outcome: "error: ENOENT" },
        "the persisted agent state must carry the failing operation",
      );
      assert.equal(
        (errorEvents[0]?.failingOperation as { op?: string } | undefined)?.op,
        "edit",
        "the run-level error event must carry the failing operation",
      );
    });
  } finally {
    await rmForce(cwd, fakeHome);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B3 — backward compat: old journals without operations[] replay without throwing
// ═══════════════════════════════════════════════════════════════════════════

const replayScript = `export const meta = { name: 'trace_replay', description: 'replay' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("legacy journal entries without operations[] replay without throwing", async () => {
  const first = {
    calls: 0,
    async run(prompt: string) {
      this.calls++;
      return `ran:${prompt}`;
    },
  };
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(replayScript, {
    agent: first,
    persistLogs: false,
    runId: "legacy-replay",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.calls, 2);

  // Simulate a journal persisted BEFORE operations[] existed: strip the field
  // from every entry, exactly what an old on-disk journal looks like.
  const legacyJournal = journal.map(({ operations: _omitted, ...entry }) => entry);

  const second = {
    calls: 0,
    async run(prompt: string) {
      this.calls++;
      return `live:${prompt}`;
    },
  };
  const r2 = await runWorkflow(replayScript, {
    agent: second,
    persistLogs: false,
    runId: "legacy-replay",
    resumeJournal: new Map(legacyJournal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.calls, 0, "a legacy journal must replay as a full cache hit");
  // JSON compare: vm-realm result objects have a different Object prototype,
  // so deepStrictEqual refuses them (same pattern as workflow-runtime.test.ts).
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});
