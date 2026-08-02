/**
 * P1-2 — Prewalk session handoff: one session continued across model tiers,
 * a first-edit swap gate, and workflow-level phase-boundary chaining.
 *
 * Covers test plan C:
 *   1. swap gate fires only after a first edit; the same session id spans the
 *      model swap,
 *   2. two-phase workflow: phase 2's token consumption drops and it references
 *      phase-1 output without re-reading context (no fresh session),
 *   3. a workflow that never edits never swaps.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type HandoffSwapInfo, WorkflowAgent } from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/**
 * Build a WorkflowAgent with a faux provider offering BOTH a planner model and
 * an executor model, so the swap gate can change the model mid-session.
 */
async function makeHandoffAgent(
  cwd: string,
  opts: {
    sessionHandoff?: boolean;
    handoffExecutionModel?: string;
    handoffToolFilter?: (toolName: string) => boolean;
    onHandoffSession?: (sessionId: string) => void;
  } = {},
): Promise<{ agent: WorkflowAgent; core: ReturnType<typeof createFauxCore> }> {
  const provider = "fauxhand";
  const core = createFauxCore({
    provider,
    models: [
      { id: "planner", name: "Planner", contextWindow: 128000, maxTokens: 4096 },
      { id: "executor", name: "Executor", contextWindow: 128000, maxTokens: 4096 },
    ],
  });
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
  runtime.registerProvider(provider, {
    name: "Faux Handoff",
    baseUrl: "http://127.0.0.1:9/faux",
    apiKey: "faux-dummy-key-not-used",
    api: core.api,
    streamSimple: core.streamSimple as never,
    models: core.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      contextWindow: m.contextWindow ?? 128000,
      maxTokens: m.maxTokens ?? 4096,
    })),
  });
  const registry = new ModelRegistry(runtime);
  const agent = new WorkflowAgent({
    cwd,
    modelRegistry: registry,
    mainModel: `${provider}/planner`,
    sessionHandoff: opts.sessionHandoff ?? true,
    handoffExecutionModel: opts.handoffExecutionModel ?? `${provider}/executor`,
    handoffToolFilter: opts.handoffToolFilter,
    onHandoffSession: opts.onHandoffSession,
  });
  return { agent, core };
}

// ═══════════════════════════════════════════════════════════════════════════
// C1 — swap gate fires only after a first edit; same session id spans the swap
// ═══════════════════════════════════════════════════════════════════════════

test("first-edit swap gate: same session id spans the model swap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-handoff-c1-"));
  try {
    await withFakeHomeAsync(cwd, async () => {
      const sessionIds: string[] = [];
      const { agent, core } = await makeHandoffAgent(cwd, {
        onHandoffSession: (id) => sessionIds.push(id),
      });
      // Phase 1 (planning): prose only. Phase 2: first file-edit tool call.
      // Compaction (planning-context prune) may consume one more response.
      core.setResponses([
        fauxAssistantMessage("planning done", { stopReason: "stop" }),
        fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "x" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("executed", { stopReason: "stop" }),
        fauxAssistantMessage("pruned planning summary", { stopReason: "stop" }),
      ]);
      const swaps: HandoffSwapInfo[] = [];
      const r1 = await agent.run("phase 1: produce a plan", { label: "planner", handoff: true });
      const r2 = await agent.run("phase 2: execute the plan", {
        label: "implementer",
        handoff: true,
        onSwap: (info) => swaps.push(info),
      });

      assert.equal(r1, "planning done");
      assert.equal(r2, "executed");
      assert.equal(sessionIds.length, 2, "one handoff session id per handoff run");
      assert.equal(sessionIds[0], sessionIds[1], "the SAME session must span both runs (no fresh session)");
      assert.equal(swaps.length, 1, "the gate opens exactly once");
      assert.equal(swaps[0].reason, "first-edit");
      assert.equal(
        swaps[0].fromModel,
        "fauxhand/planner",
        "the session was still on the planning model before the swap",
      );
      assert.equal(swaps[0].toModel, "fauxhand/executor", "the gate swaps to the execution model");
      assert.equal(swaps[0].sessionId, sessionIds[1], "the swap reports the SAME session id (continuation)");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("swap gate fires through an injected tool-call filter (mock)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-handoff-filter-"));
  try {
    await withFakeHomeAsync(cwd, async () => {
      const seen: string[] = [];
      const { agent, core } = await makeHandoffAgent(cwd, {
        // Mock filter: only a custom tool name opens the gate — proves the
        // gate is driven by the injected predicate, not a hardcoded name list.
        handoffToolFilter: (name) => {
          seen.push(name);
          return name === "my_edit_tool";
        },
      });
      core.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("my_edit_tool", { path: "a.txt" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done", { stopReason: "stop" }),
        fauxAssistantMessage("pruned", { stopReason: "stop" }),
      ]);
      const swaps: HandoffSwapInfo[] = [];
      await agent.run("do the work", {
        label: "worker",
        handoff: true,
        onSwap: (info) => swaps.push(info),
      });
      assert.ok(seen.includes("read") && seen.includes("my_edit_tool"), "filter sees every tool call");
      assert.equal(swaps.length, 1, "gate opened on the first my_edit_tool call only");
      assert.equal(swaps[0].reason, "first-edit");
      assert.equal(swaps[0].toModel, "fauxhand/executor");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C3 — a workflow that never edits never swaps
// ═══════════════════════════════════════════════════════════════════════════

test("a workflow that never edits never swaps (gate stays closed, behavior unchanged)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-handoff-c3-"));
  try {
    await withFakeHomeAsync(cwd, async () => {
      const { agent, core } = await makeHandoffAgent(cwd);
      // Two read-only phases: prose only, zero tool calls.
      core.setResponses([
        fauxAssistantMessage("analysis one", { stopReason: "stop" }),
        fauxAssistantMessage("analysis two", { stopReason: "stop" }),
        // A THIRD phase finally edits — its swap must report the model was
        // still the planner (i.e. the gate never opened earlier).
        fauxAssistantMessage(fauxToolCall("edit", { path: "a.txt", oldString: "a", newString: "b" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("executed", { stopReason: "stop" }),
        fauxAssistantMessage("pruned", { stopReason: "stop" }),
      ]);
      const swaps: HandoffSwapInfo[] = [];
      await agent.run("phase 1: analyze", { label: "a1", handoff: true });
      await agent.run("phase 2: analyze more", {
        label: "a2",
        handoff: true,
        onSwap: (info) => swaps.push(info),
      });
      assert.equal(swaps.length, 0, "read-only phases must not open the swap gate");
      await agent.run("phase 3: implement", {
        label: "a3",
        handoff: true,
        onSwap: (info) => swaps.push(info),
      });
      assert.equal(swaps.length, 1, "the gate opens only once the first edit happens");
      assert.equal(swaps[0].fromModel, "fauxhand/planner", "the session model never changed before the first edit");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C2 — two-phase workflow: phase 2's token consumption drops (no re-read)
// ═══════════════════════════════════════════════════════════════════════════

test("two-phase handoff: phase 2 reuses the session and its input is cached, not re-read", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-handoff-c2-"));
  try {
    await withFakeHomeAsync(cwd, async () => {
      const sessionIds: string[] = [];
      const { agent, core } = await makeHandoffAgent(cwd, {
        onHandoffSession: (id) => sessionIds.push(id),
      });
      const bigSummary = "codebase context: ".repeat(200);
      core.setResponses([
        fauxAssistantMessage("the plan: refactor module A to B", { stopReason: "stop" }),
        fauxAssistantMessage("execution complete", { stopReason: "stop" }),
      ]);
      const usages: Array<{ phase: number; input: number; cacheRead: number }> = [];
      const histories: Array<Array<unknown>> = [];
      await agent.run(`Phase 1 — read the codebase and plan:\n${bigSummary}`, {
        label: "planner",
        handoff: true,
        onUsage: (u) => usages.push({ phase: 1, input: u.input, cacheRead: u.cacheRead }),
        onHistory: (h) => histories.push(h),
      });
      const r2 = await agent.run("Phase 2 — execute the plan you produced in phase 1; do not re-read the codebase.", {
        label: "implementer",
        handoff: true,
        onUsage: (u) => usages.push({ phase: 2, input: u.input, cacheRead: u.cacheRead }),
        onHistory: (h) => histories.push(h),
      });

      // Same session: ids identical, and phase 2's transcript already contains
      // phase 1's output (trajectory continuity — nothing was re-read).
      assert.equal(sessionIds.length, 2);
      assert.equal(sessionIds[0], sessionIds[1], "phase 2 must continue phase 1's session (no fresh session)");
      assert.equal(r2, "execution complete");
      assert.ok(
        histories[1].some((h) => JSON.stringify(h).includes("the plan")),
        "phase 2's session carries phase 1's output forward",
      );

      // Token consumption: the re-sent trajectory prefix is billed as a CACHE
      // read, and phase 2's genuinely-new input is a small fraction of phase
      // 1's full read — i.e. phase 2 did not re-read the codebase context.
      assert.ok(usages[1].cacheRead > 0, "phase 2's prefix must hit the provider cache (context not re-read)");
      const phase2FreshInput = usages[1].input - usages[1].cacheRead;
      assert.ok(
        phase2FreshInput < usages[0].input,
        `phase 2's fresh input (${phase2FreshInput}) must be below phase 1's full input (${usages[0].input})`,
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("planning guidance is handoff-only and pruned once the swap gate opens", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-handoff-prune-"));
  try {
    // Non-handoff agents never carry the planning guidance (no behavior change).
    const plain = new WorkflowAgent({ cwd: "/tmp" });
    const plainPrompt = (plain as unknown as { buildPrompt(p: string, o: unknown, s: boolean): string }).buildPrompt(
      "task",
      {},
      false,
    );
    assert.ok(!plainPrompt.includes("PLANNING phase"), "non-handoff agents must not get planning guidance");

    await withFakeHomeAsync(cwd, async () => {
      const sessionIds: string[] = [];
      const { agent, core } = await makeHandoffAgent(cwd, {
        onHandoffSession: (id) => sessionIds.push(id),
      });
      const handoff = agent as unknown as { buildPrompt(p: string, o: unknown, s: boolean): string };
      assert.ok(
        handoff.buildPrompt("task", {}, false).includes("PLANNING phase"),
        "a handoff session starts in planning mode",
      );
      core.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "x" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done", { stopReason: "stop" }),
        fauxAssistantMessage("pruned", { stopReason: "stop" }),
      ]);
      await agent.run("plan then edit", { label: "worker", handoff: true });
      assert.ok(
        !handoff.buildPrompt("task", {}, false).includes("PLANNING phase"),
        "planning context is pruned once the first edit fires the swap",
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Workflow orchestration: phase-boundary chaining + teardown
// ═══════════════════════════════════════════════════════════════════════════

test("runWorkflow chains handoff sessions at phase boundaries only (isolation preserved)", async () => {
  const calls: Array<{ prompt: string; handoff: boolean }> = [];
  const runner = {
    async run(prompt: string, options: { handoff?: boolean }) {
      calls.push({ prompt, handoff: options.handoff === true });
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'chain', description: 'chain', phases: [{ title: 'plan' }, { title: 'execute' }] }
phase('plan')
const a = await agent('p1', { label: 'a' })
const b = await agent('p2', { label: 'b' })
phase('execute')
const c = await agent('e1', { label: 'c' })
const d = await parallel(['x', 'y'].map((p) => () => agent(p, { label: p })))
return { a, b, c, d }`;
  await runWorkflow(script, { agent: runner, sessionHandoff: true, persistLogs: false });
  const byPrompt = new Map(calls.map((c) => [c.prompt, c.handoff]));
  assert.equal(byPrompt.get("p1"), true, "the first top-level call creates the chain root");
  assert.equal(byPrompt.get("p2"), false, "a same-phase sibling gets a fresh session (isolation)");
  assert.equal(byPrompt.get("e1"), true, "a phase-boundary call continues the handoff session");
  assert.equal(byPrompt.get("x"), false, "fan-out agents never chain");
  assert.equal(byPrompt.get("y"), false, "fan-out agents never chain");
});

test("runWorkflow closes the runner (handoff session teardown) when the run finishes", async () => {
  let closed = 0;
  const runner = {
    async run(_prompt: string) {
      return "ok";
    },
    close() {
      closed++;
    },
  };
  await runWorkflow(
    `export const meta = { name: 'close_me', description: 'close' }
const a = await agent('work', { label: 'a' })
return a`,
    { agent: runner, sessionHandoff: true, persistLogs: false },
  );
  assert.equal(closed, 1, "the workflow layer must dispose the runner's handoff session at teardown");
});

test("workflow-level handoff chains a real run across a phase boundary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-handoff-int-"));
  try {
    await withFakeHomeAsync(cwd, async () => {
      const sessionIds: string[] = [];
      const { agent, core } = await makeHandoffAgent(cwd, {
        onHandoffSession: (id) => sessionIds.push(id),
      });
      // Phase-boundary chain in a real run: two phases, different models,
      // first edit in phase 2.
      const script = `export const meta = { name: 'chain_real', description: 'chain real', phases: [{ title: 'plan', model: 'fauxhand/planner' }, { title: 'execute', model: 'fauxhand/executor' }] }
phase('plan')
const plan = await agent('produce a plan', { label: 'planner' })
phase('execute')
const done = await agent('execute the plan', { label: 'implementer' })
return { plan, done }`;
      core.setResponses([
        fauxAssistantMessage("the plan", { stopReason: "stop" }),
        fauxAssistantMessage(fauxToolCall("write", { path: "x.txt", content: "y" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done", { stopReason: "stop" }),
        fauxAssistantMessage("pruned", { stopReason: "stop" }),
      ]);
      const result = await runWorkflow(script, {
        agent,
        sessionHandoff: true,
        persistLogs: false,
      });
      assert.ok(result.result && typeof result.result === "object");
      const rr = result.result as { plan: string; done: string };
      assert.equal(rr.plan, "the plan");
      assert.equal(rr.done, "done");
      // Both phases chained the SAME handoff session end to end (the phase
      // boundary carried the trajectory; the swap happened at the first edit).
      assert.equal(sessionIds.length, 2, "one handoff session id per chained run");
      assert.equal(sessionIds[0], sessionIds[1], "the phase-boundary chain must continue one session");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
