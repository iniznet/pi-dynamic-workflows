import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowAgent } from "../src/agent.js";
import { DurableStore } from "../src/durable-store.js";
import { WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { loadPersistedJournal } from "../src/run-persistence.js";
import {
  buildRunReport,
  deriveTruncationReports,
  type RunReport,
  terminationReason,
  writeRunReport,
} from "../src/run-report.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "run-report-test-"));
}

const fixtureState = (overrides: Partial<PersistedRunState> = {}): PersistedRunState => ({
  runId: "fixture-run-1",
  workflowName: "fixture",
  script: `export const meta = { name: "fixture", description: "x", phases: [{ title: "build", model: "vendor/build-model" }, { title: "review" }] }
phase("build")
return "ok"`,
  status: "completed",
  phases: ["build", "review"],
  agents: [
    {
      id: 1,
      callId: "fixture-run-1:0",
      label: "builder",
      phase: "build",
      prompt: "p",
      status: "done",
      result: "ok",
      tokens: 100,
      tokenUsage: { input: 40, output: 60, cacheRead: 0, cacheWrite: 0, total: 100, cost: 0.01 },
      model: "vendor/build-model",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:01:00.000Z",
    },
    {
      id: 2,
      callId: "fixture-run-1:1",
      label: "reviewer",
      phase: "review",
      prompt: "p2",
      status: "done",
      result: "ok",
      tokens: 50,
      model: "session/main-model",
    },
    {
      id: 3,
      callId: "fixture-run-1:2",
      label: "flaky",
      phase: "review",
      prompt: "p3",
      status: "error",
      error: "MODEL_NOT_FOUND",
      errorCode: WorkflowErrorCode.MODEL_NOT_FOUND,
      tokens: 10,
    },
  ],
  logs: [
    "embedded payload capped at 4000 chars (was 12000); tail detail omitted (marker added)",
    "embedded payload capped at 4000 chars (was 12000); tail detail omitted (marker added)",
    "embedded payload capped at 512 chars (was 900); tail detail omitted (marker added)",
  ],
  checkpoints: [{ runId: "fixture-run-1", taskId: "cp-1", status: "completed", timestamp: "2024-01-01T00:00:30.000Z" }],
  startedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:02:00.000Z",
  completedAt: "2024-01-01T00:02:00.000Z",
  durationMs: 120_000,
  tokenUsage: {
    input: 80,
    output: 120,
    total: 200,
    cost: 0.02,
    cacheRead: 0,
    cacheWrite: 0,
    freshSpend: 200,
  },
  tokenBudget: 1000,
  ...overrides,
});

// ─── report shape ────────────────────────────────────────────────────────────

test("buildRunReport: per-agent roster with model/tier/outcome/tokens", () => {
  const report = buildRunReport(fixtureState(), { mainModel: "session/main-model" });
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.runId, "fixture-run-1");
  assert.equal(report.status, "completed");
  assert.equal(report.terminationReason, "completed");
  assert.equal(report.agents.length, 3);
  const builder = report.agents[0];
  assert.ok(builder);
  assert.equal(builder.label, "builder");
  assert.equal(builder.phase, "build");
  assert.equal(builder.model, "vendor/build-model");
  assert.equal(builder.outcome, "done");
  assert.equal(builder.tokens, 100);
  assert.equal(builder.tokenUsage?.cost, 0.01);
  const flaky = report.agents[2];
  assert.equal(flaky?.outcome, "error");
  assert.equal(flaky?.errorCode, "MODEL_NOT_FOUND");
});

test("buildRunReport: per-phase spend + QW5 tier + routing reason", () => {
  const report = buildRunReport(fixtureState(), { mainModel: "session/main-model" });
  const build = report.phases.find((p) => p.name === "build");
  assert.ok(build);
  assert.equal(build.spend, 100, "build phase spend = sum of its agents' tokens");
  assert.equal(build.agentCount, 1);
  assert.equal(build.model, "vendor/build-model", "declared meta model is surfaced");
  assert.ok(build.routingReason.includes("declares model"), "routing reason explains the route");

  const review = report.phases.find((p) => p.name === "review");
  assert.ok(review);
  assert.equal(review.spend, 60, "review spend sums its two agents");
  assert.equal(review.agentCount, 2);
});

test("buildRunReport: approvals (checkpoint verdicts) + truncations (QW3)", () => {
  const report = buildRunReport(fixtureState());
  assert.equal(report.approvals.length, 1);
  assert.equal(report.approvals[0]?.taskId, "cp-1");
  assert.equal(report.approvals[0]?.verdict, "completed");
  assert.deepEqual(report.truncations, [
    { cappedChars: 4000, originalChars: 12000, count: 2 },
    { cappedChars: 512, originalChars: 900, count: 1 },
  ]);
});

test("terminationReason covers every persisted status", () => {
  assert.equal(terminationReason(fixtureState()), "completed");
  assert.equal(terminationReason(fixtureState({ status: "aborted" })), "aborted");
  assert.equal(terminationReason(fixtureState({ status: "paused", pauseReason: "usage_limit" })), "paused:usage_limit");
  assert.equal(terminationReason(fixtureState({ status: "paused" })), "paused:unknown");
  assert.equal(
    terminationReason(
      fixtureState({
        status: "failed",
        agents: [{ id: 1, label: "x", prompt: "p", status: "error", errorCode: WorkflowErrorCode.AGENT_EXHAUSTED }],
      }),
    ),
    "failed:AGENT_EXHAUSTED",
  );
});

test("buildRunReport: budget block from the persisted budget + total", () => {
  const report = buildRunReport(fixtureState());
  assert.deepEqual(report.budget, { limit: 1000, spent: 200 });
});

test("buildRunReport: V2-QW2 per-phase budgets surface from the durable entries view", async () => {
  const store = new DurableStore({ dir: tempDir(), projectKey: "report-budgets", now: (s) => `t-${s}` });
  // The durable entries carry the persisted carve keys workflow.ts phase() writes.
  await store.put("phaseBudgets:fixture-run-1:build", 400);
  await store.put("phaseBudgets:fixture-run-1:review", 200);
  const report = buildRunReport(fixtureState(), {
    durable: store.snapshot() as { entries: Record<string, unknown>; ledger: unknown[] },
  });
  const build = report.phases.find((p) => p.name === "build");
  assert.equal(build?.budget, 400, "the persisted carve reaches the report phase row");
  const review = report.phases.find((p) => p.name === "review");
  assert.equal(review?.budget, 200);
  // The report schema version is bumped for the additive shape.
  assert.equal(report.schemaVersion, 3);
  // Without a durable view the budget stays absent (shape unchanged).
  assert.equal(buildRunReport(fixtureState()).phases[0]?.budget, undefined);
});

test("buildRunReport: durable view (entries + ledger) folds in when supplied", async () => {
  const dir = tempDir();
  const store = new DurableStore({ dir, projectKey: "report-proj", now: (s) => `t-${s}` });
  await store.put("tasks:t1", "done");
  await store.record({ source: "agent", agent: "builder" });
  const report = buildRunReport(fixtureState(), {
    durable: store.snapshot() as { entries: Record<string, unknown>; ledger: unknown[] },
  });
  assert.ok(report.durable);
  assert.deepEqual(report.durable?.entries, { "tasks:t1": "done" });
  assert.equal(report.durable?.ledger.length, 1);
  assert.equal((report.durable?.ledger[0] as { source?: string }).source, "agent");
});

test("deriveTruncationReports: empty/missing logs degrade to []", () => {
  assert.deepEqual(deriveTruncationReports(undefined), []);
  assert.deepEqual(deriveTruncationReports([]), []);
  assert.deepEqual(deriveTruncationReports(["no markers here"]), []);
});

// ─── write path + resume-hash isolation ─────────────────────────────────────

test("writeRunReport writes <runsDir>/reports/<runId>.json and never touches the run record", () => {
  const cwd = tempDir();
  const runsDir = workflowProjectPaths(cwd).runsDir;
  const state = fixtureState();
  const statePath = join(runsDir, "fixture-run-1.json");
  // Pre-seed the run record exactly like the persistence layer would.
  writeRunRecord(statePath, state);

  const beforeHash = hashOf(statePath);
  const reportPath = writeRunReport(state, { runsDir });
  assert.ok(reportPath, "the report write succeeds");
  assert.equal(reportPath, join(runsDir, "reports", "fixture-run-1.json"));

  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as RunReport;
  assert.equal(report.runId, "fixture-run-1");
  assert.equal(report.terminationReason, "completed");
  // The run record itself is untouched: resume() reads ONLY the run file, so
  // the report can never affect resume-replay hashes.
  assert.equal(hashOf(statePath), beforeHash, "the run record is byte-identical after the report write");
  // And the report lives OUTSIDE the run-record `*.json` scan: the run listing
  // never mistakes a report for a run.
  assert.deepEqual(
    readdirSync(runsDir).filter((f) => f.endsWith(".json") && !f.endsWith(".bak")),
    ["fixture-run-1.json"],
    "only the run record sits in the runs dir root",
  );
});

test("resume journal is unchanged by report emission (report is additive)", () => {
  const cwd = tempDir();
  const runsDir = workflowProjectPaths(cwd).runsDir;
  const state = fixtureState({
    journal: [
      { index: 0, runId: "fixture-run-1", hash: "abc", result: "ok", storeDelta: { k: "v" }, storeCommitSeq: 0 },
    ],
  });
  writeRunRecord(join(runsDir, "fixture-run-1.json"), state);
  const journalBefore = loadPersistedJournal(state);
  writeRunReport(state, { runsDir });
  const reloaded = JSON.parse(readFileSync(join(runsDir, "fixture-run-1.json"), "utf-8")) as PersistedRunState;
  const journalAfter = loadPersistedJournal(reloaded);
  assert.deepEqual(journalAfter, journalBefore, "the report file is never read by the resume path");
});

// ─── manager integration: report emitted on completion + resume ─────────────

function deferredAgent(delayMs = 5) {
  // Auto-resolving runner: each agent call settles on its own after a short
  // tick, so sequential agents never deadlock on pre-resolved indices.
  return {
    runner: {
      async run() {
        await sleep(delayMs);
        return "ok";
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

const quietScript = `export const meta = { name: "quiet", description: "d" }
const r1 = await agent("one")
const r2 = await agent("two")
await durableStore.put("seen", [r1, r2])
return [r1, r2]`;

async function waitForStatus(manager: WorkflowManager, runId: string, status: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (manager.getRun(runId)?.status === status) return status;
    await sleep(10);
  }
  return manager.getRun(runId)?.status ?? "missing";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("manager emits a completed run report at completion", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(quietScript);
    await promise.catch(() => {});
    await waitForStatus(manager, runId, "completed");

    const reportPath = join(runsDir, "reports", `${runId}.json`);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as RunReport;
    assert.equal(report.status, "completed");
    assert.equal(report.terminationReason, "completed");
    assert.equal(report.agents.length, 2);
    assert.equal(report.agents[0]?.label, "agent 1");
    assert.ok(report.durable, "the report folds in the run's durable-store view");
    assert.deepEqual(report.durable?.entries.seen, ["ok", "ok"]);
  }));

test("manager emits V2-QW2 per-phase budgets in the completed report (persisted carve)", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const budgetScript = `export const meta = { name: "budgeted", description: "d" }
phase("research", { budget: 120 })
await agent("one", { label: "researcher" })
phase("build", { budget: 60 })
await agent("two", { label: "builder" })
return "ok"`;
    const { runId, promise } = manager.startInBackground(budgetScript);
    await promise.catch(() => {});
    await waitForStatus(manager, runId, "completed");

    const reportPath = join(runsDir, "reports", `${runId}.json`);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as RunReport;
    assert.equal(report.schemaVersion, 3);
    const research = report.phases.find((p) => p.name === "research");
    assert.ok(research, "the research phase row is present");
    assert.equal(research?.budget, 120, "the persisted carve reaches the emitted report");
    const build = report.phases.find((p) => p.name === "build");
    assert.equal(build?.budget, 60);
  }));

test("manager emits a paused report at pause and a resumed report at resume", async () =>
  withFakeHomeAsync(tempDir(), async () => {
    const cwd = tempDir();
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const da = deferredAgent(300);
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(quietScript);
    await sleep(30);
    assert.equal(manager.pause(runId), true);
    await promise.catch(() => {});

    const pausedReportPath = join(runsDir, "reports", `${runId}.json`);
    const paused = JSON.parse(readFileSync(pausedReportPath, "utf-8")) as RunReport;
    assert.equal(paused.status, "paused");
    assert.equal(paused.terminationReason, "paused:unknown");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await waitForStatus(manager, runId, "completed");
    const finalReport = JSON.parse(readFileSync(pausedReportPath, "utf-8")) as RunReport;
    assert.equal(finalReport.status, "completed", "the report is re-emitted at completion after resume");
  }));

// helper: write a run record exactly like the persistence layer (atomic shape)
function writeRunRecord(path: string, state: PersistedRunState): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
