/**
 * P2-5 — Resume-journal compaction + reconstruction QA (engine + gate).
 *
 * Covers the task's core requirements:
 *   1. a resolved multi-call run compacts then reconstructs byte-identical
 *      to the original,
 *   2. a deliberately broken compaction candidate is rejected by the QA gate
 *      (the original journal survives — the caller keeps it),
 *   3. the fold decision is driven by the operations[] traces (P1-1).
 *
 * The manager's persist wiring (opt-in flag, journalCompacted on disk, resume
 * reconstruction) lives in tests/journal-compaction-persist.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OperationTrace } from "../src/agent.js";
import {
  compactJournal,
  isResolvedEntry,
  reconstructJournal,
  verifyJournalCompaction,
} from "../src/journal-compaction.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

/**
 * Build a journal entry in the SAME canonical key order workflow.ts uses when
 * journaling (`index, runId, hash, result, storeDelta, operations`) — the
 * byte-identical diff is serialization-order-sensitive, so fixtures must be
 * canonical (as real journals are). `runId: null` omits the field entirely
 * (legacy entry); `runId` absent defaults to the top-level frame "run-1".
 */
function entry(
  index: number,
  fields: {
    runId?: string | null;
    hash?: string;
    result: unknown;
    storeDelta?: Record<string, unknown>;
    operations?: OperationTrace[];
  } = { result: undefined },
): JournalEntry {
  const runId = fields.runId === undefined ? "run-1" : fields.runId; // null → legacy (no runId)
  return {
    index,
    ...(runId !== null ? { runId } : {}),
    hash: fields.hash ?? `h-${index}`,
    result: fields.result,
    ...(fields.storeDelta !== undefined ? { storeDelta: fields.storeDelta } : {}),
    ...(fields.operations !== undefined ? { operations: fields.operations } : {}),
  };
}

/** A resolved fan-out journal: two JSON-identical agents + one legacy + one repaired. */
function mixedJournal(): JournalEntry[] {
  const sharedResult = { verdict: "ok", detail: "shared fan-out output" };
  const sharedDelta = { step: 1 };
  const sharedOps: OperationTrace[] = [{ line: 2, op: "read", outcome: "ok" }];
  return [
    // Resolved fan-out twin 1.
    entry(0, { result: { ...sharedResult }, storeDelta: { ...sharedDelta }, operations: [...sharedOps] }),
    // Resolved fan-out twin 2 — JSON-identical but structurally distinct objects.
    entry(1, { result: { ...sharedResult }, storeDelta: { ...sharedDelta }, operations: [...sharedOps] }),
    // Legacy-style resolved entry: no runId, no storeDelta, no operations.
    entry(2, { runId: null, result: "legacy-output" }),
    // Tool-error repair: carries an error trace → kept verbatim, never interned.
    entry(3, {
      result: "repaired-output",
      operations: [
        { line: 4, op: "edit", outcome: "error: EACCES" },
        { line: 4, op: "read", outcome: "ok" },
      ],
    }),
    // Nested frame with a positional index-0 collision vs the parent's entry 0.
    entry(0, { runId: "run-1-nested1", result: "nested-output" }),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — resolved multi-call runs compact and reconstruct byte-identical
// ═══════════════════════════════════════════════════════════════════════════

test("a resolved multi-call journal compacts then reconstructs byte-identical to the original", () => {
  const journal = mixedJournal();
  const summary = compactJournal(journal);

  // The fold actually happened: JSON-equal hashes/results/deltas/traces intern
  // into single table slots (4 resolved entries share, 1 verbatim does not).
  assert.equal(summary.kind, "compact");
  assert.equal(summary.version, 1);
  assert.equal(summary.hashes.length, 3, "entries 0 and 4 share the same default hash (h-0) — one slot");
  assert.equal(
    summary.results.length,
    3,
    "shared fan-out + legacy + nested (the verbatim entry's result stays inside its record)",
  );
  assert.equal(summary.storeDeltas.length, 1, "both fan-out twins share one delta slot");
  assert.equal(
    summary.opTraces.length,
    1,
    "the shared ok-trace is interned; the verbatim entry's repair trace stays inside its record",
  );
  assert.equal(summary.records.length, journal.length, "no entry is dropped");

  // Reconstruction QA passes: byte-identical.
  const qa = verifyJournalCompaction(summary, journal);
  assert.deepEqual(qa, { ok: true }, `gate must accept the lossless summary: ${qa.reason ?? ""}`);
  const reconstructed = reconstructJournal(summary);
  assert.equal(JSON.stringify(reconstructed), JSON.stringify(journal), "must be byte-identical");
  assert.deepEqual(reconstructed, journal, "must be structurally identical too");
});

test("reconstruction preserves each entry's exact optional-field presence and canonical key order", () => {
  const journal = mixedJournal();
  const reconstructed = reconstructJournal(compactJournal(journal));

  // Resolved fan-out twin: every canonical key, in workflow.ts construction order.
  assert.deepEqual(Object.keys(reconstructed[0]), ["index", "runId", "hash", "result", "storeDelta", "operations"]);
  assert.deepEqual(reconstructed[0]?.storeDelta, { step: 1 });
  assert.deepEqual(reconstructed[0]?.operations, [{ line: 2, op: "read", outcome: "ok" }]);

  // Legacy entry: no runId/storeDelta/operations keys at all.
  const legacy = reconstructed[2];
  assert.deepEqual(Object.keys(legacy), ["index", "hash", "result"]);
  assert.equal(legacy?.runId, undefined);
  assert.equal(legacy?.storeDelta, undefined);
  assert.equal(legacy?.operations, undefined);

  // Verbatim entry keeps its exact repair trace.
  assert.deepEqual(reconstructed[3]?.operations, [
    { line: 4, op: "edit", outcome: "error: EACCES" },
    { line: 4, op: "read", outcome: "ok" },
  ]);

  // Positional deltaKey surface is untouched: (runId, index) pairs survive intact.
  assert.equal(reconstructed[4]?.runId, "run-1-nested1");
  assert.equal(reconstructed[4]?.index, 0);
  assert.equal(reconstructed[0]?.index, 0);
});

test("fan-out journals actually shrink (the summary is smaller than the original)", () => {
  const result = { verdict: "ok", body: "the same answer every fan-out member produced" };
  const journal = Array.from({ length: 10 }, (_, i) =>
    entry(i, { result: { ...result }, storeDelta: { step: i }, operations: [{ line: 2, op: "read", outcome: "ok" }] }),
  );
  const summary = compactJournal(journal);
  assert.equal(summary.results.length, 1, "all 10 JSON-identical results intern to one slot");
  assert.ok(
    JSON.stringify(summary).length < JSON.stringify(journal).length,
    "a foldable fan-out must persist smaller than the original journal",
  );
  assert.equal(verifyJournalCompaction(summary, journal).ok, true);
});

test("empty journals and single resolved entries round-trip (the gate may reject persisting the larger form)", () => {
  assert.equal(verifyJournalCompaction(compactJournal([]), []).ok, true);
  const single = [entry(0, { result: "only" })];
  const summary = compactJournal(single);
  assert.equal(verifyJournalCompaction(summary, single).ok, true, "round-trip itself is exact");
  assert.ok(
    JSON.stringify(summary).length > JSON.stringify(single).length,
    "a single entry's summary carries table overhead — expected larger",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — a deliberately broken compaction candidate is rejected (original survives)
// ═══════════════════════════════════════════════════════════════════════════

test("the QA gate rejects a candidate whose hash reference is corrupted", () => {
  const journal = mixedJournal();
  const broken = compactJournal(journal);
  // Deliberately corrupt the interned hash reference of the first record.
  (broken.records[0] as { hashRef: number }).hashRef = 999;
  const qa = verifyJournalCompaction(broken, journal);
  assert.equal(qa.ok, false, "a corrupted hashRef must fail reconstruction QA");
  assert.ok(qa.reason, "the rejection must carry a reason");
  assert.notEqual(
    JSON.stringify(reconstructJournal(broken)),
    JSON.stringify(journal),
    "the broken candidate genuinely diverges from the original",
  );
});

test("the QA gate rejects a candidate whose result reference points at the wrong payload", () => {
  const journal = mixedJournal();
  const broken = compactJournal(journal);
  // Point record 0's result at record 2's payload: reconstructs fine but wrong.
  const first = broken.records[0] as { resultRef: number };
  const third = broken.records[2] as { resultRef: number };
  first.resultRef = third.resultRef;
  const qa = verifyJournalCompaction(broken, journal);
  assert.equal(qa.ok, false, "a result that reconstructs to different bytes must be rejected");
  assert.match(qa.reason ?? "", /byte-identical/);
});

test("the QA gate rejects a candidate with a truncated interned table", () => {
  const journal = mixedJournal();
  const broken = compactJournal(journal);
  // Truncating the results table orphans every later reference.
  broken.results = broken.results.slice(0, 1);
  assert.equal(verifyJournalCompaction(broken, journal).ok, false);
});

test("the QA gate rejects a candidate with the wrong entry count", () => {
  const journal = mixedJournal();
  const broken = compactJournal(journal);
  broken.records = broken.records.slice(0, -1);
  const qa = verifyJournalCompaction(broken, journal);
  assert.equal(qa.ok, false, "a summary missing an entry must be rejected");
  assert.match(qa.reason ?? "", /entries/);
});

test("the QA gate rejects a candidate whose reconstruction throws (non-serializable payload)", () => {
  const journal = mixedJournal();
  const broken = compactJournal(journal);
  // A circular result is not JSON-serializable — verify must fail cleanly,
  // never throw.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  broken.results[0] = circular;
  const qa = verifyJournalCompaction(broken, journal);
  assert.equal(qa.ok, false, "a reconstruction that throws must be a rejection, not a crash");
  assert.match(qa.reason ?? "", /threw|does not reconstruct/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — the operations[] traces decide what is safe to fold
// ═══════════════════════════════════════════════════════════════════════════

test("isResolvedEntry: all-ok (or absent) operations are foldable; error/aborted are not", () => {
  const resolved = { index: 0, runId: "run-1", hash: "h", result: "x" } as JournalEntry;
  assert.equal(isResolvedEntry(resolved), true, "no traces → resolved (test double / prose-only)");
  assert.equal(
    isResolvedEntry({ ...resolved, operations: [{ line: 1, op: "read", outcome: "ok" }] }),
    true,
    "all-ok traces → resolved",
  );
  assert.equal(
    isResolvedEntry({ ...resolved, operations: [{ line: 1, op: "edit", outcome: "error: EACCES" }] }),
    false,
    "an error trace marks tool-error repair → not foldable",
  );
  assert.equal(
    isResolvedEntry({ ...resolved, operations: [{ line: 1, op: "read", outcome: "aborted" }] }),
    false,
    "an aborted trace → not foldable",
  );
  assert.equal(
    isResolvedEntry({
      ...resolved,
      operations: [
        { line: 1, op: "read", outcome: "ok" },
        { line: 1, op: "edit", outcome: "error: ENOENT" },
      ],
    }),
    false,
    "a recovery-after-error history → not foldable",
  );
});

test("entries with error/aborted traces are kept verbatim in the summary, not interned", () => {
  const journal = mixedJournal();
  const summary = compactJournal(journal);
  const verbatim = summary.records[3];
  assert.equal(verbatim.fold, "verbatim");
  if (verbatim.fold === "verbatim") {
    assert.deepEqual(verbatim.entry.operations, [
      { line: 4, op: "edit", outcome: "error: EACCES" },
      { line: 4, op: "read", outcome: "ok" },
    ]);
  }
  // The resolved twins are interned records referencing shared table slots.
  assert.equal(summary.records[0]?.fold, "resolved");
  assert.equal(summary.records[1]?.fold, "resolved");
  const twin0 = summary.records[0] as { resultRef: number };
  const twin1 = summary.records[1] as { resultRef: number };
  assert.equal(twin0.resultRef, twin1.resultRef, "JSON-identical results share one slot");
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — end-to-end: a real resolved multi-call run compacts + reconstructs exactly
// ═══════════════════════════════════════════════════════════════════════════

const compactScript = `export const meta = { name: 'compact_run', description: 'multi-call compaction demo' }
const a = await agent('fan-out task', { label: 'a' })
const b = await agent('fan-out task', { label: 'b' })
const c = await agent('different task', { label: 'c' })
return { a, b, c }`;

test("a resolved multi-call runWorkflow run compacts then reconstructs byte-identical to its journal", async () => {
  const journal: JournalEntry[] = [];
  const runner = {
    async run(prompt: string, options: { scriptLine?: number; onOperations?: (ops: OperationTrace[]) => void }) {
      options.onOperations?.([{ line: options.scriptLine ?? 0, op: "read", outcome: "ok" }]);
      return { outcome: `result-of-${prompt}`, detail: "same shape every time" };
    },
  };
  const result = await runWorkflow(compactScript, {
    agent: runner,
    persistLogs: false,
    runId: "compact-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(journal.length, 3, "all three agents journal");
  assert.deepEqual(
    journal.map((e) => e.result),
    [
      { outcome: "result-of-fan-out task", detail: "same shape every time" },
      { outcome: "result-of-fan-out task", detail: "same shape every time" },
      { outcome: "result-of-different task", detail: "same shape every time" },
    ],
  );

  const summary = compactJournal(journal);
  const qa = verifyJournalCompaction(summary, journal);
  assert.deepEqual(qa, { ok: true }, "the gate must accept this run's journal");
  const reconstructed = reconstructJournal(summary);
  assert.equal(JSON.stringify(reconstructed), JSON.stringify(journal), "byte-identical to the original journal");
  assert.equal(JSON.stringify(reconstructed[0]), JSON.stringify(journal[0]));
  // The fan-out twins shared hashes (identical prompt) and results → real folds.
  assert.equal(summary.hashes.length, 2, "two identical prompts share one hash slot");
  assert.equal(summary.results.length, 2, "two identical results share one slot");
  // Positional deltaKeys are intact: the resume lookup surface is unchanged.
  assert.equal(`${journal[2]?.runId}:${journal[2]?.index}`, "compact-run:2");
  // vm-realm result objects have a different prototype, so compare via JSON
  // (same pattern as operation-traces.test.ts / workflow-runtime.test.ts).
  assert.equal(
    JSON.stringify(result.result),
    JSON.stringify({
      a: { outcome: "result-of-fan-out task", detail: "same shape every time" },
      b: { outcome: "result-of-fan-out task", detail: "same shape every time" },
      c: { outcome: "result-of-different task", detail: "same shape every time" },
    }),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — perf guard: compaction + QA stay off quadratic behavior (single-stringify diff)
// ═══════════════════════════════════════════════════════════════════════════

test("compacting and QA-verifying a 20k-entry journal stays within a generous wall-clock bound", () => {
  const journal = Array.from({ length: 20_000 }, (_, i) =>
    entry(i, {
      result: { i },
      storeDelta: { step: i % 7 },
      operations: [{ line: 1, op: "read", outcome: "ok" }],
    }),
  );
  const started = Date.now();
  const summary = compactJournal(journal);
  const qa = verifyJournalCompaction(summary, journal);
  const elapsed = Date.now() - started;
  assert.equal(qa.ok, true, "the 20k-entry journal must still compact + reconstruct byte-identically");
  assert.equal(summary.records.length, journal.length, "no entry is dropped");
  assert.ok(
    elapsed < 8000,
    `compact+verify of 20k entries took ${elapsed}ms — expected well under the generous 8s bound`,
  );
});
