import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { createEffortState, effortDirective } from "../src/effort-command.js";
import { WorkflowStateManager } from "../src/phases/state-machine.js";
import { createRunPersistence, loadRunState } from "../src/run-persistence.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "../src/workflow-editor.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { createWorktree } from "../src/worktree.js";

type Handler = (args: string, ctx: any) => Promise<void>;

/** Capture the registered command + outputs for assertions. */
function harness(
  managerOverrides: Record<string, any> = {},
  commandOptions: Record<string, any> = {},
  initialTools: string[] = [WORKFLOW_TOOL_NAME],
  sendMessageImpl?: (
    m: { customType?: string; content?: string },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ) => Promise<void>,
) {
  const printed: string[] = [];
  const sent: Array<{
    customType?: string;
    content?: string;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  const notified: Array<{ message: string; type?: string }> = [];
  const calls: string[] = [];
  const activeTools = [...initialTools];
  let handler: Handler | undefined;

  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [],
    registerCommand: (_name: string, opts: { handler: Handler }) => {
      handler = opts.handler;
    },
    sendMessage: (sendMessageImpl ??
      (async (
        m: { customType?: string; content?: string },
        options?: { triggerTurn?: boolean; deliverAs?: string },
      ) => {
        sent.push({ ...m, options });
        if (!options && typeof m.content === "string") printed.push(m.content);
      })) as unknown as ExtensionAPI["sendMessage"],
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames: string[]) => {
      activeTools.splice(0, activeTools.length, ...toolNames);
    },
  };

  const manager: Partial<WorkflowManager> = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    // The real WorkflowManager extends EventEmitter, so watchRun's attach-first
    // listener registration (L17) requires these on every manager-shaped fixture.
    on: () => manager as WorkflowManager,
    off: () => manager as WorkflowManager,
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      return true;
    },
    pause: (id: string) => {
      calls.push(`pause:${id}`);
      return true;
    },
    resume: async (id: string) => {
      calls.push(`resume:${id}`);
      return false;
    },
    deleteRun: (id: string) => {
      calls.push(`rm:${id}`);
      return true;
    },
    ...managerOverrides,
  };

  registerWorkflowCommands(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager, commandOptions);
  const ctx = { ui: { notify: (message: string, type?: string) => notified.push({ message, type }) } };
  const run = (args: string) => {
    if (!handler) throw new Error("command not registered");
    return handler(args, ctx);
  };
  return { run, printed, sent, notified, calls, activeTools };
}

test("/workflows list shows empty hint when no runs", async () => {
  const h = harness();
  await h.run("list");
  assert.match(h.printed[0], /No workflow runs yet/);
});

test("/workflows (no args) defaults to list", async () => {
  const h = harness({
    listRuns: () => [{ runId: "run-1", workflowName: "demo", status: "completed", phases: [], agents: [], logs: [] }],
  });
  await h.run("");
  assert.match(h.printed[0], /Workflow runs:/);
  assert.match(h.printed[0], /run-1/);
});

test("/workflows list rows unify canonical glyph + word + phase + elapsed + tokens/cost", async () => {
  const h = harness({
    listRuns: () => [
      {
        runId: "wf-a1b2",
        workflowName: "audit",
        status: "paused",
        currentPhase: "Scan",
        phases: ["Scan"],
        agents: [
          { id: 1, label: "a", status: "done", prompt: "x" },
          { id: 2, label: "b", status: "done", prompt: "x" },
          { id: 3, label: "c", status: "done", prompt: "x" },
        ],
        logs: [],
        durationMs: 242_000,
      },
      {
        runId: "wf-c3d4",
        workflowName: "review",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        tokenUsage: { input: 100_000, output: 20_000, total: 120_000, cost: 1.2 },
      },
    ],
  });
  await h.run("list");
  const out = h.printed[0];
  assert.match(out, /Workflow runs:/);
  assert.match(out, /⏸ wf-a1b2\s+audit — paused · Scan · 3\/3 agents · 4m 02s/);
  assert.match(out, /✓ wf-c3d4\s+review — completed · 0\/0 agents · [\d.,]+ tok · \$1\.20/);
  assert.match(out, /Legend: · pending ◆ running ⏸ paused ✓ completed ✗ failed ⊘ aborted/);
});

test("/workflows (no args) prints the legend instead of the 11-verb usage block", async () => {
  const h = harness({
    listRuns: () => [{ runId: "run-1", workflowName: "demo", status: "running", phases: [], agents: [], logs: [] }],
  });
  await h.run("");
  const out = h.printed[0];
  assert.match(out, /Workflow runs:/);
  assert.match(out, /Legend: /);
  assert.doesNotMatch(out, /Usage: \/workflows/);
});

test("/workflows list shows live elapsed from startedAt for a running run without durationMs", async () => {
  const h = harness({
    listRuns: () => [
      {
        runId: "wf-live",
        workflowName: "audit",
        status: "running",
        phases: [],
        agents: [],
        logs: [],
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  });
  await h.run("list");
  assert.match(h.printed[0], /1m \d{2}s/);
});

test("/workflows list elapsed prefers cumulative startedAtMs over the ISO stamp (resume keeps original start)", async () => {
  // ISO startedAt is the resume-local time on disk; startedAtMs is the run's
  // ORIGINAL first start (see PersistedRunState.startedAtMs). The row must read
  // the cumulative clock so a resumed run doesn't reset to ~0s.
  const h = harness({
    listRuns: () => [
      {
        runId: "wf-res",
        workflowName: "audit",
        status: "running",
        phases: [],
        agents: [],
        logs: [],
        startedAtMs: Date.now() - 4 * 60_000,
        startedAt: new Date(Date.now() - 3_000).toISOString(),
      },
    ],
  });
  await h.run("list");
  assert.match(h.printed[0], /4m \d{2}s/);
  assert.doesNotMatch(h.printed[0], /0m 0\ds/);
});

test("/workflows status <id> labels runs with canonical glyphs", async () => {
  const h = harness({
    listRuns: () => [
      {
        runId: "run-p",
        workflowName: "audit",
        status: "paused",
        phases: ["Scan"],
        currentPhase: "Scan",
        agents: [
          { id: 1, label: "scan files", status: "done", prompt: "x" },
          { id: 2, label: "audit keys", status: "running", prompt: "x" },
        ],
        logs: [],
      },
    ],
  });
  await h.run("status run-p");
  assert.match(h.printed[0], /⏸ audit \(run-p\) — paused/);
  assert.match(h.printed[0], /\s+✓ scan files/);
  assert.match(h.printed[0], /\s+◆ audit keys/);
});

test("/workflows run without prompt warns usage", async () => {
  const h = harness();
  await h.run("run");
  assert.equal(h.sent.length, 0);
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage: \/workflows run <prompt>/);
});

test("/workflows run <prompt> sends a forced workflow follow-up turn", async () => {
  const h = harness();
  await h.run("run audit auth boundaries");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].customType, "workflow-run");
  // #P5: /workflows run is an explicit command → forcing directive (no question-escape).
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("audit auth boundaries"));
  assert.doesNotMatch(h.sent[0].content ?? "", /answer it directly and stay/i, "no question-answer escape");
  assert.match(h.sent[0].content ?? "", /Call the `workflow` tool now/i, "forces the tool call");
  assert.equal(h.sent[0].options?.triggerTurn, true);
  assert.equal(h.sent[0].options?.deliverAs, "followUp");
  assert.deepEqual(h.activeTools, [WORKFLOW_TOOL_NAME], "does not duplicate an already-active workflow tool");
});

test("/workflows run <prompt> notifies error when sendMessage rejects and does not bubble", async () => {
  const failingSend = async () => {
    throw new Error("send failed");
  };
  const h = harness({}, {}, [WORKFLOW_TOOL_NAME], failingSend);
  await h.run("run audit auth");
  assert.ok(
    h.notified.some((n) => n.message === "Could not start the workflow turn."),
    "should notify the error message",
  );
});

test("/workflows run adds the workflow tool when absent and does not depend on the keyword trigger", async () => {
  const h = harness({}, {}, ["bash", "read"]);
  await h.run("run summarize the auth module");
  assert.deepEqual(h.activeTools, ["bash", "read", WORKFLOW_TOOL_NAME]);
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("summarize the auth module"));
});

test("/workflows run carries standing effort directives", async () => {
  const effort = createEffortState();
  effort.level = "ultra";
  const h = harness({}, { effort });
  await h.run("run do X");
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("do X", effortDirective("ultra")));
});

test("/workflows stop <id> calls manager.stop", async () => {
  const h = harness();
  await h.run("stop run-9");
  assert.deepEqual(h.calls, ["stop:run-9"]);
});

test("/workflows status <id> renders a persisted run", async () => {
  const h = harness({
    listRuns: () => [
      {
        runId: "run-7",
        workflowName: "audit",
        status: "completed",
        phases: ["Scan"],
        agents: [{ id: 1, label: "scan files", status: "done", prompt: "x" }],
        logs: [],
        tokenUsage: { input: 10, output: 5, total: 15 },
      },
    ],
  });
  await h.run("status run-7");
  assert.match(h.printed[0], /audit \(run-7\)/);
  assert.match(h.printed[0], /scan files/);
});

test("/workflows status without id warns", async () => {
  const h = harness();
  await h.run("status");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
});

test("registerWorkflowCommands is idempotent (skips when already registered)", () => {
  let registrations = 0;
  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [{ name: "workflows" } as SlashCommandInfo],
    registerCommand: () => {
      registrations++;
    },
  };
  registerWorkflowCommands(pi as unknown as ExtensionAPI, {} as unknown as WorkflowManager);
  assert.equal(registrations, 0);
});

test("/workflows status watches a running run: live status bar + prints on completion", async () => {
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
  const manager: any = new EventEmitter();
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];

  const statusLine: Array<string | undefined> = [];
  const printed: string[] = [];
  let handler: ((a: string, c: any) => Promise<void>) | undefined;
  const pi: any = {
    getCommands: () => [],
    registerCommand: (_n: string, o: any) => {
      handler = o.handler;
    },
    sendMessage: async (m: any) => printed.push(m.content),
  };
  registerWorkflowCommands(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager);
  const ctx = { ui: { notify: () => {}, setStatus: (_k: string, t?: string) => statusLine.push(t) } };

  assert.ok(handler, "handler should exist");
  await handler("status run-1", ctx);
  assert.ok(
    statusLine.some((s) => typeof s === "string"),
    "sets a live status line",
  );
  assert.equal(printed.length, 0, "does not print until the run finishes");

  // Mark done and emit completion -> watcher prints the final snapshot and clears status.
  snapshot.agents[0].status = "done";
  manager.emit("complete", { runId: "run-1" });
  assert.equal(printed.length, 1, "prints final snapshot on completion");
  assert.ok(statusLine.includes(undefined), "clears the status line");
});

test("/workflows watch appends elapsed to the live status line when the snapshot has startedAtMs", async () => {
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
    startedAtMs: Date.now() - 60_000,
  };
  const manager: any = new EventEmitter();
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];

  const statusLine: Array<string | undefined> = [];
  let handler: ((a: string, c: any) => Promise<void>) | undefined;
  const pi: any = {
    getCommands: () => [],
    registerCommand: (_n: string, o: any) => {
      handler = o.handler;
    },
    sendMessage: async () => {},
  };
  registerWorkflowCommands(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager);
  const ctx = { ui: { notify: () => {}, setStatus: (_k: string, t?: string) => statusLine.push(t) } };

  assert.ok(handler, "handler should exist");
  await handler("status run-1", ctx);
  const live = statusLine.find((s) => typeof s === "string");
  assert.ok(live, "sets a live status line");
  assert.match(live, /1m \d{2}s/, "the status line carries the run's elapsed");
});

// ═══════════════════════════════════════════════════════════════════════════
// pause — calls manager.pause, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows pause <id> calls manager.pause and notifies Paused", async () => {
  const h = harness();
  await h.run("pause run-p1");
  assert.deepEqual(h.calls, ["pause:run-p1"], "should call manager.pause");
  assert.equal(h.notified.length, 1);
  assert.match(h.notified[0].message, /Paused.+run-p1/);
});

test("/workflows pause without id warns usage", async () => {
  const h = harness();
  await h.run("pause");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows pause <id> warns when manager.pause returns false", async () => {
  const h = harness({ pause: () => false });
  await h.run("pause run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot pause")),
    "should show cannot pause",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// resume — calls manager.resume, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows resume <id> calls manager.resume and notifies Resumed", async () => {
  const h = harness({
    resume: async (id: string) => {
      h.calls.push(`resume:${id}`);
      return true;
    },
  });
  await h.run("resume run-r1");
  assert.ok(
    h.calls.some((c) => c.startsWith("resume:run-r1")),
    "should call manager.resume",
  );
  assert.ok(
    h.notified.some((n) => n.message.includes("Resumed")),
    "should notify Resumed",
  );
});

test("/workflows resume without id warns usage", async () => {
  const h = harness();
  await h.run("resume");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows resume <id> warns when resume returns false", async () => {
  const h = harness({ resume: async () => false });
  await h.run("resume run-fail");
  assert.ok(
    h.notified.some((n) => n.message.includes("Resume not available")),
    "should show not available",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Resume not available"))?.type, "warning");
});

// ═══════════════════════════════════════════════════════════════════════════
// rm — calls manager.deleteRun, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows rm <id> calls manager.deleteRun and notifies Removed", async () => {
  const h = harness();
  await h.run("rm run-del1");
  assert.deepEqual(h.calls, ["rm:run-del1"], "should call manager.deleteRun");
  assert.ok(
    h.notified.some((n) => n.message.includes("Removed")),
    "should notify Removed",
  );
});

test("/workflows rm without id warns usage", async () => {
  const h = harness();
  await h.run("rm");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows rm <id> warns when deleteRun returns false", async () => {
  const h = harness({ deleteRun: () => false });
  await h.run("rm run-missing");
  assert.ok(
    h.notified.some((n) => n.message.includes("No run")),
    "should show No run",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// stop without id — warn usage
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows stop without id warns usage", async () => {
  const h = harness();
  await h.run("stop");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows stop <id> shows Cannot stop when manager returns false", async () => {
  const h = harness({ stop: () => false, getRun: () => undefined });
  await h.run("stop run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot stop")),
    "should show cannot stop",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Cannot stop"))?.type, "warning");
});

test("/workflows stop <id> notifies info (not warning) when stopped a real run", async () => {
  const h = harness({ stop: () => true, getRun: () => ({}) });
  await h.run("stop run-active");
  const stopMsg = h.notified.find((n) => n.message.includes("Stopped"));
  assert.ok(stopMsg, "should notify Stopped");
  assert.equal(stopMsg?.type, "info", "should be info when run was actually running");
});

// ═══════════════════════════════════════════════════════════════════════════
// save — saves a run's script as a saved workflow
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows save without name warns usage", async () => {
  const h = harness();
  await h.run("save");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows save <name> warns when no storage configured", async () => {
  const h = harness();
  await h.run("save my-workflow");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "error");
  assert.match(h.notified[0].message, /Saving is not available/);
});

test("/workflows save <name> saves the most recent run with a script", async () => {
  const saved: Array<{ name: string; description: string; script: string }> = [];
  const _h = harness({
    listRuns: () => [
      { runId: "old", workflowName: "old", status: "completed", script: null, agents: [], logs: [] },
      {
        runId: "recent",
        workflowName: "scan",
        status: "completed",
        script: "export const meta = { name: 'scan', description: 'scan' }",
        agents: [],
        logs: [],
      },
    ],
  });
  // Register with storage mock
  const storage: any = {
    save: (w: any) => {
      saved.push(w);
      return { ...w, id: "saved-1" };
    },
  };
  registerWorkflowCommands(
    {
      getCommands: () => [],
      registerCommand: (_n: string, _o: any) => {},
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => [
        {
          runId: "recent",
          workflowName: "scan",
          status: "completed",
          script: "export const meta = { name: 'scan', description: 'scan' }",
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
    } as unknown as WorkflowManager,
    { storage },
  );

  assert.equal(saved.length, 0);
});

test("/workflows save <name> <runId> saves the specified run", async () => {
  const saved: Array<{ name: string; description: string; script: string }> = [];
  const storage: any = {
    save: (w: any) => {
      saved.push(w);
      return { ...w, id: "saved-2" };
    },
  };

  const runs = [
    {
      runId: "run-target",
      workflowName: "audit",
      status: "completed",
      script: "export const meta = { name: 'audit', description: 'audit' }",
      agents: [],
      logs: [],
    },
  ];

  // Override the handler for one invocation
  const { registerWorkflowCommands: reg2 } = await import("../src/workflow-commands.js");
  const notified: Array<{ message: string; type?: string }> = [];
  let handler: any;
  reg2(
    {
      getCommands: () => [{ name: "xxx" }],
      registerCommand: (_n: string, o: any) => {
        handler = o.handler;
      },
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => runs,
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  if (handler) {
    await handler("save target-name run-target", {
      ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
    });
  }
  assert.equal(saved.length, 1, "should save one workflow");
  assert.equal(saved[0].name, "target-name");
  assert.equal(saved[0].script, runs[0].script);
  assert.ok(
    notified.some((n) => n.message.includes("Saved")),
    "should notify Saved",
  );
});

test("/workflows save <name> <runId> warns when run has no script", async () => {
  const storage: any = { save: (w: any) => w };
  let handler: any;
  const { registerWorkflowCommands: reg3 } = await import("../src/workflow-commands.js");
  const notified: Array<{ message: string; type?: string }> = [];
  reg3(
    {
      getCommands: () => [{ name: "xxx" }],
      registerCommand: (_n: string, o: any) => {
        handler = o.handler;
      },
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => [{ runId: "no-script", workflowName: "empty", status: "completed", agents: [], logs: [] }],
      getSnapshot: () => null,
      getRun: () => undefined,
      pause: () => false,
      resume: async () => false,
      stop: () => false,
      deleteRun: () => false,
    } as unknown as WorkflowManager,
    { storage },
  );

  if (handler) {
    await handler("save empty no-script", {
      ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
    });
  }
  assert.equal(notified.length, 1);
  assert.match(notified[0].message, /No run/, "should warn no script");
});

test("/workflows save validates the run's script before saving — malformed scripts are rejected, nothing is blocked", async () => {
  const saved: Array<{ name: string; script: string }> = [];
  let handler: any;
  const storage: any = {
    save: (w: any) => {
      saved.push(w);
      return { ...w, name: w.name };
    },
    list: () => saved,
  };
  const notified: Array<{ message: string; type?: string }> = [];
  const { registerWorkflowCommands: reg4 } = await import("../src/workflow-commands.js");
  reg4(
    {
      getCommands: () => [{ name: "xxx" }],
      registerCommand: (_n: string, o: any) => {
        handler = o.handler;
      },
      sendMessage: async () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI,
    {
      listRuns: () => [
        {
          runId: "run-bad",
          workflowName: "broken",
          status: "completed",
          script: "const notAWorkflow = 1",
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
    } as unknown as WorkflowManager,
    { storage, cwd: "/tmp" },
  );

  assert.ok(handler);
  await handler("save broken run-bad", {
    ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
  });
  assert.equal(saved.length, 0, "a malformed script must not be persisted");
  assert.ok(
    notified.some((n) => n.type === "error" && n.message.includes("Cannot save")),
    "should notify Cannot save",
  );
  assert.ok(
    notified.some((n) => n.message.includes("first statement")),
    "the validation error should name the concrete problem",
  );
});

test("/workflows save derives the arg schema from the run's args and wires /name through the manager", async () => {
  const saved: Array<{ name: string; parameters?: unknown }> = [];
  const started: string[] = [];
  const commands = new Map<string, { handler: (a: string, c: any) => Promise<void> }>();
  const storage: any = {
    save: (w: any) => {
      saved.push(w);
      return { ...w, name: w.name };
    },
    list: () => saved.map((w) => ({ name: w.name })),
  };
  const pi = {
    getCommands: () => [...commands.keys()].map((name) => ({ name })),
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendMessage: async () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  const manager: any = {
    listRuns: () => [
      {
        runId: "run-1",
        workflowName: "scan",
        status: "completed",
        script: "export const meta = { name: 'scan', description: 'scan' }\nreturn 1",
        args: { scope: "src/", depth: 2, verbose: true },
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
    startInBackground: (script: string, args: unknown) => {
      started.push(JSON.stringify({ script, args }));
      return { runId: "new-run-1" };
    },
  };

  const { registerWorkflowCommands: reg5 } = await import("../src/workflow-commands.js");
  const notified: Array<{ message: string; type?: string }> = [];
  reg5(pi as unknown as ExtensionAPI, manager as unknown as WorkflowManager, { storage, cwd: "/tmp" });

  const ctx = { ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) } };
  const workflows = commands.get("workflows");
  assert.ok(workflows, "/workflows command should be registered");
  await workflows.handler("save scan run-1", ctx);

  assert.equal(saved.length, 1, "should save exactly one workflow");
  const parameters = saved[0].parameters as Record<string, { type: string; default: unknown }>;
  assert.equal(parameters?.scope.type, "string");
  assert.equal(parameters?.scope.default, "src/");
  assert.equal(parameters?.depth.type, "integer");
  assert.equal(parameters?.depth.default, 2);
  assert.equal(parameters?.verbose.type, "boolean");
  assert.equal(parameters?.verbose.default, true);

  // The newly registered /scan command runs through the SHARED manager's
  // background path (full execution parity) instead of the inline fallback.
  assert.ok(commands.has("scan"), "the saved workflow should be registered as a command");
  const scan = commands.get("scan");
  assert.ok(scan, "/scan command should be registered");
  await scan.handler("", ctx);
  assert.equal(started.length, 1, "/scan should start through startInBackground");
  assert.ok(
    notified.some((n) => n.message.includes("new-run-1")),
    "the background start notice should include the new run id",
  );
  const launch = JSON.parse(started[0]) as { script: string; args: Record<string, unknown> };
  assert.match(launch.script, /name: 'scan'/);
  assert.equal(launch.args.scope, "src/", "declared defaults replay the originating invocation");
  assert.equal(launch.args.depth, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// implement — Phase 3 fan-out, gated on human approval (G1)
// ═══════════════════════════════════════════════════════════════════════════

/** Minimal git repo with identity + a base commit (worktree fixture). */
function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

/**
 * Fixture for `/workflows implement`: writes the run's plan file at the
 * canonical `.pi/workflows/plans/<runId>.json` path and drives the REAL phase
 * machine into the gate-open state (Phase 3 + humanApproved).
 */
async function approvedImplementFixture(repo: string, runId: string, stepCount = 2): Promise<WorkflowStateManager> {
  const plansDir = join(repo, ".pi", "workflows", "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, `${runId}.json`),
    JSON.stringify({
      id: `bp-${runId}`,
      title: `plan for ${runId}`,
      preconditions: ["p"],
      executionSteps: Array.from({ length: stepCount }, (_, i) => ({
        id: `s${i}`,
        description: `step ${i}`,
        action: `action ${i}`,
        expectedOutcome: "done",
        rollbackProcedure: "revert",
      })),
      failSafeProcedures: ["fs"],
      verificationTests: ["vt"],
      createdAt: new Date().toISOString(),
    }),
    "utf-8",
  );
  const phaseState = new WorkflowStateManager(join(repo, ".pi", "workflows"));
  await phaseState.markWayfinderComplete();
  await phaseState.markPrewalkComplete();
  await phaseState.transitionTo(1);
  await phaseState.transitionTo(2);
  await phaseState.approvePlan();
  await phaseState.transitionTo(3);
  return phaseState;
}

test("/workflows implement without id warns usage", async () => {
  const h = harness();
  await h.run("implement");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage: \/workflows implement/);
});

test("/workflows implement <id> errors when the run does not exist and never fans out", async () => {
  let factoryCalls = 0;
  const h = harness(
    {},
    {
      cwd: "/tmp",
      implementRunnerFactory: () => {
        factoryCalls++;
        return {
          executeTasks: async () => [],
          getTaskStatus: () => undefined,
          cleanup: async () => {},
          abort: () => {},
        };
      },
    },
  );
  await h.run("implement run-missing");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "error");
  assert.match(h.notified[0].message, /No workflow run/);
  assert.equal(factoryCalls, 0, "no fan-out without a run");
});

test("/workflows implement <id> refuses while humanApproved is false (no phase state = Phase 0)", async () => {
  const repo = initRepo("wf-cmd-gate1-");
  let factoryCalls = 0;
  try {
    const h = harness(
      { getRun: (id: string) => ({ runId: id, status: "completed" }) },
      {
        cwd: repo,
        // A fresh state machine (no state file) reads defaults: Phase 0, no approval.
        phaseState: new WorkflowStateManager(join(repo, ".pi", "workflows")),
        implementRunnerFactory: () => {
          factoryCalls++;
          return {
            executeTasks: async () => [],
            getTaskStatus: () => undefined,
            cleanup: async () => {},
            abort: () => {},
          };
        },
      },
    );
    await h.run("implement run-unapproved");
    assert.ok(
      h.notified.some((n) => n.type === "warning" && n.message.includes("implement blocked")),
      "the Phase 3 + humanApproved gate must refuse an unapproved run",
    );
    assert.ok(
      h.notified.some((n) => n.message.includes("Phase 3 with human approval")),
      "the refusal names the missing gate",
    );
    assert.equal(factoryCalls, 0, "no fan-out while the approval gate is closed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("/workflows implement <id> refuses in Phase 3 when the plan was never approved", async () => {
  const repo = initRepo("wf-cmd-gate2-");
  let factoryCalls = 0;
  try {
    // Phase 3 reached without approvePlan — humanApproved stays false.
    const phaseState = new WorkflowStateManager(join(repo, ".pi", "workflows"));
    await phaseState.setState({ activePhase: 3, humanApproved: false });
    const h = harness(
      { getRun: (id: string) => ({ runId: id, status: "completed" }) },
      {
        cwd: repo,
        phaseState,
        implementRunnerFactory: () => {
          factoryCalls++;
          return {
            executeTasks: async () => [],
            getTaskStatus: () => undefined,
            cleanup: async () => {},
            abort: () => {},
          };
        },
      },
    );
    await h.run("implement run-unapproved");
    assert.ok(
      h.notified.some((n) => n.type === "warning" && n.message.includes("implement blocked")),
      "Phase 3 alone is not enough — human approval is the gate",
    );
    assert.equal(factoryCalls, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("/workflows implement <id> fans approved plan steps out into isolated worktrees", async () => {
  const repo = initRepo("wf-cmd-impl-");
  let factoryCalls = 0;
  const receivedTasks: Array<{ id: string; branch?: string; worktreePath: string; repoRoot: string }> = [];
  try {
    const phaseState = await approvedImplementFixture(repo, "run-impl", 2);
    const h = harness(
      { getRun: (id: string) => ({ runId: id, status: "completed" }) },
      {
        cwd: repo,
        phaseState,
        implementRunnerFactory: () => {
          factoryCalls++;
          return {
            executeTasks: async (tasks: any[]) => {
              receivedTasks.push(...tasks);
              return tasks.map((t) => ({ taskId: t.id, success: true, output: "ok", duration: 5 }));
            },
            getTaskStatus: () => undefined,
            cleanup: async () => {},
            abort: () => {},
          };
        },
      },
    );
    await h.run("implement run-impl");

    assert.equal(factoryCalls, 1, "the runner factory supplies the production runner seam");
    assert.equal(receivedTasks.length, 2, "one worktree task per blueprint execution step");
    for (const [index, task] of receivedTasks.entries()) {
      assert.equal(task.id, `run-impl-${index}`);
      assert.match(task.branch ?? "", /^pi\/wf\//, "each task lands on its own worktree branch");
      assert.ok(task.worktreePath.includes(join(".pi", "worktrees")), `task ${index} runs in an isolated worktree`);
      assert.equal(normalize(task.repoRoot), normalize(repo));
    }
    assert.match(h.printed[0], /Implement run-impl: 2 task\(s\) from "plan for run-impl"/);
    assert.match(h.printed[0], /✓ run-impl-0/);
    assert.match(h.printed[0], /✓ run-impl-1/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// clean + end-to-end checkpoint wiring (G5)
// ═══════════════════════════════════════════════════════════════════════════

/** git porcelain prints forward-slash paths even on Windows — mirror that. */
const forward = (p: string) => p.replace(/\\/g, "/");

/** Seed a run in the same persistence store the real WorkflowManager uses. */
function seedRun(cwd: string, runId: string): void {
  createRunPersistence(cwd).save({
    runId,
    workflowName: "wf",
    script: "export const meta = { name: 'w', description: 'w' }",
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
}

test("/workflows clean refuses while a run is running or paused", async () => {
  const repo = initRepo("wf-cmd-clean-active-");
  try {
    const h = harness(
      {
        listRuns: () => [{ runId: "run-1", workflowName: "w", status: "running", phases: [], agents: [], logs: [] }],
      },
      { cwd: repo },
    );
    await h.run("clean");
    assert.ok(
      h.notified.some((n) => n.type === "warning" && n.message.includes("clean refused")),
      "clean must refuse to reclaim a live run's worktrees",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("/workflows clean outside a git repository warns and sweeps nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-norepo-"));
  try {
    const h = harness({}, { cwd: dir });
    await h.run("clean");
    assert.ok(
      h.notified.some((n) => n.type === "warning" && n.message.includes("not inside a git repository")),
      "a non-repo cwd must warn instead of sweeping",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/workflows clean prunes orphaned project worktrees + pi/wf branches, keeps foreign worktrees", async () => {
  const repo = initRepo("wf-cmd-clean-");
  const foreign = mkdtempSync(join(tmpdir(), "pi-wt-foreign-"));
  try {
    // A project-owned worktree (under <root>/.pi/worktrees) whose branch must die
    // with it, a dangling pi/wf branch, and a foreign worktree that is NOT ours.
    const wt = await createWorktree(repo, "run-1-0-step");
    execFileSync("git", ["-C", repo, "branch", "pi/wf/zzz-dangling"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", foreign, "-b", "foreign-branch"], {
      stdio: "pipe",
    });
    const before = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    assert.ok(before.includes(forward(wt.cwd)), "fixture: project worktree is registered");
    assert.ok(before.includes(forward(foreign)), "fixture: foreign worktree is registered");

    const h = harness({}, { cwd: repo });
    await h.run("clean");

    const after = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    assert.ok(!after.includes(forward(wt.cwd)), "the orphaned project worktree is reclaimed");
    assert.ok(after.includes(forward(foreign)), "a foreign worktree is never touched");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "pi/wf/*"], { encoding: "utf8" });
    assert.doesNotMatch(branches, /pi\/wf\//, "all temporary pi/wf branches are deleted");
    assert.ok(
      h.notified.some((n) => n.type === "info" && n.message.includes("branch(es) removed")),
      "clean reports the number of removed branches",
    );
  } finally {
    try {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", foreign], { stdio: "ignore" });
    } catch {
      // foreign worktree already gone — nothing to deregister
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("/workflows implement persists one atomic checkpoint per task via the real runner", async () => {
  const repo = initRepo("wf-cmd-ckpt-");
  try {
    seedRun(repo, "run-ckpt-e2e");
    const phaseState = await approvedImplementFixture(repo, "run-ckpt-e2e", 2);
    const h = harness(
      { getRun: (id: string) => ({ runId: id, status: "running" }) },
      { cwd: repo, phaseState }, // NO implementRunnerFactory — the real runner path
    );
    await h.run("implement run-ckpt-e2e");

    const state = await loadRunState("run-ckpt-e2e", repo);
    assert.ok(state, "the run's persisted state exists after fan-out");
    assert.equal(state?.checkpoints.length, 2, "one checkpoint per blueprint execution step");
    assert.deepEqual(
      state?.checkpoints.map((c) => c.taskId),
      ["run-ckpt-e2e-0", "run-ckpt-e2e-1"],
      "checkpoints keep first-seen order (dedupe by taskId)",
    );
    for (const cp of state?.checkpoints ?? []) {
      assert.equal(cp.status, "failed", "a spec-less step honestly fails — no fabricated commit");
      assert.match(cp.branch ?? "", /^pi\/wf\//, "the checkpoint records the worktree branch");
      assert.ok(
        cp.worktreePath?.includes(join(".pi", "worktrees")),
        "the checkpoint records the isolated worktree path",
      );
      assert.ok(cp.timestamp, "the checkpoint carries a timestamp");
    }
    assert.match(h.printed[0], /Implement run-ckpt-e2e: 2 task\(s\)/);
    assert.match(h.printed[0], /✗ run-ckpt-e2e-0/, "the honest failure is printed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unknown subcommand
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows <unknown> warns usage", async () => {
  const h = harness();
  await h.run("bogus");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Unknown subcommand/);
});
