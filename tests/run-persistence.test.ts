// E-SPEC 6/7: tests/run-persistence.test.ts fully split into tests/slices/persistence/{snapshot,lease,journal,corrupt}.test.ts
// See tasks/audit-fix-implementation/reports/E6.md

// ═══════════════════════════════════════════════════════════════════════════
// core-01 (slice atomic-io) — atomic lease renewal + torn/corrupt-lock safety
//
// The original monolithic run-persistence.test.ts was split (E6); the lease
// lifecycle tests live in tests/slices/persistence/run-persistence-lease.test.ts.
// THIS file carries the core-01 regression tests for the audit finding at
// src/run-persistence.ts (renewRunLease's truncate-then-write → torn lock →
// readLockAt JSON.parse → null → acquireRunLease re-acquires → the SAME runId
// double-executed, double token spend). Two pins, the slice-A contract:
//   1. a torn/corrupt lock file is NEVER read as "no lease" — acquisition
//      refuses and the read-only lease view reports "held, not reclaimable";
//   2. renewRunLease's token/owner guard refuses to clobber a lease that was
//      concurrently re-acquired between its read and its rename.
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync as realReadFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
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

function baseRunState(
  runId: string,
  updatedAt = "2024-01-01T00:00:00.000Z",
  status: PersistedRunState["status"] = "running",
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
  "core-01: a torn/corrupt lock file is treated as held — never 'no lease' (acquire refuses)",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    rp.save(baseRunState("torn-lock"));
    // Simulate the legacy truncate-then-write tear: the lock exists but holds
    // half-written JSON (a crash between the truncate and the write). The old
    // reader JSON.parsed this as null → "no lease" → acquireRunLease re-
    // acquired → the SAME runId double-executed (double token spend).
    writeFileSync(join(runsDir, "torn-lock.lock"), '{"runId": "torn-lock", "pid": ', "utf-8");

    assert.equal(
      rp.acquireRunLease("torn-lock"),
      null,
      "a torn lock must NOT read as absent: acquisition refuses instead of re-acquiring",
    );
    assert.equal(
      existsSync(join(runsDir, "torn-lock.lock")),
      true,
      "the torn lock is not silently unlinked and replaced",
    );
    const info = rp.getLeaseInfo?.("torn-lock");
    assert.ok(info, "the read-only lease view reports a lease for a corrupt lock (not null / 'no lease')");
    assert.equal(info?.reclaimable, false, "a corrupt lock is never reclaimable (ownership cannot be verified)");
    assert.equal(
      rp.renewRunLease?.({ runId: "torn-lock", token: "any" }),
      false,
      "a corrupt lock cannot be renewed (owner token unverifiable)",
    );
  }),
);

test(
  "core-01: renewRunLease never clobbers a concurrently re-acquired lease (token/owner guard)",
  withTempCwd(async (cwd) => {
    const runsDir = workflowProjectPaths(cwd).runsDir;
    mkdirSync(runsDir, { recursive: true });
    const lockPath = join(runsDir, "steal-race.lock");
    const ownerToken = "owner-token";
    const replacementToken = "new-owner-token";

    // Phase 1 — the owner acquires and holds the lease (real fs).
    const rp = createRunPersistence(cwd);
    const lease = rp.acquireRunLease("steal-race");
    assert.ok(lease, "the owner acquires the lease");
    const acquired = JSON.parse(realReadFileSync(lockPath, "utf-8")) as { token: string };
    assert.equal(acquired.token, lease.token);

    // Phase 2 — a concurrent acquirer replaces the lock between renew's token
    // check and its rename. The injected reader returns the ORIGINAL lock on
    // renew's first read (the read that happened before the steal) and the
    // replacement on the re-verify — a deterministic TOCTOU simulation.
    let reads = 0;
    const rpStolen = createRunPersistence(cwd, {
      readFileSync: ((path: string, encoding: "utf-8") => {
        if (path.endsWith("steal-race.lock")) {
          reads += 1;
          return JSON.stringify(
            reads === 1 ? { runId: "steal-race", token: ownerToken } : { runId: "steal-race", token: replacementToken },
          );
        }
        return realReadFileSync(path, encoding);
      }) as typeof realReadFileSync,
    });
    // Land the steal on real disk so a clobber would be observable.
    writeFileSync(lockPath, JSON.stringify({ runId: "steal-race", token: replacementToken }), "utf-8");

    const renewed = rpStolen.renewRunLease?.({ runId: "steal-race", token: ownerToken });
    assert.equal(renewed, false, "renew refuses once ownership changed mid-renewal");
    const onDisk = JSON.parse(realReadFileSync(lockPath, "utf-8")) as { token: string };
    assert.equal(
      onDisk.token,
      replacementToken,
      "the concurrently-acquired lease is never clobbered by the stale renewal",
    );
    assert.deepEqual(
      readdirSync(runsDir).filter((name) => name.endsWith(".tmp")),
      [],
      "the aborted renewal cleans up its tmp file",
    );
  }),
);
