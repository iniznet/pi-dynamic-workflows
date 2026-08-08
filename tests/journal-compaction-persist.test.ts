/**
 * P2-5 — Compaction persist wiring through WorkflowManager (opt-in flag,
 * journalCompacted on disk, reconstruction-QA keep-original fallback, and
 * resume replay of a compacted journal).
 *
 * The pure engine + QA gate are covered in tests/journal-compaction.test.ts;
 * this file proves the OPT-IN flag (default OFF) and the "never persist a
 * failed-QA compacted form" behavior at the manager's disk choke point.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowAgent } from "../src/agent.js";
import { reconstructJournal } from "../src/journal-compaction.js";
import { loadPersistedJournal } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a run's status until it reaches `status` or the deadline passes. */
async function waitForStatus(
  manager: WorkflowManager,
  runId: string,
  status: string,
  deadlineMs = 3000,
): Promise<string | undefined> {
  const deadline = Date.now() + deadlineMs;
  let current: string | undefined;
  while (Date.now() < deadline) {
    current = manager.getRun(runId)?.status;
    if (current === status) return current;
    // In-memory status poll: 50ms cadence (3s default deadline → 60 fires).
    await sleep(50);
  }
  return current;
}

/**
 * Poll until the persisted run carries journalCompacted. Since S1-3 moved the
 * compactJournal + verifyJournalCompaction fold OFF the pause critical path
 * (sync-compaction-at-boundary), a non-terminal settle persists the RAW
 * journal synchronously and the compacted form lands a tick later from the
 * queued setImmediate task — the tests await that task instead of asserting
 * an immediate post-pause fold.
 */
async function waitForCompacted(manager: WorkflowManager, runId: string, deadlineMs = 3000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (manager.getPersistence().load(runId)?.journalCompacted !== undefined) return true;
    // Disk poll (persistence.load) at 200ms: the compacted form lands from the
    // queued setImmediate fold task within ms, so a 3s deadline (15 fires) is
    // ample.
    await sleep(200);
  }
  return false;
}

/** Run each manager test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-compact-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      await rmForce(cwd, fakeHome);
    }
  };
}

/** Agent runner with PER-CALL deferred promises (each run() hangs until its own resolve). */
function perCallDeferredAgent() {
  const resolves: Array<(value: unknown) => void> = [];
  let callIdx = 0;
  return {
    resolve: (idx: number, value: unknown = "done") => resolves[idx]?.(value),
    resolveAll: (value: unknown = "done") => {
      for (let i = 0; i < resolves.length; i++) resolves[i]?.(value);
    },
    runner: {
      async run() {
        const idx = callIdx++;
        return new Promise((resolve) => {
          resolves[idx] = resolve;
        });
      },
    } as unknown as Pick<WorkflowAgent, "run">,
  };
}

/** 8-way identical fan-out + one hanging tail agent — the foldable shape that actually shrinks. */
const fanOutScript = `export const meta = { name: 'compact_fanout', description: 'fan-out compaction demo' }
const results = await parallel([0, 1, 2, 3, 4, 5, 6, 7].map((i) => () => agent('fan-out task', { label: 'w' + i })))
const tail = await agent('tail task', { label: 'tail' })
return { results, tail }`;

// ─── loadPersistedJournal (run-persistence normalization) ─────────────────────

test("loadPersistedJournal reconstructs a compacted journal and passes plain/absent journals through", () => {
  const compacted = {
    kind: "compact" as const,
    version: 1 as const,
    hashes: ["h0"],
    opTraces: [],
    results: ["replayed-result"],
    models: [],
    storeDeltas: [],
    records: [{ fold: "resolved" as const, index: 0, runId: "run-x", hashRef: 0, resultRef: 0 }],
  };
  const fromCompacted = loadPersistedJournal({ journalCompacted: compacted });
  assert.equal(fromCompacted.length, 1);
  assert.equal(fromCompacted[0]?.result, "replayed-result");
  assert.equal(fromCompacted[0]?.hash, "h0");
  assert.equal(fromCompacted[0]?.index, 0);

  const plain = [{ index: 0, runId: "run-x", hash: "h0", result: "plain" }];
  assert.equal(loadPersistedJournal({ journal: plain }), plain, "a plain journal is returned unchanged");
  assert.deepEqual(loadPersistedJournal({}), []);
  // A compacted form wins over a legacy plain array (never both on disk).
  assert.equal(loadPersistedJournal({ journal: plain, journalCompacted: compacted }).length, 1);
});

// ─── default (OFF) path changes nothing ───────────────────────────────────────

test(
  "default (off) path: the persisted journal is the plain array, no journalCompacted, no new keys",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise: origPromise } = manager.startInBackground(fanOutScript);
    await sleep(30);
    for (let i = 0; i < 8; i++) da.resolve(i, "fan-result");
    await sleep(50);
    assert.equal(manager.pause(runId), true);

    const persisted = manager.getPersistence().load(runId);
    assert.ok(persisted, "run must be persisted");
    assert.equal(persisted.journalCompacted, undefined, "compaction is opt-in — off by default");
    assert.equal(persisted.compactJournal, undefined, "the flag is not persisted on default runs");
    assert.ok(Array.isArray(persisted.journal), "the plain journal array is persisted unchanged");
    assert.equal(persisted.journal?.length, 8);
    // Entries carry exactly the pre-compaction surface (no compact markers).
    assert.deepEqual(Object.keys(persisted.journal?.[0] ?? {}).sort(), [
      "hash",
      "index",
      "result",
      "runId",
      "storeCommitSeq",
      "storeDelta",
    ]);

    // Resume, let the live tail call register its deferred slot, then resolve.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await sleep(50);
    for (let i = 8; i < 12; i++) da.resolve(i, "done");
    assert.equal(await waitForStatus(manager, runId, "completed"), "completed");
    da.resolveAll();
    await origPromise.catch(() => {});
  }),
);

// ─── opt-in compaction persists the compacted journal (QA passed) ─────────────

test(
  "opt-in compaction: a resolved fan-out run persists journalCompacted (reconstruction QA passed)",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise: origPromise } = manager.startInBackground(fanOutScript, undefined, {
      compactJournal: true,
    });
    await sleep(30);
    for (let i = 0; i < 8; i++) da.resolve(i, "fan-result");
    await sleep(50);
    // The tail agent is still in-flight; its call has not journaled yet.
    assert.equal(manager.pause(runId), true);
    // The pause write persisted the raw journal synchronously; the compacted
    // form lands from the deferred-compaction task (sync-compaction-at-boundary).
    assert.ok(await waitForCompacted(manager, runId), "deferred compaction landed after pause");

    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.compactJournal, true, "the opt-in flag is persisted for resume");
    assert.ok(persisted?.journalCompacted, "opt-in runs must persist the compacted form");
    assert.equal(persisted?.journal, undefined, "the compacted form REPLACES the plain journal array");
    assert.equal(persisted?.journalCompacted?.kind, "compact");

    // Reconstruction QA held: what's on disk reconstructs to the original
    // journal that was in memory at pause time.
    const original = manager.getRun(runId)?.journal ?? [];
    const reconstructed = reconstructJournal(persisted.journalCompacted);
    assert.equal(JSON.stringify(reconstructed), JSON.stringify(original), "disk form reconstructs byte-identical");
    assert.ok(
      JSON.stringify(persisted.journalCompacted).length < JSON.stringify(original).length,
      "the persisted compacted form must actually be smaller than the original journal",
    );
    // The 8 fan-out members shared one hash, one result, and one (empty) store
    // delta — the tail agent had not journaled yet at pause time.
    assert.equal(persisted.journalCompacted.hashes.length, 1, "one shared fan-out hash");
    assert.equal(persisted.journalCompacted.results.length, 1, "one shared fan-out result");
    assert.equal(persisted.journalCompacted.storeDeltas.length, 1, "one shared (empty) store delta");
    assert.equal(persisted.journalCompacted.records.length, 8);

    // Resume: the compacted journal is reconstructed on load and replays. Let
    // the resumed tail call register, then resolve both the original and the
    // resumed tail calls.
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await sleep(50);
    for (let i = 8; i < 12; i++) da.resolve(i, "tail-result");
    assert.equal(await waitForStatus(manager, runId, "completed"), "completed");
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(
      JSON.stringify(finalRun?.result?.result),
      JSON.stringify({
        results: [
          "fan-result",
          "fan-result",
          "fan-result",
          "fan-result",
          "fan-result",
          "fan-result",
          "fan-result",
          "fan-result",
        ],
        tail: "tail-result",
      }),
      "the replayed fan-out prefix must come from the reconstructed journal, not live runs",
    );
    await origPromise.catch(() => {});
  }),
);

// ─── QA rejection keeps the original journal ──────────────────────────────────

test(
  "a compaction candidate that cannot be persisted (nothing foldable / no shrink) is discarded — the original journal survives",
  withTempCwd(async (cwd) => {
    // Two DISTINCT one-off agents: every hash/result unique, so the summary
    // carries pure table overhead and does not shrink — the persist gate must
    // keep the plain journal instead of persisting a larger "compaction".
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const script = `export const meta = { name: 'compact_nofold', description: 'distinct one-off agents' }
const a = await agent('task one', { label: 'a' })
const b = await agent('task two', { label: 'b' })
return { a, b }`;
    const { runId, promise: origPromise } = manager.startInBackground(script, undefined, { compactJournal: true });
    await sleep(30);
    da.resolve(0, "first-distinct-result-with-a-long-body-to-make-it-real");
    await sleep(40);
    assert.equal(manager.pause(runId), true);

    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.journalCompacted, undefined, "a non-shrinking candidate must not be persisted");
    assert.ok(Array.isArray(persisted?.journal), "the ORIGINAL journal survives on disk");
    assert.equal(persisted?.journal?.length, 1);

    // Let the resumed run register its live call, then sweep every outstanding
    // deferred (original + resumed executions) to unblock completion.
    assert.equal(await manager.resume(runId), true);
    await sleep(50);
    da.resolveAll();
    assert.equal(await waitForStatus(manager, runId, "completed"), "completed");
    await origPromise.catch(() => {});
  }),
);

// ─── resume keeps compacting (flag carried through) ───────────────────────────

test(
  "a resumed compacted run keeps compacting: the flag survives the pause/resume cycle",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise: origPromise } = manager.startInBackground(fanOutScript, undefined, {
      compactJournal: true,
    });
    await sleep(30);
    for (let i = 0; i < 8; i++) da.resolve(i, "fan-result");
    await sleep(50);
    assert.equal(manager.pause(runId), true);
    assert.ok(await waitForCompacted(manager, runId), "deferred compaction landed after the first pause");
    const firstPersist = manager.getPersistence().load(runId);
    assert.ok(firstPersist?.journalCompacted, "first pause persisted the compacted journal");

    assert.equal(await manager.resume(runId), true);
    await sleep(30);
    // While the resumed execution is mid-flight (tail hanging), the persisted
    // journal must STILL be compacted — the flag carried through resume().
    assert.equal(manager.pause(runId), true);
    assert.ok(await waitForCompacted(manager, runId), "deferred compaction landed after the second pause");
    const secondPersist = manager.getPersistence().load(runId);
    assert.equal(secondPersist?.compactJournal, true, "the opt-in flag survived the pause/resume cycle");
    assert.ok(secondPersist?.journalCompacted, "the resumed run keeps compacting");

    // Second resume: let the live tail register, sweep all deferreds, complete.
    assert.equal(await manager.resume(runId), true);
    await sleep(50);
    da.resolveAll();
    assert.equal(await waitForStatus(manager, runId, "completed"), "completed");
    await origPromise.catch(() => {});
  }),
);
