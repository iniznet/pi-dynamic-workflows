/**
 * UI/commands slice fixes (M6/M7/M13/L17/L20/L22/L24/L25 + live cost meter).
 *
 * These tests exercise the PURE pieces of each fix — the helpers are exported
 * so assertions never need a real TUI. Where a fix touches the command wiring
 * (save/rm confirm, /workflows ui), a minimal pi/ctx double drives the handler.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerWorkflowCommands } from "../../../src/workflow-commands.js";
import type { WorkflowManager } from "../../../src/workflow-manager.js";

// ═══════════════════════════════════════════════════════════════════════════
// M6 — corrupt-data guards: persisted `agents` that is not an array must never
// take the task panel or /workflows list down.
// ═══════════════════════════════════════════════════════════════════════════

test("renderPanel survives a run whose persisted agents are not an array (M6)", async () => {
  const { renderPanel } = await import("../../../src/task-panel.js");
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const manager = {
    listRuns: () => [{ runId: "a", workflowName: "corrupt", status: "running", agents: "not-an-array", logs: [] }],
    getRun: () => undefined,
  };
  const lines = renderPanel(manager as never, theme as never);
  assert.ok(
    lines.some((l) => l.includes("corrupt")),
    "run still listed",
  );
  assert.ok(
    lines.some((l) => l.includes("0/0 agents")),
    "corrupt agents count as 0/0",
  );
});

test("renderPanelDetailed survives a run whose persisted agents are an object (M6)", async () => {
  const { renderPanelDetailed, clearTokenSamples } = await import("../../../src/task-panel.js");
  clearTokenSamples("m6-detail");
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const manager = {
    listRuns: () => [{ runId: "m6-detail", workflowName: "bad", status: "running", agents: { oops: true }, logs: [] }],
    getRun: () => undefined,
  };
  const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
  assert.ok(
    lines.some((l) => l.includes("bad")),
    "run still listed",
  );
  assert.ok(
    lines.some((l) => l.includes("0/0 agents")),
    "corrupt agents count as 0/0",
  );
});

test("/workflows list survives a corrupt persisted run without throwing (M6)", async () => {
  const printed: string[] = [];
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    getCommands: () => [],
    registerCommand: (_n: string, o: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      handler = o.handler;
    },
    sendMessage: async (m: { content?: string }) => {
      if (typeof m.content === "string") printed.push(m.content);
    },
  } as unknown as ExtensionAPI;
  const manager = {
    listRuns: () => [{ runId: "r-bad", workflowName: "bad", status: "completed", agents: 42, logs: [] }],
    getSnapshot: () => null,
    getRun: () => undefined,
    on: () => {},
    off: () => {},
  } as unknown as WorkflowManager;
  registerWorkflowCommands(pi, manager);
  assert.ok(handler);
  await handler("list", { ui: { notify: () => {} } } as never);
  assert.match(printed[0] ?? "", /r-bad/);
});

// ═══════════════════════════════════════════════════════════════════════════
// M7 — truthful final labels: paused/stopped/failed never print "completed".
// ═══════════════════════════════════════════════════════════════════════════

test("workflowFinalHeader maps every final status truthfully (M7)", async () => {
  const { workflowFinalHeader } = await import("../../../src/display.js");
  assert.equal(workflowFinalHeader("completed"), "Workflow completed");
  assert.equal(workflowFinalHeader("done"), "Workflow completed");
  assert.equal(workflowFinalHeader("paused"), "Workflow paused (resumable)");
  assert.equal(workflowFinalHeader("stopped"), "Workflow stopped");
  assert.equal(workflowFinalHeader("aborted"), "Workflow stopped");
  assert.equal(workflowFinalHeader("failed"), "Workflow failed");
  assert.equal(workflowFinalHeader("error"), "Workflow failed");
  assert.equal(workflowFinalHeader("running"), "Workflow running");
  assert.equal(workflowFinalHeader("whatever"), "Workflow running");
});

test("renderWorkflowStatusText never labels a paused/stopped/failed run 'completed' (M7)", async () => {
  const { createWorkflowSnapshot, renderWorkflowStatusText } = await import("../../../src/display.js");
  const snap = createWorkflowSnapshot({ name: "wf", description: "d" } as never);
  for (const [status, header] of [
    ["paused", "Workflow paused (resumable)"],
    ["stopped", "Workflow stopped"],
    ["failed", "Workflow failed"],
    ["completed", "Workflow completed"],
  ] as const) {
    const text = renderWorkflowStatusText(snap, status);
    assert.ok(text.startsWith(header), `${status} should open with "${header}"`);
    assert.ok(!/Workflow completed/.test(text) || status === "completed", `${status} must not say completed`);
  }
});

test("watchRun prints a truthful header per final event (M7)", async () => {
  const { registerWorkflowCommands } = await import("../../../src/workflow-commands.js");
  for (const [event, header] of [
    ["complete", "Workflow completed"],
    ["error", "Workflow failed"],
    ["stopped", "Workflow stopped"],
    ["paused", "Workflow paused (resumable)"],
  ] as const) {
    const snapshot = {
      name: "demo",
      phases: ["Run"],
      currentPhase: "Run",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", prompt: "x" }],
      agentCount: 1,
      runningCount: 1,
      doneCount: 0,
      errorCount: 0,
    };
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (id: string) => unknown;
      getSnapshot: () => unknown;
      listRuns: () => unknown[];
    };
    manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
    manager.getSnapshot = () => null;
    manager.listRuns = () => [];

    const printed: string[] = [];
    let handler: ((a: string, c: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      getCommands: () => [],
      registerCommand: (_n: string, o: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) => {
        handler = o.handler;
      },
      sendMessage: async (m: { content?: string }) => {
        if (typeof m.content === "string") printed.push(m.content);
      },
    } as unknown as ExtensionAPI;
    registerWorkflowCommands(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager);
    assert.ok(handler);
    await handler("status run-1", { ui: { notify: () => {}, setStatus: () => {} } } as never);
    manager.emit(event, { runId: "run-1" });
    assert.equal(printed.length, 1, `${event} should print exactly one final snapshot`);
    assert.ok(
      printed[0].startsWith(header),
      `${event} should open with "${header}", got: ${printed[0].split("\n")[0]}`,
    );
  }
});

test("watchRun on a non-running run detaches and returns false (L17 attach-first guard)", async () => {
  const { registerWorkflowCommands } = await import("../../../src/workflow-commands.js");
  const printed: string[] = [];
  let handler: ((a: string, c: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    getCommands: () => [],
    registerCommand: (_n: string, o: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) => {
      handler = o.handler;
    },
    sendMessage: async (m: { content?: string }) => {
      if (typeof m.content === "string") printed.push(m.content);
    },
  } as unknown as ExtensionAPI;
  const manager = {
    listRuns: () => [
      {
        runId: "r-done",
        workflowName: "done",
        status: "completed",
        phases: [],
        agents: [{ id: 1, label: "a", status: "done", prompt: "x" }],
        logs: [],
      },
    ],
    getSnapshot: () => null,
    getRun: () => undefined,
    on: () => {},
    off: () => {},
  } as unknown as WorkflowManager;
  registerWorkflowCommands(pi, manager);
  assert.ok(handler);
  await handler("status r-done", { ui: { notify: () => {}, setStatus: () => {} } } as never);
  assert.equal(printed.length, 1, "a non-running run falls through to the persisted status render");
  assert.match(printed[0], /done \(r-done\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// M13 — save overwrite confirm: a declined confirm must not overwrite.
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows save does not overwrite when the user declines the confirm (M13)", async () => {
  const saved: unknown[] = [];
  const notified: Array<{ message: string; type?: string }> = [];
  const storage = {
    load: () => ({ name: "existing", description: "old", script: "old", location: "project" as const }),
    save: (w: unknown) => {
      saved.push(w);
      return { ...(w as object), id: "saved" };
    },
    list: () => [],
    delete: () => true,
  };
  let handler: ((a: string, c: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    getCommands: () => [],
    registerCommand: (_n: string, o: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) => {
      handler = o.handler;
    },
    sendMessage: async () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  const manager = {
    listRuns: () => [
      {
        runId: "run-1",
        workflowName: "scan",
        status: "completed",
        script: "export const meta = { name: 'scan', description: 'scan' }\nreturn 1",
        args: undefined,
        agents: [],
        logs: [],
      },
    ],
    getSnapshot: () => null,
    getRun: () => undefined,
    pause: () => false,
    resume: async () => false,
    stop: () => false,
    deleteRun: () => false,
    on: () => {},
    off: () => {},
  } as unknown as WorkflowManager;
  registerWorkflowCommands(pi, manager, { storage, cwd: "/tmp" });
  assert.ok(handler);
  const ctx = {
    ui: {
      notify: (m: string, t?: string) => notified.push({ message: m, type: t }),
      confirm: async () => false,
    },
  } as never;
  await handler("save existing run-1", ctx);
  assert.equal(saved.length, 0, "declined confirm must not overwrite the existing saved workflow");
  assert.ok(
    notified.some((n) => /Save cancelled/.test(n.message)),
    "the cancellation is surfaced",
  );
});

test("/workflows save proceeds when the user accepts the overwrite confirm (M13)", async () => {
  const saved: Array<{ name: string }> = [];
  let handler: ((a: string, c: ExtensionCommandContext) => Promise<void>) | undefined;
  const storage = {
    load: () => ({ name: "existing", description: "old", script: "old", location: "project" as const }),
    save: (w: { name: string }) => {
      saved.push(w);
      return { ...w, id: "saved" };
    },
    list: () => saved.map((w) => ({ name: w.name })),
    delete: () => true,
  };
  const pi = {
    getCommands: () => [],
    registerCommand: (_n: string, o: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) => {
      handler = o.handler;
    },
    sendMessage: async () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  const manager = {
    listRuns: () => [
      {
        runId: "run-1",
        workflowName: "scan",
        status: "completed",
        script: "export const meta = { name: 'scan', description: 'scan' }\nreturn 1",
        args: undefined,
        agents: [],
        logs: [],
      },
    ],
    getSnapshot: () => null,
    getRun: () => undefined,
    pause: () => false,
    resume: async () => false,
    stop: () => false,
    deleteRun: () => false,
    on: () => {},
    off: () => {},
  } as unknown as WorkflowManager;
  registerWorkflowCommands(pi, manager, { storage, cwd: "/tmp" });
  assert.ok(handler);
  await handler("save existing run-1", {
    ui: { notify: () => {}, confirm: async () => true },
  } as never);
  assert.equal(saved.length, 1, "accepted confirm overwrites");
  assert.equal(saved[0].name, "existing");
});

// ═══════════════════════════════════════════════════════════════════════════
// L20 — rm confirmation: a declined confirm must not delete.
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows rm does not delete when the user declines the confirm (L20)", async () => {
  const deleted: string[] = [];
  const notified: Array<{ message: string; type?: string }> = [];
  let handler: ((a: string, c: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    getCommands: () => [],
    registerCommand: (_n: string, o: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) => {
      handler = o.handler;
    },
    sendMessage: async () => {},
  } as unknown as ExtensionAPI;
  const manager = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    deleteRun: (id: string) => {
      deleted.push(id);
      return true;
    },
    on: () => {},
    off: () => {},
  } as unknown as WorkflowManager;
  registerWorkflowCommands(pi, manager);
  assert.ok(handler);
  await handler("rm run-9", {
    ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }), confirm: async () => false },
  } as never);
  assert.deepEqual(deleted, [], "declined confirm must not call deleteRun");
  assert.ok(
    notified.some((n) => /Deletion cancelled/.test(n.message)),
    "the cancellation is surfaced",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// L24 — /workflows ui in a no-UI host says so instead of dumping the list.
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows ui in a no-UI host prints an explicit unavailable message (L24)", async () => {
  const printed: string[] = [];
  let handler: ((a: string, c: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    getCommands: () => [],
    registerCommand: (_n: string, o: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }) => {
      handler = o.handler;
    },
    sendMessage: async (m: { content?: string }) => {
      if (typeof m.content === "string") printed.push(m.content);
    },
  } as unknown as ExtensionAPI;
  const manager = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    on: () => {},
    off: () => {},
  } as unknown as WorkflowManager;
  registerWorkflowCommands(pi, manager);
  assert.ok(handler);
  await handler("ui", { hasUI: false, ui: { notify: () => {} } } as never);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /no UI/i);
  assert.doesNotMatch(printed[0], /Workflow runs:/, "must not silently fall back to the list");
});

// ═══════════════════════════════════════════════════════════════════════════
// L22 — result delivery falls back to a notify instead of swallowing (and
// always logs the original failure).
// ═══════════════════════════════════════════════════════════════════════════

test("installResultDelivery notifies and logs when sendMessage throws (L22)", async () => {
  const { installResultDelivery } = await import("../../../src/task-panel.js");
  const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
    getRun: (id: string) => unknown;
  };
  const run = {
    runId: "r-l22",
    background: true,
    snapshot: { name: "wf", agentCount: 1 },
    result: { agentCount: 1, result: { verdict: "done" } },
  };
  manager.getRun = (id: string) => (id === "r-l22" ? run : undefined);

  const notify = mock.fn();
  const warn = mock.method(console, "warn", () => {});
  try {
    installResultDelivery(
      {
        sendMessage: () => {
          throw new Error("stale ctx after reload");
        },
      } as unknown as ExtensionAPI,
      manager as unknown as WorkflowManager,
      { notify: notify as never },
    );
    manager.emit("complete", { runId: "r-l22" });
    assert.equal(notify.mock.callCount(), 1, "fallback notify fires on sync sendMessage failure");
    assert.equal(notify.mock.calls[0].arguments[1], "error");
    assert.match(notify.mock.calls[0].arguments[0] as string, /delivery failed/i);
    assert.equal(warn.mock.callCount(), 1, "the original failure is logged, never swallowed");
  } finally {
    warn.mock.restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// L25 — the isSubstantive threshold is a named, exported constant.
// ═══════════════════════════════════════════════════════════════════════════

test("isSubstantive uses the exported SUBSTANTIVE_MIN_LENGTH constant (L25)", async () => {
  const { isSubstantive, SUBSTANTIVE_MIN_LENGTH } = await import("../../../src/effort-command.js");
  assert.equal(typeof SUBSTANTIVE_MIN_LENGTH, "number");
  const terse = "x".repeat(SUBSTANTIVE_MIN_LENGTH - 1);
  const boundary = "x".repeat(SUBSTANTIVE_MIN_LENGTH);
  assert.equal(isSubstantive(terse), false, "under the threshold is not substantive");
  assert.equal(isSubstantive(boundary), true, "at the threshold is substantive");
  assert.equal(isSubstantive("/".concat(boundary)), false, "slash commands never arm");
});

// ═══════════════════════════════════════════════════════════════════════════
// L19 — per-keystroke render discipline: one keypress performs ONE persisted
// runs() scan (itemKindAt + currentCount + drill all share a render frame).
// ═══════════════════════════════════════════════════════════════════════════

test("a navigator keypress reads persisted runs at most once (L19 frame)", async () => {
  const { openWorkflowNavigator } = await import("../../../src/workflow-ui.js");
  type Captured = { handleInput?: (data: string) => void; dispose?: () => void };
  let captured: Captured | undefined;
  const ui = {
    notify: () => {},
    custom: <T>(
      factory: (_tui: unknown, _theme: unknown, _keybindings: unknown, _done: (result: T) => void) => Captured,
    ) => {
      const component = factory(
        { requestRender: () => {}, terminal: { rows: 24 } },
        { fg: (_n: string, s: string) => s, bg: (_n: string, s: string) => s, bold: (s: string) => s },
        {},
        () => {},
      );
      captured = component;
      return Promise.resolve(undefined as T);
    },
  };
  let listCalls = 0;
  const manager = {
    on: () => {},
    off: () => {},
    listRuns: () => {
      listCalls++;
      return [
        {
          runId: "l19",
          workflowName: "wf",
          status: "running",
          phases: [],
          agents: [],
          logs: [],
        },
      ];
    },
    getRun: () => undefined,
  };

  openWorkflowNavigator({} as ExtensionAPI, manager as never, ui as never).catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(captured, "navigator component captured");

  listCalls = 0;
  captured.handleInput?.("down");
  assert.equal(listCalls, 1, "move+itemKindAt+currentCount share one frame: exactly 1 listRuns() per keypress");

  listCalls = 0;
  captured.handleInput?.("enter");
  assert.equal(listCalls, 1, "drill reads runs() once inside the same frame");
  captured.dispose?.();
});

// ═══════════════════════════════════════════════════════════════════════════
// FEATURE — live cost meter: pure math + a rendered detailed-panel fixture.
// ═══════════════════════════════════════════════════════════════════════════

test("cost-meter math: pricePerToken/costPerSecond/estimatedCost are exact and safe", async () => {
  const { pricePerToken, costPerSecond, estimatedCost } = await import("../../../src/display.js");
  const price = pricePerToken(1.25);
  assert.ok(price !== undefined && Math.abs(price - 0.00000125) < 1e-12, "per-token price from per-1M output");
  const cps = costPerSecond(1000, price);
  assert.ok(cps !== undefined && Math.abs(cps - 0.00125) < 1e-12, "rate × price = cost/s");
  const spent = estimatedCost(1000, price);
  assert.ok(spent !== undefined && Math.abs(spent - 0.00125) < 1e-12, "tokens × price = spend");
  assert.equal(pricePerToken(undefined), undefined);
  assert.equal(pricePerToken(0), undefined);
  assert.equal(pricePerToken(-1), undefined);
  assert.equal(costPerSecond(0, price), undefined);
  assert.equal(costPerSecond(1000, undefined), undefined);
  assert.equal(estimatedCost(0, price), undefined);
});

test("formatBudgetBar renders a 10-cell bar and hides when no budget", async () => {
  const { formatBudgetBar } = await import("../../../src/display.js");
  assert.equal(formatBudgetBar(5000, 10000), "[█████░░░░░] 50%");
  assert.equal(formatBudgetBar(0, 10000), "[░░░░░░░░░░] 0%");
  assert.equal(formatBudgetBar(12000, 10000), "[██████████] 100%", "clamped at 100%");
  assert.equal(formatBudgetBar(5000, null), "", "null budget renders nothing");
  assert.equal(formatBudgetBar(5000, undefined), "", "absent budget renders nothing");
});

test("renderPanelDetailed shows estimated cost/s, spend, and a budget bar from the registry (FEATURE)", async () => {
  const { renderPanelDetailed, clearTokenSamples } = await import("../../../src/task-panel.js");
  clearTokenSamples("cost-r1");
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const model = {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    cost: { output: 1000 },
    contextWindow: 200000,
  };
  function costManager(tokens: number) {
    const snapshot = {
      name: "cost-meter",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [{ id: 1, label: "a1", status: "done", phase: "Scan", tokens, model: "anthropic/claude-haiku-4-5" }],
      tokenUsage: { total: 0, input: 0, output: 0 },
    };
    return {
      listRuns: () => [
        {
          runId: "cost-r1",
          workflowName: "cost-meter",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
          tokenBudget: 100000,
        },
      ],
      getRun: (id: string) => (id === "cost-r1" ? { snapshot, status: "running" } : undefined),
      getModelRegistry: () => ({ getAvailable: () => [model], getAll: () => [model], find: () => model }),
    };
  }
  // Two growing samples → 2000 tok/s; price = $1000/1M output → ~$2/s.
  renderPanelDetailed(costManager(1000) as never, theme as never, undefined, 8, 1000);
  const lines = renderPanelDetailed(costManager(3000) as never, theme as never, undefined, 8, 2000);
  const text = lines.join("\n");
  assert.match(text, /2000 tok\/s/, "live rate readout");
  assert.match(text, /~\$2\.00\/s/, "estimated cost/s = rate × tier price");
  assert.match(text, /\[░░░░░░░░░░\] 3%/, "spend-vs-tokenBudget bar (3000/100000)");
  assert.match(text, /~\$3\.00 estimated spend across 1 active run/, "session-aggregate cost line");
});

test("renderPanelDetailed falls back to finalized cost when the registry has no price (FEATURE)", async () => {
  const { renderPanelDetailed, clearTokenSamples } = await import("../../../src/task-panel.js");
  clearTokenSamples("cost-r2");
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const snapshot = {
    name: "wf",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    agents: [{ id: 1, label: "a", status: "done", phase: "P", tokens: 1000, model: "unknown/model" }],
    tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
  };
  const manager = {
    listRuns: () => [
      {
        runId: "cost-r2",
        workflowName: "wf",
        status: "running",
        agents: snapshot.agents,
        tokenUsage: snapshot.tokenUsage,
      },
    ],
    getRun: (id: string) => (id === "cost-r2" ? { snapshot, status: "running" } : undefined),
    getModelRegistry: () => undefined,
  };
  const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
  assert.match(lines.join("\n"), /\$0\.02/, "finalized cost shown without a ~ estimate marker");
  assert.doesNotMatch(lines.join("\n"), /\/s/, "no per-second estimate without a known price");
});
