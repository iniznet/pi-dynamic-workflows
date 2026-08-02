import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence } from "../../../src/run-persistence.js";

test("L2: a lease older than MAX_RUN_LEASE_AGE_MS is reclaimable even while its pid is alive and its TTL is fresh", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-l2-"));
  try {
    const persistence = createRunPersistence(cwd);
    const runId = "stale-owner";
    const runsDir = persistence.getRunsDir();
    mkdirSync(runsDir, { recursive: true });

    // A lock whose owner pid is ALIVE (this process), whose TTL is unexpired,
    // but whose startedAt is more than a day old — the recycled-PID / runaway
    // renew class (L2). A fresh acquire must reclaim it instead of returning
    // null forever.
    const stale: Record<string, unknown> = {
      runId,
      runPath: join(runsDir, `${runId}.json`),
      pid: process.pid,
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      token: "stale-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(runsDir, `${runId}.lock`), JSON.stringify(stale, null, 2), { flag: "wx" });

    const lease = persistence.acquireRunLease(runId);
    if (!lease) throw new Error("expected the age-stale lease to be reclaimed");
    assert.notEqual(lease.token, "stale-token", "a NEW token replaced the stale lock");
    persistence.releaseRunLease(lease);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
