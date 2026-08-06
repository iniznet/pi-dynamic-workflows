/**
 * persistence-fast-path-e2e.test.ts — E2E coverage for the E4 journal-delta
 * fast path (audit finding `fastpath-checkpoint-merge-coverage`).
 *
 * The audit gap (cpu-leak-audit report, §"Not verified"): saveFastPath's
 * checkpoint-fold behavior (journalDeltaCheckpointBytes) and its interaction
 * with load()'s sidecar merge were not exercised against the full-CAS-write
 * reference, nor across repeated folds, nor against a concurrent full writer's
 * fold-and-clear. These probes drive the REAL persistence layer
 * (createRunPersistence + save/load over real temp-dir files, no mocks):
 *
 *   1. Parity: the same logical state sequence driven through saveFastPath
 *      (with a deterministic fold threshold) vs through plain full CAS saves
 *      produces a load() result whose journal is BYTE-IDENTICAL and whose
 *      whole state deep-equals the reference — across three fold cycles and a
 *      final boundary write (persisted primaries agree modulo the volatile
 *      updatedAt stamp; resume replay maps agree).
 *   2. Concurrent-writer merge: a second persistence instance (a resume() /
 *      damage-control / saveCheckpoint-style full writer) folds the pending
 *      sidecar into the primary and clears it; the fast writer's next tick
 *      stays delta-only (its stale folded map must not resurrect cleared
 *      entries), and checkpoints survive.
 *   3. Compacted boundary + fast-path deltas: a boundary write persisted in
 *      compacted-summary form (P2-5) followed by fast-path ticks folds
 *      without losing a single entry (the fold de-compacts to the plain
 *      journal — reconstructible byte-identically, nothing dropped), and an
 *      IMMEDIATE first-tick fold onto a compacted primary replaces the stale
 *      summary so the resume surface (loadPersistedJournal) keeps every
 *      delta (S1's never-both fix, regression-guarded).
 *   4. Zero-delta steady state: a fastPath save with no new content writes
 *      NOTHING (primary and sidecar stay byte-identical — the identity /
 *      content-based detection short-circuit).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactJournal } from "../src/journal-compaction.js";
import {
  buildResumeJournal,
  createRunPersistence,
  JOURNAL_DELTA_SUFFIX,
  loadPersistedJournal,
  type PersistedRunState,
  type RunCheckpoint,
} from "../src/run-persistence.js";
import type { JournalEntry } from "../src/workflow.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-fp-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

const primaryPath = (cwd: string, runId: string) => join(workflowProjectPaths(cwd).runsDir, `${runId}.json`);
const deltaPath = (cwd: string, runId: string) => `${primaryPath(cwd, runId)}${JOURNAL_DELTA_SUFFIX}`;

/** Deterministic journal entry (uniform serialized size across indices). */
function entry(runId: string, index: number): JournalEntry {
  return {
    index,
    runId,
    hash: `h${index}`,
    model: "provider/model",
    result: { reply: `agent ${index} replied`, tokens: { input: 10 * index, output: 5 * index, total: 15 * index } },
    storeDelta: { [`key${index % 2}`]: index },
  };
}

function stateWith(
  runId: string,
  journal: JournalEntry[],
  overrides: Partial<PersistedRunState> = {},
): PersistedRunState {
  return {
    runId,
    workflowName: "wf",
    script: "export const meta = { name: 'w', description: 'w' }",
    status: "running",
    phases: ["plan", "execute"],
    currentPhase: "execute",
    agents: [{ id: 1, label: "a1", prompt: "p1", status: "done", result: { reply: "x" } }],
    logs: ["started", "finished"],
    journal,
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    tokenUsage: { input: 100, output: 50, total: 150 },
    ...overrides,
  };
}

type StableRunState = Omit<PersistedRunState, "updatedAt">;

/** Loaded state with the volatile updatedAt stamp removed (content comparison). */
function stable(s: PersistedRunState | null): StableRunState {
  assert.ok(s, "run must load");
  const copy: StableRunState & { updatedAt?: string } = { ...s };
  delete copy.updatedAt;
  return copy;
}

// ═══════════════════════════════════════════════════════════════════════════

test(
  "fast-path checkpoint folds + load() merge reproduce a full CAS write (journal byte-identical, whole state equal)",
  withTempCwd(async (cwd) => {
    const runId = "parity";
    const refDir = join(cwd, "ref");
    const fastDir = join(cwd, "fast");

    // Threshold midpoint between the LARGEST 4-entry sidecar and the SMALLEST
    // 5-entry sidecar across every fold cycle of this test (indices grow a
    // couple of digits, so a fixed per-entry estimate drifts) — deterministic
    // fold cadence: 4 deltas append, the 5th folds.
    const sidecarBytes = (start: number, n: number) =>
      JSON.stringify(Array.from({ length: n }, (_, i) => entry(runId, start + i))).length;
    const cycles = [5, 10, 15];
    const maxFour = Math.max(...cycles.map((s) => sidecarBytes(s, 4)));
    const minFive = Math.min(...cycles.map((s) => sidecarBytes(s, 5)));
    assert.ok(maxFour < minFive, "entry size grows slower than one entry — the midpoint exists");
    const ref = createRunPersistence(refDir);
    const fast = createRunPersistence(fastDir, undefined, {
      journalDeltaCheckpointBytes: Math.floor((maxFour + minFive) / 2),
    });

    const assertParity = (label: string) => {
      const refState = ref.load(runId);
      const fastState = fast.load(runId);
      assert.ok(refState && fastState, `${label}: both runs load`);
      assert.equal(
        JSON.stringify(fastState.journal),
        JSON.stringify(refState.journal),
        `${label}: merged journal is byte-identical to the full-CAS-write reference`,
      );
      assert.deepEqual(stable(fastState), stable(refState), `${label}: whole state identical (no loss)`);
    };

    // Step 0 — boundary seed: e0..e4 on both writers.
    const journal = Array.from({ length: 5 }, (_, i) => entry(runId, i));
    ref.save(stateWith(runId, journal));
    fast.save(stateWith(runId, journal));
    assertParity("seed");

    // Steps 1-4 — fast ticks e5..e8: sidecar appends (4 entries ≤ threshold).
    for (let i = 5; i <= 8; i++) {
      journal.push(entry(runId, i));
      ref.save(stateWith(runId, journal));
      fast.save(stateWith(runId, journal), { fastPath: true });
    }
    assert.ok(existsSync(deltaPath(fastDir, runId)), "the 4-entry sidecar stays below the threshold");
    assertParity("sidecar pending (load() merges)");

    // Step 5 — e9 pushes the sidecar past the threshold → checkpoint fold.
    // A checkpoint rides the fold (the manager's checkpoints land on disk via
    // their own CAS write; here both writers carry the same checkpoint state).
    const c1: RunCheckpoint = { runId, taskId: "c1", status: "active", timestamp: "2024-01-01T00:05:00.000Z" };
    journal.push(entry(runId, 9));
    ref.save(stateWith(runId, journal, { checkpoints: [c1] }));
    fast.save(stateWith(runId, journal, { checkpoints: [c1] }), { fastPath: true });
    assert.equal(existsSync(deltaPath(fastDir, runId)), false, "first fold: sidecar cleared");
    assert.equal(
      (JSON.parse(readFileSync(primaryPath(fastDir, runId), "utf-8")) as { journal?: unknown[] }).journal?.length,
      10,
      "first fold wrote the full journal to the primary",
    );
    assertParity("after first fold");

    // Steps 6-10 — e10..e14: second fold cycle, c2 rides it.
    for (let i = 10; i <= 13; i++) {
      journal.push(entry(runId, i));
      ref.save(stateWith(runId, journal));
      fast.save(stateWith(runId, journal), { fastPath: true });
    }
    const c2: RunCheckpoint = { runId, taskId: "c2", status: "active", timestamp: "2024-01-01T00:10:00.000Z" };
    journal.push(entry(runId, 14));
    ref.save(stateWith(runId, journal, { checkpoints: [c1, c2] }));
    fast.save(stateWith(runId, journal, { checkpoints: [c1, c2] }), { fastPath: true });
    assert.equal(existsSync(deltaPath(fastDir, runId)), false, "second fold: sidecar cleared");
    assertParity("after second fold");

    // Steps 11-14 — e15..e18: pending sidecar again (below threshold).
    for (let i = 15; i <= 18; i++) {
      journal.push(entry(runId, i));
      ref.save(stateWith(runId, journal));
      fast.save(stateWith(runId, journal), { fastPath: true });
    }
    assert.ok(existsSync(deltaPath(fastDir, runId)), "final sidecar pending below the threshold");
    assertParity("final pending sidecar");

    // Final boundary — paused: folds the pending sidecar, keeps checkpoints.
    ref.save(stateWith(runId, journal, { status: "paused", checkpoints: [c1, c2], result: { done: true } }));
    fast.save(stateWith(runId, journal, { status: "paused", checkpoints: [c1, c2], result: { done: true } }));
    assert.equal(existsSync(deltaPath(fastDir, runId)), false, "boundary write folded the pending sidecar");
    assertParity("final paused boundary");

    // Strongest claim: the PERSISTED primaries agree modulo the volatile
    // updatedAt stamp (both went through the same casWrite produce shape).
    const readStripped = (file: string) => {
      const state = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      delete state.updatedAt;
      return state;
    };
    assert.deepEqual(
      readStripped(primaryPath(fastDir, runId)),
      readStripped(primaryPath(refDir, runId)),
      "persisted primaries identical modulo updatedAt",
    );

    // Resume parity: the replay map the resume path builds is the same.
    const refResume = buildResumeJournal(runId, ref.load(runId)?.journal);
    const fastResume = buildResumeJournal(runId, fast.load(runId)?.journal);
    assert.equal(fastResume.size, refResume.size, "same replay key count");
    for (const [key, value] of refResume) {
      assert.deepEqual(fastResume.get(key), value, `replay entry ${key} identical`);
    }
  }),
);

test(
  "a concurrent full writer's fold-and-clear is honored — the fast writer's next delta stays delta-only",
  withTempCwd(async (cwd) => {
    const runId = "concurrent";
    const dir = join(cwd, "runs");
    // Huge threshold: the fast writer appends to the sidecar without folding
    // on its own — only the concurrent full writer can fold here.
    const writer = createRunPersistence(dir, undefined, { journalDeltaCheckpointBytes: 1024 * 1024 });
    const other = createRunPersistence(dir); // cold second instance (resume/damage-control process)

    writer.save(stateWith(runId, [entry(runId, 0), entry(runId, 1), entry(runId, 2)]));
    // Fast tick adds e3 → sidecar [e3] only.
    writer.save(stateWith(runId, [entry(runId, 0), entry(runId, 1), entry(runId, 2), entry(runId, 3)]), {
      fastPath: true,
    });
    assert.ok(existsSync(deltaPath(dir, runId)), "sidecar pending before the concurrent write");

    // The concurrent full writer (a separate persistence instance) saves its
    // own snapshot + a checkpoint: casWrite folds the sidecar into the primary
    // and clears it.
    const ck: RunCheckpoint = { runId, taskId: "t1", status: "active", timestamp: "2024-01-01T00:10:00.000Z" };
    other.save(
      stateWith(runId, [entry(runId, 0), entry(runId, 1), entry(runId, 2), entry(runId, 3)], {
        status: "paused",
        checkpoints: [ck],
      }),
    );
    assert.equal(existsSync(deltaPath(dir, runId)), false, "the concurrent full write folded and cleared the sidecar");
    const afterOther = other.load(runId);
    assert.equal(afterOther?.journal?.length, 4, "the concurrent write folded the deltas into the primary");
    assert.deepEqual(afterOther?.checkpoints, [ck], "the checkpoint landed");

    // The fast writer keeps going: e4 must be the ONLY new delta — its stale
    // folded map must NOT resurrect e0..e3 into the sidecar.
    writer.save(
      stateWith(runId, [entry(runId, 0), entry(runId, 1), entry(runId, 2), entry(runId, 3), entry(runId, 4)]),
      {
        fastPath: true,
      },
    );
    const sidecar = JSON.parse(readFileSync(deltaPath(dir, runId), "utf-8")) as Array<{ index: number }>;
    assert.deepEqual(
      sidecar.map((e) => e.index),
      [4],
      "only the new entry is delta'd — cleared entries are not resurrected",
    );

    const merged = writer.load(runId);
    assert.equal(merged?.journal?.length, 5, "fast load() merges primary + new delta");
    assert.deepEqual(merged?.checkpoints, [ck], "the concurrent checkpoint survives the fast writer's tick");

    // A cold reader (crash-restart) sees the same merged view.
    const cold = createRunPersistence(dir).load(runId);
    assert.equal(cold?.journal?.length, 5, "cold instance merges primary + sidecar");
    assert.deepEqual(cold?.checkpoints, [ck], "cold instance keeps the checkpoint");
  }),
);

test(
  "a compacted boundary + fast-path deltas fold with no loss (the fold de-compacts to the plain journal)",
  withTempCwd(async (cwd) => {
    const runId = "compact";
    const dir = join(cwd, "runs");
    // Threshold between "3 sidecar entries append" and "4 fold" — so the
    // first fast tick writes a real sidecar and the SECOND tick folds with
    // that sidecar on disk (the realistic accumulation flow; load() merges
    // the sidecar onto the compacted primary and clears the summary before
    // the fold lands).
    const sidecarBytes = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => entry(runId, i))).length;
    const rp = createRunPersistence(dir, undefined, { journalDeltaCheckpointBytes: sidecarBytes(3) + 1 });

    // Boundary write in COMPACTED form (P2-5 opt-in) covering e0..e2.
    const orig = [entry(runId, 0), entry(runId, 1), entry(runId, 2)];
    rp.save(stateWith(runId, [], { journalCompacted: compactJournal(orig) }));
    const compacted = rp.load(runId);
    assert.equal(compacted?.journalCompacted?.records.length, 3, "the compacted form loads back compacted");
    assert.deepEqual(
      loadPersistedJournal(compacted).map((e) => e.index),
      [0, 1, 2],
      "reconstruction reproduces the original entries",
    );

    // Fast tick 1: the manager passes the RAW journal on throttled ticks.
    // The instance's folded map is empty (a compacted primary has no plain
    // journal), so the whole journal is delta'd — but 3 entries stay under
    // the threshold and land in the sidecar.
    rp.save(stateWith(runId, [entry(runId, 0), entry(runId, 1), entry(runId, 2)]), { fastPath: true });
    assert.ok(existsSync(deltaPath(dir, runId)), "first fast tick appended the sidecar (no fold yet)");

    // Fast tick 2: e3 pushes the sidecar past the threshold → checkpoint
    // fold, with the sidecar present on disk — load()'s merge clears the
    // compacted summary before the fold, so the persisted form stays
    // single-form (never both) and every entry survives.
    rp.save(stateWith(runId, [entry(runId, 0), entry(runId, 1), entry(runId, 2), entry(runId, 3)]), { fastPath: true });

    const loaded = rp.load(runId);
    assert.equal(loaded?.journalCompacted, undefined, "the fold de-compacts to the plain journal (never both)");
    assert.deepEqual(
      loaded?.journal?.map((e) => e.index),
      [0, 1, 2, 3],
      "no entry is lost across compacted boundary → fast delta → fold",
    );
    assert.equal(existsSync(deltaPath(dir, runId)), false, "the sidecar was folded into the primary");

    // Resume parity: the reconstructed journal replays identically.
    const resume = buildResumeJournal(runId, loaded?.journal);
    assert.equal(resume.size, 4, "all four entries are replayable");
    assert.deepEqual(resume.get(`${runId}:3`)?.result, entry(runId, 3).result, "the delta entry replays");
  }),
);

test(
  "an immediate fold onto a compacted primary clears the stale summary — the resume surface keeps every delta (no loss)",
  withTempCwd(async (cwd) => {
    const runId = "compact-immediate";
    const dir = join(cwd, "runs");
    // Threshold below a 4-entry sidecar: the FIRST fast tick folds with NO
    // sidecar on disk yet (the instance's folded map is empty after a
    // compacted boundary, so the whole journal is delta'd and the fold fires
    // before any sidecar write). The fold must REPLACE the stale compacted
    // summary with the plain journal — never persist both, and never let
    // loadPersistedJournal's compaction preference shadow the delta entries.
    const sidecarBytes = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => entry(runId, i))).length;
    const rp = createRunPersistence(dir, undefined, { journalDeltaCheckpointBytes: sidecarBytes(3) + 1 });

    rp.save(
      stateWith(runId, [], { journalCompacted: compactJournal([entry(runId, 0), entry(runId, 1), entry(runId, 2)]) }),
    );
    rp.save(stateWith(runId, [entry(runId, 0), entry(runId, 1), entry(runId, 2), entry(runId, 3)]), { fastPath: true });

    const loaded = rp.load(runId);
    assert.equal(loaded?.journalCompacted, undefined, "the fold replaced the stale summary (never both)");
    assert.deepEqual(
      loaded?.journal?.map((e) => e.index),
      [0, 1, 2, 3],
      "the folded primary holds every entry",
    );
    assert.equal(existsSync(deltaPath(dir, runId)), false, "the sidecar was folded into the primary");
    assert.deepEqual(
      loadPersistedJournal(loaded).map((e) => e.index),
      [0, 1, 2, 3],
      "the resume surface (loadPersistedJournal) keeps the delta — no loss",
    );
  }),
);

test(
  "a zero-delta fastPath save writes nothing (identity short-circuit keeps primary and sidecar byte-identical)",
  withTempCwd(async (cwd) => {
    const runId = "steady";
    const dir = join(cwd, "runs");
    const rp = createRunPersistence(dir, undefined, { journalDeltaCheckpointBytes: 1024 * 1024 });
    const base = [entry(runId, 0), entry(runId, 1)];

    rp.save(stateWith(runId, base));
    rp.save(stateWith(runId, [...base, entry(runId, 2)]), { fastPath: true }); // sidecar [e2]

    const primary = primaryPath(dir, runId);
    const delta = deltaPath(dir, runId);
    const primaryBefore = readFileSync(primary, "utf-8");
    const deltaBefore = readFileSync(delta, "utf-8");
    const mtimeBefore = statSync(primary).mtimeMs;

    // Same content as the previous tick (fresh objects, no new entries):
    // content-based detection short-circuits → zero delta → no disk write.
    rp.save(stateWith(runId, [...base, entry(runId, 2)]), { fastPath: true });

    assert.equal(readFileSync(primary, "utf-8"), primaryBefore, "primary untouched");
    assert.equal(readFileSync(delta, "utf-8"), deltaBefore, "sidecar untouched");
    assert.equal(statSync(primary).mtimeMs, mtimeBefore, "primary mtime unchanged (no rewrite)");
    const loaded = rp.load(runId);
    assert.equal(loaded?.journal?.length, 3, "load() still sees the full journal");
  }),
);
