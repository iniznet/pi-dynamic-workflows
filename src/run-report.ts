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
 *   - per-phase budget spend (QW5: economy tier + routing reason per phase)
 *   - approvals (persisted checkpoint verdicts)
 *   - truncations (QW3: capEmbedded reports, parsed from the persisted log
 *     stream — the capEmbedded log site in workflow.ts records truncations as
 *     `embedded payload capped at <n> chars (was <m>)` lines)
 *   - the run's durable-store view (provenance ledger + entries) when present
 */

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
export const RUN_REPORT_SCHEMA_VERSION = 1 as const;

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
  /** Soft per-phase sub-budget, when it was declared at runtime and the run
   *  persisted it. Budgets are live-only today (the phase() helper carves them
   *  in memory); absent here when not persisted. */
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

export interface RunReportApproval {
  taskId: string;
  /** The checkpoint verdict status ("completed" = approved, "failed" = denied...). */
  verdict: string;
  at?: string;
}

export interface RunReport {
  schemaVersion: 1;
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
  agents: RunReportAgent[];
  phases: RunReportPhase[];
  approvals: RunReportApproval[];
  truncations: RunReportTruncation[];
  /** The run's durable-store view (entries + provenance ledger), when the run
   *  bound one and it is still registered at report time. */
  durable?: {
    entries: Record<string, unknown>;
    ledger: Array<{ id?: string; source?: string; file?: string; agent?: string; phase?: string; timestamp?: string }>;
  };
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
 * Per-phase QW5 row: the phase's declared model (script meta), the actual
 * models its agents ran on, the reverse-matched tier, and an honest routing
 * reason string.
 */
export function derivePhaseReport(
  title: string,
  agents: ReadonlyArray<PersistedRunState["agents"][number]>,
  declaredModel: string | undefined,
  config: ModelTierConfig | null,
  mainModel: string | undefined,
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
    ...(declaredModel !== undefined ? { model: declaredModel } : {}),
    ...(tier !== undefined ? { tier } : {}),
    routingReason,
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

  const phaseTitles = state.phases ?? [];
  const phases = phaseTitles.map((title) =>
    derivePhaseReport(title, state.agents ?? [], declaredByTitle.get(title), config, mainModel),
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
    agents,
    phases,
    approvals,
    truncations,
    ...(options.durable ? { durable: options.durable as RunReport["durable"] } : {}),
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
