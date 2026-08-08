import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWorktreeCommand } from "../src/agent/worktree-runner.js";
import { rmForce } from "./helpers/rm-force.js";

/**
 * Windows releases a killed child's cwd handle a few ms after process exit —
 * the timeout test's child dies with cwd=dir, so removal can transiently EPERM.
 * Delegate to the shared rmForce helper, which retries EBUSY/EPERM with its own
 * bounded outer loop (tests/helpers/rm-force.ts) instead of failing the test on
 * a cleanup artifact.
 */
async function removeDirRetry(dir: string): Promise<void> {
  await rmForce(dir);
}

/**
 * Count live stdio/process handles attributed to spawn cycles. Pipe = a child's
 * stdio pipe, ChildProcess = a live child — both must return to baseline after
 * every cycle. `getActiveResourcesInfo` is public (Node >= 17.3) and typed in
 * @types/node.
 */
function liveSpawnHandles(): number {
  const info = (process.getActiveResourcesInfo?.() ?? []) as string[];
  return info.filter((t) => t === "Pipe" || t === "ChildProcess").length;
}

/** Give close/GC callbacks a few macrotask turns to propagate. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("G8: 20 spawn cycles keep stdio pipe + child-process handles flat (no fd growth)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-fd-"));
  try {
    // Warm-up cycle: lazy one-time init (module load, shell resolution) must
    // not be attributed to the measured leak window.
    await runWorktreeCommand("node -e 0", dir, 30_000);
    await settle();
    const baseline = liveSpawnHandles();

    const samples: number[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const result = await runWorktreeCommand("node -e 0", dir, 30_000);
      assert.equal(result.ok, true, `cycle ${cycle} must actually run`);
      assert.equal(result.code, 0);
      await settle();
      samples.push(liveSpawnHandles());
    }
    const final = liveSpawnHandles();

    assert.ok(
      final <= baseline + 1,
      `stdio handles must not grow across 20 spawn cycles (baseline=${baseline}, final=${final})`,
    );
    assert.ok(
      samples.every((s) => s <= baseline + 1),
      `no measured sample may exceed the baseline: ${JSON.stringify(samples)}`,
    );
  } finally {
    await removeDirRetry(dir);
  }
});

test("G8: a spawn failure releases its stdio handles too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-fd-err-"));
  try {
    const baseline = liveSpawnHandles();
    const result = await runWorktreeCommand("definitely-not-a-real-command-xyz", dir, 5_000);
    assert.equal(result.ok, false, "a bogus command must not report success");
    await settle();
    assert.ok(liveSpawnHandles() <= baseline + 1, "a failed spawn must not leave stdio pipes behind");
  } finally {
    await removeDirRetry(dir);
  }
});

test("G8: a timeout-killed child settles promptly and releases its stdio handles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-fd-to-"));
  try {
    const baseline = liveSpawnHandles();
    const started = Date.now();
    const result = await runWorktreeCommand('node -e "setInterval(() => {}, 1000)"', dir, 80);
    assert.equal(result.ok, false, "a never-exiting command must not report success");
    assert.equal(result.code, "timeout", "the settle path reports the timeout reason");
    assert.ok(Date.now() - started < 2_000, "the timeout must settle promptly, not hang");
    await settle();
    assert.ok(liveSpawnHandles() <= baseline + 1, "a killed child must not leave stdio pipes behind");
  } finally {
    await removeDirRetry(dir);
  }
});
