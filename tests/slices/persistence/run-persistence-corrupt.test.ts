import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRunPersistence,
  loadRunState,
  RUN_STATE_SCHEMA_VERSION,
  resumeRun,
} from "../../../src/run-persistence.js";
import { workflowProjectPaths } from "../../../src/workflow-paths.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-rp-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test(
  "loadRunState falls back to checkpoint-shaped journal entries for legacy polluted runs",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "p0-4-legacy";
    rp.save({
      runId,
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      // A run persisted by the pre-P0-4 saveCheckpoint: checkpoint records
      // were written into the journal alongside real call-hash entries.
      journal: [
        { index: 0, runId, hash: "real-call-hash", result: { reply: "ok" } },
        {
          index: 1,
          runId,
          hash: "approve-plan",
          result: { runId, taskId: "approve-plan", status: "completed", timestamp: "2024-01-01T00:05:00.000Z" },
        },
      ],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const state = await loadRunState(runId, cwd);
    assert.equal(
      state?.checkpoints.length,
      1,
      "only checkpoint-shaped journal entries are treated as checkpoints, real agent-call entries are not",
    );
    assert.equal(state?.checkpoints[0].taskId, "approve-plan");
  }),
);

test(
  "load() migrates a legacy (v0) fixture so resume preserves its data",
  withTempCwd(async (cwd) => {
    const runsDir = workflowProjectPaths(cwd).runsDir;
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "legacy-v0.json"),
      JSON.stringify({
        runId: "legacy-v0",
        workflowName: "wf",
        script: "export const meta = { name: 'w', description: 'w' }",
        status: "paused",
        phases: ["Scan"],
        agents: [{ id: 1, label: "a", prompt: "p", status: "done", result: { ok: true } }],
        logs: ["started"],
        journal: [{ index: 0, hash: "h0", result: "cached" }],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        // No schemaVersion → treated as prior version 0.
      }),
      "utf-8",
    );

    const rp = createRunPersistence(cwd);
    const state = rp.load("legacy-v0");
    assert.equal(state?.schemaVersion, RUN_STATE_SCHEMA_VERSION, "legacy fixture is migrated to the current version");
    assert.equal(state?.status, "paused");
    assert.deepEqual(state?.phases, ["Scan"]);
    assert.deepEqual(state?.journal, [{ index: 0, hash: "h0", result: "cached" }]);
    assert.equal((state?.agents[0]?.result as { ok?: boolean })?.ok, true);

    // Resume from the migrated fixture: the CAS status flip must not lose the
    // legacy journal or the persisted data.
    const resumed = await resumeRun("legacy-v0", cwd);
    assert.equal(resumed.status, "active");
    const after = rp.load("legacy-v0");
    assert.equal(after?.status, "running");
    assert.deepEqual(
      after?.journal,
      [{ index: 0, hash: "h0", result: "cached" }],
      "resume preserves the legacy journal",
    );
    assert.equal(after?.schemaVersion, RUN_STATE_SCHEMA_VERSION);
  }),
);
