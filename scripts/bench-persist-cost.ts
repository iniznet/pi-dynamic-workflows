/**
 * Benchmark: run-state persistence cost — full CAS write vs the E4
 * journal-delta fast path (audit findings `benchmark-persist-cost` +
 * `journal-budget-stringify`, cpu-leak-audit).
 *
 * Quantifies, for synthetic run states with 10k / 50k / 500k journal entries:
 *   (a) the full `casWrite` path — what every 400ms throttled progress tick
 *       pays while the fast path is dead-coded off (`useFastPath = false`):
 *       pretty-printed serialize of the whole state + secret scan + .tmp/.bak
 *       double write + read-backs, PLUS the capJournalBudget full-journal
 *       stringify once the entry count passes the 10k threshold;
 *   (b) the `saveFastPath` sidecar path — what the same tick pays once the
 *       fast path is re-enabled (S1): an O(delta) `.jdelta` sidecar write.
 *   (c) `capJournalBudget`'s standalone full-journal stringify cost at/over
 *       the 10_000-entry count threshold (finding 2's amplifier).
 *
 * The persistence primitives are driven DIRECTLY (createRunPersistence +
 * save({fastPath})), so the numbers are independent of the manager wiring.
 *
 * Run: npx tsx scripts/bench-persist-cost.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  capJournalBudget,
  createRunPersistence,
  DEFAULT_JOURNAL_BYTE_BUDGET,
  journalEntryKey,
  MAX_JOURNAL_ENTRIES,
  type PersistedRunState,
} from "../src/run-persistence.js";
import type { JournalEntry } from "../src/workflow.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";

/** Mirrors the unexported JOURNAL_BYTE_CHECK_THRESHOLD in src/run-persistence.ts. */
const JOURNAL_BYTE_CHECK_THRESHOLD = 10_000;

const SIZES = [10_000, 50_000, 500_000] as const;

// ── synthetic run state ──────────────────────────────────────────────────────

function makeEntry(runId: string, index: number): JournalEntry {
  return {
    index,
    runId,
    hash: `sha256-${index}`,
    model: index % 3 === 0 ? "provider/model" : undefined,
    result: {
      reply: `agent ${index} finished step ${index % 20}`,
      tokens: { input: 1_200 + index, output: 300, total: 1_500 + index },
    },
    storeDelta: index % 7 === 0 ? { [`k${index % 5}`]: index } : undefined,
  };
}

function makeJournal(runId: string, size: number): JournalEntry[] {
  return Array.from({ length: size }, (_, i) => makeEntry(runId, i));
}

function makeState(runId: string, journal: JournalEntry[]): PersistedRunState {
  return {
    runId,
    workflowName: "bench",
    script: "export const meta = { name: 'bench', description: 'benchmark' }",
    args: { journalSize: journal.length },
    status: "running",
    phases: ["plan", "execute"],
    currentPhase: "execute",
    agents: Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      label: `agent-${i}`,
      prompt: `do thing ${i}`,
      status: "done" as const,
      result: { reply: "x".repeat(2_000), tokens: 100 },
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:01:00.000Z",
    })),
    logs: Array.from({ length: 50 }, (_, i) => `[tick] step ${i} completed`),
    journal,
    startedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    tokenUsage: { input: 100_000, output: 50_000, total: 150_000 },
  };
}

// ── measurement helpers ──────────────────────────────────────────────────────

function timeOnce(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function gcIfPossible(): void {
  try {
    (globalThis as { gc?: () => void }).gc?.();
  } catch {
    // no --expose-gc; skip
  }
}

function timeAvg(fn: () => void, runs: number): number {
  let total = 0;
  for (let i = 0; i < runs; i++) {
    gcIfPossible();
    total += timeOnce(fn);
  }
  return total / runs;
}

const primaryPath = (dir: string, runId: string) => join(workflowProjectPaths(dir).runsDir, `${runId}.json`);
const deltaPath = (dir: string, runId: string) => `${primaryPath(dir, runId)}.jdelta`;

/** Benchmark states always carry a journal — extract it without a `!` assertion. */
function requireJournal(state: PersistedRunState): JournalEntry[] {
  const journal = state.journal;
  if (!journal) throw new Error("benchmark state must carry a journal");
  return journal;
}

// ── benchmarks ───────────────────────────────────────────────────────────────

/** (a) Full CAS write: average wall time of one full-state save. */
function benchFullWrite(dir: string, state: PersistedRunState, runs: number): number {
  const rp = createRunPersistence(dir);
  rp.save(state); // warmup: dir creation, lazy paths, first-parse caches
  return timeAvg(() => rp.save(state), runs);
}

/**
 * (b) Fast path, steady state: one new journal entry per tick on the SAME
 * in-memory journal array (the manager's pattern — objects are reused between
 * saves, so the identity fast-reject keeps the delta at exactly one entry).
 * Reported as average ms per tick.
 */
function benchFastPath(dir: string, state: PersistedRunState, ticks: number): { avgMs: number; folds: number } {
  const rp = createRunPersistence(dir);
  rp.save(state); // boundary seed → foldedByRun covers the whole journal
  const journal = requireJournal(state);
  let nextIndex = journal.length;
  let total = 0;
  let folds = 0;
  for (let t = 0; t < ticks; t++) {
    journal.push(makeEntry(state.runId, nextIndex++));
    total += timeOnce(() => rp.save(state, { fastPath: true }));
    // A fold (sidecar past journalDeltaCheckpointBytes → full checkpoint) clears the sidecar.
    if (!existsSync(deltaPath(dir, state.runId))) folds++;
  }
  return { avgMs: total / ticks, folds };
}

/**
 * (c) One checkpoint-fold event: the tick whose sidecar crosses the threshold
 * and rewrites the primary (casWrite fold). Detected by the primary file's
 * bytes changing on that tick.
 */
function benchFoldEvent(dir: string, state: PersistedRunState, thresholdBytes: number): number {
  const rp = createRunPersistence(dir, undefined, { journalDeltaCheckpointBytes: thresholdBytes });
  rp.save(state); // seed
  const journal = requireJournal(state);
  let nextIndex = journal.length;
  for (let t = 0; t < 10_000; t++) {
    journal.push(makeEntry(state.runId, nextIndex++));
    const before = readFileSync(primaryPath(dir, state.runId), "utf-8");
    const ms = timeOnce(() => rp.save(state, { fastPath: true }));
    const after = readFileSync(primaryPath(dir, state.runId), "utf-8");
    if (after !== before) return ms; // this tick rewrote the primary = checkpoint fold
  }
  throw new Error(`fold never fired for ${state.journal?.length} entries`);
}

/**
 * The saveFastPath delta-detection loop alone (journalEntryKey + Map.get per
 * entry) — the O(n) per-tick component that scales with the in-memory journal
 * independent of what actually gets written.
 */
function benchDeltaScan(journal: JournalEntry[], runId: string): number {
  const folded = new Map(journal.map((e) => [journalEntryKey(e.runId ?? runId, e.index), e] as const));
  return timeAvg(() => {
    for (const e of journal) {
      folded.get(journalEntryKey(e.runId ?? runId, e.index));
    }
  }, 5);
}

// ── budget table ─────────────────────────────────────────────────────────────

interface BudgetRow {
  entries: number;
  stringifyMs: number;
  capMs: number;
  overBudget: boolean;
  cappedTo: number;
}

function benchBudget(): BudgetRow[] {
  const runId = "budget";
  return [JOURNAL_BYTE_CHECK_THRESHOLD, JOURNAL_BYTE_CHECK_THRESHOLD + 1, 50_000, 500_000].map((n) => {
    const journal = makeJournal(runId, n);
    const serializedBytes = JSON.stringify(journal).length;
    const repeats = n >= 500_000 ? 2 : 3;
    const stringifyMs = timeAvg(() => JSON.stringify(journal), repeats);
    const capped = capJournalBudget(journal, DEFAULT_JOURNAL_BYTE_BUDGET);
    const capMs = timeAvg(() => capJournalBudget(journal, DEFAULT_JOURNAL_BYTE_BUDGET), repeats);
    return {
      entries: n,
      stringifyMs,
      capMs,
      overBudget: serializedBytes > DEFAULT_JOURNAL_BYTE_BUDGET,
      cappedTo: capped.length,
    };
  });
}

// ── output ───────────────────────────────────────────────────────────────────

interface SizeRow {
  entries: number;
  journalKb: number;
  persistedEntries: number;
  fullMs: number;
  fastMs: number;
  fastFolds: number;
  ratio: number;
  foldMs: number;
  scanMs: number;
}

function fmtMs(ms: number): string {
  return ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
}

function printTable(rows: SizeRow[]): void {
  const headers = [
    "entries",
    "journal KB",
    "persisted",
    "full-write ms",
    "fast-path ms",
    "ratio",
    "fold ms",
    "scan ms",
  ];
  const widths = headers.map((h, i) =>
    Math.max(
      h.length,
      ...rows.map((r) => {
        const cells = [
          String(r.entries),
          r.journalKb.toFixed(0),
          String(r.persistedEntries),
          fmtMs(r.fullMs),
          fmtMs(r.fastMs),
          r.ratio.toFixed(1),
          fmtMs(r.foldMs),
          fmtMs(r.scanMs),
        ];
        return cells[i]?.length ?? 0;
      }),
    ),
  );
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  console.log(line(headers));
  console.log(`|-${widths.map((w) => "-".repeat(w)).join("-|-")}-|`);
  for (const r of rows) {
    console.log(
      line([
        String(r.entries),
        r.journalKb.toFixed(0),
        String(r.persistedEntries),
        fmtMs(r.fullMs),
        fmtMs(r.fastMs),
        r.ratio.toFixed(1),
        fmtMs(r.foldMs),
        fmtMs(r.scanMs),
      ]),
    );
  }
}

function printBudgetTable(rows: BudgetRow[]): void {
  const headers = ["entries", "raw stringify ms", "capJournalBudget ms", "over 32MB budget", "kept entries"];
  const widths = headers.map((h, i) =>
    Math.max(
      h.length,
      ...rows.map((r) => {
        const cells = [
          String(r.entries),
          fmtMs(r.stringifyMs),
          fmtMs(r.capMs),
          r.overBudget ? "yes" : "no",
          String(r.cappedTo),
        ];
        return cells[i]?.length ?? 0;
      }),
    ),
  );
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  console.log(line(headers));
  console.log(`|-${widths.map((w) => "-".repeat(w)).join("-|-")}-|`);
  for (const r of rows) {
    console.log(
      line([String(r.entries), fmtMs(r.stringifyMs), fmtMs(r.capMs), r.overBudget ? "yes" : "no", String(r.cappedTo)]),
    );
  }
}

function main(): void {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-bench-home-"));
  const rows: SizeRow[] = [];
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const size of SIZES) {
      const dir = mkdtempSync(join(tmpdir(), "pi-dw-bench-"));
      try {
        // One fresh state per measurement so the fast/fold benches never inherit
        // another bench's pushed entries or per-instance folded map.
        const fullState = makeState("bench", makeJournal("bench", size));
        const fastState = makeState("bench", makeJournal("bench", size));
        const foldState = makeState("bench", makeJournal("bench", size));
        const journalKb = JSON.stringify(fullState.journal).length / 1024;

        const fullMs = benchFullWrite(join(dir, "full"), fullState, size >= 500_000 ? 2 : 5);
        const fast = benchFastPath(join(dir, "fast"), fastState, size >= 500_000 ? 3 : 300);
        const foldMs = benchFoldEvent(join(dir, "fold"), foldState, 2048);
        const scanMs = benchDeltaScan(requireJournal(fastState), "bench");

        rows.push({
          entries: size,
          journalKb,
          persistedEntries: Math.min(size, MAX_JOURNAL_ENTRIES),
          fullMs,
          fastMs: fast.avgMs,
          fastFolds: fast.folds,
          ratio: fullMs / fast.avgMs,
          foldMs,
          scanMs,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }

  console.log("benchmark: run-state persistence cost (full CAS write vs E4 fast path)");
  console.log("audit findings: benchmark-persist-cost, journal-budget-stringify (cpu-leak-audit)");
  console.log(`host: ${process.platform} node ${process.version}`);
  console.log(
    "synthetic state: 20 agents (2KB results), 50 log lines, script/args/tokenUsage + N journal entries (~250B each)",
  );
  console.log("full-write ms = one full save() through casWrite (serialize + secret scan + .tmp/.bak + read-backs)");
  console.log("fast-path ms  = one save({ fastPath: true }) tick with a single new journal entry (sidecar write)");
  console.log(
    "fold ms       = the tick where the sidecar crosses journalDeltaCheckpointBytes and rewrites the primary",
  );
  console.log("scan ms       = saveFastPath's per-tick delta-detection loop alone (O(n) identity scan, no disk)");
  console.log();
  printTable(rows);
  console.log();
  for (const r of rows) {
    if (r.fastFolds > 0) {
      console.log(
        `  note: ${r.entries} entries — ${r.fastFolds} of the timed fast-path ticks folded (degenerate regime).`,
      );
    }
  }
  console.log(
    "  note: the persisted journal is capped at MAX_JOURNAL_ENTRIES (50k) by the CAS merge, so 50k and 500k rows",
  );
  console.log(
    "  serialize the same on-disk size; the 500k fast-path row degenerates because only the newest 50k entries can be",
  );
  console.log(
    "  folded, so EVERY tick exceeds the 1MB sidecar threshold and folds (production journals never reach 500k in memory).",
  );
  console.log();
  console.log(
    `capJournalBudget full-journal stringify cost (count threshold = ${JOURNAL_BYTE_CHECK_THRESHOLD} entries):`,
  );
  console.log(
    "  casWrite pays this stringify on EVERY save once journal.length > 10_000 — at 10_000 exactly the count check is skipped.",
  );
  printBudgetTable(benchBudget());
}

main();
