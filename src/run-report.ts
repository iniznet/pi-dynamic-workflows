/**
 * Machine-readable run report (N04 + QW3 + QW5).
 *
 * Emits a structured, additive artifact alongside a run's persisted state:
 * `<runsDir>/<runId>.report.json` — written at completion AND on resume, and
 * derived entirely from the persisted run record (PersistedRunState) plus
 * optional live inputs (the run's durable store, the model-tiers config).
 *
 * The report is deliberately DERIVED, never a new journal: resume() only ever
 * reads `<runId>.json` (+ its `.jdelta` sidecar), so the report file can never
 * affect resume-replay hashes. It exists so an operator/model can answer, from
 * disk alone, "which agents ran on what, under which phase budget, with which
 * approvals, truncations, and provider/tier choices".
 *
 * Contents:
 *   - per-agent roster (label, phase, model/tier, outcome, tokens, worktree
 *     provenance reference)
 *   - per-phase budget spend (QW5: economy tier + routing reason per phase;
 *     V2-QW2: the persisted per-phase soft sub-budget when phase() declared one
 *     and the run's durable sink persisted it)
 *   - approvals (persisted checkpoint verdicts)
 *   - truncations (QW3: capEmbedded reports, parsed from the persisted log
 *     stream — the capEmbedded log site in workflow.ts records truncations as
 *     `embedded payload capped at <n> chars (was <m>)` lines)
 *   - the run's durable-store view (provenance ledger + entries) when present
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentUsage } from "./agent.js";
import type { WorkflowErrorCode } from "./errors.js";
import {
  ensureDir,
  type PersistenceFsLayer,
  resolvePersistenceFs,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";
import { loadModelTierConfig, type ModelTierConfig, resolveTierModel, sortedTierNames } from "./model-tier-config.js";
import type { PersistedRunState, RunStatus } from "./run-persistence.js";
import { parseWorkflowScript } from "./workflow.js";
import { workflowProjectPaths } from "./workflow-paths.js";

/** Report schema version — bump only on a breaking shape change. */
export const RUN_REPORT_SCHEMA_VERSION = 3 as const;

/** Subdirectory under the runs dir where report artifacts live. Reports are
 *  written here (not as `<runId>.report.json` next to the run record) so the
 *  run listing's `*.json` scan never mistakes a report for a run record. */
export const RUN_REPORTS_SUBDIR = "reports";

/** The report artifact path for a run: `<runsDir>/reports/<runId>.json`. */
export function runReportPath(runsDir: string, runId: string): string {
  return join(runsDir, RUN_REPORTS_SUBDIR, `${runId}.json`);
}

export interface RunReportAgent {
  id: number;
  callId?: string;
  label: string;
  phase?: string;
  /** The model (provider/id) this agent actually ran on, when known. */
  model?: string;
  outcome: "done" | "error" | "skipped" | "running";
  tokens?: number;
  tokenUsage?: AgentUsage;
  error?: string;
  errorCode?: WorkflowErrorCode;
}

export interface RunReportPhase {
  name: string;
  /** Soft per-phase sub-budget, when it was declared at runtime AND the run
   *  bound a durable sink that persisted it (V2-QW2: phase() carves persist
   *  per-phase keys `phaseBudgets:<runId>:<title>` into the run's durable
   *  store; the report reads them from the durable entries view). Absent for
   *  runs that declared no budget, or when no durable view was supplied. */
  budget?: number;
  /** Sum of the phase's agents' token figures (the persisted per-agent scalar
   *  estimate / reported total). */
  spend: number;
  agentCount: number;
  /** The phase's declared model from the script meta, when declared. */
  model?: string;
  /** QW5: the economy tier this phase's agents ran under, when derivable
   *  (reverse-matched from the actual models against the model-tiers config;
   *  falls back to the declared meta model / the session default). */
  tier?: string;
  /** QW5: why this phase's agents were routed the way they were. */
  routingReason: string;
}

export interface RunReportTruncation {
  cappedChars: number;
  originalChars: number;
  count: number;
}

/**
 * V2-QW3: the run-level total-output budget accounting, persisted by the
 * runtime into the run's durable store at run end (`outputBudget:<runId>`)
 * and read back by the report from the durable entries view. Absent entirely
 * when the run configured no `maxTotalOutputChars` ceiling.
 */
export interface RunReportOutputBudget {
  /** The run's frozen `maxTotalOutputChars` ceiling (null = disabled). */
  limit: number | null;
  /** The run's final accumulated agent-output chars (post-P05-cap). */
  spent: number;
}

export interface RunReportApproval {
  taskId: string;
  /** The checkpoint verdict status ("completed" = approved, "failed" = denied...). */
  verdict: string;
  at?: string;
}

/**
 * V2-P08: one applied steer-plan revision surfaced in the run report (the
 * runtime persists them as `steerRevisions:<runId>` in the run's durable
 * store; the report reads the raw persisted records back). Additive — never
 * read by resume().
 */
export interface RunReportSteerRevision {
  note?: string;
  reason?: string;
  currentPhase?: string;
  phases?: Array<{ title: string; budget?: number }>;
  /** The journal callIndex the revision was recorded at (frame-scoped). */
  callIndex?: number;
}

export interface RunReport {
  schemaVersion: 3;
  runId: string;
  workflowName: string;
  status: RunStatus;
  /** Why the run ended the way it did: "completed", "failed:<code>",
   *  "paused:<pauseReason>", or "aborted". */
  terminationReason: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
    freshSpend?: number;
  };
  budget?: { limit: number | null; spent: number };
  /**
   * V2-QW3: run-level total-output accounting, when the run configured a
   * `maxTotalOutputChars` ceiling (read from the durable entries view's
   * `outputBudget:<runId>` key, written by workflow.ts at run end). Absent
   * on runs with no ceiling. Additive — never read by resume().
   */
  outputBudget?: RunReportOutputBudget;
  agents: RunReportAgent[];
  phases: RunReportPhase[];
  approvals: RunReportApproval[];
  truncations: RunReportTruncation[];
  /**
   * V2-P08: the applied steer-plan revisions (journaled plan-rescopes), read
   * from the durable entries view's `steerRevisions:<runId>` key (written by
   * workflow.ts). Absent when the run submitted no steer revision, or when no
   * durable view was supplied. Additive — never read by resume().
   */
  steerRevisions?: RunReportSteerRevision[];
  /** The run's durable-store view (entries + provenance ledger), when the run
   *  bound one and it is still registered at report time. */
  durable?: {
    entries: Record<string, unknown>;
    ledger: Array<{
      id?: string;
      source?: string;
      file?: string;
      agent?: string;
      phase?: string;
      detail?: unknown;
      timestamp?: string;
    }>;
  };
  /**
   * V2-P09 (re-scoped): the run's cross-run token-spend ledger entry
   * (`spendLedger:<runId>`, written by workflow.ts at run end into the run's
   * durable store), parsed from the durable entries view. Absent when the run
   * bound no durable sink, or the entry is malformed/not yet written. Additive
   * — never read by resume().
   */
  spendLedger?: unknown;
  /**
   * V2-N2: the run's conformance-trend block (`conformanceTrend:<runId>`,
   * written by the spec-conformance script into the run's durable store),
   * parsed from the durable entries view. Absent when the run bound no durable
   * sink, the script was not spec-conformance, or the workspace was not
   * fingerprint-able. Additive — never read by resume().
   */
  conformanceTrend?: RunReportConformanceTrend | null;
}

/**
 * V2-N2: the machine-readable trend block the run report surfaces — the
 * spec-conformance script's fingerprint-keyed score ledger entry for THIS run
 * with its delta vs the prior audit of the same workspace fingerprint.
 * Deliberately a shallow shape (no raw evidence payloads): the trend is an
 * observability summary; the durable ledger holds the full records.
 */
export interface RunReportConformanceTrend {
  /** The N01 workspace-fingerprint content-derived key this run audited. */
  fingerprint: string;
  /** The run that produced this trend record. */
  runId: string;
  /** This run's machine-computed conformance score (0-100). */
  score: number;
  covered: number;
  total: number;
  /** The prior audit's score on the same fingerprint (null when first). */
  priorScore: number | null;
  /** score - priorScore (null when there was no prior audit). */
  scoreDelta: number | null;
  /** Requirements that regressed covered → missing vs the prior audit. */
  regression: string[];
  /** Requirements that improved missing → covered vs the prior audit. */
  improvement: string[];
}

export interface BuildRunReportOptions {
  /** The run's durable store (resolved from the run registry by the caller). */
  durable?: { entries: Record<string, unknown>; ledger: unknown[] } | null;
  /** Explicit model-tiers config; defaults to loadModelTierConfig(). */
  tierConfig?: ModelTierConfig | null;
  /** The session's main model — the fallback tier label when nothing matched. */
  mainModel?: string;
}

/**
 * Termination reason derived from the persisted status + error/pause fields.
 */
export function terminationReason(state: PersistedRunState): string {
  switch (state.status) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "paused":
      return `paused:${state.pauseReason ?? "unknown"}`;
    case "failed": {
      // Persisted failures surface through the run's failed agents / result;
      // use the first failed agent's code when present for an actionable code.
      const failed = state.agents?.find((a) => a.status === "error" && a.errorCode);
      return failed ? `failed:${failed.errorCode}` : "failed";
    }
    case "running":
      return "running";
    case "pending":
      return "pending";
    default:
      return String(state.status);
  }
}

/**
 * V2-QW3: output-budget key in the run's durable-store entries
 * (`outputBudget:<runId>`, written by workflow.ts's end-of-run flush).
 */
const OUTPUT_BUDGET_PREFIX = "outputBudget";

/**
 * Extract the run's persisted output-budget accounting from the durable
 * entries view (V2-QW3). Returns undefined when the run persisted no output
 * budget (no durable view, or no ceiling configured) so the report shape
 * stays unchanged for ceiling-less runs.
 */
function readOutputBudget(entries: Record<string, unknown>, runId: string): RunReportOutputBudget | undefined {
  const raw = entries[`${OUTPUT_BUDGET_PREFIX}:${runId}`];
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("limit" in raw) ||
    !("spent" in raw) ||
    typeof (raw as { limit: unknown }).limit !== "number" ||
    typeof (raw as { spent: unknown }).spent !== "number"
  ) {
    return undefined;
  }
  return { limit: (raw as { limit: number }).limit, spent: (raw as { spent: number }).spent };
}

/**
 * V2-P08: steer-revision key in the run's durable-store entries
 * (`steerRevisions:<runId>`, written by workflow.ts's steerPlan.submit and
 * the end-of-run flush).
 */
const STEER_REVISIONS_PREFIX = "steerRevisions";

/**
 * Extract the run's persisted applied steer revisions from the durable
 * entries view (V2-P08). Returns undefined when the run persisted no steer
 * revision (no durable view, or no submit happened) so the report shape stays
 * unchanged for unsteered runs.
 */
function readSteerRevisions(entries: Record<string, unknown>, runId: string): RunReportSteerRevision[] | undefined {
  const raw = entries[`${STEER_REVISIONS_PREFIX}:${runId}`];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const revisions: RunReportSteerRevision[] = [];
  for (const record of raw) {
    if (typeof record !== "object" || record === null) continue;
    const revision =
      typeof (record as { revision?: unknown }).revision === "object" &&
      (record as { revision?: unknown }).revision !== null
        ? ((record as { revision?: unknown }).revision as Record<string, unknown>)
        : (record as Record<string, unknown>);
    const row: RunReportSteerRevision = {};
    if (typeof revision.note === "string") row.note = revision.note;
    if (typeof revision.reason === "string") row.reason = revision.reason;
    if (typeof revision.currentPhase === "string") row.currentPhase = revision.currentPhase;
    if (Array.isArray(revision.phases)) {
      const phases: Array<{ title: string; budget?: number }> = [];
      for (const entry of revision.phases) {
        if (typeof entry !== "object" || entry === null) continue;
        const phaseRow: { title: string; budget?: number } = {
          title:
            typeof (entry as { title?: unknown }).title === "string"
              ? ((entry as { title?: unknown }).title as string)
              : "",
        };
        if (typeof (entry as { budget?: unknown }).budget === "number") {
          phaseRow.budget = (entry as { budget?: unknown }).budget as number;
        }
        if (phaseRow.title.length > 0) phases.push(phaseRow);
      }
      if (phases.length > 0) row.phases = phases;
    }
    if (typeof (record as { callIndex?: unknown }).callIndex === "number") {
      row.callIndex = (record as { callIndex?: unknown }).callIndex as number;
    }
    revisions.push(row);
  }
  return revisions.length > 0 ? revisions : undefined;
}

/**
 * One row of the recent-reports listing (V2-QW5), derived from the report
 * artifact itself so a listing never needs to parse the run record too.
 */
export interface RunReportSummary {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  reportPath: string;
}

/**
 * V2-QW5: read one run's report artifact (`<runsDir>/reports/<runId>.json`),
 * missing-file safe. Returns the parsed report, or null when the file is
 * absent or malformed (a malformed/legacy artifact must never throw the
 * caller — the report is an observability artifact, not a contract).
 */
export async function readRunReport(runsDir: string, runId: string): Promise<RunReport | null> {
  try {
    const raw = await readFile(runReportPath(runsDir, runId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { runId?: unknown }).runId !== "string") {
      return null;
    }
    return parsed as RunReport;
  } catch {
    return null;
  }
}

/**
 * V2-QW5: list recent report artifacts under `<runsDir>/reports/*.json`,
 * newest-first (sorted by the report's startedAt, runId as a stable tiebreak).
 * Malformed/empty entries are skipped silently (best-effort observability).
 * `limit` bounds the returned rows (default 25). Deterministic for a fixed
 * set of report files — never wall-clock dependent.
 */
export async function listRunReports(runsDir: string, limit: number = 25): Promise<RunReportSummary[]> {
  let names: string[];
  try {
    names = await readdir(join(runsDir, RUN_REPORTS_SUBDIR));
  } catch {
    // No reports dir yet → empty listing, never an error.
    return [];
  }
  const rows: RunReportSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const report = await readRunReport(runsDir, name.slice(0, -".json".length));
    if (report === null) continue;
    rows.push({
      runId: report.runId,
      workflowName: report.workflowName,
      status: report.status,
      startedAt: report.startedAt,
      ...(report.completedAt !== undefined ? { completedAt: report.completedAt } : {}),
      reportPath: runReportPath(runsDir, report.runId),
    });
  }
  rows.sort((a, b) =>
    a.startedAt === b.startedAt
      ? a.runId < b.runId
        ? 1
        : a.runId > b.runId
          ? -1
          : 0
      : a.startedAt < b.startedAt
        ? 1
        : -1,
  );
  return rows.slice(0, limit);
}

/**
 * Parse capEmbedded truncation reports out of the persisted log stream. The
 * capEmbedded log site (workflow.ts) records every truncation as
 * `embedded payload capped at <n> chars (was <m>); tail detail omitted (marker added)`.
 * Returns one entry per distinct (cappedChars, originalChars) pair with its
 * count, ordered by first occurrence.
 */
export function deriveTruncationReports(logs: readonly string[] | undefined): RunReportTruncation[] {
  if (!logs || logs.length === 0) return [];
  const byKey = new Map<string, RunReportTruncation>();
  const order: string[] = [];
  const pattern = /embedded payload capped at (\d+) chars \(was (\d+)\)/g;
  for (const line of logs) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(line);
    while (match !== null) {
      const cappedChars = Number.parseInt(match[1], 10);
      const originalChars = Number.parseInt(match[2], 10);
      const key = `${cappedChars}:${originalChars}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        byKey.set(key, { cappedChars, originalChars, count: 1 });
        order.push(key);
      }
      match = pattern.exec(line);
    }
  }
  return order.map((key) => byKey.get(key) as RunReportTruncation);
}

/**
 * Reverse-match an actual model spec to the tier whose configured route
 * resolves to it (QW5). Falls back to `undefined` — the caller decides the
 * fallback label.
 */
function tierForModel(
  model: string | undefined,
  config: ModelTierConfig | null,
  mainModel: string | undefined,
): string | undefined {
  if (!model) return undefined;
  if (!config) {
    // No model-tiers.json: an untagged agent on the session main is the
    // default-tier route; anything else is an explicit model choice.
    return model === mainModel ? "default" : undefined;
  }
  for (const tier of sortedTierNames(config)) {
    const resolved = resolveTierModel(tier, config, mainModel);
    if (resolved !== undefined && resolved === model) return tier;
  }
  return undefined;
}

/**
 * V2-QW2: phase-budget key prefix in the run's durable-store entries
 * (`phaseBudgets:<runId>:<title>`, written by workflow.ts phase()).
 */
const PHASE_BUDGETS_PREFIX = "phaseBudgets";

/**
 * Extract the run's persisted phase budgets from the durable entries view
 * (V2-QW2). Returns undefined when the run persisted no budget (no durable
 * view, or no phase declared a budget) so the report shape stays unchanged.
 */
function readPhaseBudgets(entries: Record<string, unknown>, runId: string): Record<string, number> | undefined {
  const prefix = `${PHASE_BUDGETS_PREFIX}:${runId}:`;
  let budgets: Record<string, number> | undefined;
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(prefix) || typeof value !== "number") continue;
    if (budgets === undefined) budgets = {};
    budgets[key.slice(prefix.length)] = value;
  }
  return budgets;
}

/**
 * Per-phase QW5 row: the phase's declared model (script meta), the actual
 * models its agents ran on, the reverse-matched tier, an honest routing
 * reason string, and (V2-QW2) the persisted soft sub-budget when one was
 * declared and the run bound a durable sink that persisted it.
 */
export function derivePhaseReport(
  title: string,
  agents: ReadonlyArray<PersistedRunState["agents"][number]>,
  declaredModel: string | undefined,
  config: ModelTierConfig | null,
  mainModel: string | undefined,
  budget: number | undefined,
): RunReportPhase {
  const phaseAgents = agents.filter((a) => (a.phase ?? undefined) === title);
  const spend = phaseAgents.reduce((sum, a) => sum + (typeof a.tokens === "number" ? a.tokens : 0), 0);
  const models = [...new Set(phaseAgents.map((a) => a.model).filter((m): m is string => Boolean(m)))];
  const actualModel = models.length === 1 ? models[0] : undefined;
  const tier = tierForModel(actualModel ?? declaredModel, config, mainModel);
  let routingReason: string;
  if (declaredModel) {
    routingReason = `phase declares model "${declaredModel}" in the script meta`;
  } else if (tier !== undefined && config) {
    routingReason = `agents resolved to tier "${tier}" (model-tiers config route "${actualModel ?? "?"}")`;
  } else if (actualModel) {
    routingReason = `explicit model choice "${actualModel}" (no matching tier route)`;
  } else if (phaseAgents.length === 0) {
    routingReason = "no agents attributed to this phase";
  } else {
    routingReason = "session default routing (no phase model, no tier route)";
  }
  return {
    name: title,
    spend,
    agentCount: phaseAgents.length,
    ...(budget !== undefined ? { budget } : {}),
    ...(declaredModel !== undefined ? { model: declaredModel } : {}),
    ...(tier !== undefined ? { tier } : {}),
    routingReason,
  };
}

/**
 * V2-N2: conformance-trend key in the run's durable-store entries
 * (`conformanceTrend:<runId>`, written by the spec-conformance script's Report
 * phase via putOnce — replay-idempotent, one record per run).
 */
const CONFORMANCE_TREND_PREFIX = "conformanceTrend";

/**
 * Extract the run's conformance-trend block from the durable entries view
 * (V2-N2). Returns undefined when the run persisted no trend record (no
 * durable view, the script was not spec-conformance, or the workspace was not
 * fingerprint-able) so the report shape stays unchanged for other patterns.
 * Malformed records degrade to null (never a throw — the trend is an
 * observability artifact, not a contract).
 */
function readConformanceTrend(
  entries: Record<string, unknown>,
  runId: string,
): RunReportConformanceTrend | null | undefined {
  const raw = entries[`${CONFORMANCE_TREND_PREFIX}:${runId}`];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.fingerprint !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.score !== "number" ||
    typeof record.covered !== "number" ||
    typeof record.total !== "number"
  ) {
    return null;
  }
  return {
    fingerprint: record.fingerprint,
    runId: record.runId,
    score: record.score,
    covered: record.covered,
    total: record.total,
    priorScore: typeof record.priorScore === "number" ? record.priorScore : null,
    scoreDelta: typeof record.scoreDelta === "number" ? record.scoreDelta : null,
    regression: Array.isArray(record.regression) ? record.regression.filter((x) => typeof x === "string") : [],
    improvement: Array.isArray(record.improvement) ? record.improvement.filter((x) => typeof x === "string") : [],
  };
}

/**
 * Build the machine-readable report from a persisted run record.
 */
export function buildRunReport(state: PersistedRunState, options: BuildRunReportOptions = {}): RunReport {
  const config = options.tierConfig !== undefined ? options.tierConfig : loadModelTierConfig();
  const mainModel = options.mainModel;
  let metaPhases: Array<{ title: string; model?: string }> = [];
  try {
    const parsed = parseWorkflowScript(state.script);
    metaPhases = parsed.meta.phases ?? [];
  } catch {
    // A malformed/legacy script must never fail the report — phases fall back
    // to the persisted titles alone.
  }
  const declaredByTitle = new Map(metaPhases.map((p) => [p.title, p.model]));
  // V2-QW2: the run's persisted phase budgets, read from the durable entries
  // view (`phaseBudgets:<runId>:<title>` keys written by workflow.ts phase()).
  const phaseBudgets =
    options.durable && typeof options.durable.entries === "object" && options.durable.entries !== null
      ? readPhaseBudgets(options.durable.entries as Record<string, unknown>, state.runId)
      : undefined;
  // V2-QW3: the run's persisted total-output accounting, read from the same
  // durable entries view (written by workflow.ts's end-of-run flush).
  const outputBudget =
    options.durable && typeof options.durable.entries === "object" && options.durable.entries !== null
      ? readOutputBudget(options.durable.entries as Record<string, unknown>, state.runId)
      : undefined;
  // V2-P08: the run's applied steer-plan revisions, read from the same durable
  // entries view (written by workflow.ts's steerPlan.submit + end-of-run
  // flush). Absent for unsteered runs or when no durable view was supplied.
  const steerRevisions =
    options.durable && typeof options.durable.entries === "object" && options.durable.entries !== null
      ? readSteerRevisions(options.durable.entries as Record<string, unknown>, state.runId)
      : undefined;

  const phaseTitles = state.phases ?? [];
  const phases = phaseTitles.map((title) =>
    derivePhaseReport(title, state.agents ?? [], declaredByTitle.get(title), config, mainModel, phaseBudgets?.[title]),
  );

  const agents: RunReportAgent[] = (state.agents ?? []).map((a) => ({
    id: a.id,
    ...(a.callId !== undefined ? { callId: a.callId } : {}),
    label: a.label,
    ...(a.phase !== undefined ? { phase: a.phase } : {}),
    ...(a.model !== undefined ? { model: a.model } : {}),
    outcome: a.status,
    ...(a.tokens !== undefined ? { tokens: a.tokens } : {}),
    ...(a.tokenUsage !== undefined ? { tokenUsage: a.tokenUsage } : {}),
    ...(a.error !== undefined ? { error: a.error } : {}),
    ...(a.errorCode !== undefined ? { errorCode: a.errorCode } : {}),
  }));

  const approvals: RunReportApproval[] = (state.checkpoints ?? []).map((c) => ({
    taskId: c.taskId,
    verdict: c.status,
    ...(c.timestamp !== undefined ? { at: c.timestamp } : {}),
  }));

  // V2-P09 (re-scoped): the run's own spend-ledger entry, read from the durable
  // entries view (written by workflow.ts at run end). The raw parsed value is
  // surfaced as-is — the report is an observability artifact, not a contract.
  const spendLedger =
    options.durable && typeof options.durable.entries === "object" && options.durable.entries !== null
      ? (options.durable.entries as Record<string, unknown>)[`spendLedger:${state.runId}`]
      : undefined;
  // V2-N2: the run's conformance-trend block, read from the same durable
  // entries view (written by the spec-conformance script's Report phase via
  // putOnce). Absent for other patterns / non-fingerprintable workspaces.
  const conformanceTrend =
    options.durable && typeof options.durable.entries === "object" && options.durable.entries !== null
      ? readConformanceTrend(options.durable.entries as Record<string, unknown>, state.runId)
      : undefined;

  const truncations = deriveTruncationReports(state.logs);

  const tokenUsage = state.tokenUsage
    ? {
        input: state.tokenUsage.input,
        output: state.tokenUsage.output,
        total: state.tokenUsage.total,
        ...(state.tokenUsage.cost !== undefined ? { cost: state.tokenUsage.cost } : {}),
        ...(state.tokenUsage.cacheRead !== undefined ? { cacheRead: state.tokenUsage.cacheRead } : {}),
        ...(state.tokenUsage.cacheWrite !== undefined ? { cacheWrite: state.tokenUsage.cacheWrite } : {}),
        ...(state.tokenUsage.freshSpend !== undefined ? { freshSpend: state.tokenUsage.freshSpend } : {}),
      }
    : undefined;

  const budget =
    state.tokenUsage !== undefined
      ? {
          limit: state.tokenBudget ?? null,
          spent: state.tokenUsage.total,
        }
      : undefined;

  return {
    schemaVersion: RUN_REPORT_SCHEMA_VERSION,
    runId: state.runId,
    workflowName: state.workflowName,
    status: state.status,
    terminationReason: terminationReason(state),
    startedAt: state.startedAt,
    ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(outputBudget !== undefined ? { outputBudget } : {}),
    ...(steerRevisions !== undefined ? { steerRevisions } : {}),
    agents,
    phases,
    approvals,
    truncations,
    ...(options.durable ? { durable: options.durable as RunReport["durable"] } : {}),
    ...(spendLedger !== undefined ? { spendLedger } : {}),
    ...(conformanceTrend !== undefined ? { conformanceTrend } : {}),
  };
}

export interface WriteRunReportOptions extends BuildRunReportOptions {
  /** Override the runs dir (defaults to workflowProjectPaths(cwd).runsDir). */
  runsDir?: string;
  /** Filesystem seam for tests. */
  fs?: Partial<PersistenceFsLayer>;
}

/**
 * Write the run report atomically under the run's persistence dir
 * (`<runsDir>/reports/<runId>.json`). Best-effort by construction: a report
 * write must never fail the run (the manager calls this after the run has
 * already settled on disk). Returns the report path, or null when the write
 * failed.
 */
export function writeRunReport(state: PersistedRunState, options: WriteRunReportOptions = {}): string | null {
  const report = buildRunReport(state, options);
  const runsDir = options.runsDir ?? workflowProjectPaths(".").runsDir;
  const reportPath = runReportPath(runsDir, state.runId);
  const fs = resolvePersistenceFs(options.fs);
  try {
    ensureDir(fs, join(runsDir, RUN_REPORTS_SUBDIR));
    writeJsonAtomicWithBackup(fs, reportPath, report);
    return reportPath;
  } catch {
    return null;
  }
}
