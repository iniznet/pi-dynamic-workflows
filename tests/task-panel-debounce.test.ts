import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type TaskPanelModule = {
  installTaskPanel: (pi: ExtensionAPI | null, manager: unknown, ui: unknown, opts?: unknown) => void;
  renderPanel: (manager: unknown, theme: unknown, width?: number, now?: number) => string[];
};

// Loaded once before all tests (matches the sibling task-panel.test.ts pattern).
let mod: TaskPanelModule;

before(async () => {
  mod = (await import("../src/task-panel.js")) as TaskPanelModule;
});

/** The coalescing window installTaskPanel uses for run events (task-panel.ts). */
const COALESCE_WINDOW_MS = 125;
/** Extra slack so a slow CI timer still fires before the assertion runs. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

/**
 * A mock manager shaped like the real WorkflowManager: an EventEmitter (for the
 * RUN_EVENTS subscriptions) plus listRuns()/getRun(), and an optional `runs`
 * map standing in for the manager's private in-memory live view.
 */
function createMockManager(
  opts: { listRuns?: () => unknown[]; getRun?: (id: string) => unknown; runs?: Map<string, unknown> } = {},
) {
  const manager = new EventEmitter() as InstanceType<typeof EventEmitter> & {
    listRuns: () => unknown[];
    getRun: (id: string) => unknown;
    runs?: Map<string, unknown>;
  };
  manager.listRuns = opts.listRuns ?? (() => []);
  manager.getRun = opts.getRun ?? (() => undefined);
  if (opts.runs) manager.runs = opts.runs;
  return manager;
}

/** Mount the panel widget and capture every tui.requestRender() call. */
function mountPanel(manager: unknown) {
  const renders: string[] = [];
  let factory:
    | ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[]; dispose?(): void })
    | undefined;
  const ui = {
    setWidget: (_name: string, f: typeof factory) => {
      factory = f;
    },
  };
  mod.installTaskPanel(null, manager, ui);
  const comp = factory?.({ requestRender: () => renders.push("render") }, theme);
  return { renders, comp };
}

// ─── panel-render-storm: render coalescing ───────────────────────────────────

describe("task-panel render coalescing", () => {
  it("coalesces a burst of run events into one requestRender per window", async () => {
    const manager = createMockManager();
    const { renders, comp } = mountPanel(manager);
    // A burst of RUN_EVENTS (agentStart/agentEnd/phase/log) fires several times
    // per second per run — the storm the finding describes.
    for (let i = 0; i < 5; i++) {
      manager.emit("agentStart", { runId: "a" });
      manager.emit("log", { runId: "a" });
      manager.emit("phase", { runId: "a" });
    }
    assert.equal(renders.length, 0, "no render while the burst is in flight");
    await sleep(COALESCE_WINDOW_MS + 150);
    assert.equal(renders.length, 1, "a burst coalesces into exactly one render");
    comp?.dispose?.();
  });

  it("renders again per burst window during sustained activity", async () => {
    const manager = createMockManager();
    const { renders, comp } = mountPanel(manager);
    manager.emit("log", { runId: "a" });
    await sleep(COALESCE_WINDOW_MS + 150);
    assert.equal(renders.length, 1, "first burst rendered once");

    manager.emit("agentEnd", { runId: "a" });
    manager.emit("log", { runId: "a" });
    manager.emit("agentStart", { runId: "a" });
    await sleep(COALESCE_WINDOW_MS + 150);
    assert.equal(renders.length, 2, "a later burst produces its own render");
    comp?.dispose?.();
  });

  it("covers lifecycle events too — a completed run still coalesces with the burst", async () => {
    const manager = createMockManager();
    const { renders, comp } = mountPanel(manager);
    manager.emit("log", { runId: "a" });
    manager.emit("complete", { runId: "a" });
    await sleep(COALESCE_WINDOW_MS + 150);
    assert.equal(renders.length, 1, "lifecycle event does not double-render the burst");
    comp?.dispose?.();
  });

  it("clears the pending render on dispose", async () => {
    const manager = createMockManager();
    const { renders, comp } = mountPanel(manager);
    comp?.dispose?.();
    manager.emit("log", { runId: "a" });
    await sleep(COALESCE_WINDOW_MS + 150);
    assert.equal(renders.length, 0, "a disposed panel never renders again");
  });

  it("keeps the 2s ticker repainting while a run is active", async () => {
    const manager = createMockManager({
      listRuns: () => [{ runId: "a", workflowName: "wf", status: "running", agents: [], logs: [] }],
    });
    const { renders, comp } = mountPanel(manager);
    await sleep(2100);
    assert.ok(renders.length >= 1, "the ticker renders even with no run events firing");
    comp?.dispose?.();
  });
});

// ─── panel-render-storm: in-memory rendering ─────────────────────────────────

describe("task-panel in-memory rendering", () => {
  it("renders active runs from the manager's in-memory view when reachable", () => {
    const snapshot = {
      name: "mem-run",
      phases: ["P"],
      currentPhase: "scanning",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", phase: "P", tokens: 100 }],
      startedAtMs: 1000,
    };
    const runs = new Map([["mem", { runId: "mem", status: "running", snapshot }]]);
    // The disk list (listRuns) knows nothing about the live run — the panel
    // must draw it from the in-memory map instead of re-reading the disk list.
    const manager = createMockManager({ runs });
    const lines = mod.renderPanel(manager, theme, undefined, 5000);
    assert.ok(
      lines.some((l) => l.includes("mem-run")),
      "in-memory run rendered without a disk row",
    );
    assert.ok(
      lines.some((l) => l.includes("scanning")),
      "live phase read from the snapshot",
    );
  });

  it("prefers the live snapshot over the stale disk row for an in-memory run", () => {
    const snapshot = {
      name: "wf",
      phases: ["P"],
      currentPhase: "fresh-phase",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", phase: "P", tokens: 100 }],
    };
    const runs = new Map([["r1", { runId: "r1", status: "running", snapshot }]]);
    const manager = createMockManager({
      runs,
      listRuns: () => [
        {
          runId: "r1",
          workflowName: "wf",
          status: "running",
          agents: [],
          logs: [],
          currentPhase: "stale-phase",
        },
      ],
    });
    const lines = mod.renderPanel(manager, theme, undefined, 5000);
    const row = lines.find((l) => l.includes("wf")) ?? "";
    assert.ok(row.includes("fresh-phase"), `live phase wins, got: ${row}`);
    assert.ok(!row.includes("stale-phase"), `stale disk phase not rendered, got: ${row}`);
  });

  it("falls back to the disk list when no in-memory view is reachable", () => {
    const manager = createMockManager({
      listRuns: () => [
        { runId: "d", workflowName: "disk-run", status: "running", agents: [{ status: "done" }], logs: [] },
      ],
    });
    const lines = mod.renderPanel(manager, theme, undefined, 5000);
    assert.ok(
      lines.some((l) => l.includes("disk-run")),
      "persisted run rendered via the fallback",
    );
  });

  it("counts finished runs from the disk list for the navigator hint", () => {
    const snapshot = { name: "live", phases: [], currentPhase: "P", logs: [], agents: [], startedAtMs: 1000 };
    const runs = new Map([["live", { runId: "live", status: "running", snapshot }]]);
    const manager = createMockManager({
      runs,
      listRuns: () => [
        { runId: "live", workflowName: "live", status: "running", agents: [], logs: [] },
        { runId: "old", workflowName: "old", status: "completed", agents: [], logs: [] },
        { runId: "older", workflowName: "older", status: "aborted", agents: [], logs: [] },
      ],
    });
    const lines = mod.renderPanel(manager, theme, undefined, 5000);
    assert.ok(
      lines.some((l) => /2 finished kept in history/.test(l)),
      "finished hint stays disk-derived even when active rows come from memory",
    );
  });
});
