import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WORKFLOW_RUNS_DIR } from "../../../src/config.js";
import {
  createRunPersistence,
  DEFAULT_RUN_LEASE_TTL_MS,
  type PersistedRunState,
  renewRunLease,
} from "../../../src/run-persistence.js";
import { WorkflowManager } from "../../../src/workflow-manager.js";
import { workflowProjectPaths } from "../../../src/workflow-paths.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";
import { rmForce } from "../../helpers/rm-force.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-rp-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

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
    } as unknown as PersistedRunState);

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
    } as unknown as PersistedRunState);
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
    } as unknown as PersistedRunState);
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

    assert.equal(rp.renewRunLease?.({ ...lease, token: "wrong-token" }), false, "a non-owner cannot renew");
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
      assert.equal(rp.renewRunLease?.(lease), true, "the owner keeps its heartbeat");
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
