/**
 * S1-persistence-core regression tests (cpu-leak audit findings owned by this
 * slice):
 *
 *  1. fast-path-dead — the manager's throttled progress write routes to the
 *     E4 `.jdelta` sidecar (primary untouched); a boundary write folds it.
 *  2. journal-budget-stringify — capJournalBudget is skipped on throttled
 *     progress writes (fastPath checkBudget:false) but enforced (binary-search
 *     truncation) on lifecycle/terminal writes; the 10_000-entry count gate
 *     stays intact.
 *  3. snapshot-retention-boundary-serialize — foldedByRun is emptied on
 *     delete, so a reused runId re-deltas from scratch (behavioral proof).
 *  4. panel-render-storm (list-cache part) — the 300ms list cache stays warm
 *     across same-status progress folds and is invalidated on a terminal
 *     status transition.
 *  5. sync-compaction-at-boundary — a non-terminal settle (pause) persists the
 *     RAW journal synchronously and runs compactJournal + verifyJournal-
 *     Compaction in a queued async task; a resume that supersedes the run
 *     invalidates the stale task; the terminal settle still folds
 *     synchronously (QA preserved).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage, WorkflowAgent } from "../../../src/agent.js";
import { WorkflowError } from "../../../src/errors.js";
import {
  createRunPersistence,
  JOURNAL_BYTE_CHECK_THRESHOLD,
  JOURNAL_DELTA_SUFFIX,
  loadPersistedJournal,
  type PersistedRunState,
} from "../../../src/run-persistence.js";
import { WorkflowManager } from "../../../src/workflow-manager.js";
import { workflowProjectPaths } from "../../../src/workflow-paths.js";
import { withFakeHomeAsync } from "../../helpers/fake-home.js";
import { rmForce } from "../../helpers/rm-force.js";

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
    await sleep(25);
  }
  return current;
}

/** Poll until the deferred-compaction task has landed journalCompacted on disk. */
async function waitForJournalCompacted(manager: WorkflowManager, runId: string, deadlineMs = 2000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (manager.getPersistence().load(runId)?.journalCompacted) return;
    await sleep(25);
  }
  assert.fail("the deferred compaction task never landed the compacted form");
}

/** Run each test with isolated cwd and HOME so workflow state is isolated. */
function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-s1-"));
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

// ─── persistence-layer state helpers ─────────────────────────────────────────

function stateWith(
  runId: string,
  journal: Array<{ index: number; runId?: string; hash: string; result: unknown }>,
  overrides: Partial<PersistedRunState> = {},
): PersistedRunState {
  return {
    runId,
    workflowName: "wf",
    script: "export const meta = { name: 'w', description: 'w' }",
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    journal,
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const entry = (runId: string, index: number, result: unknown = `r${index}`) => ({
  index,
  runId,
  hash: `h${index}`,
  result,
});

const deltaPath = (cwd: string, runId: string) =>
  join(workflowProjectPaths(cwd).runsDir, `${runId}.json${JOURNAL_DELTA_SUFFIX}`);

// ═══════════════════════════════════════════════════════════════════════════
// 1. fast-path-dead — the wiring is TRULY reachable end-to-end
// ═══════════════════════════════════════════════════════════════════════════

test(
  "manager throttled progress writes route to the .jdelta sidecar (primary untouched); a boundary write folds it",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const script = `export const meta = { name: 's1_fastpath', description: 'three sequential agents — the tail keeps the run running while deltas append' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
const c = await agent('tail', { label: 'c' })
return { a, b, c }`;
    const { runId, promise } = manager.startInBackground(script);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    try {
      // Wait for the run to actually reach the first agent() before resolving
      // it — a fixed sleep races under parallel test load (a resolve on a
      // not-yet-called agent is a no-op, leaving agent 0 hanging forever).
      const deadline = Date.now() + 5000;
      while ((manager.getRun(runId)?.snapshot.agents.length ?? 0) < 1) {
        if (Date.now() > deadline) assert.fail("the run never reached the first agent()");
        await sleep(10);
      }
      // Complete agent 1 → onAgentJournal → schedulePersist (400ms trailing).
      da.resolve(0, "first-done");
      await sleep(600); // past the trailing throttle: the fast-path write lands

      const primary1 = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf-8")) as PersistedRunState;
      assert.equal(primary1.status, "running");
      assert.equal(primary1.journal?.length ?? 0, 0, "the primary still holds the start snapshot — no full rewrite");
      const sidecar1 = JSON.parse(readFileSync(deltaPath(cwd, runId), "utf-8")) as Array<{ index: number }>;
      assert.deepEqual(
        sidecar1.map((e) => e.index),
        [0],
        "the journaled entry went to the append-only .jdelta sidecar, not the primary",
      );

      // Complete agent 2 — the run is STILL running (the tail agent hangs), so
      // the next throttled tick appends its delta instead of a terminal fold.
      da.resolve(1, "second-done");
      await sleep(600);
      const sidecar2 = JSON.parse(readFileSync(deltaPath(cwd, runId), "utf-8")) as Array<{ index: number }>;
      assert.deepEqual(
        sidecar2.map((e) => e.index),
        [0, 1],
        "the second delta was appended; nothing was re-written to the primary",
      );
      const primary2 = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf-8")) as PersistedRunState;
      assert.equal(
        primary2.journal?.length ?? 0,
        0,
        "the primary is STILL the start snapshot after two progress ticks",
      );

      // A boundary write (pause) folds the sidecar into the primary and clears it.
      assert.equal(manager.pause(runId), true);
      const loaded = manager.getPersistence().load(runId);
      assert.equal(loaded?.status, "paused");
      assert.deepEqual(
        loaded?.journal?.map((e) => e.index),
        [0, 1],
        "the boundary write folds the sidecar deltas into the primary journal",
      );
      assert.equal(existsSync(deltaPath(cwd, runId)), false, "the sidecar is cleared by the fold");

      // Resume reads the same journal a full-CAS run would have persisted.
      assert.equal(await manager.resume(runId), true);
      await sleep(80);
      da.resolveAll();
      assert.equal(await waitForStatus(manager, runId, "completed"), "completed");
    } finally {
      // Always settle the run so an assertion failure above cannot leave a live
      // lease heartbeat keeping the test runner from exiting (file-level hang).
      da.resolveAll();
      await promise.catch(() => {});
    }
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. journal-budget-stringify — budget skipped on progress, enforced on lifecycle
// ═══════════════════════════════════════════════════════════════════════════

test(
  "the journal byte budget is skipped on throttled progress folds but enforced on lifecycle writes (count gate intact)",
  withTempCwd(async (cwd) => {
    // Each part uses its OWN runId: the persistence CAS-merges onto whatever
    // is already on disk for a runId, so sharing one would pile entries up
    // across parts and break the per-part counts.
    const runIdFast = "s1-budget-fast";
    const runIdLife = "s1-budget-life";
    const runIdGate = "s1-budget-gate";
    // > JOURNAL_BYTE_CHECK_THRESHOLD entries whose serialized size exceeds the
    // 32MB DEFAULT_JOURNAL_BYTE_BUDGET: the ONLY way capJournalBudget's
    // truncation can fire.
    const bigJournal = Array.from({ length: JOURNAL_BYTE_CHECK_THRESHOLD + 1 }, (_, i) =>
      entry(runIdFast, i, "x".repeat(3800)),
    );
    assert.ok(
      JSON.stringify(bigJournal).length > 32 * 1024 * 1024,
      "fixture must actually exceed the byte budget so the truncation can fire",
    );

    // (a) Throttled path: fastPath + checkBudget:false → the fold keeps EVERY entry.
    const rpFast = createRunPersistence(cwd, undefined, { journalDeltaCheckpointBytes: 1 });
    rpFast.save(stateWith(runIdFast, [entry(runIdFast, 0)])); // boundary seed (tiny primary)
    rpFast.save(stateWith(runIdFast, bigJournal), { fastPath: true, checkBudget: false }); // immediate fold
    const fastFolded = rpFast.load(runIdFast);
    assert.equal(
      fastFolded?.journal?.length,
      bigJournal.length,
      "the throttled fold skipped the budget check — every entry persisted",
    );

    // (b) Lifecycle path: a boundary write of the SAME journal enforces the budget.
    const rpLife = createRunPersistence(cwd);
    rpLife.save(stateWith(runIdLife, [entry(runIdLife, 0)]));
    rpLife.save({
      ...stateWith(
        runIdLife,
        bigJournal.map((e) => ({ ...e, runId: runIdLife })),
      ),
      status: "paused",
    });
    const capped = rpLife.load(runIdLife);
    assert.ok(
      capped?.journal && capped.journal.length < bigJournal.length,
      `the lifecycle write enforced the budget (truncated ${bigJournal.length} → ${capped?.journal?.length} entries)`,
    );
    assert.ok(
      JSON.stringify(capped?.journal).length <= 32 * 1024 * 1024,
      "the capped journal actually fits the byte budget",
    );

    // (c) The count gate is intact: exactly-threshold journals skip the byte check.
    const atThreshold = Array.from({ length: JOURNAL_BYTE_CHECK_THRESHOLD }, (_, i) =>
      entry(runIdGate, 10_000 + i, "tiny"),
    );
    const rpGate = createRunPersistence(cwd);
    rpGate.save({ ...stateWith(runIdGate, atThreshold), status: "paused" });
    assert.equal(
      rpGate.load(runIdGate)?.journal?.length,
      JOURNAL_BYTE_CHECK_THRESHOLD,
      "gate: 10_000 entries pass through",
    );
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. snapshot-retention-boundary-serialize — foldedByRun emptied on delete
// ═══════════════════════════════════════════════════════════════════════════

test(
  "foldedByRun is emptied on delete: a reused runId re-deltas from scratch instead of trusting the stale map",
  withTempCwd(async (cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "s1-delete-reuse";

    rp.save(stateWith(runId, [entry(runId, 0)])); // boundary
    rp.save(stateWith(runId, [entry(runId, 0), entry(runId, 1)]), { fastPath: true }); // sidecar [e1]
    assert.ok(existsSync(deltaPath(cwd, runId)), "sidecar exists before delete");
    assert.equal(rp.delete(runId), true, "delete removes the run");
    assert.equal(existsSync(deltaPath(cwd, runId)), false, "sidecar removed by delete");

    // Recreate the SAME runId from scratch. If foldedByRun survived the delete,
    // the fast path would believe e0/e1 are already on disk, write NO delta, and
    // load() would miss e1 — the behavioral proof the map was emptied.
    rp.save(stateWith(runId, [entry(runId, 0)]));
    rp.save(stateWith(runId, [entry(runId, 0), entry(runId, 1)]), { fastPath: true });
    const loaded = rp.load(runId);
    assert.deepEqual(
      loaded?.journal?.map((e) => e.index),
      [0, 1],
      "the reused runId re-deltas from scratch — foldedByRun was emptied on delete",
    );
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. panel-render-storm (list-cache part) — warm across progress, invalidated
//    on terminal transition
// ═══════════════════════════════════════════════════════════════════════════

test(
  "list() cache stays warm across same-status progress folds and is invalidated on a terminal status transition",
  withTempCwd(async (cwd) => {
    let readdirCalls = 0;
    const rp = createRunPersistence(
      cwd,
      {
        readdirSync: ((...args: Parameters<typeof readdirSync>) => {
          readdirCalls++;
          return readdirSync(...args);
        }) as typeof readdirSync,
      },
      { journalDeltaCheckpointBytes: 1 }, // every fastPath tick folds via casWrite
    );
    const runId = "s1-warm-cache";

    rp.save(stateWith(runId, [entry(runId, 0)])); // boundary seed (running)
    readdirCalls = 0;
    const first = rp.list();
    assert.equal(first.length, 1);
    assert.equal(readdirCalls, 1, "the first (cold) list() scans the runs directory");

    // Progress fold: a fastPath tick folds running→running via casWrite — this
    // must NOT invalidate the cache, so the next list() (within the 300ms TTL)
    // serves the cached array without re-walking the directory.
    rp.save(stateWith(runId, [entry(runId, 0), entry(runId, 1)]), { fastPath: true, checkBudget: false });
    const warm = rp.list();
    assert.equal(warm.length, 1, "the warm cache still serves the run");
    assert.equal(readdirCalls, 1, "a same-status progress fold did NOT invalidate the cache (TTL stays warm)");

    // Terminal transition: running→completed must invalidate so the very next
    // list() reflects the new status instead of serving the warm snapshot.
    rp.save({ ...stateWith(runId, [entry(runId, 0), entry(runId, 1)]), status: "completed" });
    const after = rp.list();
    assert.equal(after[0]?.status, "completed", "the terminal write invalidated the cache — fresh status visible");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. sync-compaction-at-boundary — raw-first pause write, queued async fold
// ═══════════════════════════════════════════════════════════════════════════

test(
  "a pause with compactJournal:true persists the RAW journal synchronously; the compacted form lands via the queued async task",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(fanOutScript, undefined, { compactJournal: true });
    await sleep(30);
    for (let i = 0; i < 8; i++) da.resolve(i, "fan-result");
    await sleep(50);
    assert.equal(manager.pause(runId), true);

    // Synchronously after pause(): the RAW journal is what's on disk — the
    // fold (several full-journal stringifies) has been moved off the critical
    // path, so pause() returns without running it.
    const raw = manager.getPersistence().load(runId);
    assert.equal(raw?.status, "paused");
    assert.ok(Array.isArray(raw?.journal), "the raw journal is persisted first");
    assert.equal(raw?.journal?.length, 8);
    assert.equal(raw?.journalCompacted, undefined, "the compacted form is NOT yet on disk at pause time");

    // The queued setImmediate task then folds + QA + re-persists.
    await waitForJournalCompacted(manager, runId);
    const compacted = manager.getPersistence().load(runId);
    assert.ok(compacted?.journalCompacted, "the queued async task landed the compacted form");
    assert.equal(compacted?.journal, undefined, "the compacted form replaces the plain journal");
    assert.equal(
      JSON.stringify(loadPersistedJournal(compacted)),
      JSON.stringify(raw?.journal),
      "reconstruction QA still holds: the compacted form reconstructs byte-identically",
    );

    da.resolveAll();
    await promise.catch(() => {});
  }),
);

test(
  "a resume that supersedes the paused run invalidates the stale deferred compaction task (no stale 'paused' write)",
  withTempCwd(async (cwd) => {
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(fanOutScript, undefined, { compactJournal: true });
    await sleep(30);
    for (let i = 0; i < 8; i++) da.resolve(i, "fan-result");
    await sleep(50);
    assert.equal(manager.pause(runId), true);
    // The pause's deferred compaction task is queued but has NOT fired yet.
    assert.equal(rawJournalOnDisk(manager, runId), true);

    // Resume runs synchronously past the queued task: it replaces the ManagedRun
    // object, so when the stale task fires it must skip (identity check) and the
    // resumed run's own writes own the disk.
    assert.equal(await manager.resume(runId), true);
    await sleep(150); // let the stale task fire + the resumed execution start

    const persisted = manager.getPersistence().load(runId);
    assert.equal(persisted?.status, "running", "the stale paused-compaction never clobbered the resumed run");
    assert.equal(loadPersistedJournal(persisted).length, 8, "the resumed run kept the full journal");

    await sleep(50);
    da.resolveAll();
    assert.equal(await waitForStatus(manager, runId, "completed"), "completed");
    await promise.catch(() => {});
  }),
);

function rawJournalOnDisk(manager: WorkflowManager, runId: string): boolean {
  const p = manager.getPersistence().load(runId);
  return Array.isArray(p?.journal) && p?.journalCompacted === undefined;
}

test(
  "a terminal (failed) settle still folds synchronously: journalCompacted lands the moment failure settles (QA preserved)",
  withTempCwd(async (cwd) => {
    // 8 identical fan-out agents (foldable shape — same content, shrinks to
    // one interned entry) then a tail call that trips the run's token budget:
    // budget 80 = exactly the 8 fan-out spends of 10, so the 9th (tail) call
    // throws TOKEN_BUDGET_EXHAUSTED — a genuine terminal "failed" settle with
    // a compactable journal.
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 10 }), defaultTokenBudget: 80 });
    manager.on("error", () => {});
    await assert.rejects(
      manager.runSync(fanOutScript, undefined, { compactJournal: true }),
      (err: unknown) => err instanceof WorkflowError,
    );

    const run = manager.listRuns()[0];
    assert.equal(run?.status, "failed");
    // The terminal settle write ran compactJournal + verifyJournalCompaction
    // synchronously (no queued task for the final word), so the compacted form
    // is on disk the moment the failure is observable.
    const persisted = manager.getPersistence().load(run.runId);
    assert.equal(persisted?.status, "failed");
    assert.ok(persisted?.journalCompacted, "the failed settle folded synchronously (compacted form on disk)");
    assert.equal(persisted?.journal, undefined, "the compacted form replaces the plain journal");
    assert.equal(
      loadPersistedJournal(persisted).length,
      8,
      "the 8 fan-out results survive the compacted fold (reconstruction QA held)",
    );
  }),
);

function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  } as unknown as Pick<WorkflowAgent, "run">;
}
