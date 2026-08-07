/**
 * agent-live-stats-surfaces.test.ts — SLICE B 'surfaces' unit suite.
 *
 * The rendering/tool side of the per-agent live-stats design:
 *
 *  1. task-panel detailed mode: RUNNING agent rows gain live tokens, cached,
 *     elapsed, an idle soft-hint, and the model tail; phase headers insert an
 *     idle count; done rows stay byte-identical; every line stays fitLine-safe.
 *  2. workflow_control status: details.run.agents carries per-running-agent
 *     live stats (elapsed/lastActiveAt/idle/tokens/tokenUsage) while the TEXT
 *     line stays byte-identical (/tokens=<N>$/ end-anchor) and list details
 *     stay deepEqual-identical.
 *  3. workflow_damage_control agents: AgentSummary merges live startedAtMs →
 *     startedAt + lastActiveAtMs → lastActiveAt over the persisted record.
 *  4. get_workflow_status: per-running-agent lines + idleAgents fact (the
 *     extension's tool binds an internal manager, so the extracted pure
 *     builder buildAgentStatusLines is the unit under test).
 *
 * Slice A (workflow-manager.ts/display.ts/workflow.ts) owns stamping the
 * snapshot fields; this suite renders them via the DESIGN field names with
 * optional-chaining-safe fixtures, so it runs against main even before that
 * merge. Companion: tests/slices/status/agent-live-stats.test.ts (Slice A).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowSnapshot } from "../../../src/display.js";
import type { PersistedRunState, RunStatus } from "../../../src/run-persistence.js";
import { createWorkflowControlTool } from "../../../src/workflow-control-tool.js";
import { summarizeAgents } from "../../../src/workflow-damage-control.js";
import type { WorkflowManager } from "../../../src/workflow-manager.js";

/** Fixed clock so elapsed/idle assertions are deterministic regardless of wall time. */
const NOW = 1_000_000;
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

// ─────────────────────────────────────────────────────────────────────────────
// task-panel (detailed mode) — per-agent rows + phase headers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A manager whose live snapshot carries the run; the disk list only knows the
 * same agents (panelRunData overlays the live snapshot for detailed mode).
 */
function liveRun(snapshot: WorkflowSnapshot, runId = "live1") {
  return {
    listRuns: () => [
      {
        runId,
        workflowName: snapshot.name,
        status: "running",
        agents: snapshot.agents,
        tokenUsage: snapshot.tokenUsage,
      },
    ],
    getRun: (id: string) => (id === runId ? { snapshot, status: "running" } : undefined),
  };
}

test("panel: a running agent row shows live tokens, cached, elapsed, idle soft-hint, and model", async () => {
  const { renderPanelDetailed, clearTokenSamples } = await import("../../../src/task-panel.js");
  clearTokenSamples("live1");
  try {
    // The exact complaint shape: a settled sibling (done, full tok/cached) plus
    // a RUNNING agent with live figures, elapsed 3m 12s, idle 45s (past the
    // 30s soft threshold) and the model tail.
    const snapshot: WorkflowSnapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "research-rendering",
          prompt: "p",
          status: "done",
          phase: "Scan",
          tokens: 69900,
          tokenUsage: { input: 30000, output: 39900, cacheRead: 1100000, cacheWrite: 0, total: 69900, cost: 0 },
          model: "provider/deepseek-v4-flash",
        },
        {
          id: 3,
          label: "research-wp-pipeline",
          prompt: "p",
          status: "running",
          phase: "Scan",
          startedAtMs: NOW - 192_000,
          lastActiveAtMs: NOW - 45_000,
          tokenUsage: { input: 8000, output: 4000, cacheRead: 1400000, cacheWrite: 300, total: 12300, cost: 0 },
          model: "provider/deepseek-v4-flash",
        },
      ],
      agentCount: 2,
      runningCount: 1,
      doneCount: 1,
      errorCount: 0,
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const lines = renderPanelDetailed(liveRun(snapshot) as never, theme as never, undefined, 8, NOW);
    const row = lines.find((l) => l.includes("[3] ● research-wp-pipeline")) ?? "";
    // Exact row (identity theme): `[3] ● label tok · cached · elapsed · idle · model`.
    // NOTE: cacheRead 1_400_000 formats as "1.4M cached" under fmtTokensShort
    // (K below 1M, M from 1M up — the design doc's "0.4M" example was off).
    assert.ok(
      row.includes("[3] ● research-wp-pipeline 12.3K tok · 1.4M cached · 3m 12s · idle 45s · deepseek-v4-flash"),
      `running row exact, got: ${row}`,
    );
    assert.ok(/12\.3K tok/.test(row) && /1\.4M cached/.test(row), `fresh/cached split, got: ${row}`);
    assert.ok(/3m 12s/.test(row), `agent elapsed, got: ${row}`);
    assert.ok(/idle 45s/.test(row), `idle soft-hint, got: ${row}`);
    assert.ok(/deepseek-v4-flash/.test(row), `model tail, got: ${row}`);
    // DONE rows stay byte-identical: label + tok + cached + model, no elapsed/idle.
    const doneRow = lines.find((l) => l.includes("[1] ✓ research-rendering")) ?? "";
    assert.ok(
      doneRow.includes("[1] ✓ research-rendering 69.9K tok") &&
        /1\.1M cached/.test(doneRow) &&
        /deepseek-v4-flash/.test(doneRow),
      `done row unchanged, got: ${doneRow}`,
    );
    assert.ok(!/idle|m 12s/.test(doneRow), `no activity segments on a done row, got: ${doneRow}`);
  } finally {
    clearTokenSamples("live1");
  }
});

test("panel: a running agent without live-stats fields renders today's row (no elapsed/idle)", async () => {
  const { renderPanelDetailed, clearTokenSamples } = await import("../../../src/task-panel.js");
  clearTokenSamples("legacy-row");
  try {
    const snapshot: WorkflowSnapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [{ id: 2, label: "audit_auth", prompt: "p", status: "running", phase: "Scan", tokens: 1800 }],
      agentCount: 1,
      runningCount: 1,
      doneCount: 0,
      errorCount: 0,
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const lines = renderPanelDetailed(liveRun(snapshot, "legacy-row") as never, theme as never, undefined, 8, NOW);
    assert.ok(
      lines.includes("    [2] ● audit_auth 1.8K tok"),
      `legacy running row is byte-identical to today, got:\n${lines.join("\n")}`,
    );
  } finally {
    clearTokenSamples("legacy-row");
  }
});

test("panel: phase header inserts the idle count; byte-identical when no agent has lastActiveAtMs", async () => {
  const { renderPanelDetailed, clearTokenSamples } = await import("../../../src/task-panel.js");
  clearTokenSamples("phase-hdr");
  clearTokenSamples("phase-hdr2");
  try {
    // 4 agents: 2 done + 1 running past the idle threshold + 1 skipped.
    // Aggregate fresh = 50000+50000+95200 = 195200 → "195.2K tok".
    const snapshot: WorkflowSnapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        { id: 1, label: "a1", prompt: "p", status: "done", phase: "Scan", tokens: 50000 },
        { id: 2, label: "a2", prompt: "p", status: "done", phase: "Scan", tokens: 50000 },
        {
          id: 3,
          label: "a3",
          prompt: "p",
          status: "running",
          phase: "Scan",
          tokens: 95200,
          startedAtMs: NOW - 192_000,
          lastActiveAtMs: NOW - 40_000,
        },
        { id: 4, label: "a4", prompt: "p", status: "skipped", phase: "Scan" },
      ],
      agentCount: 4,
      runningCount: 1,
      doneCount: 2,
      errorCount: 0,
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const lines = renderPanelDetailed(liveRun(snapshot, "phase-hdr") as never, theme as never, undefined, 8, NOW);
    assert.ok(
      lines.some((l) => l.includes("▶ Scan") && l.includes("2/4 agents · 1 running · 1 idle · 195.2K tok")),
      `idle count + live phase tokens, got:\n${lines.join("\n")}`,
    );
    // Same phase, but the running agent carries NO lastActiveAtMs/startedAtMs:
    // the header and the row are byte-identical to today.
    const legacy: WorkflowSnapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        { id: 1, label: "a1", prompt: "p", status: "done", phase: "Scan", tokens: 50000 },
        { id: 2, label: "a2", prompt: "p", status: "done", phase: "Scan", tokens: 50000 },
        { id: 3, label: "a3", prompt: "p", status: "running", phase: "Scan", tokens: 95200 },
        { id: 4, label: "a4", prompt: "p", status: "skipped", phase: "Scan" },
      ],
      agentCount: 4,
      runningCount: 1,
      doneCount: 2,
      errorCount: 0,
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const legacyLines = renderPanelDetailed(liveRun(legacy, "phase-hdr2") as never, theme as never, undefined, 8, NOW);
    assert.ok(
      legacyLines.some((l) => l.includes("▶ Scan") && l.includes("2/4 agents · 1 running · 195.2K tok")),
      `header without idle is byte-identical, got:\n${legacyLines.join("\n")}`,
    );
    assert.ok(
      !legacyLines.some((l) => /idle/.test(l)),
      `no idle segment anywhere without lastActiveAtMs, got:\n${legacyLines.join("\n")}`,
    );
  } finally {
    clearTokenSamples("phase-hdr");
    clearTokenSamples("phase-hdr2");
  }
});

test("panel: fitLine keeps every rendered line within the overlay width (ansi theme)", async () => {
  const { renderPanelDetailed, clearTokenSamples } = await import("../../../src/task-panel.js");
  clearTokenSamples("fitline");
  try {
    const ansiTheme = {
      fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[22m`,
      bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
    };
    const snapshot: WorkflowSnapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 3,
          label: "research-wp-pipeline-handling-github-issues-and-prs-with-a-very-long-suffix",
          prompt: "p",
          status: "running",
          phase: "Scan",
          startedAtMs: NOW - 192_000,
          lastActiveAtMs: NOW - 45_000,
          tokenUsage: { input: 8000, output: 4000, cacheRead: 400000, cacheWrite: 300, total: 12300, cost: 0 },
          model: "provider/deepseek-v4-flash-with-a-very-long-model-suffix",
        },
      ],
      agentCount: 1,
      runningCount: 1,
      doneCount: 0,
      errorCount: 0,
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const lines = renderPanelDetailed(liveRun(snapshot, "fitline") as never, ansiTheme as never, 42, 8, NOW);
    assert.ok(lines.length > 0, "panel renders active runs");
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds width (${visibleWidth(line)} > 42): ${JSON.stringify(line)}`);
    }
  } finally {
    clearTokenSamples("fitline");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// workflow_control — status per-agent detail, byte-identical text/list
// ─────────────────────────────────────────────────────────────────────────────

function run(status: RunStatus = "running", runId = "audit-abc123"): PersistedRunState {
  return {
    runId,
    workflowName: "audit",
    script: "export const meta = { name: 'audit', description: 'audit' }; return await agent('x')",
    status,
    phases: ["Inspect"],
    currentPhase: "Inspect",
    agents: [
      { id: 1, label: "active scan", prompt: "scan", status: status === "running" ? "running" : "done", tokens: 30 },
      { id: 2, label: "done check", prompt: "check", status: "done" },
      { id: 3, label: "failed check", prompt: "fail", status: "error" },
      { id: 4, label: "optional check", prompt: "optional", status: "skipped" },
    ],
    logs: [],
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    tokenUsage: { input: 20, output: 10, total: 30 },
  };
}

function fakeManager(initial: PersistedRunState[], liveSnapshots: Record<string, WorkflowSnapshot> = {}) {
  const runs = new Map(initial.map((item) => [item.runId, item]));
  const manager = {
    listRuns: () => [...runs.values()],
    getSnapshot: (runId: string) => liveSnapshots[runId] ?? null,
    pause: () => false,
    async resume() {
      return false;
    },
    stop: () => false,
  } as unknown as WorkflowManager;
  return { manager };
}

async function execute(manager: WorkflowManager, params: Record<string, unknown>) {
  const tool = createWorkflowControlTool({ manager });
  return (tool.execute as any)("control-call", params, undefined, undefined, {});
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content[0].text;
}

test("workflow_control status surfaces per-running-agent live stats; text and list stay byte-identical", async () => {
  const clock = Date.now();
  // Live snapshot with the per-agent live-stats fields (Slice A's shape). The
  // run aggregate = 80 (running) + 40 (done) = 120 → the /tokens=120$/ anchor.
  const live: WorkflowSnapshot = {
    name: "audit",
    phases: ["Inspect"],
    currentPhase: "Inspect",
    logs: [],
    agents: [
      {
        id: 1,
        callId: "audit-abc123:0",
        label: "active scan",
        prompt: "scan",
        status: "running",
        tokens: 80,
        startedAtMs: clock - 192_000,
        lastActiveAtMs: clock - 45_000,
        tokenUsage: { input: 40, output: 40, cacheRead: 0, cacheWrite: 0, total: 80, cost: 0 },
      },
      {
        id: 2,
        label: "reported",
        prompt: "check",
        status: "done",
        tokens: 40,
        tokenUsage: { input: 15, output: 5, total: 40, cacheRead: 20, cacheWrite: 0, cost: 0 },
      },
    ],
    agentCount: 2,
    runningCount: 1,
    doneCount: 1,
    errorCount: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
  };
  const { manager } = fakeManager([run()], { "audit-abc123": live });

  const status = await execute(manager, { action: "status", runId: "audit-abc123" });
  assert.match(text(status), /^action=status result=ok /);
  // The TEXT line keeps its end-anchor: no per-agent segments appended.
  assert.match(text(status), /tokens=120$/);

  const agents = (status.details.run as { agents: Array<Record<string, unknown>> }).agents;
  assert.equal(agents.length, 1, "only the RUNNING agent is detailed");
  const active = agents[0] as {
    id: number;
    label: string;
    status: string;
    elapsedMs?: number;
    lastActiveAtMs?: number;
    idleMs?: number;
    tokens?: number;
  };
  assert.equal(active.id, 1);
  assert.equal(active.label, "active scan");
  assert.equal(active.status, "running");
  assert.equal(typeof active.elapsedMs, "number", "elapsed derived from startedAtMs");
  assert.ok(Math.abs((active.elapsedMs ?? 0) - 192_000) < 5_000, "elapsed ≈ 3m 12s");
  assert.equal(active.lastActiveAtMs, clock - 45_000, "lastActiveAtMs passed through");
  assert.equal(typeof active.idleMs, "number", "idle derived from lastActiveAtMs");
  assert.ok(Math.abs((active.idleMs ?? 0) - 45_000) < 5_000, "idle ≈ 45s");
  assert.equal(active.tokens, 80, "final-attempt scalar tokens");

  // LIST details stay deepEqual-identical (no live snapshot → no agents key).
  const { manager: bareManager } = fakeManager([run()]);
  const listed = await execute(bareManager, { action: "list" });
  assert.deepEqual(listed.details, {
    action: "list",
    result: "ok",
    runs: [
      {
        runId: "audit-abc123",
        workflowName: "audit",
        status: "running",
        phase: "Inspect",
        counts: { total: 4, done: 1, running: 1, error: 1, skipped: 1 },
        activeLabels: ["active scan"],
        tokenTotal: 30,
      },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// workflow_damage_control — AgentSummary live lastActiveAt/startedAt merge
// ─────────────────────────────────────────────────────────────────────────────

test("workflow_damage_control: live lastActiveAt + startedAtMs merge over persisted; live-only agents degrade gracefully", () => {
  const persisted: PersistedRunState = {
    runId: "dc-unit-1",
    workflowName: "unit audit",
    script: "export const meta = { name: 'unit', description: 'x' }; return await agent('x')",
    status: "running",
    phases: ["Inspect"],
    currentPhase: "Inspect",
    agents: [
      {
        id: 1,
        callId: "dc-unit-1:0",
        label: "active",
        prompt: "a",
        status: "running",
        tokens: 30,
        startedAt: "2026-07-14T00:00:00.000Z",
        endedAt: "2026-07-14T00:05:00.000Z",
      },
    ],
    logs: [],
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:01:00.000Z",
    tokenUsage: { input: 20, output: 10, total: 30 },
  };
  const liveStartedAt = Date.parse("2026-07-14T00:10:00.000Z");
  const liveLastActive = Date.parse("2026-07-14T00:11:00.000Z");
  const live: WorkflowSnapshot = {
    name: "unit audit",
    phases: ["Inspect"],
    currentPhase: "Inspect",
    logs: ["live"],
    agents: [
      {
        id: 1,
        callId: "dc-unit-1:0",
        label: "active",
        prompt: "a",
        status: "running",
        tokens: 99,
        model: "provider/live",
        startedAtMs: liveStartedAt,
        lastActiveAtMs: liveLastActive,
      },
      // Live-only agent (absent from persisted — mid-flight before a boundary
      // write): still resolves via its callId and gets live-sourced times.
      {
        id: 9,
        callId: "dc-unit-1:9",
        label: "live-only",
        prompt: "z",
        status: "running",
        tokens: 5,
        startedAtMs: liveStartedAt + 1000,
        lastActiveAtMs: liveLastActive + 2000,
      },
    ],
    agentCount: 2,
    runningCount: 2,
    doneCount: 0,
    errorCount: 0,
    durationMs: 1234,
    tokenUsage: { input: 90, output: 9, total: 99 },
    runId: "dc-unit-1",
  };

  const agents = summarizeAgents(persisted, live);
  const active = agents.find((a) => a.id === 1);
  assert.ok(active, "persisted agent resolved");
  assert.equal(active.tokens, 99, "live tokens override persisted");
  assert.equal(active.model, "provider/live", "live model override persisted");
  assert.equal(active.startedAt, new Date(liveStartedAt).toISOString(), "live startedAtMs wins over persisted ISO");
  assert.equal(
    active.lastActiveAt,
    new Date(liveLastActive).toISOString(),
    "lastActiveAt derived from live lastActiveAtMs",
  );
  assert.equal(active.endedAt, "2026-07-14T00:05:00.000Z", "endedAt stays persisted");

  const liveOnly = agents.find((a) => a.id === 9);
  assert.ok(liveOnly, "live-only agent is merged in (never under-reported)");
  assert.equal(liveOnly.startedAt, new Date(liveStartedAt + 1000).toISOString(), "live-only startedAt from live");
  assert.equal(
    liveOnly.lastActiveAt,
    new Date(liveLastActive + 2000).toISOString(),
    "live-only lastActiveAt from live",
  );

  // A live agent WITHOUT the live-stats fields degrades: lastActiveAt undefined,
  // startedAt falls back to the persisted ISO.
  const bare: WorkflowSnapshot = {
    ...live,
    agents: [{ id: 1, callId: "dc-unit-1:0", label: "active", prompt: "a", status: "running", tokens: 99 }],
  };
  const bareAgents = summarizeAgents(persisted, bare);
  const bareActive = bareAgents.find((a) => a.id === 1);
  assert.equal(bareActive?.lastActiveAt, undefined, "no lastActiveAt without live lastActiveAtMs");
  assert.equal(bareActive?.startedAt, "2026-07-14T00:00:00.000Z", "startedAt falls back to the persisted ISO");
});

// ─────────────────────────────────────────────────────────────────────────────
// get_workflow_status — per-running-agent lines + idleAgents fact
// ─────────────────────────────────────────────────────────────────────────────

test("get_workflow_status: per-running-agent lines and the idleAgents fact (live snapshot)", async () => {
  const { buildAgentStatusLines } = await import("../../../extensions/workflow.js");
  const agents = [
    { id: 1, label: "research-rendering", prompt: "p", status: "done" },
    {
      id: 3,
      label: "research-wp-pipeline",
      prompt: "p",
      status: "running",
      startedAtMs: NOW - 192_000,
      lastActiveAtMs: NOW - 45_000,
      tokens: 80,
      tokenUsage: { input: 40, output: 40, cacheRead: 0, cacheWrite: 0, total: 80, cost: 0 },
    },
    // Running but with no live-stats fields → "-" idle, never counted as idle.
    { id: 5, label: "quiet-agent", prompt: "p", status: "running" },
  ];

  const { lines, agents: details, idleAgents } = buildAgentStatusLines(agents as never, NOW);
  assert.ok(
    lines.some(
      (l) =>
        l.includes("agent=3") &&
        l.includes('label="research-wp-pipeline"') &&
        l.includes("status=running") &&
        l.includes("elapsed=3m 12s") &&
        l.includes("idle=45s") &&
        l.includes("tokens=80"),
    ),
    `running-agent line with live facts, got:\n${lines.join("\n")}`,
  );
  assert.ok(
    lines.some((l) => l.includes("agent=5") && l.includes("idle=-") && !l.includes("tokens=")),
    `agent without live-stats fields degrades to '-' idle, got:\n${lines.join("\n")}`,
  );
  assert.equal(idleAgents, 1, "only the agent past the 30s soft threshold counts");
  assert.equal(details.length, 2, "running agents only");
  const detailed = details.find((d) => d.id === 3);
  assert.equal(detailed?.elapsedMs, 192_000);
  assert.equal(detailed?.idleMs, 45_000);
  assert.equal(detailed?.tokens, 80);

  // No running agents → no extra lines and a zero idle fact (today's output).
  const empty = buildAgentStatusLines([{ id: 1, label: "a", prompt: "p", status: "done" }] as never, NOW);
  assert.deepEqual(empty.lines, []);
  assert.deepEqual(empty.agents, []);
  assert.equal(empty.idleAgents, 0);
});
