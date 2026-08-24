/**
 * P2-5 — Resume-journal compaction + reconstruction QA (Fabric-aligned).
 *
 * The resume journal is a deterministic cache keyed by the positional deltaKey
 * (`${runId}:${callIndex}` — see buildResumeJournal): every journaled call's
 * `hash`, `result`, `tokens`, `tokenUsage`, and `storeDelta` is required on
 * resume replay, so compaction here is LOSSLESS by design. `compactJournal`
 * folds the journal into an interned summary — one canonical copy per distinct
 * hash, operation-trace array, result, scalar-token count, usage breakdown,
 * and store delta, referenced by index — instead of dropping anything. The
 * `operations[]` traces (P1-1) decide WHAT is safe to fold: an entry whose
 * traces are all "ok" (or absent) is a fully resolved call and gets interned;
 * an entry carrying `error:`/`aborted` traces is evidence of tool-error repair
 * and is kept VERBATIM so the exact trace order and per-entry payloads survive
 * as the failure-diagnosis surface.
 *
 * `verifyJournalCompaction` is the reconstruction-QA gate: reconstruct the
 * original journal from the summary and diff it byte-identical (canonical
 * JSON serialization). A summary that cannot reconstruct — or reconstructs
 * differently — is rejected, and the caller (WorkflowManager's persist path)
 * discards it and keeps the original journal. A compacted form is never
 * persisted without passing this gate.
 */

import type { AgentUsage, OperationTrace } from "./agent.js";
import type { JournalEntry } from "./workflow.js";

/** Schema version of the compacted journal encoding. Bump on any shape change. */
const COMPACT_JOURNAL_VERSION = 1 as const;

/**
 * One journal entry record in a compacted summary. Resolved entries are
 * interned (refs into the summary's tables); unresolved entries are kept
 * verbatim. The positional deltaKey surface (`index` + `runId`) is carried
 * through unchanged — never re-derived or relabeled.
 */
type CompactJournalRecord =
  | {
      fold: "resolved";
      index: number;
      /** Present only when the original entry had it (legacy entries omit it). */
      runId?: string;
      /** Index into summary.hashes. */
      hashRef: number;
      /** Index into summary.results. */
      resultRef: number;
      /** Index into summary.tokens; absent when the original had no tokens (legacy / estimate-only entries). */
      tokensRef?: number;
      /** Index into summary.usages; absent when the original had no usage breakdown. */
      usageRef?: number;
      /** Index into summary.models; absent when the original had no model. */
      modelRef?: number;
      /** Index into summary.storeDeltas; absent when the original had no delta. */
      storeDeltaRef?: number;
      /** E2 commit ordinal; absent when the original had none (legacy entries). */
      storeCommitSeq?: number;
      /** Index into summary.opTraces; absent when the original had no traces. */
      opRef?: number;
    }
  | {
      /** An entry with error/aborted traces (tool-error repair) — kept whole. */
      fold: "verbatim";
      entry: JournalEntry;
    };

/**
 * The compacted form of a resume journal. LOSSLESS by construction: every
 * field of every original entry is preserved; interning identical hashes,
 * traces, results, and store deltas is what folds fan-out journals down. The
 * reconstruction-QA gate (verifyJournalCompaction) is the safety net that
 * guarantees reconstructJournal reproduces the original byte-identically.
 */
export interface CompactJournalSummary {
  /** Discriminates this field from a legacy plain journal array. */
  kind: "compact";
  version: typeof COMPACT_JOURNAL_VERSION;
  /** Distinct call hashes, in first-seen order. */
  hashes: string[];
  /** Distinct operation-trace arrays, in first-seen order. */
  opTraces: OperationTrace[][];
  /** Distinct results, in first-seen order (JSON.stringify-keyed). */
  results: unknown[];
  /**
   * Distinct scalar token counts, in first-seen order (JSON.stringify-keyed).
   * Absent on summaries compacted before the live-stats fields existed (and on
   * hand-built legacy summaries) — reconstructJournal treats a missing table
   * as "no entry referenced it", so old summaries reconstruct unchanged.
   */
  tokens?: number[];
  /**
   * Distinct usage breakdowns, in first-seen order (JSON.stringify-keyed).
   * Absent on summaries compacted before the live-stats fields existed — same
   * legacy-degradation semantics as `tokens`.
   */
  usages?: AgentUsage[];
  /** Distinct resolved models, in first-seen order. */
  models: string[];
  /** Distinct store deltas, in first-seen order (JSON.stringify-keyed). */
  storeDeltas: Record<string, unknown>[];
  /** Per-entry records, in the original journal's order. */
  records: CompactJournalRecord[];
}

/**
 * Whether a journal entry is FULLY RESOLVED (safe to fold). The operations[]
 * traces (P1-1) decide: all "ok" outcomes — or no traces at all (test doubles,
 * prose-only sessions, legacy journals) — mean the call completed through a
 * clean tool path. Any `error:`/`aborted` trace marks tool-error repair, and
 * the entry is preserved verbatim instead of interned.
 */
export function isResolvedEntry(entry: JournalEntry): boolean {
  return entry.operations === undefined || entry.operations.every((trace) => trace.outcome === "ok");
}

/**
 * Fold a journal into its compact summary. Returns a summary whose
 * reconstructJournal output is byte-identical to the input (verified by
 * verifyJournalCompaction before any caller persists it).
 */
export function compactJournal(entries: JournalEntry[]): CompactJournalSummary {
  const hashes: string[] = [];
  const opTraces: OperationTrace[][] = [];
  const results: unknown[] = [];
  const tokens: number[] = [];
  const usages: AgentUsage[] = [];
  const models: string[] = [];
  const storeDeltas: Record<string, unknown>[] = [];
  const hashRefs = new Map<string, number>();
  const traceRefs = new Map<string, number>();
  const resultRefs = new Map<string, number>();
  const tokenRefs = new Map<string, number>();
  const usageRefs = new Map<string, number>();
  const modelRefs = new Map<string, number>();
  const deltaRefs = new Map<string, number>();

  const intern = <T>(values: T[], refs: Map<string, number>, value: T): number => {
    const key = JSON.stringify(value);
    const existing = refs.get(key);
    if (existing !== undefined) return existing;
    const ref = values.length;
    values.push(value);
    refs.set(key, ref);
    return ref;
  };

  const records: CompactJournalRecord[] = [];
  for (const entry of entries) {
    if (isResolvedEntry(entry)) {
      records.push({
        fold: "resolved",
        index: entry.index,
        ...(entry.runId !== undefined ? { runId: entry.runId } : {}),
        hashRef: intern(hashes, hashRefs, entry.hash),
        resultRef: intern(results, resultRefs, entry.result),
        ...(entry.tokens !== undefined ? { tokensRef: intern(tokens, tokenRefs, entry.tokens) } : {}),
        ...(entry.tokenUsage !== undefined ? { usageRef: intern(usages, usageRefs, entry.tokenUsage) } : {}),
        ...(entry.model !== undefined ? { modelRef: intern(models, modelRefs, entry.model) } : {}),
        ...(entry.storeDelta !== undefined ? { storeDeltaRef: intern(storeDeltas, deltaRefs, entry.storeDelta) } : {}),
        ...(entry.storeCommitSeq !== undefined ? { storeCommitSeq: entry.storeCommitSeq } : {}),
        ...(entry.operations !== undefined ? { opRef: intern(opTraces, traceRefs, entry.operations) } : {}),
      });
    } else {
      records.push({ fold: "verbatim", entry });
    }
  }

  return {
    kind: "compact",
    version: COMPACT_JOURNAL_VERSION,
    hashes,
    opTraces,
    results,
    tokens,
    usages,
    models,
    storeDeltas,
    records,
  };
}

/**
 * Reconstruct the original journal from a compacted summary. Entry objects
 * are built in the same canonical key order workflow.ts uses when journaling
 * (`index, runId, hash, result, tokens, tokenUsage, model, storeDelta,
 * storeCommitSeq, operations`), materializing optional fields only when the
 * original had them, so JSON.stringify output matches the original
 * byte-for-byte. Interned results/deltas/traces are shared by reference across
 * entries that originally held JSON-equal values — serialization is
 * unaffected, and neither applyDelta (resume replay) nor the read-only trace
 * surface mutates them.
 */
export function reconstructJournal(summary: CompactJournalSummary): JournalEntry[] {
  return summary.records.map((record): JournalEntry => {
    if (record.fold === "verbatim") return record.entry;
    return {
      index: record.index,
      ...(record.runId !== undefined ? { runId: record.runId } : {}),
      hash: summary.hashes[record.hashRef],
      result: summary.results[record.resultRef],
      ...(record.tokensRef !== undefined && summary.tokens !== undefined
        ? { tokens: summary.tokens[record.tokensRef] }
        : {}),
      ...(record.usageRef !== undefined && summary.usages !== undefined
        ? { tokenUsage: summary.usages[record.usageRef] }
        : {}),
      ...(record.modelRef !== undefined ? { model: summary.models[record.modelRef] } : {}),
      ...(record.storeDeltaRef !== undefined ? { storeDelta: summary.storeDeltas[record.storeDeltaRef] } : {}),
      ...(record.storeCommitSeq !== undefined ? { storeCommitSeq: record.storeCommitSeq } : {}),
      ...(record.opRef !== undefined ? { operations: summary.opTraces[record.opRef] } : {}),
    };
  });
}

interface JournalCompactionVerification {
  ok: boolean;
  /** Why the gate rejected the summary (present when ok === false). */
  reason?: string;
}

/**
 * Reconstruction-QA gate: reconstruct the original journal from the summary
 * and diff it against the stored original. Every reconstruction failure
 * (a throwing or byte-divergent reconstruct, an entry-count mismatch) is a
 * rejection with a reason. Callers must never persist a summary this gate
 * rejects — keep the original journal instead.
 *
 * Perf: the diff serializes each side ONCE (full-array stringify), not once
 * per entry — a 500k-entry fan-out journal pays two stringifies, not a
 * million. The per-entry scan that produces the rejection reason only runs
 * after a mismatch is already known.
 */
export function verifyJournalCompaction(
  summary: CompactJournalSummary,
  original: JournalEntry[],
): JournalCompactionVerification {
  try {
    const reconstructed = reconstructJournal(summary);
    if (reconstructed.length !== original.length) {
      return {
        ok: false,
        reason: `reconstructed ${reconstructed.length} entries, expected ${original.length}`,
      };
    }
    if (JSON.stringify(reconstructed) === JSON.stringify(original)) {
      return { ok: true };
    }
    for (let i = 0; i < original.length; i++) {
      if (JSON.stringify(reconstructed[i]) !== JSON.stringify(original[i])) {
        return { ok: false, reason: `entry ${i} does not reconstruct byte-identically` };
      }
    }
    // Unreachable: the full-stringify diff above already failed. Kept so the
    // gate's contract stays "ok only when byte-identical".
    return { ok: false, reason: "reconstructed bytes diverge from the original" };
  } catch (err) {
    return { ok: false, reason: `reconstruction threw: ${(err as Error).message}` };
  }
}
