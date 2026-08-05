import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import type { WorkflowRunResult } from "../../../src/workflow.js";
import type { WorkflowManager } from "../../../src/workflow-manager.js";
import {
  backgroundStartedText,
  createWorkflowTool,
  formatCompletedResultText,
  reviseHint,
} from "../../../src/workflow-tool.js";

const HEADLESS_SURFACE = [
  "createWorkflowTool",
  "createWorkflowControlTool",
  "WorkflowManager",
  "createWorkflowStorage",
  "UsageLimitScheduler",
  "runWorkflow",
  "createRunPersistence",
  "parseWorkflowScript",
  "MissingPeerError",
  "lazyPeerImport",
  "probePeerAvailability",
  "formatCompletedResultText",
] as const;

const TUI_SURFACE = [
  "installTaskPanel",
  "installResultDelivery",
  "openWorkflowNavigator",
  "renderNavigator",
  "registerWorkflowCommands",
] as const;

// ─── H4: barrel surface with peers present ──────────────────────────────────────

test("barrel exports the headless surface and the TUI surface when peers are present", async () => {
  const barrel = await import("../../../src/index.js");
  for (const name of HEADLESS_SURFACE) {
    assert.equal(typeof barrel[name], "function", `${name} should be a function on the barrel`);
  }
  assert.equal(typeof barrel.PEER_DEPENDENCIES, "object", "PEER_DEPENDENCIES should be the peer table");
  for (const name of TUI_SURFACE) {
    assert.equal(typeof barrel[name], "function", `${name} should be a function when pi-tui is present`);
  }
});

test("createWorkflowTool builds its schema from the lazily-loaded typebox peer", () => {
  const tool = createWorkflowTool();
  assert.equal(tool.name, "workflow");
  assert.equal(tool.label, "Workflow");
  assert.ok(tool.parameters, "schema must be present");
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  assert.ok("script" in properties, "schema should expose the script property");
  assert.ok("resumeFromRunId" in properties, "schema should expose resumeFromRunId");
});

// ─── M18: reviseHint only for paused/failed runs ────────────────────────────────

test("formatCompletedResultText never advertises resume on a completed run", () => {
  const result: WorkflowRunResult = {
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
  assert.ok(text.includes("fanout"), "should name the workflow");
  assert.ok(text.includes("3"), "should report the agent count");
  assert.ok(!text.includes("resumeFromRunId"), "completed text must not advertise resume (M18)");
  assert.ok(!text.includes("To revise"), "completed text must not carry the revise hint (M18)");
});

test("backgroundStartedText does not advertise resume (the run is still running)", () => {
  const text = backgroundStartedText("deep-research", "run-xyz");
  assert.ok(text.includes("run-xyz"));
  assert.ok(!text.includes("resumeFromRunId"), "a just-started run is not resumable (M18)");
  assert.ok(!text.includes("To revise"), "background text must not carry the revise hint (M18)");
});

test("reviseHint remains available for the paused/failed paths", () => {
  assert.equal(reviseHint(undefined), "");
  const hint = reviseHint("run-failed");
  assert.ok(hint.includes('resumeFromRunId="run-failed"'));
  assert.ok(hint.includes("replay from cache"));
});

test("a failed sync run's error carries the resume hint (paused/failed are resumable)", async () => {
  // Stub manager: runSync throws the run's failure, listRuns exposes the run
  // that settled failed for the workflow just attempted.
  const workflowName = "failing_wf";
  const script = `export const meta = { name: '${workflowName}', description: 'fails on purpose' }\n`;
  const stubManager = {
    runSync: async () => {
      throw new WorkflowError("agent blew up", WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    },
    listRuns: () => [
      { runId: "failing_wf-1", workflowName, status: "failed" as const, startedAt: "2026-01-01T00:00:00.000Z" },
      { runId: "other-1", workflowName: "other", status: "failed" as const, startedAt: "2026-01-02T00:00:00.000Z" },
      { runId: "completed-1", workflowName, status: "completed" as const, startedAt: "2026-01-03T00:00:00.000Z" },
    ],
  } as unknown as WorkflowManager;

  const tool = createWorkflowTool({ manager: stubManager });
  await assert.rejects(
    () => tool.execute("t1", { script, background: false }, undefined, undefined, { hasUI: false } as never),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowError, "should stay a WorkflowError");
      assert.match(err.message, /agent blew up/);
      // The newest FAILED run for this workflow name (completed excluded).
      assert.match(err.message, /resumeFromRunId="failing_wf-1"/);
      return true;
    },
  );
});
