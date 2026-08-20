/**
 * V2-P09 (re-scoped): cross-run token spend ledger + aggregate analytics.
 *
 * The original V2-P09 dollar-budget proposal was rejected 0/2 by verify()
 * (no budgetUsd/dollar denomination exists anywhere — budgets are token-based
 * per run). This is the re-scoped token version: a durable, project-scoped
 * ledger of per-run token spend (from the run's journaled spend + the
 * runtime's aggregated token accounting) with deterministic aggregate
 * analytics (per-phase / per-pattern / per-provider totals + a per-run trend).
 *
 * Storage: one `spendLedger:<runId>` entry per run in the project's durable
 * store (the same project-scoped KV under getAgentDir() that P06 provides).
 * This keeps the ledger replay-idempotent (DurableStore.put is a deep-equal
 * no-op for a re-executed write), resume-correct (a RESUMED run's cumulative
 * total replaces the stale pre-pause entry under the same runId), and visible
 * in the run report's durable entries view automatically.
 *
 * Determinism-only: entry timestamps come from the durable-store's
 * deterministic clock (constant epoch + write seq — never wall clock); the
 * trend orders by that stamp with the (time-ordered) runId as tiebreak, so
 * analytics are a pure function of the persisted ledger. Read-only query
 * global — NEVER part of any agent() resume identity.
 */

import { deterministicRunClock, projectDurableStorePath, readDurableStoreFile } from "./durable-store.js";
import { workflowProjectKey } from "./workflow-paths.js";

/** On-disk schema version of one ledger entry (bump only on a breaking shape change). */
export const SPEND_LEDGER_SCHEMA_VERSION = 1 as const;

/** Durable-store key prefix for per-run spend-ledger entries. */
export const SPEND_LEDGER_PREFIX = "spendLedger";

/** The deterministic stamp for one run's ledger entry (fixed epoch + runId → stable, ordered by runId). */
export function spendLedgerTimestamp(runId: string): string {
  return deterministicRunClock(runId)(0);
}

/** Durable-store key for one run's spend-ledger entry. */
export function spendLedgerKey(runId: string): string {
  return `${SPEND_LEDGER_PREFIX}:${runId}`;
}

/** Per-phase spend row in a ledger entry. */
export interface SpendLedgerPhase {
  /** The phase title spend was attributed to (M25 assignment). */
  name: string;
  /** Tokens attributed to this phase across the whole run tree. */
  spend: number;
  /** The phase's declared soft sub-budget, when one was carved. */
  budget?: number;
}

/** Per-provider spend row in a ledger entry. */
export interface SpendLedgerProvider {
  /** Provider (first path segment of the canonical model spec). */
  provider: string;
  /** Tokens attributed to this provider. */
  spend: number;
}

/** V2-P11 re-plan summary captured at run end (when a threshold was configured). */
export interface SpendLedgerReplan {
  /** Whether the forecast crossed the re-plan threshold at any point. */
  triggered: boolean;
  /** The frozen threshold fraction used by this run (0..1). */
  threshold: number;
  /** Number of times the crossing edge fired on the live path (0 when never). */
  events: number;
}

/** One durable cross-run spend record for a single run. */
export interface SpendLedgerEntry {
  schemaVersion: typeof SPEND_LEDGER_SCHEMA_VERSION;
  runId: string;
  /** The run's workflow name — the "pattern" dimension of the analytics. */
  workflowName: string;
  /** Best-effort run outcome at ledger-write time ("completed" | "failed"). */
  status: "completed" | "failed";
  /** Total agent() calls recorded by the run's SharedRuntime counter. */
  agents: number;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
    /** Fresh spend = input+output (T1-01 counter). */
    freshSpend: number;
  };
  /** The run's frozen token budget ceiling (null = unlimited). */
  budgetLimit: number | null;
  /** The run's final accumulated agent-output chars, when a ceiling was configured. */
  totalOutputChars: number | null;
  phases: SpendLedgerPhase[];
  providers: SpendLedgerProvider[];
  replan?: SpendLedgerReplan;
  /** Deterministic stamp (constant epoch; trend tiebreak = runId order). */
  at: string;
}

/** Inputs the runtime feeds the ledger writer at run end (all deterministic). */
export interface BuildSpendLedgerEntryInput {
  runId: string;
  workflowName: string;
  status: SpendLedgerEntry["status"];
  agents: number;
  tokenUsage: SpendLedgerEntry["tokenUsage"];
  budgetLimit: number | null;
  totalOutputChars: number | null;
  phases: ReadonlyMap<string, number>;
  phaseBudgets: ReadonlyMap<string, { budget: number; warned: boolean }>;
  providers: ReadonlyMap<string, number>;
  replan?: SpendLedgerReplan;
}

/** Pure builder — deterministic over its inputs, never reads the wall clock. */
export function buildSpendLedgerEntry(input: BuildSpendLedgerEntryInput): SpendLedgerEntry {
  const phases: SpendLedgerPhase[] = [...input.phases]
    .map(([name, spend]) => {
      const budget = input.phaseBudgets.get(name)?.budget;
      return { name, spend, ...(budget !== undefined ? { budget } : {}) };
    })
    // Keep phases with actual spend OR a declared budget (a budget declared but
    // never spent still matters to the analytics: it describes the plan).
    .filter(({ name, spend }) => spend > 0 || input.phaseBudgets.has(name));
  const providers: SpendLedgerProvider[] = [...input.providers]
    .map(([provider, spend]) => ({ provider, spend }))
    .filter(({ spend }) => spend > 0);
  return {
    schemaVersion: SPEND_LEDGER_SCHEMA_VERSION,
    runId: input.runId,
    workflowName: input.workflowName,
    status: input.status,
    agents: input.agents,
    tokenUsage: {
      input: input.tokenUsage.input,
      output: input.tokenUsage.output,
      total: input.tokenUsage.total,
      cost: input.tokenUsage.cost,
      cacheRead: input.tokenUsage.cacheRead,
      cacheWrite: input.tokenUsage.cacheWrite,
      freshSpend: input.tokenUsage.freshSpend,
    },
    budgetLimit: input.budgetLimit,
    totalOutputChars: input.totalOutputChars,
    phases,
    providers,
    ...(input.replan !== undefined ? { replan: input.replan } : {}),
    at: spendLedgerTimestamp(input.runId),
  };
}

/**
 * Write one run's spend-ledger entry. REPLAY-IDEMPOTENT (DurableStore.put is a
 * deep-equal no-op for a re-executed write) and RESUME-CORRECT: a resumed run
 * writes its cumulative total under the SAME runId, replacing the stale
 * pre-pause entry instead of appending a duplicate (the per-runId key keeps
 * the ledger a map, never a growing list). Best-effort by contract — the
 * caller must never fail a run on a ledger write.
 */
export async function writeSpendLedgerEntry(
  store: { put(key: string, value: unknown): Promise<void> },
  entry: SpendLedgerEntry,
): Promise<void> {
  return store.put(spendLedgerKey(entry.runId), entry);
}

/** A spend-ledger entry read back from the durable store (lenient shape guard). */
export function parseSpendLedgerEntry(value: unknown): SpendLedgerEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<SpendLedgerEntry>;
  if (typeof entry.runId !== "string" || typeof entry.workflowName !== "string") return null;
  if (typeof entry.tokenUsage?.total !== "number") return null;
  return {
    schemaVersion: SPEND_LEDGER_SCHEMA_VERSION,
    runId: entry.runId,
    workflowName: entry.workflowName,
    status: entry.status === "failed" ? "failed" : "completed",
    agents: typeof entry.agents === "number" ? entry.agents : 0,
    tokenUsage: {
      input: typeof entry.tokenUsage.input === "number" ? entry.tokenUsage.input : 0,
      output: typeof entry.tokenUsage.output === "number" ? entry.tokenUsage.output : 0,
      total: entry.tokenUsage.total,
      cost: typeof entry.tokenUsage.cost === "number" ? entry.tokenUsage.cost : 0,
      cacheRead: typeof entry.tokenUsage.cacheRead === "number" ? entry.tokenUsage.cacheRead : 0,
      cacheWrite: typeof entry.tokenUsage.cacheWrite === "number" ? entry.tokenUsage.cacheWrite : 0,
      freshSpend: typeof entry.tokenUsage.freshSpend === "number" ? entry.tokenUsage.freshSpend : 0,
    },
    budgetLimit: typeof entry.budgetLimit === "number" || entry.budgetLimit === null ? entry.budgetLimit : null,
    totalOutputChars:
      typeof entry.totalOutputChars === "number" || entry.totalOutputChars === null ? entry.totalOutputChars : null,
    phases: Array.isArray(entry.phases) ? (entry.phases.filter(isPhaseRow) as SpendLedgerPhase[]) : [],
    providers: Array.isArray(entry.providers) ? (entry.providers.filter(isProviderRow) as SpendLedgerProvider[]) : [],
    ...(entry.replan !== undefined && isReplan(entry.replan) ? { replan: entry.replan } : {}),
    at: typeof entry.at === "string" ? entry.at : spendLedgerTimestamp(entry.runId),
  };
}

function isPhaseRow(value: unknown): value is SpendLedgerPhase {
  if (typeof value !== "object" || value === null) return false;
  const row = value as SpendLedgerPhase;
  return typeof row.name === "string" && typeof row.spend === "number";
}

function isProviderRow(value: unknown): value is SpendLedgerProvider {
  if (typeof value !== "object" || value === null) return false;
  const row = value as SpendLedgerProvider;
  return typeof row.provider === "string" && typeof row.spend === "number";
}

function isReplan(value: unknown): value is SpendLedgerReplan {
  if (typeof value !== "object" || value === null) return false;
  const replan = value as SpendLedgerReplan;
  return typeof replan.triggered === "boolean" && typeof replan.threshold === "number";
}

/** Extract all parsed ledger entries from a durable-store entries view. */
export function readSpendLedgerEntries(entries: Readonly<Record<string, unknown>>): SpendLedgerEntry[] {
  const result: SpendLedgerEntry[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(`${SPEND_LEDGER_PREFIX}:`)) continue;
    const parsed = parseSpendLedgerEntry(value);
    if (parsed !== null) result.push(parsed);
  }
  return result;
}

// ── aggregate analytics (pure, deterministic) ────────────────────────────────

/** One per-dimension aggregate row. */
export interface SpendAnalyticsRow {
  name: string;
  spend: number;
  runs: number;
}

/** Per-run trend row (newest-first by the deterministic stamp, runId tiebreak). */
export interface SpendAnalyticsTrendRow {
  runId: string;
  workflowName: string;
  status: SpendLedgerEntry["status"];
  total: number;
  agents: number;
  at: string;
}

/** Deterministic aggregate analytics over a set of ledger entries. */
export interface SpendAnalytics {
  /** Number of ledger entries aggregated. */
  runCount: number;
  totals: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
    freshSpend: number;
    agents: number;
  };
  /** Sum of spend per phase title, phase-name sorted. */
  perPhase: SpendAnalyticsRow[];
  /** Sum of spend per workflow name ("pattern"), name sorted. */
  perPattern: SpendAnalyticsRow[];
  /** Sum of spend per provider, name sorted. */
  perProvider: SpendAnalyticsRow[];
  /** One row per run, newest-first. */
  trend: SpendAnalyticsTrendRow[];
  /** The aggregated entries themselves, newest-first. */
  runs: SpendLedgerEntry[];
}

function sumRows(rows: ReadonlyMap<string, { spend: number; runs: number }>): SpendAnalyticsRow[] {
  return [...rows]
    .map(([name, { spend, runs }]) => ({ name, spend, runs }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Sort entries newest-first: deterministic stamp desc, then runId desc (time-ordered). */
function sortEntriesNewestFirst(entries: SpendLedgerEntry[]): SpendLedgerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.at === b.at) return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
    return a.at < b.at ? 1 : -1;
  });
}

/**
 * Aggregate a set of ledger entries. Pure function of its input — numeric
 * sums + sorted keys, never wall clock / RNG. Deterministic for a fixed
 * ledger, so a replayed/resumed run computes identical analytics.
 */
export function aggregateSpendAnalytics(entries: readonly SpendLedgerEntry[]): SpendAnalytics {
  const byPhase = new Map<string, { spend: number; runs: number }>();
  const byPattern = new Map<string, { spend: number; runs: number }>();
  const byProvider = new Map<string, { spend: number; runs: number }>();
  let totals = {
    input: 0,
    output: 0,
    total: 0,
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
    freshSpend: 0,
    agents: 0,
  };
  const add = (map: Map<string, { spend: number; runs: number }>, name: string, spend: number) => {
    if (name.length === 0 || spend <= 0) return;
    const existing = map.get(name);
    if (existing) {
      existing.spend += spend;
      existing.runs += 1;
    } else {
      map.set(name, { spend, runs: 1 });
    }
  };
  for (const entry of entries) {
    totals = {
      input: totals.input + entry.tokenUsage.input,
      output: totals.output + entry.tokenUsage.output,
      total: totals.total + entry.tokenUsage.total,
      cost: totals.cost + entry.tokenUsage.cost,
      cacheRead: totals.cacheRead + entry.tokenUsage.cacheRead,
      cacheWrite: totals.cacheWrite + entry.tokenUsage.cacheWrite,
      freshSpend: totals.freshSpend + entry.tokenUsage.freshSpend,
      agents: totals.agents + entry.agents,
    };
    for (const phase of entry.phases) add(byPhase, phase.name, phase.spend);
    add(byPattern, entry.workflowName, entry.tokenUsage.total);
    for (const provider of entry.providers) add(byProvider, provider.provider, provider.spend);
  }
  const newestFirst = sortEntriesNewestFirst([...entries]);
  return {
    runCount: entries.length,
    totals,
    perPhase: sumRows(byPhase),
    perPattern: sumRows(byPattern),
    perProvider: sumRows(byProvider),
    trend: newestFirst.map((entry) => ({
      runId: entry.runId,
      workflowName: entry.workflowName,
      status: entry.status,
      total: entry.tokenUsage.total,
      agents: entry.agents,
      at: entry.at,
    })),
    runs: newestFirst,
  };
}

// ── script-facing query global ───────────────────────────────────────────────

/** Query options for the `spendAnalytics` runtime global. */
export interface SpendAnalyticsOptions {
  /** Cap on the returned per-run `runs`/`trend` rows (default 50, min 1). */
  limit?: number;
}

const DEFAULT_ANALYTICS_LIMIT = 50;

/**
 * Compute cross-run spend analytics for one project by reading the project's
 * durable-store file from disk (the freshest on-disk truth — the same read
 * surface lineage/recall use). Missing/corrupt/newer-schema store → empty
 * analytics, never an error. Fully deterministic. Read-only — never part of
 * any agent() resume identity.
 */
export function computeSpendAnalytics(cwd: string, options: SpendAnalyticsOptions = {}): SpendAnalytics {
  const path = projectDurableStorePath(workflowProjectKey(cwd));
  const store = readDurableStoreFile(path);
  const entries = store !== null ? readSpendLedgerEntries(store.entries) : [];
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : DEFAULT_ANALYTICS_LIMIT;
  const analytics = aggregateSpendAnalytics(entries);
  return { ...analytics, trend: analytics.trend.slice(0, limit), runs: analytics.runs.slice(0, limit) };
}

/** The runtime binding for the `spendAnalytics` global (pure; no wall clock). */
export function bindSpendAnalytics(options: { cwd: string }): (query?: SpendAnalyticsOptions) => SpendAnalytics {
  const cwd = options.cwd;
  return (query) => computeSpendAnalytics(cwd, query);
}
