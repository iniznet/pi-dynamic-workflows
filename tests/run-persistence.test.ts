import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  type statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WORKFLOW_RUNS_DIR } from "../src/config.js";
import {
  capJournalBudget,
  cleanupRun,
  createRunPersistence,
  DEFAULT_JOURNAL_BYTE_BUDGET,
  DEFAULT_RUN_LEASE_TTL_MS,
  generateRunId,
  listActiveRuns,
  loadRunState,
  MAX_JOURNAL_ENTRIES,
  migrateRunState,
  type PersistedRunState,
  RUN_STATE_SCHEMA_VERSION,
  type RunCheckpoint,
  redactText,
  renewRunLease,
  resumeRun,
  saveCheckpoint,
  updateRunState,
  upsertJournalEntry,
} from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

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
  "createRunPersistence creates runs directory on first save",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.equal(existsSync(runsDir), false, "dir should not exist yet");
    rp.save({
      runId: "test-1",
      workflowName: "demo",
      script: "export const meta = { name: 'd', description: 'd' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.ok(existsSync(runsDir), "dir should be created");
    assert.ok(existsSync(join(runsDir, "test-1.json")), "run file should exist");
    assert.equal(existsSync(join(cwd, WORKFLOW_RUNS_DIR)), false, "legacy project runs dir should not be created");
  }),
);

test(
  "createRunPersistence save and load round-trips correctly",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "roundtrip-1",
      workflowName: "test-wf",
      script: "export const meta = { name: 't', description: 't' }",
      args: { key: "value" },
      status: "running",
      phases: ["Scan", "Report"],
      currentPhase: "Scan",
      agents: [{ id: 1, label: "agent-1", prompt: "do it", status: "running" }],
      logs: ["started", "phase: Scan"],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
    };
    rp.save(state);

    const loaded = rp.load("roundtrip-1");
    assert.ok(loaded, "should load saved state");
    assert.equal(loaded?.runId, "roundtrip-1");
    assert.equal(loaded?.workflowName, "test-wf");
    assert.equal(loaded?.status, "running");
    assert.deepEqual(loaded?.phases, ["Scan", "Report"]);
    assert.equal(loaded?.currentPhase, "Scan");
    assert.equal(loaded?.agents.length, 1);
    assert.equal(loaded?.agents[0].label, "agent-1");
    assert.deepEqual(loaded?.logs, ["started", "phase: Scan"]);
    assert.deepEqual(loaded?.args, { key: "value" });
  }),
);

test(
  "createRunPersistence save updates updatedAt",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "update-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    rp.save(state);
    const before = rp.load("update-test");
    const beforeTime = before?.updatedAt;

    // Small delay so updatedAt changes
    await new Promise((r) => setTimeout(r, 10));

    rp.save({ ...state, status: "running" });
    const after = rp.load("update-test");
    assert.notEqual(after?.updatedAt, beforeTime, "updatedAt should change");
    assert.equal(after?.status, "running");
  }),
);

test(
  "createRunPersistence load returns null for missing run",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const loaded = rp.load("nonexistent");
    assert.equal(loaded, null);
  }),
);

test(
  "createRunPersistence reads legacy project run files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-run.json"),
      JSON.stringify({
        runId: "legacy-run",
        workflowName: "legacy",
        script: "export const meta = { name: 'legacy', description: 'legacy' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    assert.equal(rp.load("legacy-run")?.workflowName, "legacy");
    assert.equal(
      rp.list().some((run) => run.runId === "legacy-run"),
      true,
    );
  }),
);

test(
  "createRunPersistence list returns runs sorted by updatedAt descending",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    // Save with explicit updatedAt values to guarantee order
    // (save() overwrites updatedAt, so we need to write files directly)
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(runsDir, { recursive: true });
    const makeFile = (runId: string, date: string) => {
      writeFileSync(
        join(runsDir, `${runId}.json`),
        JSON.stringify({
          runId,
          workflowName: `wf-${runId}`,
          script: "export const meta = { name: 'w', description: 'w' }",
          status: "completed",
          phases: [],
          agents: [],
          logs: [],
          startedAt: date,
          updatedAt: date,
        }),
      );
    };
    makeFile("oldest", "2024-01-01T00:00:00.000Z");
    makeFile("middle", "2024-03-01T00:00:00.000Z");
    makeFile("newest", "2024-06-01T00:00:00.000Z");

    const runs = rp.list();
    assert.equal(runs.length, 3);
    assert.equal(runs[0].runId, "newest");
    assert.equal(runs[1].runId, "middle");
    assert.equal(runs[2].runId, "oldest");
  }),
);

test(
  "createRunPersistence list handles empty state",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runs = rp.list();
    assert.deepEqual(runs, []);
    assert.equal(existsSync(workflowProjectPaths(cwd).runsDir), false, "list should not create the runs dir");
  }),
);

test(
  "createRunPersistence list skips corrupted files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    // Save one valid run
    rp.save({
      runId: "valid",
      workflowName: "v",
      script: "export const meta = { name: 'v', description: 'v' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    // Write a corrupted file
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(runsDir, "corrupted.json"), "not valid json{{{");
    writeFileSync(join(runsDir, "empty.json"), "");

    const runs = rp.list();
    assert.equal(runs.length, 1, "should only return valid run");
    assert.equal(runs[0].runId, "valid");
  }),
);

test(
  "createRunPersistence delete removes run and returns true",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "delete-me",
      workflowName: "d",
      script: "export const meta = { name: 'd', description: 'd' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    assert.ok(existsSync(join(workflowProjectPaths(cwd).runsDir, "delete-me.json")), "existsSync() should succeed");
    const deleted = rp.delete("delete-me");
    assert.equal(deleted, true);
    assert.equal(rp.load("delete-me"), null);
  }),
);

test(
  "createRunPersistence delete removes legacy project run files",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "delete-legacy.json"),
      JSON.stringify({
        runId: "delete-legacy",
        workflowName: "legacy",
        script: "export const meta = { name: 'legacy', description: 'legacy' }",
        status: "completed",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    assert.equal(rp.delete("delete-legacy"), true);
    assert.equal(existsSync(join(legacyRunsDir, "delete-legacy.json")), false);
  }),
);

test(
  "createRunPersistence delete returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const deleted = rp.delete("no-such-run");
    assert.equal(deleted, false);
  }),
);

test(
  "createRunPersistence getRunsDir returns the runs directory path",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    assert.equal(rp.getRunsDir(), workflowProjectPaths(cwd).runsDir);
  }),
);

test(
  "createRunPersistence save and load preserves journal entries",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const state: PersistedRunState = {
      runId: "journal-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      journal: [
        { index: 0, hash: "abc123", result: { ok: true } },
        { index: 1, hash: "def456", result: { value: 42 } },
      ],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    rp.save(state);
    const loaded = rp.load("journal-test");
    assert.equal(loaded?.journal?.length, 2);
    assert.equal(loaded?.journal?.[0].index, 0);
    assert.equal(loaded?.journal?.[0].hash, "abc123");
    assert.deepEqual(loaded?.journal?.[0].result, { ok: true });
  }),
);

test(
  "createRunPersistence save and load preserves token usage",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "tokens",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      tokenUsage: { input: 100, output: 50, total: 150 },
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const loaded = rp.load("tokens");
    assert.deepEqual(loaded?.tokenUsage, { input: 100, output: 50, total: 150 });
  }),
);

test(
  "createRunPersistence save and load preserves completedAt and durationMs",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "timing",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:01:00.000Z",
      durationMs: 60000,
    });
    const loaded = rp.load("timing");
    assert.equal(loaded?.completedAt, "2024-01-01T00:01:00.000Z");
    assert.equal(loaded?.durationMs, 60000);
  }),
);

test("generateRunId returns a string with timestamp and random parts", () => {
  const id = generateRunId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 5, "run id should have reasonable length");
  assert.ok(id.includes("-"), "run id should have separator");
});

test("generateRunId produces unique ids", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
  assert.equal(ids.size, 100, "all 100 generated ids should be unique");
});

test(
  "createRunPersistence save throws ENOSPC when disk is full",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      writeFileSync: () => {
        const err = new Error("ENOSPC: no space left on device");
        (err as { code?: string }).code = "ENOSPC";
        throw err;
      },
    });

    const state: PersistedRunState = {
      runId: "enospc-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.throws(
      () => rp.save(state),
      (err: unknown) => (err as { code?: string }).code === "ENOSPC",
    );
  }),
);

test(
  "createRunPersistence save throws EACCES when permission denied",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      writeFileSync: () => {
        const err = new Error("EACCES: permission denied");
        (err as { code?: string }).code = "EACCES";
        throw err;
      },
    });

    const state: PersistedRunState = {
      runId: "eacces-test",
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "pending",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.throws(
      () => rp.save(state),
      (err: unknown) => (err as { code?: string }).code === "EACCES",
    );
  }),
);

test(
  "createRunPersistence list returns empty array when directory is unreadable",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, {
      readdirSync: () => {
        throw new Error("EACCES: permission denied, scandir");
      },
    });

    const runs = rp.list();
    assert.deepEqual(runs, []);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// list() caching (perf fix) — list() is called on essentially every progress
// tick (task-panel re-render), and previously did a full readdirSync +
// per-file readFileSync + JSON.parse of the entire run history on every call.
// A short in-memory TTL cache lets repeated same-tick reads reuse the parse,
// invalidated synchronously by every save()/delete() this instance performs.
// ═══════════════════════════════════════════════════════════════════════════

function baseRunState(
  runId: string,
  updatedAt = "2024-01-01T00:00:00.000Z",
  status: PersistedRunState["status"] = "completed",
): PersistedRunState {
  return {
    runId,
    workflowName: "wf",
    script: "export const meta = { name: 'w', description: 'w' }",
    status,
    phases: [],
    agents: [],
    logs: [],
    startedAt: updatedAt,
    updatedAt,
  };
}

test(
  "createRunPersistence list() caches within the TTL: a repeated call does not re-read disk",
  withTempCwd(async (cwd) => {
    let readdirCalls = 0;
    let readFileCalls = 0;
    const rp = createRunPersistence(cwd, {
      readdirSync: ((...args: Parameters<typeof readdirSync>) => {
        readdirCalls++;
        return readdirSync(...args);
      }) as typeof readdirSync,
      readFileSync: ((...args: Parameters<typeof readFileSync>) => {
        readFileCalls++;
        return readFileSync(...args);
      }) as typeof readFileSync,
    });

    // "running" (non-terminal): a terminal save would trigger the retention
    // scan (see enforceRetention() in run-persistence.ts), which itself reads
    // and mtime-caches this file as a side effect — defeating the point of
    // this test, which measures list()'s OWN caching in isolation.
    rp.save(baseRunState("cache-1", undefined, "running"));
    // save() doesn't touch readdirSync/readFileSync, but reset for clarity.
    readdirCalls = 0;
    readFileCalls = 0;

    const first = rp.list();
    assert.equal(first.length, 1);
    assert.ok(readdirCalls > 0, "the first (uncached) list() call should read the directory");
    assert.ok(readFileCalls > 0, "the first (uncached) list() call should read+parse the run file");
    const readdirAfterFirst = readdirCalls;
    const readFileAfterFirst = readFileCalls;

    const second = rp.list();
    assert.equal(
      readdirCalls,
      readdirAfterFirst,
      "a repeated list() within the TTL must not re-read the runs directory",
    );
    assert.equal(readFileCalls, readFileAfterFirst, "a repeated list() within the TTL must not re-parse the run files");
    assert.deepEqual(second, first, "cached data must be identical to the freshly-computed data");
  }),
);

test(
  "createRunPersistence list() cache is invalidated by save(): a new run appears on the very next call",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(baseRunState("a"));
    const before = rp.list();
    assert.equal(before.length, 1);

    rp.save(baseRunState("b"));
    const after = rp.list();
    assert.equal(after.length, 2, "save() must invalidate the cache so the next list() reflects the new run");
    assert.ok(after.some((r) => r.runId === "b"));
  }),
);

test(
  "createRunPersistence list() cache is invalidated by an update to an existing run's data",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(baseRunState("a", "2024-01-01T00:00:00.000Z"));
    const before = rp.list();
    assert.equal(before[0].status, "completed");

    rp.save({ ...baseRunState("a", "2024-01-02T00:00:00.000Z"), status: "running" });
    const after = rp.list();
    assert.equal(after[0].status, "running", "save() must invalidate the cache so an updated field is visible");
  }),
);

test(
  "createRunPersistence list() cache is invalidated by delete()",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(baseRunState("a"));
    rp.save(baseRunState("b"));
    const before = rp.list();
    assert.equal(before.length, 2);

    rp.delete("a");
    const after = rp.list();
    assert.equal(after.length, 1, "delete() must invalidate the cache");
    assert.equal(after[0].runId, "b");
  }),
);

test(
  "createRunPersistence list() re-reads disk again once the TTL has elapsed (not cached forever)",
  withTempCwd(async (cwd) => {
    let readdirCalls = 0;
    const rp = createRunPersistence(cwd, {
      readdirSync: ((...args: Parameters<typeof readdirSync>) => {
        readdirCalls++;
        return readdirSync(...args);
      }) as typeof readdirSync,
    });

    rp.save(baseRunState("ttl-test"));
    readdirCalls = 0;
    rp.list();
    assert.equal(readdirCalls, 1);

    // Wait past the TTL window (well beyond any reasonable short cache) and
    // confirm a later call does read disk again — this is a cache, not a
    // permanent snapshot.
    await new Promise((r) => setTimeout(r, 400));
    rp.list();
    assert.ok(readdirCalls >= 2, "list() should read disk again once the TTL has elapsed");
  }),
);

test(
  "createRunPersistence list() does not re-parse a file whose mtime/size are unchanged, even across TTL expiry",
  withTempCwd(async (cwd) => {
    let readFileCalls = 0;
    const rp = createRunPersistence(cwd, {
      readFileSync: ((...args: Parameters<typeof readFileSync>) => {
        readFileCalls++;
        return readFileSync(...args);
      }) as typeof readFileSync,
    });

    // Two runs: one that will never change again ("stable"), one that will
    // be re-saved between list() calls ("changing"). Both are "running" so
    // retention-enforcement (a terminal-only path) never fires here.
    rp.save(baseRunState("stable", "2024-01-01T00:00:00.000Z", "running"));
    rp.save(baseRunState("changing", "2024-01-01T00:00:00.000Z", "running"));
    readFileCalls = 0;

    const first = rp.list();
    assert.equal(first.length, 2);
    assert.equal(readFileCalls, 2, "first (cold) scan parses both files");

    // Wait past the TTL so the next list() forces a real disk re-scan
    // (readdirSync fires again), then re-save only "changing" with a
    // different byte size (not just mtime) so this test's signal doesn't
    // depend on the filesystem's mtime resolution.
    await new Promise((r) => setTimeout(r, 400));
    rp.save({ ...baseRunState("changing", "2024-01-02T00:00:00.000Z", "running"), logs: ["it changed"] });
    readFileCalls = 0;

    const second = rp.list();
    assert.equal(second.length, 2);
    assert.equal(readFileCalls, 1, "only the file that actually changed on disk should be re-parsed");
  }),
);

test(
  "createRunPersistence list() re-parses when mtime+size are unchanged but the inode differs (closes the same-tick-rename false-positive)",
  withTempCwd(async (cwd) => {
    // A fully faked fs layer: real filesystems can't reliably produce two
    // saves with identical mtime+size but different inodes on demand
    // (mtime granularity is OS/filesystem dependent), so this simulates the
    // exact scenario directly — two 400ms-throttled persists landing in the
    // same coarse mtime tick (realistic on HFS+, many network mounts, and
    // some Docker volume drivers) with coincidentally equal byte length
    // ("paused" and "failed" are both 6 characters).
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const filePath = join(runsDir, "r.json");

    const makeContent = (status: string) =>
      JSON.stringify({
        runId: "r",
        workflowName: "w",
        script: "s",
        status,
        phases: [],
        agents: [],
        logs: [],
        startedAt: "t",
        updatedAt: "t",
      });
    const contentA = makeContent("paused");
    const contentB = makeContent("failed");
    assert.equal(contentA.length, contentB.length, "fixture must have equal byte length to isolate the ino signal");

    let currentContent = contentA;
    // Same mtime+size across both "generations" — only the inode differs,
    // exactly as it would after tmp+rename replaces the file with a new one
    // in the same tick on a coarse-mtime filesystem/mount.
    const stat = { mtimeMs: 1_700_000_000_000, size: contentA.length, ino: 111 } as ReturnType<typeof statSync>;

    const rp = createRunPersistence(cwd, {
      existsSync: ((p: string) => p === runsDir || p === filePath) as typeof existsSync,
      readdirSync: (() => ["r.json"]) as unknown as typeof readdirSync,
      statSync: (() => stat) as unknown as typeof statSync,
      readFileSync: (() => currentContent) as unknown as typeof readFileSync,
    });

    const first = rp.list();
    assert.equal(first[0]?.status, "paused");

    // Simulate a same-tick rename onto the same path: content changes,
    // mtime and size stay identical, only the inode changes.
    currentContent = contentB;
    (stat as unknown as { ino: number }).ino = 222;

    // Past the TTL so the next list() call actually re-scans.
    await new Promise((r) => setTimeout(r, 400));
    const second = rp.list();
    assert.equal(
      second[0]?.status,
      "failed",
      "a changed inode must be treated as a changed file, even with identical mtime+size — otherwise this would serve stale cached content forever",
    );
  }),
);

test(
  "createRunPersistence retention: terminal runs beyond the cap are evicted oldest-first; running/paused survive purely because of the status filter, not save order",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd, undefined, { maxTerminalRunsOnDisk: 3 });

    // Save running/paused FIRST: save() always overwrites `updatedAt` to
    // "now" (see run-persistence.ts's save()), so saving these first gives
    // them the OLDEST real updatedAt of everything in this test — deliberately
    // the worst case for them. If enforceRetention()'s status filter were
    // removed (evicting purely oldest-by-updatedAt regardless of status),
    // these two would be among the very FIRST candidates evicted. Saving
    // terminal runs LAST (as the earlier, accidentally-passing version of
    // this test did) would let recency alone protect running/paused,
    // masking whether the status filter does anything at all.
    rp.save(baseRunState("still-running", "2023-01-01T00:00:00.000Z", "running"));
    rp.save(baseRunState("still-paused", "2023-01-01T00:00:00.000Z", "paused"));

    // Now enough terminal runs (saved after, so newer) to exceed the cap.
    for (let i = 0; i < 5; i++) {
      rp.save(baseRunState(`terminal-${i}`, `2024-01-0${i + 1}T00:00:00.000Z`, "completed"));
    }

    const runIds = rp.list().map((r) => r.runId);
    const terminalKept = runIds.filter((id) => id.startsWith("terminal-"));
    assert.equal(terminalKept.length, 3, "only maxTerminalRunsOnDisk terminal runs are kept");
    assert.deepEqual(
      new Set(terminalKept),
      new Set(["terminal-2", "terminal-3", "terminal-4"]),
      "the oldest terminal runs are evicted first among themselves, newest are kept",
    );
    assert.ok(
      runIds.includes("still-running"),
      "a running run survives even though it has the OLDEST updatedAt of everything saved here",
    );
    assert.ok(
      runIds.includes("still-paused"),
      "a paused run survives even though it has the OLDEST updatedAt of everything saved here",
    );
    assert.equal(rp.load("terminal-0"), null, "an evicted run's file is actually gone from disk");
  }),
);

test(
  "createRunPersistence concurrent save and load returns consistent data",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);

    const state: PersistedRunState = {
      runId: "concurrent-test",
      workflowName: "test-wf",
      script: "export const meta = { name: 't', description: 't' }",
      args: { items: [1, 2, 3] },
      status: "running",
      phases: ["Scan", "Analyze", "Report"],
      currentPhase: "Analyze",
      agents: [
        { id: 1, label: "agent-a", prompt: "scan", status: "done", result: { found: true } },
        { id: 2, label: "agent-b", prompt: "analyze", status: "running" },
      ],
      logs: ["started", "phase: Scan", "phase: Analyze"],
      tokenUsage: { input: 500, output: 200, total: 700 },
      journal: [{ index: 0, hash: "abc", result: { ok: true } }],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: undefined,
    };

    rp.save(state);
    const loaded = rp.load("concurrent-test");

    assert.ok(loaded, "should load immediately after save");
    assert.equal(loaded.runId, state.runId);
    assert.equal(loaded.workflowName, state.workflowName);
    assert.equal(loaded.status, "running");
    assert.equal(loaded.currentPhase, "Analyze");
    assert.deepEqual(loaded.args, { items: [1, 2, 3] });
    assert.deepEqual(loaded.phases, ["Scan", "Analyze", "Report"]);
    assert.equal(loaded.agents.length, 2);
    assert.deepEqual(loaded.agents[0].result, { found: true });
    assert.equal(loaded.agents[1].status, "running");
    assert.deepEqual(loaded.logs, ["started", "phase: Scan", "phase: Analyze"]);
    assert.deepEqual(loaded.tokenUsage, { input: 500, output: 200, total: 700 });
    assert.deepEqual(loaded.journal, [{ index: 0, hash: "abc", result: { ok: true } }]);
  }),
);

// ─── P1-1: crash-safe durable resume ────────────────────────────────────────────

test(
  "save writes the primary plus a .bak (atomic temp+rename leaves no .tmp)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "running",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.ok(existsSync(join(runsDir, "r1.json")), "primary written");
    assert.ok(existsSync(join(runsDir, "r1.json.bak")), ".bak written");
    assert.equal(existsSync(join(runsDir, "r1.json.tmp")), false, "no leftover .tmp");
  }),
);

test(
  "load recovers from .bak when the primary is corrupt",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "running",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    // Corrupt the primary; the .bak from the good save should still load.
    writeFileSync(join(workflowProjectPaths(cwd).runsDir, "r1.json"), "{ truncated", "utf-8");
    const loaded = rp.load("r1");
    assert.equal(loaded?.runId, "r1", "load falls back to the intact .bak");
  }),
);

test(
  "delete removes the .bak sidecar too",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "r1",
      workflowName: "w",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    rp.delete("r1");
    const runsDir = workflowProjectPaths(cwd).runsDir;
    assert.equal(existsSync(join(runsDir, "r1.json")), false);
    assert.equal(existsSync(join(runsDir, "r1.json.bak")), false, ".bak cleaned up");
  }),
);

test(
  "persistence round-trips cost and cache fields in tokenUsage",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "tu",
      workflowName: "w",
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      tokenUsage: { input: 1, output: 2, total: 3, cost: 0.5, cacheRead: 9, cacheWrite: 4 },
    } as PersistedRunState);
    const loaded = rp.load("tu");
    assert.equal(loaded?.tokenUsage?.cost, 0.5, "cost survives reload");
    assert.equal(loaded?.tokenUsage?.cacheRead, 9, "cacheRead survives reload");
    assert.equal(loaded?.tokenUsage?.cacheWrite, 4, "cacheWrite survives reload");
  }),
);

test(
  "run lease creates an exclusive lock and releases only with the owner token",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const lease = rp.acquireRunLease("lease-1");
    assert.ok(lease, "first acquire should succeed");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")), true, "lock file is created");

    const second = rp.acquireRunLease("lease-1");
    assert.equal(second, null, "second acquire should be refused while owner pid is alive");

    rp.releaseRunLease({ ...lease, token: "wrong-token" });
    assert.equal(
      existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")),
      true,
      "wrong token does not release",
    );

    rp.releaseRunLease(lease);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "lease-1.lock")), false, "owner token releases");
  }),
);

test(
  "run lease refuses while a legacy project lock owner is alive",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-live.lock"),
      JSON.stringify({
        runId: "legacy-live",
        runPath: join(legacyRunsDir, "legacy-live.json"),
        pid: process.pid,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-owner",
      }),
      "utf-8",
    );

    assert.equal(rp.acquireRunLease("legacy-live"), null);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "legacy-live.lock")), false);
  }),
);

test(
  "run lease removes a stale legacy project lock before acquiring the new lock",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    const primaryRunsDir = workflowProjectPaths(cwd).runsDir;
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-stale.lock"),
      JSON.stringify({
        runId: "legacy-stale",
        runPath: join(legacyRunsDir, "legacy-stale.json"),
        pid: 2147483647,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-stale",
      }),
      "utf-8",
    );

    const lease = rp.acquireRunLease("legacy-stale");
    assert.ok(lease, "dead-pid legacy lock should not block the new owner");
    assert.equal(existsSync(join(legacyRunsDir, "legacy-stale.lock")), false);
    assert.equal(existsSync(join(primaryRunsDir, "legacy-stale.lock")), true);
    rp.releaseRunLease(lease);
  }),
);

test(
  "run lease steals a stale lock whose pid is dead",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    rp.save({
      runId: "stale-lock",
      workflowName: "w",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);

    writeFileSync(
      join(runsDir, "stale-lock.lock"),
      JSON.stringify({
        runId: "stale-lock",
        runPath: join(runsDir, "stale-lock.json"),
        pid: 2147483647,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "stale",
      }),
      "utf-8",
    );

    const lease = rp.acquireRunLease("stale-lock");
    assert.ok(lease, "dead-pid lock should be stolen");
    const lock = JSON.parse(readFileSync(join(runsDir, "stale-lock.lock"), "utf-8")) as { token: string };
    assert.equal(lock.token, lease.token, "stale lock is replaced by the new owner");
    rp.releaseRunLease(lease);
  }),
);

test(
  "delete removes the lock sidecar too",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "delete-lock",
      workflowName: "w",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    const lease = rp.acquireRunLease("delete-lock");
    assert.ok(lease, "lease exists before delete");
    rp.delete("delete-lock");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "delete-lock.lock")), false, "lock cleaned up");
  }),
);

test(
  "WorkflowManager reconciles a stale 'running' run to 'paused' on construction",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save({
      runId: "stale",
      workflowName: "w",
      status: "running",
      script: "export const meta = { name: 'w', description: 'd' }\nawait agent('x',{label:'x'})\nreturn 1",
      phases: [],
      agents: [],
      logs: [],
    } as PersistedRunState);
    // A fresh manager (the previous process died) should recover the orphan.
    new WorkflowManager({ cwd });
    assert.equal(rp.load("stale")?.status, "paused", "stale running -> paused (journal preserved for resume)");
  }),
);

test(
  "WorkflowManager does not recover a legacy running run while its legacy lock owner is alive",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const legacyRunsDir = join(cwd, WORKFLOW_RUNS_DIR);
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(
      join(legacyRunsDir, "legacy-live.json"),
      JSON.stringify({
        runId: "legacy-live",
        workflowName: "w",
        status: "running",
        script: "export const meta = { name: 'w', description: 'd' }\nawait agent('x',{label:'x'})\nreturn 1",
        phases: [],
        agents: [],
        logs: [],
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );
    writeFileSync(
      join(legacyRunsDir, "legacy-live.lock"),
      JSON.stringify({
        runId: "legacy-live",
        runPath: join(legacyRunsDir, "legacy-live.json"),
        pid: process.pid,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "legacy-owner",
      }),
      "utf-8",
    );

    new WorkflowManager({ cwd });

    assert.equal(rp.load("legacy-live")?.status, "running");
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "legacy-live.json")), false);
  }),
);

test(
  "WorkflowManager.listRuns is scoped to the bound session and switches with setSessionId",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const run = (runId: string, sessionId: string): PersistedRunState =>
      ({
        runId,
        workflowName: "w",
        status: "completed",
        sessionId,
        phases: [],
        agents: [],
        logs: [],
      }) as PersistedRunState;
    rp.save(run("a", "s1"));
    rp.save(run("b", "s2"));

    const m = new WorkflowManager({ cwd, sessionId: "s1" });
    assert.deepEqual(
      m.listRuns().map((r) => r.runId),
      ["a"],
      "only the bound session's runs are listed",
    );

    m.setSessionId("s2");
    assert.deepEqual(
      m.listRuns().map((r) => r.runId),
      ["b"],
      "switching sessions re-shows that session's runs",
    );

    m.setSessionId(undefined);
    assert.deepEqual(
      m
        .listRuns()
        .map((r) => r.runId)
        .sort(),
      ["a", "b"],
      "unbound lists all runs (legacy/global)",
    );

    // listAllRuns ignores the session binding.
    assert.equal(new WorkflowManager({ cwd, sessionId: "s1" }).listAllRuns().length, 2);
  }),
);

// ─── P0-4: saveCheckpoint must not pollute the resume journal ────────────────

test(
  "saveCheckpoint appends to checkpoints[] and leaves the resume journal untouched (no fake hash entry)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "p0-4-journal";
    const seededJournal = [
      { index: 0, runId, hash: "real-call-hash-1", result: { reply: "first" } },
      { index: 1, runId, hash: "real-call-hash-2", result: { reply: "second" } },
    ];
    rp.save({
      runId,
      workflowName: "wf",
      script: "export const meta = { name: 'w', description: 'w' }",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      journal: seededJournal,
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      worktreePath: "/tmp/worktree",
      branch: "plan-approval",
      output: "approved",
      timestamp: "2024-01-01T00:05:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    const raw = rp.load(runId);
    assert.deepEqual(
      raw?.journal,
      seededJournal,
      "the resume journal must be unchanged — a checkpoint must never add an entry the resume path could replay as a cache hit",
    );
    assert.equal(raw?.journal?.length, 2, "no fake hash entry may be appended");
    assert.deepEqual(raw?.checkpoints, [checkpoint], "the checkpoint lands in checkpoints[]");

    // Round-trip through the exported reader.
    const state = await loadRunState(runId, cwd);
    assert.equal(state?.status, "active", "a paused run maps to checkpoint-state 'active'");
    assert.deepEqual(state?.checkpoints, [checkpoint], "checkpoint round-trips via loadRunState");
    assert.equal(state?.checkpoints[0].taskId, "approve-plan");
    assert.equal(state?.checkpoints[0].branch, "plan-approval");

    // listActiveRuns (paused run) reads from checkpoints[] too.
    const active = await listActiveRuns(cwd);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0].checkpoints, [checkpoint]);
  }),
);

test(
  "saveCheckpoint dedupes by taskId and keeps checkpoints in first-seen order",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "p0-4-dedupe";
    rp.save({
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

    const mk = (taskId: string, timestamp: string): RunCheckpoint => ({
      runId,
      taskId,
      status: "active",
      timestamp,
    });
    await saveCheckpoint(runId, mk("t1", "2024-01-01T00:01:00.000Z"), cwd);
    await saveCheckpoint(runId, mk("t2", "2024-01-01T00:02:00.000Z"), cwd);
    // Re-saving t1 must update in place, not append a duplicate at the end.
    await saveCheckpoint(runId, mk("t1", "2024-01-01T00:03:00.000Z"), cwd);

    const state = await loadRunState(runId, cwd);
    assert.equal(state?.checkpoints.length, 2, "re-saving an existing taskId must not duplicate it");
    assert.deepEqual(
      state?.checkpoints.map((c) => c.taskId),
      ["t1", "t2"],
      "checkpoints keep their first-seen order after an in-place update",
    );
    assert.equal(
      state?.checkpoints[0].timestamp,
      "2024-01-01T00:03:00.000Z",
      "the updated checkpoint replaces the old one in place",
    );
  }),
);

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

// ═══════════════════════════════════════════════════════════════════════════
// CAS single-writer persistence (core-orchestration:f3 / i2)
// ═══════════════════════════════════════════════════════════════════════════

test(
  "updateRunState applies a mutation to the freshest snapshot and persists atomically (no leftover .tmp)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-basic";
    rp.save({
      ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: "cached" }],
    });
    const final = await updateRunState(
      runId,
      (s) => {
        s.status = "running";
      },
      cwd,
    );
    assert.equal(final?.status, "running");
    const loaded = rp.load(runId);
    assert.equal(loaded?.status, "running");
    assert.deepEqual(
      loaded?.journal,
      [{ index: 0, runId, hash: "h0", result: "cached" }],
      "the mutation must not clobber the journal",
    );
    assert.equal(
      existsSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.json.tmp`)),
      false,
      "the CAS write is atomic — no leftover .tmp",
    );
  }),
);

test(
  "updateRunState returns null for a missing run and creates no file",
  withTempCwd(async (cwd) => {
    const result = await updateRunState(
      "ghost",
      (s) => {
        s.status = "running";
      },
      cwd,
    );
    assert.equal(result, null);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).runsDir, "ghost.json")), false);
  }),
);

test(
  "concurrent writers (journaling + checkpointing) never lose each other's data: a stale checkpoint save preserves the journal",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-race-journal";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    // Writer B (checkpoint saver) captures a stale snapshot BEFORE A journals.
    const staleB = rp.load(runId);
    assert.ok(staleB, "B's snapshot exists");
    assert.equal(staleB.journal?.length, undefined, "B's snapshot predates A's journal entry");
    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      timestamp: "2024-01-01T00:02:00.000Z",
    };

    // Writer A (the manager) journals an entry — this is the freshest state.
    await updateRunState(
      runId,
      (s) => {
        s.journal = upsertJournalEntry(s.journal ?? [], { index: 0, runId, hash: "h-journaled", result: "journaled" });
      },
      cwd,
    );

    await saveCheckpoint(runId, checkpoint, cwd);

    // B now persists its stale snapshot: the CAS merge must re-read the
    // freshest file and keep A's journal entry instead of erasing it.
    rp.save({ ...staleB, checkpoints: [checkpoint] });

    const final = rp.load(runId);
    assert.equal(final?.journal?.[0]?.result, "journaled", "the journaling writer's entry survives B's stale save");
    assert.deepEqual(final?.checkpoints, [checkpoint], "B's checkpoint is present");
  }),
);

test(
  "concurrent writers never lose each other's data: a stale journaling save preserves the checkpoint",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-race-checkpoint";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    // Writer A (the manager) captures a stale snapshot BEFORE B's checkpoint.
    const staleA = rp.load(runId);
    assert.ok(staleA, "A's snapshot exists");
    assert.equal(staleA.checkpoints, undefined, "A's snapshot predates B's checkpoint");

    // Writer B saves a checkpoint first (fresh CAS read).
    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      timestamp: "2024-01-01T00:01:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    // A journals an entry (fresh CAS read), then persists its stale snapshot.
    await updateRunState(
      runId,
      (s) => {
        s.journal = upsertJournalEntry(s.journal ?? [], { index: 0, runId, hash: "h-journaled", result: "journaled" });
      },
      cwd,
    );
    rp.save({ ...staleA, journal: [{ index: 0, runId, hash: "h-stale", result: "stale" }] });

    const final = rp.load(runId);
    assert.deepEqual(final?.checkpoints, [checkpoint], "the checkpoint writer's data survives A's stale save");
    assert.equal(final?.journal?.length, 1, "A's journal entry survives");
    assert.equal(final?.journal?.[0]?.result, "stale", "the journaling writer's own entry wins its key");
  }),
);

test(
  "a manager-style full snapshot save never erases disk checkpoints (save() carries them into the write)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-checkpoints-survive";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve-plan",
      status: "completed",
      timestamp: "2024-01-01T00:01:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    // The manager's writeRunToDisk save object carries NO checkpoints field —
    // save() must merge the disk list instead of dropping it.
    rp.save({
      ...baseRunState(runId, "2024-01-01T00:02:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: "cached" }],
    });
    const final = rp.load(runId);
    assert.deepEqual(final?.checkpoints, [checkpoint], "manager persists keep the checkpoint");
    assert.equal(final?.journal?.[0]?.result, "cached");
  }),
);

test(
  "concurrent updateRunState appends all land (no lost updates under real fs)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-stress";
    rp.save({ ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "running") });

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        updateRunState(
          runId,
          (s) => {
            s.journal = upsertJournalEntry(s.journal ?? [], { index: i, runId, hash: `h${i}`, result: `r${i}` });
          },
          cwd,
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveCheckpoint(
          runId,
          { runId, taskId: `t${i}`, status: "completed", timestamp: `2024-01-01T00:0${i}:00.000Z` },
          cwd,
        ),
      ),
    );

    const final = rp.load(runId);
    assert.equal(final?.journal?.length, 25, "all 25 concurrent journal appends must land");
    assert.equal(final?.checkpoints?.length, 5, "all 5 checkpoints must land");
  }),
);

test(
  "cleanupRun and resumeRun go through CAS: neither clobbers concurrent journal/checkpoint data",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "cas-lifecycle";
    rp.save({
      ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: "cached" }],
    });
    const checkpoint: RunCheckpoint = {
      runId,
      taskId: "approve",
      status: "completed",
      timestamp: "2024-01-01T00:01:00.000Z",
    };
    await saveCheckpoint(runId, checkpoint, cwd);

    const resumed = await resumeRun(runId, cwd);
    assert.equal(resumed.status, "active");
    assert.deepEqual((await loadRunState(runId, cwd))?.checkpoints, [checkpoint]);
    assert.deepEqual(rp.load(runId)?.journal, [{ index: 0, runId, hash: "h0", result: "cached" }]);

    await cleanupRun(runId, cwd);
    const finished = rp.load(runId);
    assert.equal(finished?.status, "completed");
    assert.ok(finished?.completedAt, "cleanup stamps completedAt");
    assert.deepEqual(finished?.checkpoints, [checkpoint], "cleanup keeps the checkpoint");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// RunState schema versioning + migration (migrateRunState)
// ═══════════════════════════════════════════════════════════════════════════

test("migrateRunState stamps the schema version and preserves every known field", () => {
  const raw = {
    runId: "legacy",
    workflowName: "wf",
    script: "export const meta = {}",
    status: "paused",
    phases: ["Scan"],
    agents: [{ id: 1, label: "a", prompt: "p", status: "done" }],
    logs: ["started"],
    journal: [{ index: 0, hash: "h", result: "r" }],
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:01:00.000Z",
  };
  const migrated = migrateRunState(raw);
  assert.equal(migrated.schemaVersion, RUN_STATE_SCHEMA_VERSION);
  assert.equal(migrated.runId, "legacy");
  assert.equal(migrated.status, "paused");
  assert.deepEqual(migrated.phases, ["Scan"]);
  assert.deepEqual(migrated.agents, [{ id: 1, label: "a", prompt: "p", status: "done" }]);
  assert.deepEqual(migrated.journal, [{ index: 0, hash: "h", result: "r" }]);
});

test("migrateRunState fills defaults for missing fields and never throws", () => {
  const migrated = migrateRunState({ runId: "partial" });
  assert.equal(migrated.status, "paused", "missing status defaults to the resumable paused");
  assert.deepEqual(migrated.phases, []);
  assert.deepEqual(migrated.agents, []);
  assert.deepEqual(migrated.logs, []);
  assert.equal(migrated.schemaVersion, RUN_STATE_SCHEMA_VERSION);
  assert.equal(typeof migrated.startedAt, "string");
  // Garbage inputs never throw; missing/invalid fields get defaults.
  assert.equal(migrateRunState(null).schemaVersion, RUN_STATE_SCHEMA_VERSION);
  assert.equal(migrateRunState(42).status, "paused");
  assert.equal(migrateRunState("junk").status, "paused");
  assert.equal(migrateRunState({ status: "bogus" }).status, "paused");
  assert.equal(migrateRunState({ journal: "not-an-array" }).journal, undefined);
  assert.equal(migrateRunState({ journalCompacted: { kind: "nope" } }).journalCompacted, undefined);
});

test("migrateRunState preserves unknown/forward fields and clamps unknown schema versions", () => {
  const migrated = migrateRunState({ runId: "fwd", schemaVersion: 999, futureField: { a: 1 }, status: "failed" });
  assert.equal(migrated.status, "failed", "a valid status is never overridden");
  assert.deepEqual((migrated as unknown as { futureField: unknown }).futureField, { a: 1 }, "forward fields survive");
  assert.equal(migrated.schemaVersion, RUN_STATE_SCHEMA_VERSION, "unknown version numbers are clamped, not thrown on");
});

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
    assert.equal(state?.agents[0]?.result?.ok, true);

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

// ═══════════════════════════════════════════════════════════════════════════
// Secret redaction (provider keys never reach disk)
// ═══════════════════════════════════════════════════════════════════════════

test("redactText masks provider keys, env-var assignments, bearer tokens, JWTs and PEM blocks", () => {
  assert.equal(redactText("sk-abcDEF1234567890"), "[REDACTED]");
  assert.equal(redactText("OPENAI_API_KEY=sk-abcDEF1234567890"), "OPENAI_API_KEY=[REDACTED]");
  assert.equal(redactText('"OPENAI_API_KEY": "sk-abcDEF1234567890"'), '"OPENAI_API_KEY=[REDACTED]"');
  assert.equal(redactText("Authorization: Bearer abcdefghijklmnop1234567890"), "Authorization: Bearer [REDACTED]");
  assert.equal(
    redactText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
    "[REDACTED]",
  );
  assert.equal(redactText("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"), "[REDACTED]");
  assert.equal(redactText("ghp_abcdefghijklmnopqrstuvwxyz1234567890"), "[REDACTED]");
  assert.equal(redactText("AIzaSyA1234567890abcdefghijklmnopqrstuvwxyz"), "[REDACTED]");
  assert.equal(redactText("AKIAIOSFODNN7EXAMPLE"), "[REDACTED]");
  // Benign content is untouched.
  assert.equal(redactText("the quick brown fox"), "the quick brown fox");
  assert.equal(redactText('{"hash":"a1b2c3d4","result":"ok"}'), '{"hash":"a1b2c3d4","result":"ok"}');
  assert.equal(redactText("2024-01-01T00:00:00.000Z"), "2024-01-01T00:00:00.000Z");
});

test(
  "a provider API key in agent output never lands in the persisted journal or compacted state",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "secret-leak";
    const key = "sk-abcDEFghijklmnopqrstuvwxyz1234567890";

    // Save 1: plain-journal form (the manager's default write).
    const journalState: PersistedRunState = {
      ...baseRunState(runId, "2024-01-01T00:00:00.000Z", "paused"),
      journal: [{ index: 0, runId, hash: "h0", result: { text: `use ${key} for the API` } }],
      logs: [`OPENAI_API_KEY=${key}`],
      agents: [{ id: 1, label: "a", prompt: "p", status: "done", result: { key } }],
    };
    rp.save(journalState);

    const rawJournal = readFileSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.json`), "utf-8");
    assert.ok(!rawJournal.includes(key), "the raw key must never be written to disk");
    assert.ok(!rawJournal.includes("sk-abcDEFghijklmnopqrstuvwxyz"), "the key prefix must not leak either");
    assert.ok(rawJournal.includes("use [REDACTED] for the API"), "the redacted form IS what lands on disk");

    const loadedJournal = rp.load(runId);
    assert.ok(!JSON.stringify(loadedJournal).includes(key), "the key is scrubbed from every loaded surface");
    assert.equal(loadedJournal?.journal?.[0]?.result?.text, "use [REDACTED] for the API");
    assert.equal(loadedJournal?.logs?.[0], "OPENAI_API_KEY=[REDACTED]");
    assert.equal(loadedJournal?.agents[0]?.result?.key, "[REDACTED]");
    // The in-memory state passed to save() is NOT mutated — only the
    // persisted form is scrubbed.
    assert.ok(
      JSON.stringify(journalState).includes(key),
      "the in-memory state keeps its value until the persistence boundary",
    );

    // Save 2: compacted-summary form (the manager's opt-in compaction write).
    const compactedState: PersistedRunState = {
      ...baseRunState(runId, "2024-01-01T00:02:00.000Z", "paused"),
      journalCompacted: {
        kind: "compact",
        version: 1,
        hashes: ["h0"],
        opTraces: [],
        results: [{ key }],
        storeDeltas: [],
        records: [{ fold: "resolved", index: 0, runId, hashRef: 0, resultRef: 0 }],
      },
    };
    rp.save(compactedState);

    const rawCompacted = readFileSync(join(workflowProjectPaths(cwd).runsDir, `${runId}.json`), "utf-8");
    assert.ok(!rawCompacted.includes(key), "the key never lands in the compacted state either");
    const loadedCompacted = rp.load(runId);
    assert.equal(loadedCompacted?.journalCompacted?.results[0]?.key, "[REDACTED]");
    assert.equal(loadedCompacted?.journalCompacted?.records.length, 1);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Journal size / stringify budget
// ═══════════════════════════════════════════════════════════════════════════

test("upsertJournalEntry caps growth at MAX_JOURNAL_ENTRIES keeping the newest entries", () => {
  const base = Array.from({ length: MAX_JOURNAL_ENTRIES }, (_, i) => ({
    index: i,
    runId: "r",
    hash: `h${i}`,
    result: i,
  }));
  const next = upsertJournalEntry(base, { index: MAX_JOURNAL_ENTRIES, runId: "r", hash: "new", result: "new" });
  assert.equal(next.length, MAX_JOURNAL_ENTRIES, "the journal never grows past the cap");
  assert.equal(next[0]?.index, 1, "the oldest entry is evicted");
  assert.equal(next[next.length - 1]?.index, MAX_JOURNAL_ENTRIES, "the newest entry is kept");
});

test("capJournalBudget drops the oldest entries first when over the byte budget", () => {
  const journal = Array.from({ length: 100 }, (_, i) => ({
    index: i,
    runId: "r",
    hash: `h${i}`,
    result: `result-${i}-${"x".repeat(100)}`,
  }));
  const capped = capJournalBudget(journal, 2000);
  assert.ok(capped.length < journal.length, "the journal was trimmed");
  assert.ok(JSON.stringify(capped).length <= 2000, "the capped journal fits the budget");
  assert.equal(capped[0]?.index, journal.length - capped.length, "the OLDEST entries were dropped, newest kept");
  assert.equal(capJournalBudget(journal, DEFAULT_JOURNAL_BYTE_BUDGET), journal, "under budget → unchanged (no copy)");
});

test(
  "persisting a 20k-entry journal stays within a generous wall-clock bound",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const journal = Array.from({ length: 20_000 }, (_, i) => ({
      index: i,
      runId: "big",
      hash: `h${i}`,
      result: { i },
    }));
    const started = Date.now();
    rp.save({ ...baseRunState("big-run", "2024-01-01T00:00:00.000Z", "paused"), journal });
    const saveMs = Date.now() - started;
    const loaded = rp.load("big-run");
    assert.equal(loaded?.journal?.length, 20_000, "the full journal round-trips");
    assert.ok(saveMs < 5000, `saving 20k entries took ${saveMs}ms — expected well under the generous 5s bound`);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Lease lifecycle: bounded-delay reclaim + renewal heartbeat
// ═══════════════════════════════════════════════════════════════════════════

test(
  "new leases carry an expiry and renewRunLease pushes it forward (owner token only)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const lease = rp.acquireRunLease("heartbeat");
    assert.ok(lease, "first acquire succeeds");
    const lockPath = join(workflowProjectPaths(cwd).runsDir, "heartbeat.lock");
    const lockBefore = JSON.parse(readFileSync(lockPath, "utf-8")) as { expiresAt: string };
    assert.ok(lockBefore.expiresAt, "new leases carry an expiry for bounded-delay reclaim");

    assert.equal(rp.renewRunLease({ ...lease, token: "wrong-token" }), false, "a non-owner cannot renew");
    assert.equal(renewRunLease(lease, cwd), true, "the owner's heartbeat renews the lease (standalone export)");

    const lockAfter = JSON.parse(readFileSync(lockPath, "utf-8")) as { expiresAt: string };
    assert.ok(Date.parse(lockAfter.expiresAt) > Date.parse(lockBefore.expiresAt), "renewal pushes the expiry forward");
    rp.releaseRunLease(lease);
  }),
);

test(
  "a still-alive owner that renews its lease is never evicted by a concurrent acquire",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const lease = rp.acquireRunLease("live-renewer");
    assert.ok(lease);
    for (let i = 0; i < 5; i++) {
      assert.equal(rp.acquireRunLease("live-renewer"), null, "a live, renewed lease must never be evicted");
      assert.equal(rp.renewRunLease(lease), true, "the owner keeps its heartbeat");
    }
    assert.equal(rp.acquireRunLease("live-renewer"), null, "still refused after the final renewal");
    rp.releaseRunLease(lease);
  }),
);

test(
  "an expired lease is reclaimable even when the owner pid is alive (bounded-delay reclaim)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    rp.save({ ...baseRunState("expired-lease", "2024-01-01T00:00:00.000Z", "paused") });
    // Simulate an owner that stopped renewing: pid is STILL alive (this process),
    // but the lease expired long ago.
    writeFileSync(
      join(runsDir, "expired-lease.lock"),
      JSON.stringify({
        runId: "expired-lease",
        runPath: join(runsDir, "expired-lease.json"),
        pid: process.pid,
        startedAt: "2024-01-01T00:00:00.000Z",
        token: "ghost-owner",
        expiresAt: "2024-01-01T00:10:00.000Z",
      }),
      "utf-8",
    );
    const stolen = rp.acquireRunLease("expired-lease");
    assert.ok(stolen, "an expired lease must be reclaimable even with a live pid");
    assert.equal(DEFAULT_RUN_LEASE_TTL_MS > 0, true, "the TTL constant is positive (the bounded delay)");
    rp.releaseRunLease(stolen);
  }),
);
