/**
 * workflow-damage-control.ts — the `workflow_damage_control` toolset.
 *
 * One agent-facing surface for inspecting, controlling, killing, recovering,
 * and cleaning the CURRENT ACTIVE workflow and its subagents. Every verb is
 * explicit, reversible where possible, and non-destructive by default:
 *
 *  - `list`/`status`/`agents` — inspection (read-only; `status`/`agents`
 *    resolve session-scoped first, then fall back to all persisted runs).
 *  - `pause`/`resume`/`stop` — lifecycle (session-scoped mutators).
 *  - `kill-agent` — terminate ONE subagent with clean in-run reconciliation
 *    (never run-fatal by itself; fan-outs absorb the item, see §5.2).
 *  - `recover` — crash/failed classification + stale-lease release + journal
 *    prefix replay via WorkflowManager.resume() (never deletes state).
 *  - `clean` — orphan/stale-lease/worktree sweep, DRY-RUN BY DEFAULT; acts
 *    only with an explicit `dryRun:false`; never deletes run state.
 *
 * Design: tasks/damage-control-recovery/design.md. The shape deliberately
 * mirrors workflow-control-tool.ts (single-object schema, normalizeInput,
 * per-status allowed-action matrix, structured `{content, details}` results,
 * typebox lazy-peer pattern) so the two tools stay consistent for models.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { aggregateAgentUsage, tokenFigures, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { WorkflowErrorCode } from "./errors.js";
import { lazyPeerImport, MissingPeerError, PEER_DEPENDENCIES } from "./peer-deps.js";
import {
  journalEntryKey,
  loadPersistedJournal,
  type PersistedRunState,
  type RunLeaseInfo,
  type RunStatus,
} from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { gitExec, pruneWorktrees, sweepOrphanWorktrees } from "./worktree.js";

// Lazy peer loading (H4): typebox loads via top-level await at module evaluation
// instead of a module-scope import, so this module stays importable when the
// peer is missing or incompatible; the MissingPeerError diagnostic is raised at
// createWorkflowDamageControlTool(). Mirrors workflow-control-tool.ts.
let typeboxNamespace: typeof import("typebox") | undefined;
try {
  typeboxNamespace = await lazyPeerImport<typeof import("typebox")>("typebox");
} catch {
  // Deferred to createWorkflowDamageControlTool().
}

const Type = typeboxNamespace?.Type;
const damageControlSchema = Type?.Object(
  // Single top-level object, exactly like workflowControlSchema: a top-level
  // anyOf/discriminated union serializes without `type: "object"`, which strict
  // providers (e.g. DeepSeek) reject. Per-action key requirements are enforced
  // at runtime in normalizeDamageControlInput().
  {
    action: Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("agents"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("stop"),
        Type.Literal("kill-agent"),
        Type.Literal("recover"),
        Type.Literal("clean"),
      ],
      {
        description:
          "list = all session runs (no runId); clean = orphan sweep (no runId, dryRun default true); " +
          "status/agents/pause/resume/stop/kill-agent/recover act on one run and require runId; " +
          "kill-agent also requires agentId.",
      },
    ),
    runId: Type.Optional(Type.String({ minLength: 1, description: "Canonical workflow run ID." })),
    agentId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Agent id: numeric agents[].id or a callId of the form runId:callIndex. Required for kill-agent; optional filter for agents.",
      }),
    ),
    dryRun: Type.Optional(
      Type.Boolean({ description: "clean only. Default true = report candidates without acting. false = act." }),
    ),
    script: Type.Optional(
      Type.String({
        description:
          "resume/recover only. Optional EDITED script for cached-prefix reuse (maps to ResumeOptions.script).",
      }),
    ),
  },
  { additionalProperties: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Public types (all exported from this module, see design §3.1)
// ─────────────────────────────────────────────────────────────────────────────

export const DAMAGE_CONTROL_ACTIONS = [
  "list",
  "status",
  "agents",
  "pause",
  "resume",
  "stop",
  "kill-agent",
  "recover",
  "clean",
] as const;

export type DamageControlAction = (typeof DAMAGE_CONTROL_ACTIONS)[number];

export const DAMAGE_CONTROL_READONLY_ACTIONS = ["list", "status", "agents"] as const;

/** "readonly" = inspection verbs only (subagent exposure); "full" = everything. */
export type DamageControlCapabilities = "readonly" | "full";

export interface DamageControlInput {
  action: DamageControlAction;
  runId?: string;
  agentId?: string;
  dryRun?: boolean;
  script?: string;
}

export interface WorkflowDamageControlToolOptions {
  manager: WorkflowManager;
  /** Project cwd used by `clean` for repo-root resolution; defaults to process.cwd(). */
  cwd?: string;
  /** "readonly" = inspection verbs only (subagent exposure); "full" = everything (default). */
  capabilities?: DamageControlCapabilities;
}

export interface DeepRunSummary {
  runId: string;
  workflowName: string;
  status: RunStatus;
  sessionId?: string;
  phase: string | null;
  /** getRun(runId) !== undefined — the run is live in THIS process. */
  live: boolean;
  pauseReason?: string;
  resetHint?: string;
  counts: {
    total: number;
    done: number;
    running: number;
    error: number;
    skipped: number;
  };
  tokenTotal: number;
  durationMs?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  journal: { entries: number; firstIndex: number | null; lastIndex: number | null; compacted: boolean };
  checkpoints: { total: number; first?: string; last?: string };
  lease: RunLeaseInfo | null;
  config: {
    autoResume?: boolean;
    failOnExhaustedAgent?: boolean;
    compactJournal?: boolean;
    tokenBudget?: number | null;
    maxAgents?: number;
    agentTimeoutMs?: number | null;
    drainTimeoutMs?: number;
    concurrency?: number;
    agentRetries?: number;
    toolset?: string;
  };
  logs: number;
  resultPresent: boolean;
}

export interface AgentSummary {
  id: number;
  callId?: string;
  label: string;
  phase?: string;
  status: WorkflowAgentSnapshot["status"];
  tokens?: number;
  /** tokenUsage.total when the provider reported a breakdown. */
  tokenTotal?: number;
  /** run.agentRetries — per-agent retry ATTEMPTS are not persisted today (see tool description). */
  retries: number;
  error?: string;
  errorCode?: string;
  recoverable?: boolean;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  /**
   * ISO instant of the agent's latest per-agent event (live snapshot only,
   * derived from lastActiveAtMs). EPHEMERAL — absent on cold/persisted rows;
   * recomputed on resume. Drives the idle soft-hint, never a "stuck" claim.
   */
  lastActiveAt?: string;
  /** One-line failing-operation summary, when the failed agent made tool calls. */
  failingOperation?: string;
}

export type RecoveryClassification =
  | { kind: "already-running"; reason: string }
  | { kind: "owned-elsewhere"; reason: string }
  | { kind: "orphan-recoverable"; reason: string }
  | { kind: "already-recoverable"; reason: string }
  | { kind: "not-recoverable"; reason: string }
  | { kind: "missing-state"; reason: string };

export interface RecoveryOutcome {
  classification: RecoveryClassification;
  statusBefore: RunStatus;
  statusAfter: RunStatus;
  leaseAction: "none" | "reclaimed" | "acquire-failed";
  resumed: boolean;
  error?: string;
}

export interface KillAgentResult {
  ok: boolean;
  reason?: string;
  runId: string;
  agentId: string;
  callId?: string;
  found: boolean;
  alreadyTerminal?: boolean;
  /** An in-flight controller was aborted (live run, this process). */
  liveAborted: boolean;
  /** Persisted agents[] updated (CAS). */
  reconciled: boolean;
  /** Live snapshot agent marked. */
  snapshotUpdated: boolean;
}

export interface CleanCandidate {
  kind: "stale-lease" | "ghost-worktree" | "orphan-run" | "tmp-branch";
  runId?: string;
  path?: string;
  detail: string;
}

export interface CleanReport {
  dryRun: boolean;
  candidates: CleanCandidate[];
  acted: {
    staleLeasesReleased: number;
    orphanRunsNormalized: number;
    ghostWorktreesRemoved: number;
    tmpBranchesRemoved: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-testable without a manager — design §3.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Runtime schema-level validation; throws structured errors (design §2.3). */
export function normalizeDamageControlInput(value: unknown): DamageControlInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_damage_control requires an object argument");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.action !== "string" || !(DAMAGE_CONTROL_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`workflow_damage_control requires action: ${DAMAGE_CONTROL_ACTIONS.join("|")}`);
  }
  const action = input.action as DamageControlAction;

  const allowedKeys: Record<DamageControlAction, ReadonlySet<string>> = {
    list: new Set(["action"]),
    clean: new Set(["action", "dryRun"]),
    "kill-agent": new Set(["action", "runId", "agentId"]),
    resume: new Set(["action", "runId", "script"]),
    recover: new Set(["action", "runId", "script"]),
    status: new Set(["action", "runId"]),
    agents: new Set(["action", "runId", "agentId"]),
    pause: new Set(["action", "runId"]),
    stop: new Set(["action", "runId"]),
  };
  const extraKey = Object.keys(input).find((key) => !allowedKeys[action].has(key));
  if (extraKey) throw new Error(`workflow_damage_control action "${action}" does not accept ${extraKey}`);

  if (action !== "list" && action !== "clean" && (typeof input.runId !== "string" || !input.runId.trim())) {
    throw new Error(`workflow_damage_control action "${action}" requires runId`);
  }
  if (action === "kill-agent" && (typeof input.agentId !== "string" || !input.agentId.trim())) {
    throw new Error(`workflow_damage_control action "kill-agent" requires agentId`);
  }

  return {
    action,
    runId: typeof input.runId === "string" ? input.runId : undefined,
    agentId: typeof input.agentId === "string" ? input.agentId : undefined,
    dryRun: typeof input.dryRun === "boolean" ? input.dryRun : undefined,
    script: typeof input.script === "string" ? input.script : undefined,
  };
}

/** Per-status + capability verb matrix for error payloads (design §4). */
export function allowedDamageControlActions(
  status: RunStatus,
  capabilities: DamageControlCapabilities,
): DamageControlAction[] {
  if (capabilities === "readonly") return [...DAMAGE_CONTROL_READONLY_ACTIONS];
  switch (status) {
    case "running":
      return ["list", "status", "agents", "pause", "stop", "kill-agent", "clean"];
    case "paused":
      return ["list", "status", "agents", "resume", "stop", "kill-agent", "recover", "clean"];
    case "failed":
    case "pending":
      return ["list", "status", "agents", "resume", "kill-agent", "recover", "clean"];
    case "completed":
    case "aborted":
      return ["list", "status", "agents", "clean"];
  }
}

/** Deep `status` payload: phase, journal, checkpoints, lease, config, counts. */
export function summarizeRunDeep(
  run: PersistedRunState,
  live: WorkflowSnapshot | null,
  lease: RunLeaseInfo | null,
): DeepRunSummary {
  const agents = live?.agents ?? run.agents;
  const liveUsage = tokenFigures(live?.tokenUsage);
  const persistedUsage = tokenFigures(run.tokenUsage);
  const agentUsage = aggregateAgentUsage(agents);
  const journal = loadPersistedJournal(run);
  const checkpoints = run.checkpoints ?? [];
  return {
    runId: run.runId,
    workflowName: live?.name ?? run.workflowName,
    status: run.status,
    sessionId: run.sessionId,
    phase: live?.currentPhase ?? run.currentPhase ?? null,
    live: live !== null && live !== undefined,
    pauseReason: run.pauseReason,
    resetHint: run.resetHint,
    counts: countAgents(agents),
    tokenTotal: Math.max(
      liveUsage.fresh + liveUsage.cacheRead,
      persistedUsage.fresh + persistedUsage.cacheRead,
      agentUsage.fresh + agentUsage.cacheRead,
    ),
    durationMs: live?.durationMs ?? run.durationMs,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    journal: {
      entries: journal.length,
      firstIndex: journal[0]?.index ?? null,
      lastIndex: journal[journal.length - 1]?.index ?? null,
      compacted: run.journalCompacted !== undefined,
    },
    checkpoints: {
      total: checkpoints.length,
      first: checkpoints[0]?.taskId,
      last: checkpoints[checkpoints.length - 1]?.taskId,
    },
    lease,
    config: {
      autoResume: run.autoResume,
      failOnExhaustedAgent: run.failOnExhaustedAgent,
      compactJournal: run.compactJournal,
      tokenBudget: run.tokenBudget !== undefined ? run.tokenBudget : null,
      maxAgents: run.maxAgents,
      agentTimeoutMs: run.agentTimeoutMs !== undefined ? run.agentTimeoutMs : null,
      drainTimeoutMs: run.drainTimeoutMs,
      concurrency: run.concurrency,
      agentRetries: run.agentRetries,
      toolset: run.toolset,
    },
    logs: (live?.logs ?? run.logs).length,
    resultPresent: run.result !== undefined,
  };
}

/**
 * Per-agent inventory (`agents` verb): merges the live snapshot (tokens,
 * tokenUsage, error, model) over the persisted record, keyed by callId so a
 * resumed run's live entries overlay the right persisted ones.
 */
export function summarizeAgents(
  run: PersistedRunState,
  live: WorkflowSnapshot | null,
  agentId?: string,
): AgentSummary[] {
  const liveByCallId = new Map<string, WorkflowAgentSnapshot>();
  for (const agent of live?.agents ?? []) {
    liveByCallId.set(agent.callId ?? journalEntryKey(run.runId, agent.id), agent);
  }
  // The persisted run.agents array can LAG the live snapshot while a run is
  // mid-flight: throttled progress writes go through the journal-delta fast
  // path, which appends ONLY the journal sidecar — the agents array lands at
  // the next lifecycle-boundary write. Merge live-only agents (same callId
  // keying as the overlay below) so the inventory never under-reports a run
  // that is genuinely executing.
  const merged: Array<WorkflowAgentSnapshot & { startedAt?: string; endedAt?: string }> = [...run.agents];
  const persistedCallIds = new Set(merged.map((a) => a.callId ?? journalEntryKey(run.runId, a.id)));
  for (const agent of live?.agents ?? []) {
    const callId = agent.callId ?? journalEntryKey(run.runId, agent.id);
    if (!persistedCallIds.has(callId)) merged.push(agent);
  }
  const summaries: AgentSummary[] = [];
  for (const agent of merged) {
    const callId = agent.callId ?? journalEntryKey(run.runId, agent.id);
    if (agentId !== undefined && callId !== agentId && String(agent.id) !== agentId) continue;
    const liveAgent = liveByCallId.get(callId);
    const failing = liveAgent?.failingOperation ?? agent.failingOperation;
    summaries.push({
      id: agent.id,
      callId,
      label: agent.label,
      phase: liveAgent?.phase ?? agent.phase,
      status: liveAgent?.status ?? agent.status,
      tokens: liveAgent?.tokens ?? agent.tokens,
      tokenTotal: (liveAgent?.tokenUsage ?? agent.tokenUsage)?.total,
      retries: run.agentRetries ?? 0,
      error: liveAgent?.error ?? agent.error,
      errorCode: (liveAgent?.errorCode ?? agent.errorCode) as string | undefined,
      recoverable: liveAgent?.recoverable ?? agent.recoverable,
      model: liveAgent?.model ?? agent.model,
      // Live startedAtMs wins (resume seeds it from the SAME persisted ISO, so
      // a replayed agent reports its original start); the persisted ISO is the
      // cold/legacy fallback. lastActiveAt is live-only by nature.
      startedAt:
        typeof liveAgent?.startedAtMs === "number" && Number.isFinite(liveAgent.startedAtMs)
          ? new Date(liveAgent.startedAtMs).toISOString()
          : agent.startedAt,
      endedAt: agent.endedAt,
      lastActiveAt:
        typeof liveAgent?.lastActiveAtMs === "number" && Number.isFinite(liveAgent.lastActiveAtMs)
          ? new Date(liveAgent.lastActiveAtMs).toISOString()
          : undefined,
      failingOperation: failing ? `${failing.op} (line ${failing.line}): ${failing.outcome}` : undefined,
    });
  }
  return summaries;
}

/** Pure orphan/crash classification (design §5.1). */
export function classifyRecoveryAction(
  run: PersistedRunState,
  lease: RunLeaseInfo | null,
  live: boolean,
): RecoveryClassification {
  switch (run.status) {
    case "running":
      if (live) {
        return { kind: "already-running", reason: "run is live in this process; use pause or stop instead" };
      }
      if (!lease || lease.reclaimable) {
        return {
          kind: "orphan-recoverable",
          reason: lease
            ? `lease owner pid=${lease.pid} is ${reclaimableReason(lease)} — reclaimable`
            : "no lease held — orphaned by a crash",
        };
      }
      return { kind: "owned-elsewhere", reason: `run is leased by another live process (pid ${lease.pid})` };
    case "failed":
      return {
        kind: "already-recoverable",
        reason: "failed runs keep their journal; resume replays the completed prefix",
      };
    case "paused":
    case "pending":
      return { kind: "already-recoverable", reason: "paused/pending runs resume by replaying the journaled prefix" };
    case "completed":
    case "aborted":
      return { kind: "not-recoverable", reason: "completed/aborted runs are terminal; start a new run" };
  }
}

/**
 * Pure CAS mutate for kill-agent state reconciliation (design §5.2). Mutates
 * `state` in place (the updateRunState? callback contract) and reports what
 * changed so the caller can render an accurate KillAgentResult.
 */
export function reconcileAgentAfterKill(
  state: PersistedRunState,
  agentId: string,
): { found: boolean; alreadyTerminal: boolean; changed: boolean } {
  const agent = state.agents.find(
    (candidate) =>
      String(candidate.id) === agentId || (candidate.callId ?? journalEntryKey(state.runId, candidate.id)) === agentId,
  );
  if (!agent) return { found: false, alreadyTerminal: false, changed: false };
  if (agent.status === "done" || agent.status === "error" || agent.status === "skipped") {
    return { found: true, alreadyTerminal: true, changed: false };
  }
  agent.status = "error";
  agent.error = "killed via workflow_damage_control";
  agent.errorCode = WorkflowErrorCode.AGENT_KILLED;
  agent.recoverable = false;
  agent.endedAt = new Date().toISOString();
  return { found: true, alreadyTerminal: false, changed: true };
}

/** Pure dry-run candidate list (design §5.3). No I/O beyond existsSync checks. */
export function collectCleanCandidates(
  runs: PersistedRunState[],
  leases: Map<string, RunLeaseInfo | null>,
  worktreePaths: string[],
  projectWorktreesDir: string,
  tmpBranchNames: string[],
): CleanCandidate[] {
  const candidates: CleanCandidate[] = [];
  const projectDir = normalizeWorktreePath(projectWorktreesDir);
  for (const run of runs) {
    const lease = leases.get(run.runId) ?? null;
    if (lease?.reclaimable) {
      candidates.push({
        kind: "stale-lease",
        runId: run.runId,
        detail: `lease pid=${lease.pid} reclaimable (${reclaimableReason(lease)})`,
      });
    }
    if (run.status === "running" && (!lease || lease.reclaimable)) {
      candidates.push({
        kind: "orphan-run",
        runId: run.runId,
        detail: `persisted 'running' with ${lease ? "a reclaimable lease" : "no lease"} — normalize to paused`,
      });
    }
  }
  for (const path of worktreePaths) {
    if (!normalizeWorktreePath(path).startsWith(projectDir)) continue;
    if (!existsSync(path)) {
      candidates.push({ kind: "ghost-worktree", path, detail: "registered worktree whose directory is gone" });
    }
  }
  for (const branch of tmpBranchNames) {
    candidates.push({ kind: "tmp-branch", detail: `temporary pi/wf branch '${branch}' left behind` });
  }
  return candidates;
}

/** `action=.. result=..` text rendering (same style as formatRun in workflow-control-tool.ts). */
export function formatDamageControlText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (typeof value === "string" || (typeof value === "object" && value !== null)) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────────

type DamageControlResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function createWorkflowDamageControlTool(
  options: WorkflowDamageControlToolOptions,
): ToolDefinition<TSchema, Record<string, unknown>> {
  if (!damageControlSchema) throw new MissingPeerError("typebox", PEER_DEPENDENCIES.typebox);
  const manager = options.manager;
  const cwd = options.cwd ?? process.cwd();
  const capabilities = options.capabilities ?? "full";

  return defineTool({
    name: "workflow_damage_control",
    label: "Workflow Damage Control",
    description:
      "Inspect, control, kill, recover, and clean the active workflow and its subagents. Verbs: list (all session runs), " +
      "status (deep run detail incl. journal/lease/config), agents (per-agent inventory, optional agentId filter), " +
      "pause/resume/stop (lifecycle, session-scoped), kill-agent (terminate ONE subagent; never run-fatal by itself — " +
      "parallel/pipeline fan-outs absorb the item, a sequential top-level kill lets the run settle failed/resumable), " +
      "recover (crash/failed classification: reclaims a stale lease, flips the orphan to paused, then resumes with journal " +
      "prefix replay; never deletes state), clean (orphan sweep: stale leases, orphan runs normalized to paused, ghost " +
      "worktrees, tmp pi/wf branches; DRY-RUN BY DEFAULT — acts only with dryRun:false; never deletes run state). " +
      "Mutating verbs are session-scoped; read-only status/agents fall back to all persisted runs. " +
      "Limitation: per-agent retry ATTEMPTS are not persisted; AgentSummary.retries reports the run-level agentRetries setting.",
    promptSnippet:
      "Inspect, pause/resume/stop, kill a subagent, recover, or clean the active workflow by canonical run ID.",
    promptGuidelines: [
      "Use workflow_damage_control for subagent-level control and crash recovery; use workflow_control for the plain 5-verb lifecycle.",
      "kill-agent takes agentId (numeric id or a callId of the form runId:callIndex); a killed agent is never retried and never run-fatal by itself.",
      "clean is dry-run by default — report candidates first; act only when the model/user explicitly requests force with dryRun:false.",
      "recover flips crash orphans to paused (never failed) and resumes from the journal — the completed prefix is not re-run.",
    ],
    parameters: damageControlSchema,
    prepareArguments: normalizeInput,
    async execute(_toolCallId, params) {
      const action = params.action;
      if (capabilities === "readonly" && !(DAMAGE_CONTROL_READONLY_ACTIONS as readonly string[]).includes(action)) {
        return errorResult(action, params.runId ?? "", `action ${action} is not permitted in readonly mode`, [
          ...DAMAGE_CONTROL_READONLY_ACTIONS,
        ]);
      }

      switch (action) {
        case "list": {
          const runs = manager.listRuns();
          const lines = runs.map((run) => {
            const summary = summarizeRunDeep(run, manager.getSnapshot(run.runId), leaseOf(manager, run.runId));
            return formatListLine(summary);
          });
          return result(
            lines.length
              ? `action=list result=ok runs=${lines.length}\n${lines.join("\n")}`
              : "action=list result=ok runs=0",
            { action: "list", result: "ok", runs },
          );
        }

        case "status": {
          const run = findAnyRun(manager, params.runId);
          if (!run) return errorResult("status", params.runId ?? "", "run not found", ["list", "clean"]);
          const summary = summarizeRunDeep(run, manager.getSnapshot(run.runId), leaseOf(manager, run.runId));
          return result(`action=status result=ok ${formatDeepRunLine(summary)}`, {
            action: "status",
            result: "ok",
            run: summary,
          });
        }

        case "agents": {
          const run = findAnyRun(manager, params.runId);
          if (!run) return errorResult("agents", params.runId ?? "", "run not found", ["list", "clean"]);
          const agents = summarizeAgents(run, manager.getSnapshot(run.runId), params.agentId);
          if (params.agentId !== undefined && agents.length === 0) {
            return errorResult("agents", run.runId, `agent ${params.agentId} not found in run ${run.runId}`, [
              "status",
              "agents",
            ]);
          }
          const lines = agents.map(formatAgentLine);
          return result(
            lines.length
              ? `action=agents result=ok runId=${run.runId} agents=${lines.length}\n${lines.join("\n")}`
              : `action=agents result=ok runId=${run.runId} agents=0`,
            { action: "agents", result: "ok", runId: run.runId, agents },
          );
        }

        case "pause": {
          const run = findSessionRun(manager, params.runId);
          if (!run) return errorResult("pause", params.runId ?? "", "run not found", ["list", "clean"]);
          if (!manager.pause(run.runId)) return invalidTransition("pause", run, capabilities);
          return actionSuccess("pause", "paused", manager, run);
        }

        case "resume": {
          const run = findSessionRun(manager, params.runId);
          if (!run) return errorResult("resume", params.runId ?? "", "run not found", ["list", "clean"]);
          const resumed = await manager.resume(run.runId, params.script !== undefined ? { script: params.script } : {});
          if (!resumed) return resumeFailure("resume", run, manager);
          return actionSuccess("resume", "resumed", manager, run);
        }

        case "stop": {
          const run = findSessionRun(manager, params.runId);
          if (!run) return errorResult("stop", params.runId ?? "", "run not found", ["list", "clean"]);
          if (!manager.stop(run.runId)) return invalidTransition("stop", run, capabilities);
          return actionSuccess("stop", "stopped", manager, run);
        }

        case "kill-agent": {
          const run = findSessionRun(manager, params.runId);
          if (!run) return errorResult("kill-agent", params.runId ?? "", "run not found", ["list", "clean"]);
          if (params.agentId === undefined) {
            return errorResult("kill-agent", run.runId, "kill-agent requires agentId", ["status", "agents"]);
          }
          const outcome = await manager.killAgent(run.runId, params.agentId);
          if (!outcome.found) {
            return errorResult("kill-agent", run.runId, `agent ${params.agentId} not found in run ${run.runId}`, [
              "status",
              "agents",
            ]);
          }
          if (outcome.alreadyTerminal) {
            return errorResult("kill-agent", run.runId, `agent ${params.agentId} is already terminal`, [
              "status",
              "agents",
            ]);
          }
          const text = formatDamageControlText({
            action: "kill-agent",
            result: "ok",
            runId: run.runId,
            agentId: params.agentId,
            callId: outcome.callId ?? "-",
            liveAborted: outcome.liveAborted,
            reconciled: outcome.reconciled,
            snapshotUpdated: outcome.snapshotUpdated,
          });
          return result(text, { action: "kill-agent", result: "ok", kill: outcome });
        }

        case "recover": {
          const run = findSessionRun(manager, params.runId);
          if (!run) return errorResult("recover", params.runId ?? "", "run not found", ["list", "clean"]);
          return await recoverRun(manager, run, params.script, capabilities);
        }

        case "clean": {
          return await cleanRuns(manager, cwd, params.dryRun !== false);
        }
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// execute() internals
// ─────────────────────────────────────────────────────────────────────────────

function normalizeInput(value: unknown): DamageControlInput {
  return normalizeDamageControlInput(value);
}

function result(text: string, details: Record<string, unknown>): DamageControlResult {
  return { content: [{ type: "text", text }], details };
}

function errorResult(
  action: string,
  runId: string,
  message: string,
  allowed: DamageControlAction[],
): DamageControlResult {
  return result(
    formatDamageControlText({ action, result: "error", runId, error: message, allowed: allowed.join(",") || "none" }),
    {
      action,
      result: "error",
      runId,
      error: message,
      allowedActions: allowed,
    },
  );
}

function invalidTransition(
  action: string,
  run: PersistedRunState,
  capabilities: DamageControlCapabilities,
): DamageControlResult {
  return errorResult(
    action,
    run.runId,
    `cannot ${action} run with status ${run.status}`,
    allowedDamageControlActions(run.status, capabilities),
  );
}

function actionSuccess(
  action: string,
  actionResult: string,
  manager: WorkflowManager,
  fallback: PersistedRunState,
): DamageControlResult {
  const current = findAnyRun(manager, fallback.runId) ?? fallback;
  const summary = summarizeRunDeep(current, manager.getSnapshot(current.runId), leaseOf(manager, current.runId));
  const text = formatDamageControlText({
    action,
    result: actionResult,
    runId: summary.runId,
    status: summary.status,
  });
  return result(text, { action, result: actionResult, run: summary });
}

function resumeFailure(
  action: "resume" | "recover",
  run: PersistedRunState,
  manager: WorkflowManager,
): DamageControlResult {
  // Distinguish a transition refusal (status moved to something non-resumable)
  // from a lease conflict (another live process owns the run). resume() is
  // advisory-first, so re-check the freshest persisted state.
  const current = manager.listAllRuns().find((candidate) => candidate.runId === run.runId) ?? run;
  const resumable = current.status === "paused" || current.status === "failed" || current.status === "pending";
  if (!resumable) {
    return errorResult(
      action,
      run.runId,
      `cannot ${action} run with status ${current.status}`,
      allowedDamageControlActions(current.status, "full"),
    );
  }
  const leaseInfo = leaseOf(manager, run.runId);
  if (leaseInfo && !leaseInfo.reclaimable && leaseInfo.pid !== process.pid) {
    return errorResult(action, run.runId, `run is leased by another live process (pid ${leaseInfo.pid})`, [
      "status",
      "agents",
    ]);
  }
  return errorResult(action, run.runId, `cannot ${action} run: resume refused (status/lease changed)`, [
    "status",
    "agents",
  ]);
}

async function recoverRun(
  manager: WorkflowManager,
  run: PersistedRunState,
  script: string | undefined,
  capabilities: DamageControlCapabilities,
): Promise<DamageControlResult> {
  const classification = classifyRecoveryAction(
    run,
    leaseOf(manager, run.runId),
    manager.getRun(run.runId) !== undefined,
  );
  switch (classification.kind) {
    case "missing-state":
      return errorResult("recover", run.runId, "run state not found", ["list", "clean"]);
    case "already-running":
      return errorResult(
        "recover",
        run.runId,
        `cannot recover: ${classification.reason}`,
        allowedDamageControlActions(run.status, capabilities),
      );
    case "owned-elsewhere":
      return errorResult("recover", run.runId, classification.reason, ["status", "agents"]);
    case "not-recoverable":
      return errorResult(
        "recover",
        run.runId,
        `cannot recover run with status ${run.status}`,
        allowedDamageControlActions(run.status, capabilities),
      );
    case "orphan-recoverable": {
      // Reclaim the stale lease, flip running → paused under it (exactly the
      // recoverStaleRuns flip), then resume replays the journal prefix.
      const persistence = manager.getPersistence();
      const acquired = persistence.acquireRunLease(run.runId);
      if (!acquired) {
        return errorResult(
          "recover",
          run.runId,
          "lease could not be reclaimed (a concurrent owner took it); re-run status to confirm",
          ["status", "agents"],
        );
      }
      const statusAfter: RunStatus = "paused";
      try {
        const fresh = persistence.load(run.runId);
        if (!fresh) {
          return errorResult("recover", run.runId, "run state disappeared while reclaiming the lease", [
            "list",
            "clean",
          ]);
        }
        persistence.save({ ...fresh, status: "paused", updatedAt: new Date().toISOString() });
      } finally {
        persistence.releaseRunLease(acquired);
      }
      const resumed = await manager.resume(run.runId, script !== undefined ? { script } : {});
      const outcome: RecoveryOutcome = {
        classification,
        statusBefore: run.status,
        statusAfter,
        leaseAction: "reclaimed",
        resumed,
      };
      if (!resumed) return resumeFailure("recover", run, manager);
      const text = formatDamageControlText({
        action: "recover",
        result: "ok",
        runId: run.runId,
        classification: outcome.classification.kind,
        statusBefore: outcome.statusBefore,
        statusAfter: outcome.statusAfter,
        leaseAction: outcome.leaseAction,
        resumed: outcome.resumed,
      });
      return result(text, { action: "recover", result: "ok", recovery: outcome });
    }
    case "already-recoverable": {
      const resumed = await manager.resume(run.runId, script !== undefined ? { script } : {});
      const outcome: RecoveryOutcome = {
        classification,
        statusBefore: run.status,
        statusAfter: run.status,
        leaseAction: "none",
        resumed,
      };
      if (!resumed) return resumeFailure("recover", run, manager);
      const text = formatDamageControlText({
        action: "recover",
        result: "ok",
        runId: run.runId,
        classification: outcome.classification.kind,
        statusBefore: outcome.statusBefore,
        statusAfter: outcome.statusAfter,
        leaseAction: outcome.leaseAction,
        resumed: outcome.resumed,
      });
      return result(text, { action: "recover", result: "ok", recovery: outcome });
    }
  }
}

async function cleanRuns(manager: WorkflowManager, cwd: string, dryRun: boolean): Promise<DamageControlResult> {
  let repoRoot: string;
  try {
    repoRoot = (await gitExec(["-C", cwd, "rev-parse", "--show-toplevel"])).trim();
  } catch {
    // Not a git repository — nothing can be swept; report it as a clean no-op.
    return result(
      formatDamageControlText({ action: "clean", result: "ok", dryRun, candidates: 0, repo: "not-a-git-repository" }),
      {
        action: "clean",
        result: "ok",
        dryRun,
        candidates: [],
        acted: { staleLeasesReleased: 0, orphanRunsNormalized: 0, ghostWorktreesRemoved: 0, tmpBranchesRemoved: 0 },
      },
    );
  }

  const persistence = manager.getPersistence();
  const projectWorktreesDir = join(repoRoot, ".pi", "worktrees");
  const runs = manager.listAllRuns();
  const leases = new Map<string, RunLeaseInfo | null>();
  for (const run of runs) leases.set(run.runId, leaseOf(manager, run.runId));
  const registered = await listRegisteredWorktreePaths(repoRoot);
  const tmpBranches = await listTemporaryWorktreeBranches(repoRoot);
  const candidates = collectCleanCandidates(runs, leases, registered, projectWorktreesDir, tmpBranches);

  const report: CleanReport = {
    dryRun,
    candidates,
    acted: { staleLeasesReleased: 0, orphanRunsNormalized: 0, ghostWorktreesRemoved: 0, tmpBranchesRemoved: 0 },
  };
  if (dryRun) {
    const text = formatDamageControlText({
      action: "clean",
      result: "ok",
      dryRun: true,
      candidates: candidates.length,
      staleLeases: candidates.filter((c) => c.kind === "stale-lease").length,
      orphanRuns: candidates.filter((c) => c.kind === "orphan-run").length,
      ghostWorktrees: candidates.filter((c) => c.kind === "ghost-worktree").length,
      tmpBranches: candidates.filter((c) => c.kind === "tmp-branch").length,
    });
    return result(candidates.length ? `${text}\n${candidates.map(formatCandidateLine).join("\n")}` : text, {
      action: "clean",
      result: "ok",
      dryRun: true,
      report,
    });
  }

  // ── Act (explicit dryRun:false only) ────────────────────────────────────
  for (const candidate of candidates) {
    const runId = candidate.runId;
    if (!runId) continue;
    if (candidate.kind === "stale-lease") {
      // Reclaim-then-release: acquiring on a reclaimable lease replaces the
      // stale lock; releasing removes the fresh one. Net effect: stale lock gone.
      const lease = persistence.acquireRunLease(runId);
      if (lease) {
        persistence.releaseRunLease(lease);
        report.acted.staleLeasesReleased++;
      }
    } else if (candidate.kind === "orphan-run") {
      // Normalize running → paused under a reclaimed lease (recoverStaleRuns
      // semantics). NEVER deletes run state.
      const lease = persistence.acquireRunLease(runId);
      if (!lease) continue;
      try {
        const fresh = persistence.load(runId);
        if (fresh?.status === "running") {
          persistence.save({ ...fresh, status: "paused", updatedAt: new Date().toISOString() });
          report.acted.orphanRunsNormalized++;
        }
      } finally {
        persistence.releaseRunLease(lease);
      }
    }
  }

  // Worktree sweep: keep non-project registrations and any project worktree a
  // live-running/paused run in THIS process still owns (per-worktree version
  // of /workflows clean's global refusal — see design §5.3).
  const kept = registered.filter(
    (path) => !isProjectWorktree(path, projectWorktreesDir) || isActiveWorktreePath(manager, path),
  );
  await sweepOrphanWorktrees(repoRoot, kept);
  await pruneWorktrees(repoRoot);
  if (tmpBranches.length > 0) {
    report.acted.tmpBranchesRemoved = await deleteTemporaryWorktreeBranches(repoRoot);
  }
  report.acted.ghostWorktreesRemoved = candidates.filter((candidate) => candidate.kind === "ghost-worktree").length;

  const text = formatDamageControlText({
    action: "clean",
    result: "ok",
    dryRun: false,
    staleLeasesReleased: report.acted.staleLeasesReleased,
    orphanRunsNormalized: report.acted.orphanRunsNormalized,
    ghostWorktreesRemoved: report.acted.ghostWorktreesRemoved,
    tmpBranchesRemoved: report.acted.tmpBranchesRemoved,
  });
  return result(text, { action: "clean", result: "ok", dryRun: false, report });
}

// ─────────────────────────────────────────────────────────────────────────────
// Small local helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Session-scoped resolution for MUTATING verbs — protects other sessions' runs. */
function findSessionRun(manager: WorkflowManager, runId: string | undefined): PersistedRunState | undefined {
  if (!runId) return undefined;
  return manager.listRuns().find((candidate) => candidate.runId === runId);
}

/** Read-only resolution: session first, then all persisted runs. */
function findAnyRun(manager: WorkflowManager, runId: string | undefined): PersistedRunState | undefined {
  return findSessionRun(manager, runId) ?? manager.listAllRuns().find((candidate) => candidate.runId === runId);
}

function leaseOf(manager: WorkflowManager, runId: string): RunLeaseInfo | null {
  return manager.getPersistence().getLeaseInfo?.(runId) ?? null;
}

function countAgents(agents: ReadonlyArray<Pick<WorkflowAgentSnapshot, "status">>): DeepRunSummary["counts"] {
  return {
    total: agents.length,
    done: agents.filter((agent) => agent.status === "done").length,
    running: agents.filter((agent) => agent.status === "running").length,
    error: agents.filter((agent) => agent.status === "error").length,
    skipped: agents.filter((agent) => agent.status === "skipped").length,
  };
}

function formatListLine(summary: DeepRunSummary): string {
  const counts = summary.counts;
  return `runId=${summary.runId} name=${quote(summary.workflowName)} status=${summary.status} phase=${quote(summary.phase ?? "-")} total=${counts.total} done=${counts.done} running=${counts.running} error=${counts.error} skipped=${counts.skipped} tokens=${summary.tokenTotal}`;
}

function formatDeepRunLine(summary: DeepRunSummary): string {
  const counts = summary.counts;
  return `runId=${summary.runId} name=${quote(summary.workflowName)} status=${summary.status} phase=${quote(summary.phase ?? "-")} live=${summary.live} total=${counts.total} done=${counts.done} running=${counts.running} error=${counts.error} skipped=${counts.skipped} tokens=${summary.tokenTotal} journal=${summary.journal.entries} compacted=${summary.journal.compacted} checkpoints=${summary.checkpoints.total} lease=${summary.lease ? (summary.lease.reclaimable ? "reclaimable" : "held") : "none"} logs=${summary.logs} result=${summary.resultPresent ? "present" : "absent"}`;
}

function formatAgentLine(agent: AgentSummary): string {
  return `id=${agent.id} callId=${quote(agent.callId ?? "-")} label=${quote(agent.label)} status=${agent.status} tokens=${agent.tokens ?? 0} retries=${agent.retries}${agent.model ? ` model=${quote(agent.model)}` : ""}${agent.startedAt ? ` startedAt=${quote(agent.startedAt)}` : ""}${agent.lastActiveAt ? ` lastActive=${quote(agent.lastActiveAt)}` : ""}${agent.error ? ` error=${quote(agent.error)}` : ""}`;
}

function formatCandidateLine(candidate: CleanCandidate): string {
  return `candidate=${candidate.kind}${candidate.runId ? ` runId=${candidate.runId}` : ""}${candidate.path ? ` path=${quote(candidate.path)}` : ""} detail=${quote(candidate.detail)}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function reclaimableReason(lease: RunLeaseInfo): string {
  if (!lease.alive) return "owner pid dead";
  if (lease.expired) return "lease ttl expired";
  return "lease stale by age";
}

function normalizeWorktreePath(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

function isProjectWorktree(path: string, projectWorktreesDir: string): boolean {
  return normalizeWorktreePath(path).startsWith(normalizeWorktreePath(projectWorktreesDir));
}

function worktreeBasename(path: string): string {
  const normalized = normalizeWorktreePath(path);
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? "";
}

/** worktree.ts's deterministic slug (same sanitization so prefixes match). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/** A project worktree whose basename belongs to a run live-running/paused in this process. */
function isActiveWorktreePath(manager: WorkflowManager, path: string): boolean {
  const basename = worktreeBasename(path);
  for (const run of manager.listAllRuns()) {
    if ((run.status === "running" || run.status === "paused") && manager.getRun(run.runId)) {
      if (basename === slugify(run.runId) || basename.startsWith(`${slugify(run.runId)}-`)) return true;
    }
  }
  return false;
}

/**
 * Every registered git worktree under `repoRoot` (`git worktree list
 * --porcelain`), best-effort — mirrors the command surface's helper so the
 * clean sweep sees exactly what git does. A non-repo yields [].
 */
async function listRegisteredWorktreePaths(repoRoot: string): Promise<string[]> {
  try {
    const out = await gitExec(["-C", repoRoot, "worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const record of out.split(/\n\s*\n/)) {
      const line = record.split("\n").find((l) => l.startsWith("worktree "));
      if (line) paths.push(line.slice("worktree ".length).trim());
    }
    return paths;
  } catch {
    return [];
  }
}

/** Leftover `pi/wf/*` temporary branches (best-effort; mirrors workflow-commands.ts). */
async function listTemporaryWorktreeBranches(repoRoot: string): Promise<string[]> {
  try {
    const refs = await gitExec(["-C", repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads/pi/wf"]);
    return refs
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Delete leftover `pi/wf/*` branches; returns how many were removed. */
async function deleteTemporaryWorktreeBranches(repoRoot: string): Promise<number> {
  const branches = await listTemporaryWorktreeBranches(repoRoot);
  let deleted = 0;
  for (const branch of branches) {
    try {
      await gitExec(["-C", repoRoot, "branch", "-D", branch]);
      deleted++;
    } catch {
      // checked out elsewhere or already gone — leave it for the next sweep
    }
  }
  return deleted;
}
