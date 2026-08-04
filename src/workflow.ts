import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { AgentUsage, OperationTrace } from "./agent.js";
import { type AgentRunOptions, usageComponentsTotal, WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  DRAIN_ABORT_TIMEOUT_MS,
  MAX_AGENT_RETRIES,
  MAX_AGENTS_PER_RUN,
  MAX_CONCURRENCY,
  MAX_NESTED_WORKFLOW_DEPTH,
  MAX_RETRY_BACKOFF_MS,
} from "./config.js";
import { isWorkflowError, WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { loadModelTierConfig, type ModelTierConfig, resolveTierModel } from "./model-tier-config.js";
import { runPrewalkStage } from "./phases/prewalk.js";
import { type PhaseStage, SUBAGENT_SPAWN_BLOCKED, type WorkflowStateManager } from "./phases/state-machine.js";
import { type FrontierMapper, runWayfinderStage } from "./phases/wayfinder.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import { typecheckWorkflowScript } from "./typecheck.js";
import { WORKFLOW_CAPABILITY_CONTRACT, type WorkflowRuntimeImplementations } from "./workflow-capability-contract.js";
import { createWorktree, finalizeWorktree, removeWorktree, type Worktree } from "./worktree.js";

/**
 * Batch-scoped cancellation for a single parallel()/pipeline() fan-out. When a
 * fan-out's agent() calls reserve past maxAgents, the breaching call throws and
 * the whole fan-out rejects — but agents already reserved and queued behind the
 * limiter would otherwise keep draining and spending. parallel()/pipeline()
 * establish a fresh store per call via fanoutScope.run(); agent() captures the
 * nearest enclosing store synchronously (before suspending on the limiter) so a
 * still-queued agent can bail once ITS OWN fan-out breaches, without touching
 * sibling fan-outs running concurrently or an enclosing fan-out when this one is
 * nested inside it (each nesting level gets its own store via ALS scoping).
 *
 * Scope note: cancellation is bounded PER breaching fan-out, not run-global — a
 * deliberate tradeoff. Deep-sixing the earlier run-global flag was required
 * because it wrongly cancelled an innocent, independently-caught sibling batch.
 * The consequence: if one fan-out breaches while an unrelated in-cap sibling or
 * a nested inner fan-out is mid-flight, that other batch is NOT cancelled and
 * finishes its already-reserved agents (still capped at maxAgents total). Only
 * the breaching fan-out's own queue is short-circuited.
 */
const fanoutScope = new AsyncLocalStorage<{ cancelled: boolean }>();

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
}

/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
  index: number;
  /**
   * The runId of the frame (top-level run, or a nested workflow()'s own run)
   * this entry's `index` is scoped to. A nested workflow() restarts its own
   * callSeq at 0, so `index` alone collides between a parent's and a child's
   * same-numbered calls — see `resumeJournal`'s key format, which namespaces
   * on this the same way SharedStore's deltaKey already does. Absent on
   * journal entries persisted before this field existed; such legacy entries
   * are treated as belonging to the run's own top-level runId (see
   * WorkflowManager.resume()) — a legacy entry that actually belonged to a
   * nested frame simply cache-misses on resume (safe degradation: it re-runs
   * live, it does not apply to the wrong call).
   */
  runId?: string;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /**
   * Per-agent write delta (keys set by this agent) for additive replay on resume.
   * Replaces the former full-map snapshot to fix parallel-agent ordering: applying
   * deltas in callSeq order accumulates all agents' writes correctly regardless of
   * which agent finished first. Absent on older journal entries.
   */
  storeDelta?: Record<string, unknown>;
  /**
   * Typed operation traces (Fabric-style): one entry per tool call this agent
   * made, in execution order, pinned to the workflow-script line of the owning
   * agent() call. Absent when the runner reported no tool calls (e.g. a test
   * double, or a session that only produced prose) and on ALL journal entries
   * persisted before this field existed — legacy journals replay unchanged.
   */
  operations?: OperationTrace[];
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  /**
   * Number of live nested workflow() frames (incremented around the nested
   * runWorkflow call in workflowFn, decremented in its finally). Enforced in
   * two places: workflowFn's policy check (`maxNestedWorkflowDepth`, default
   * 1 — the documented one-level-deep rule) and the vm wrapper's hard runaway
   * ceiling (MAX_NESTED_WORKFLOW_DEPTH), which every script execution passes
   * through. The ceiling is a runaway guard, NOT a security boundary — the vm
   * is deliberately not a sandbox.
   */
  depth: number;
  /**
   * Monotonic count of every workflow() call anywhere in this run tree,
   * regardless of nesting depth — used (instead of `depth`) to build each
   * nested run's runId suffix (see workflowFn below). `depth` alone is NOT
   * enough: it returns to 0 after each nested call finishes, so two
   * SEQUENTIAL nested workflow() calls at the same depth (`await
   * workflow('a'); await workflow('b')`) would otherwise both compute the
   * exact same `${runId}-nested1` suffix. That collision matters because a
   * child's own callSeq restarts at 0, so its deltaKey (`${childRunId}:
   * ${callIndex}`) — the same id used as SharedStore's delta key AND as the
   * onAgentStart/onAgentEnd/onAgentHistory event id (see item 2's identity
   * model) — would collide between the two children's same-callIndex calls.
   * That's a real, not just theoretical, collision risk: an un-awaited
   * stray agent() call from the first child (still in SharedRuntime.inFlight,
   * not yet drained — only the top-level frame drains) can still be pending
   * when the second child starts and mints the very same id.
   */
  nestedCallSeq: number;
  /**
   * Fires exactly once a run-fatal error is determined: an error that escaped
   * the TOP-level script's own execution completely uncaught (see runWorkflow's
   * catch below) — i.e. nothing anywhere in the call chain, at any nesting
   * depth, caught it, so the run really is failing. Shared (not per-nesting-
   * level) so a nested workflow()'s in-flight siblings wind down too, the
   * instant the fate of the WHOLE run is sealed — not the instant any single
   * fan-out rejects, which would break parallel()'s null-on-recoverable-error
   * contract and a script's own try/catch around agent()/workflow(). Every
   * agent() call (this level and any nested workflow()) links its per-attempt
   * AbortController to this signal, alongside the caller's own options.signal,
   * so already-in-flight sibling subagent sessions actually abort instead of
   * running to completion on a run whose outcome is already decided. Wrapped
   * in an AbortController (not a bare boolean) purely so workflow.ts never
   * needs write access to the caller-owned options.signal/AbortController.
   */
  runFatalController: AbortController;
  /**
   * Every agent() promise spawned anywhere in this run (this level's script
   * and any nested workflow()'s), added on call and removed on settle. Drained
   * (awaited to completion) by the TOP-level runWorkflow's finally, before the
   * SharedStore is disposed — so a script that forgets to `await agent(...)`
   * can never have that call still mutating the store (or reporting results)
   * after the run has been marked complete and torn down. See the drain below.
   */
  inFlight: Set<Promise<unknown>>;
  /**
   * Host-clock start of the TOP-LEVEL run — the seed for the injected
   * elapsedMs() global. Nested workflow() frames inherit the parent's value via
   * the shared runtime so elapsedMs() is consistent across nesting levels.
   * Deliberately never part of any resume hash: elapsed values are
   * timing-dependent and must not influence call identity (see elapsedMs).
   */
  runStartedAtMs: number;
}

/** Runtime instrumentation for workflow boundaries, quality helpers, and control attempts. */
export type WorkflowRuntimeEvent =
  | { type: "phase"; title: string; budget: number | null }
  | { type: "workflow"; stage: "start" | "end"; name: string; args: unknown }
  | {
      type: "quality";
      stage: "start" | "end";
      helper: "verify" | "judgePanel" | "completenessCheck" | "consensus";
    }
  | { type: "control-attempt"; helper: "retry" | "gate"; attempt: number; accepted: boolean };

/** Minimal injected agent surface used by the workflow runtime and deterministic tests. */
export interface WorkflowAgentRunner {
  run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
  /**
   * Optional teardown the workflow layer calls when the top-level run frame
   * finishes (used to dispose a chained handoff session). Absent on injected
   * test doubles.
   */
  close?(): void;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: WorkflowAgentRunner;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Injectable source for the model-tiers config used by the resume-replay
   * identity hash (see hashAgentCall's `tierModel` field). Defaults to the
   * real disk read (~/.pi/workflows/model-tiers.json), which matches the live
   * resolution WorkflowAgent performs — so in production the hash captures the
   * resolved tier→model id and editing model-tiers.json invalidates a cached
   * replay result on the next resume (routing-budgets:f1/i2). Injected in
   * tests so a tier-config change can be exercised without touching the real
   * config file; this only seeds the hash, it never affects the live agent run
   * (the resolution there re-reads from disk via WorkflowAgent.loadTierConfig).
   */
  loadTierConfig?: () => ModelTierConfig | null;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) +
   * `~/.pi/agent/agents` (user, primary) + `~/.pi/agents` (user, deprecated
   * fallback). Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  /**
   * Base exponential-backoff delay (ms) between retry attempts after a
   * recoverable agent failure: attempt N→N+1 waits base × 2^(N-1), capped at
   * 8× base. Default 1000. 0 disables the wait. A pure timing knob (not frozen
   * per run, unlike agentRetries).
   */
  retryBackoffMs?: number;
  /**
   * Whether an agent that ends with a failure (exhausted recoverable retries,
   * or an error absorbed as a null by parallel()/pipeline()) should make the
   * RUN fail (settle failed, journal preserved → resumable via resumeFromRunId)
   * instead of silently completing with a null result. Default false for direct
   * embeds (agent() still returns null; script null-handling is unchanged); the
   * workflow TOOL defaults it to true so an orchestrator never mistakes an
   * incomplete run for success and restarts from scratch.
   */
  failOnExhaustedAgent?: boolean;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /**
   * Maximum workflow() nesting depth, clamped to 1..MAX_NESTED_WORKFLOW_DEPTH.
   * Default 1 — the documented one-level-deep policy. Raising it lets a
   * workflow nest a few saved runs deep for staged pipelines; the vm wrapper's
   * hard ceiling (MAX_NESTED_WORKFLOW_DEPTH) still blocks runaway recursion
   * with a clear SCRIPT_VALIDATION_ERROR (a runaway guard, not a sandbox).
   */
  maxNestedWorkflowDepth?: number;
  /**
   * OPT-IN advisory pre-run typecheck: run `tsc --noEmit` over the workflow
   * script before executing it, so type mistakes surface pre-flight instead of
   * mid-run. Default OFF — a script's runtime behavior never depends on it.
   * SOFT-FAIL by design: no TypeScript toolchain, a spawn error, a timeout,
   * or tsc reporting problems only logs a warning and the run proceeds
   * unchanged. Users without a toolchain are never blocked.
   */
  preRunTypecheck?: boolean;
  /**
   * OPT-IN resume-journal compaction request (default OFF). When true, the
   * journal owner (WorkflowManager's persist path — runWorkflow itself emits
   * journal entries but never holds the accumulated journal) folds the run's
   * resolved journal segments — calls whose operation traces are all "ok" —
   * into a compact interned summary at persist time, persisting it ONLY when
   * reconstruction QA reproduces the original journal byte-identically; a
   * summary that fails QA is discarded and the original journal is kept. The
   * positional deltaKey (`${runId}:${callIndex}`) scheme is untouched — no
   * migration, no relabeling. Default OFF: emitted journal entries are
   * byte-identical to the pre-compaction shape. Direct callers that
   * accumulate onAgentJournal entries themselves can apply the same pipeline
   * via compactJournal/reconstructJournal/verifyJournalCompaction from
   * journal-compaction.ts.
   */
  compactJournal?: boolean;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /**
   * Drain-side backstop deadline in milliseconds: how long the top-level run
   * waits for outstanding (possibly un-awaited) agent() calls to settle after
   * the script has finished, before aborting them via runFatalController and
   * completing the run anyway. Defaults to DRAIN_ABORT_TIMEOUT_MS. This is
   * what guarantees the run terminates even when agentTimeoutMs is null and an
   * in-flight agent ignores its abort signal.
   */
  drainTimeoutMs?: number;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /**
   * Resume: cached agent/checkpoint results keyed by `${runId}:${callIndex}`
   * — the same namespacing SharedStore's deltaKey uses — so a nested
   * workflow() call's callIndex-0 (its callSeq restarts at 0) can never
   * collide with the parent's own callIndex-0 entry. A legacy entry with no
   * `runId` (persisted before namespacing existed) is looked up under the
   * run's own top-level runId only; see `JournalEntry.runId`.
   */
  resumeJournal?: Map<string, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /**
   * Called once per FAILED-AND-RETRIED attempt (not the final attempt of an
   * agent() call, which reports its own tokens via onAgentEnd as before),
   * with that attempt's full usage breakdown. recordTokens() already folds a
   * retried attempt's spend into shared.spent/shared.tokenUsage (so the
   * run-wide budget was never leaky) — but onAgentEnd only ever reports the
   * FINAL attempt's tokens, so a caller accumulating a persisted total purely
   * from onAgentEnd (see WorkflowManager) would under-count by exactly the
   * wasted retried attempts' spend. This is a separate, silent channel
   * specifically so retried-attempt spend can be accounted for without
   * changing onAgentEnd's one-call-per-agent-call cadence (a contract other
   * code depends on). M26: the payload is the FULL breakdown (AgentUsage
   * shape) — never a scalar — so the persisted aggregate keeps the invariant
   * `total === input+output+cacheRead+cacheWrite` across retries.
   */
  onRetrySpend?: (spend: AgentUsage) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /**
   * Seed the FRESH SharedRuntime's cumulative spend/tokenUsage counters from a
   * previously-persisted total (resume()), instead of starting at zero. Used
   * only on the fresh-SharedRuntime branch below — never applied when
   * `sharedRuntime` is supplied (a nested workflow() call inherits the
   * parent's live, already-correct counters and must not be re-seeded).
   * Without this, a resumed run's tokenBudget cap silently resets: it would
   * enforce the ceiling against only what THIS execution spends, ignoring
   * whatever was already spent before the pause.
   */
  initialTokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /**
   * Shared store for this run. One instance is created per top-level run and
   * propagated into nested workflow() calls. Pass an existing instance to share
   * state across a parent and child run; omit to create a fresh isolated store.
   */
  sharedStore?: SharedStore;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  /**
   * Optional visual approve/deny gate for checkpoint() — e.g. a plannotator SSE
   * bridge (createPlannotatorBridge()). When provided, checkpoint() publishes
   * the checkpoint payload to the gate and waits for the human verdict instead
   * of the inline `confirm` prompt; see CheckpointGate for the verdict mapping.
   * Default behavior (no gate, no confirm) is unchanged: headless takes the
   * declared default.
   */
  checkpointGate?: CheckpointGate;
  /**
   * Optional persisted phase state machine wiring (PhaseGuard activation) — see
   * PhaseStateIntegration. Strictly additive: the existing live phasing in
   * model-routing.ts, phase budgets, and onPhase events are untouched.
   */
  phaseState?: PhaseStateIntegration;
  /**
   * Optional Phase 0/1 pipeline wiring (wayfinder -> prewalk) — see
   * PhasePipelineOptions. Strictly additive: absent, the run behaves exactly
   * as before; the PhaseGuard gate on agent() (Phase 3 + human approval) is
   * untouched.
   */
  pipeline?: PhasePipelineOptions;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  /** Runtime behavior trace used by diagnostics and comprehension evidence. */
  onRuntimeEvent?: (event: WorkflowRuntimeEvent) => void;
  onAgentStart?: (event: { id: string; label: string; phase?: string; prompt: string; model?: string }) => void;
  onAgentEnd?: (event: {
    /**
     * Unique per agent() CALL (not per label — concurrent agents routinely
     * share a label, e.g. parallel()'s default `"${phase} agent N"` labels or
     * an author-supplied label reused across a fan-out). Stable across this
     * call's start/end/history events. Callers must key any per-agent
     * bookkeeping on this, never on label, to avoid misattributing a
     * concurrent same-label agent's event to the wrong entry.
     */
    id: string;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    tokenUsage?: AgentUsage;
    worktree?: string;
    model?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    /**
     * The failing tool call (Fabric-style line-numbered failure repair): the
     * last operation whose outcome was not "ok" (else the final operation)
     * when this agent's run() made tool calls before failing. Present only on
     * error events whose session reported traces.
     */
    failingOperation?: OperationTrace;
  }) => void;
  onAgentHistory?: (event: { id: string; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  /**
   * Agents that ended with a failure (exhausted recoverable retries, or an
   * error absorbed as a null by parallel()/pipeline()). Empty/absent when every
   * agent succeeded. The manager reads this at completion time to settle the run
   * failed+resumable when failOnExhaustedAgent is on; the tool renders it as a
   * visible failure section so a lenient run's result is never mistaken for a
   * clean success.
   */
  failedAgents?: Array<{ label: string; error: string; errorCode: WorkflowErrorCode; nested?: string }>;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  /**
   * Coarse model tier, resolved from the user's model-tiers config (see
   * /workflows-models). The contract's standard vocabulary is the closed
   * union `"small" | "medium" | "big"` (PRD Task 3); a user-configured route
   * outside it is honored only when context supplies its name and purpose.
   * An explicit `model` takes precedence; a tier takes precedence over the
   * phase model. When the tier has no configured entry it falls back to the
   * session's main model.
   */
  tier?: string;
  isolation?: "worktree";
  /**
   * Keep the isolated worktree and its branch after the agent finishes instead of
   * removing them (worktree-isolation:f2). Agent edits are always finalized
   * (`git add -A` + `git commit --allow-empty`) before teardown, so with this opt-in
   * the retained branch carries the agent's committed work for inspection; without
   * it, the finalized branch and worktree are discarded.
   */
  keepWorktree?: boolean;
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

/**
 * Minimal visual approve/deny gate for checkpoint() — satisfied structurally by
 * createPlannotatorBridge() from integrations/plannotator.ts. When a run is
 * configured with a gate, every checkpoint() publishes its payload (prompt,
 * kind, choices, declared default, run/call identity) to the gate and waits for
 * the human verdict instead of the inline `confirm` prompt.
 *
 * Verdict mapping: an approved "confirm" checkpoint resolves `true`; a rejected
 * or timed-out one resolves `false`. For "input"/"select" checkpoints the gate
 * presents the declared `default` as the payload under review, so approval
 * resolves the default value and rejection resolves `false` — the gate is
 * approve/deny, not a free-text channel.
 *
 * The payload must be JSON-serializable: gate implementations persist it (the
 * plannotator bridge writes it to `.pi/workflows/plans/<id>.json`).
 */
export interface CheckpointGate {
  /** Publish a checkpoint to the visual gate; resolves with the gate's plan id. */
  submitPlan(blueprint: unknown): Promise<{ id: string }>;
  /**
   * Wait for the human verdict; resolves `true` on approval, `false` on denial
   * or when the timeout elapses with no decision.
   */
  waitForApproval(planId: string, timeoutMs?: number, signal?: AbortSignal): Promise<boolean>;
  /** Subscribe to gate status transitions (the SSE 'update' surface). Optional. */
  onStatusChange?(callback: (plan: { id: string; status: string; feedback?: string }) => void): () => void;
}

/** Options for the phase() runtime helper. */
export interface PhaseOptions {
  /** Soft per-phase token sub-budget carved from the run total. */
  budget?: number;
  /**
   * Deterministic stage (0–3) for the persisted phase state machine — see
   * PhaseStateIntegration. Declaring a higher stage advances the machine;
   * backward/no-op declarations throw PHASE_TRANSITION_INVALID when the queued
   * transition flushes. Ignored when no state machine is configured.
   */
  stage?: PhaseStage;
}

/**
 * Opt-in wiring of the Phase 0/1 pipeline (wayfinder -> prewalk) into a
 * workflow run's entry — executed BEFORE the script body once per top-level
 * run. When configured:
 *
 * - the run's task prompt is assessed with the wayfinder statable-question
 *   gate; a foggy prompt persists a decision map to `.pi/workflows/map.md`
 *   (the local branch of the PRD's "GitHub Issues or local" ticket store);
 * - the prewalk stage is gated on `wayfinderComplete`: while wayfinder
 *   decision tickets remain unresolved, no blueprint is produced and the
 *   flag stays false (tickets resolve session-by-session);
 * - once wayfinder completes, prewalk generates the "1986 Aircraft Manual"
 *   blueprint, writes it to `.pi/workflows/plans/<runId>.json` (the path the
 *   plannotator gate reads), and marks `prewalkComplete` so the Phase 2
 *   gate opens.
 *
 * Strictly additive: absent, the run behaves exactly as before, and the
 * PhaseGuard gate on agent() (Phase 3 + human approval) is untouched.
 */
export interface PhasePipelineOptions {
  /**
   * The persisted state machine whose flags gate the pipeline. Falls back to
   * `phaseState.stateManager` when omitted; when neither is configured the
   * pipeline is skipped (a run cannot gate what it cannot persist).
   */
  stateManager?: WorkflowStateManager;
  /** Directory for `.pi/workflows` artifacts (default: the run's cwd). */
  dir?: string;
  /** Task prompt to assess (default: `meta.description`, else the script). */
  prompt?: string;
  /** Codebase summary fed to generateBlueprint (default: a minimal summary). */
  codebaseSummary?: string;
  /** Frontier-mapper seam for the decision map (default: the deterministic stub). */
  mapper?: FrontierMapper;
}

/**
 * Opt-in wiring of the persisted phase state machine (phases/state-machine.ts)
 * into a workflow run — the PhaseGuard activation path. When provided:
 *
 * - `phase(title, { stage })` queues a forward transition of the persisted
 *   state (stages must be declared strictly ascending; a backward declaration
 *   fails the run at the next flush point with PHASE_TRANSITION_INVALID).
 * - a checkpoint routed through a CheckpointGate records `plannotatorSubmitted`
 *   and, on approval, `humanApproved` (approvePlan() — only valid at stage 2).
 * - `agent()` calls inherit PhaseGuard's gate: subagent spawning requires
 *   stage 3 with human approval (SUBAGENT_SPAWN_BLOCKED otherwise), unless
 *   `gateAgentCalls` is false.
 *
 * Existing live phasing (model-routing.ts, onPhase/phase budgets) is untouched;
 * this is strictly additive on top of it.
 */
export interface PhaseStateIntegration {
  /** The persisted state machine that becomes authoritative for this run. */
  stateManager: WorkflowStateManager;
  /**
   * Gate agent() calls (the live subagent spawn) behind stage 3 + human
   * approval. Defaults to `true` when the integration is provided.
   */
  gateAgentCalls?: boolean;
}

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling. Spend is attributed via phaseSpend (M25): every token an agent
   * spends is charged to the phase it was ASSIGNED at call time (assignedPhase),
   * recorded when the agent finishes (recordTokens). A phase exceeding its
   * ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall budget is
   * untouched. Soft gate (like the global one): spend accrues after each agent,
   * so an in-flight wave may overshoot slightly. Attribution limitation (honest):
   * an agent whose call spans a phase() transition is charged to the phase it was
   * assigned when the call STARTED, and retried attempts charge the same phase —
   * interleaved phases therefore attribute by assignment, not by wall-clock time.
   */
  phaseBudgets: Map<string, { budget: number; warned: boolean }>;
  /**
   * Per-phase accumulated token spend (M25), keyed by assignedPhase, reset to 0
   * whenever phase(title, { budget }) (re-)declares the phase's budget. Kept
   * separate from phaseBudgets so the budget ceiling and the running spend are
   * independently observable and re-declaration re-bases cleanly.
   */
  phaseSpend: Map<string, number>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
  /**
   * Phase of the last TOP-LEVEL agent() call (undefined before the first). Used
   * by the session-handoff chaining rule: a top-level call whose phase differs
   * from its predecessor continues the handoff session, so phase N+1's agent
   * inherits phase N's trajectory instead of re-reading context. Fan-out calls
   * (inside parallel()/pipeline()) never chain — they stay isolated.
   */
  lastTopLevelPhase?: string;
  /** True once the first top-level agent() call has run (handoff chain root). */
  sawTopLevelAgent: boolean;
  /**
   * Agents that ended with a failure (exhausted recoverable retries, or a
   * non-recoverable error absorbed as a null by parallel()/pipeline()). The
   * manager's completion-time AGENT_EXHAUSTED gate reads this to settle the run
   * failed+resumable instead of silently completing with nulls. Nested
   * workflow() failures are merged in with a `nested` marker.
   */
  failedAgents: Array<{ label: string; error: string; errorCode: WorkflowErrorCode; nested?: string }>;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

/** Default number of independent panelists polled per consensus() round. */
const CONSENSUS_DEFAULT_PANELISTS = 3;

/** Default bounded round count before consensus() arbitrates or gives up. */
const CONSENSUS_DEFAULT_ROUNDS = 2;

/**
 * Default pairwise-agreement gate: the largest mutually-agreeing panelist
 * group must cover at least this fraction of valid votes for consensus().
 */
const CONSENSUS_DEFAULT_AGREE_THRESHOLD = 0.66;

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body, bodyLineToScriptLine } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  // Positive integer in 1..MAX_NESTED_WORKFLOW_DEPTH; anything else (undefined,
  // NaN, 0, negatives, fractions) falls back to the documented one-level policy.
  const maxNestedWorkflowDepth =
    typeof options.maxNestedWorkflowDepth === "number" && Number.isFinite(options.maxNestedWorkflowDepth)
      ? Math.max(1, Math.min(MAX_NESTED_WORKFLOW_DEPTH, Math.floor(options.maxNestedWorkflowDepth)))
      : 1;
  // Positive finite numbers only; anything else (undefined, NaN, <= 0) falls
  // back to the documented constant so the drain always has a deadline.
  const drainTimeoutMs =
    typeof options.drainTimeoutMs === "number" && Number.isFinite(options.drainTimeoutMs) && options.drainTimeoutMs > 0
      ? options.drainTimeoutMs
      : DRAIN_ABORT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    failedAgents: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    phaseSpend: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
    sawTopLevelAgent: false,
  };

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  // options.initialTokenUsage (resume() only) seeds spent/tokenUsage so the
  // tokenBudget ceiling holds cumulatively across a pause/resume cycle instead
  // of resetting to zero (see WorkflowRunOptions.initialTokenUsage). Deliberately
  // NOT applied when options.sharedRuntime is supplied — that branch inherits a
  // parent workflow()'s already-live counters, which must not be re-seeded.
  //
  // agentCount is NOT seeded here, unlike spent/tokenUsage — and doesn't need
  // to be: resume() always replays the whole script from callIndex 0, and
  // agent()'s `shared.agentCount++` fires unconditionally for every call
  // (cache-hit replay or live) before the replay-vs-live branch runs. That
  // replay alone reconstructs the correct cumulative count in this fresh
  // SharedRuntime by the time any new live agent executes, so maxAgents stays
  // a genuine cumulative cap across resume with no extra seeding. Token spend
  // needs seeding precisely because its cache-hit branch deliberately does NOT
  // re-run recordTokens() (to avoid double-counting already-spent tokens) —
  // there is no replay-based reconstruction for it the way there is for count.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: options.initialTokenUsage?.total ?? 0,
    tokenUsage: options.initialTokenUsage
      ? { ...options.initialTokenUsage }
      : { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
    nestedCallSeq: 0,
    runFatalController: new AbortController(),
    inFlight: new Set<Promise<unknown>>(),
    // Seed the elapsedMs() global from the true top-level start; a nested
    // workflow() frame inherits this exact value via options.sharedRuntime.
    runStartedAtMs: Date.now(),
  };
  const limiter = shared.limiter;
  // This frame created `shared` fresh (rather than inheriting a parent
  // workflow()'s) — i.e. it's the true top-level run, the only frame allowed
  // to declare the run's fate sealed (see SharedRuntime.runFatalController) or
  // drain/dispose the SharedStore. A nested workflow() call always passes both
  // sharedRuntime and sharedStore together (see workflowFn below), so this is
  // equivalent to `!options.sharedStore` — used at both choke points below.
  const isTopLevelRun = !options.sharedRuntime;

  // PhaseGuard activation: when a persisted phase state machine is configured,
  // phase(title, { stage }) queues forward transitions on a chain that flushes
  // at the run's await points (checkpoint-gate publish, agent() gate check,
  // run end). Queueing (not awaiting inline) keeps phase() synchronous — the
  // documented runtime signature is `phase(title, options?) => void` — while
  // the chain guarantees transitions apply in declaration order and any
  // backward-transition error surfaces at a deterministic flush point.
  const phaseStateIntegration = options.phaseState;
  const gateAgentCalls = phaseStateIntegration ? (phaseStateIntegration.gateAgentCalls ?? true) : false;
  let phaseStateChain: Promise<void> = Promise.resolve();
  const queuePhaseTransition = (stage: PhaseStage) => {
    if (!phaseStateIntegration) return;
    phaseStateChain = phaseStateChain.then(() => phaseStateIntegration.stateManager.transitionTo(stage));
  };
  const flushPhaseState = () => phaseStateChain;
  /** Record a gate verdict in the persisted state machine (approval only at stage 2). */
  const recordGateVerdict = async (approved: boolean) => {
    if (!phaseStateIntegration) return;
    const stateManager = phaseStateIntegration.stateManager;
    await stateManager.setState({ plannotatorSubmitted: true });
    if (approved) await stateManager.approvePlan();
  };
  /**
   * Live PhaseGuard gate for agent(): the persisted machine must be at stage 3
   * with human approval before the run may spawn subagents.
   */
  const assertPhaseGateOpen = async () => {
    if (!phaseStateIntegration || !gateAgentCalls) return;
    await flushPhaseState();
    const stateManager = phaseStateIntegration.stateManager;
    // Refresh the synchronous cache before the synchronous gate check.
    await stateManager.getState();
    if (!stateManager.canSpawnSubagents()) {
      const state = await stateManager.getState();
      throw new WorkflowError(
        `agent() is gated: subagent spawning requires Phase 3 with human approval (current: Phase ${state.activePhase}, approved: ${state.humanApproved}).`,
        SUBAGENT_SPAWN_BLOCKED,
        {
          recoverable: false,
          details: { code: SUBAGENT_SPAWN_BLOCKED },
        },
      );
    }
  };

  // One store instance per run; nested workflow() calls inherit the parent's store
  // so all agents across nesting levels share the same key-value space.
  const store: SharedStore = options.sharedStore ?? new SharedStore();

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  /** Minimal codebase summary when the pipeline caller supplies none. */
  const DEFAULT_PIPELINE_CODEBASE_SUMMARY = "No codebase summary provided to the phase pipeline.";

  // Phase 0/1 pipeline wiring (wayfinder -> prewalk): runs once per TOP-LEVEL
  // frame before the script body. A nested workflow() inherits options.pipeline
  // via the spread below, so gating on isTopLevelRun is what stops the pipeline
  // from re-firing per frame. Pipeline persistence is bookkeeping: a failure is
  // logged, never allowed to fail an otherwise-runnable script, while the state
  // machine's Phase 1/2 gates still enforce ordering on every successful run.
  if (options.pipeline && isTopLevelRun) {
    const pipelineStateManager = options.pipeline.stateManager ?? phaseStateIntegration?.stateManager;
    if (pipelineStateManager) {
      const pipelineDir = options.pipeline.dir ?? baseCwd;
      const pipelinePrompt = options.pipeline.prompt ?? meta.description ?? script;
      try {
        const wayfinder = await runWayfinderStage({
          stateManager: pipelineStateManager,
          prompt: pipelinePrompt,
          dir: pipelineDir,
          mapper: options.pipeline.mapper,
          onLog: log,
        });
        if (wayfinder.completed) {
          // Wayfinder -> prewalk: transition with prerequisite enforcement so
          // the declared wayfinderComplete gate is a real check, not a formality.
          await pipelineStateManager.transitionTo(1, { enforcePrerequisites: true });
          await runPrewalkStage({
            stateManager: pipelineStateManager,
            task: pipelinePrompt,
            codebaseSummary: options.pipeline.codebaseSummary ?? DEFAULT_PIPELINE_CODEBASE_SUMMARY,
            dir: pipelineDir,
            runId,
            onLog: log,
          });
          // Prewalk -> plannotator gate: prewalkComplete is the Phase 2
          // prerequisite; once set, the Phase 2 gate is open.
          await pipelineStateManager.transitionTo(2, { enforcePrerequisites: true });
          log(`phase pipeline: Phase 2 (plannotator review) gate open for run ${runId}`);
        }
      } catch (error) {
        log(`phase pipeline failed (run continues): ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      log("phase pipeline skipped: no state manager configured (pass pipeline.stateManager or phaseState)");
    }
  }

  /**
   * Guarded host-callback dispatch (M1): every host-invoked callback
   * (onAgentStart/onAgentEnd/onAgentJournal/onAgentHistory/onTokenUsage/onPhase/
   * onRuntimeEvent/onRetrySpend) goes through this so a throwing host callback
   * can never corrupt the run's control flow. In particular a throwing onAgentEnd
   * must not turn a successful agent attempt into a caught failure (which would
   * re-run recordTokens(null) and double-count tokens, then null the result) and
   * a throwing onTokenUsage must not fail a completing run. Log and continue.
   */
  const safeCallback = <A extends unknown[]>(
    label: string,
    fn: ((...args: A) => void) | undefined,
    ...args: A
  ): void => {
    if (fn === undefined) return;
    try {
      fn(...args);
    } catch (error) {
      log(`host callback ${label} threw (run continues): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const phase = (title: string, phaseOptions?: PhaseOptions) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current phase-attributed spend (idempotent
    // across resume: the script re-runs phase() and the ceiling is recomputed
    // from live spend). Spend itself is attributed per-agent via phaseSpend
    // (M25), so the gate reads the attributed total, not the run-wide counter.
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, warned: false });
      state.phaseSpend.set(title, 0);
    }
    // Deterministic stage for the persisted phase state machine (opt-in, see
    // PhaseStateIntegration). Queued — phase() stays synchronous — and flushed
    // at the next checkpoint-gate/agent()/run-end boundary. Same lenient
    // validation as `budget`: a non-integer or out-of-range stage is ignored.
    if (
      phaseStateIntegration &&
      typeof phaseOptions?.stage === "number" &&
      Number.isInteger(phaseOptions.stage) &&
      phaseOptions.stage >= 0 &&
      phaseOptions.stage <= 3
    ) {
      queuePhaseTransition(phaseOptions.stage as PhaseStage);
    }
    safeCallback("onPhase", options.onPhase, title);
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "phase",
      title,
      budget: typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0 ? phaseOptions.budget : null,
    });
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const agentLimitError = () =>
    new WorkflowError(
      `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
      WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
      { recoverable: false },
    );

  // True on an intentional external abort (pause/stop/Esc, via options.signal)
  // OR once this run's fate has been sealed (shared.runFatalController — see
  // its doc comment). Every abort check in this file goes through this so the
  // two sources compose identically everywhere instead of only some call
  // sites remembering to check the second one.
  const isAborted = () => Boolean(options.signal?.aborted || shared.runFatalController.signal.aborted);

  const throwIfAborted = () => {
    if (isAborted()) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const agent = (prompt: string, agentOptions: AgentOptions = {}): Promise<unknown> => {
    // Track every call (awaited or not) so the top-level run can drain
    // outstanding calls before completing (see SharedRuntime.inFlight and the
    // drain in the finally below) — this is what stops a forgotten `await`
    // from letting an agent mutate state after the run is torn down.
    const call = agentImpl(prompt, agentOptions);
    shared.inFlight.add(call);
    // Attaching a handler here (independent of whatever the script itself does
    // with the returned promise) also means an un-awaited call's eventual
    // rejection never becomes a process-crashing unhandled rejection.
    call.catch(() => {}).finally(() => shared.inFlight.delete(call));
    return call;
  };

  const agentImpl = async (prompt: string, agentOptions: AgentOptions = {}) => {
    throwIfAborted();

    // Capture the enclosing parallel()/pipeline() fan-out's cancellation batch
    // (if any) synchronously, while the ALS context of the caller is still
    // active — i.e. before suspending on the limiter below. The limiter body
    // closes over this so a still-queued agent can bail once its OWN fan-out
    // breaches the cap, without affecting sibling or outer fan-outs.
    const batch = fanoutScope.getStore();

    // Check agent limit. A fan-out that overshoots the cap has already reserved
    // and queued up to `maxAgents` agents; the breaching call throws here, and
    // parallel()/pipeline() mark their own batch cancelled so the already-queued
    // agents short-circuit before their real API call (see the limiter body).
    if (shared.agentCount >= maxAgents) {
      throw agentLimitError();
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spend accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so later phases still proceed. Spend is attributed per-agent to the
    // phase it was assigned at call time (M25, see phaseSpend).
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = state.phaseSpend.get(assignedPhase) ?? 0;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();

    // Typed operation traces: attribute this call to its workflow-script line.
    // The stack is read at CALL time (the vm frame is the agent() call site)
    // and mapped back through the prelude + body line maps (see
    // captureScriptLine). Best-effort: an unattributable call site yields
    // undefined and traces carry line 0 rather than failing the run.
    const scriptLine = captureScriptLine(
      new Error().stack ?? "",
      `${meta.name || "workflow"}.js`,
      bodyLineToScriptLine,
    );
    // Session-handoff chaining (Prewalk): a top-level agent() call whose phase
    // differs from the previous top-level call continues the handoff session, so
    // phase N+1's agent inherits phase N's trajectory instead of re-reading
    // context. The FIRST top-level call creates the chain root. Fan-out calls
    // (inside parallel()/pipeline()) never chain — isolation is preserved.
    const chainHandoff =
      options.sessionHandoff === true &&
      batch === undefined &&
      (!state.sawTopLevelAgent || state.lastTopLevelPhase !== assignedPhase);
    state.lastTopLevelPhase = assignedPhase;
    state.sawTopLevelAgent = true;

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const modelSpec =
      explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
    // For display in /workflows: the model this agent runs on — its explicit/phase
    // spec, else the session's main model. The real resolved id overrides this via
    // onModelResolved once the subagent session is created.
    let displayModel = modelSpec ?? options.mainModel;

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;
    const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
    const tierModel = resolveRoutingModelSignature(
      agentOptions,
      agentDef,
      modelSpec,
      options.mainModel,
      options.loadTierConfig ?? loadModelTierConfig,
    );
    const callHash = hashAgentCall(
      prompt,
      modelSpec,
      tierModel,
      assignedPhase,
      agentOptions,
      agentDefinitionKey(agentDef),
      options.mainModel,
      resolvedIsolation,
    );
    // Store delta key: callIndex alone is NOT run-unique. A nested workflow()
    // call (see workflowFn below) shares this run's SharedStore instance but
    // restarts its own callSeq at 0, so a parent agent and a concurrently
    // running nested-run agent — or two SEQUENTIAL sibling nested runs, whose
    // depth alone would otherwise repeat — can both get callIndex 0 and
    // collide in SharedStore.agentDeltas — whichever commits last
    // steals/overwrites the other's journaled delta (and, via this same
    // deltaKey doubling as the onAgentStart/onAgentEnd/onAgentHistory event
    // id, misattributes one agent's events to the other — see item 2's
    // identity model). Composing the run's own runId (unique per top-level
    // run AND per nested run, see `${runId}-nested${++shared.nestedCallSeq}`
    // below) with callIndex makes the key unique across the whole store.
    const deltaKey = `${runId}:${callIndex}`;

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    shared.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    // Namespaced the same way as SharedStore's deltaKey (deltaKey IS this
    // exact `${runId}:${callIndex}` string) so a nested workflow()'s
    // callIndex-0 can never accidentally replay the parent's callIndex-0
    // entry, or vice versa (see JournalEntry.runId).
    const cached = options.resumeJournal?.get(deltaKey);
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      safeCallback("onAgentStart", options.onAgentStart, {
        id: deltaKey,
        label,
        phase: assignedPhase,
        prompt,
        model: displayModel,
      });
      safeCallback("onAgentEnd", options.onAgentEnd, {
        id: deltaKey,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: 0,
        model: displayModel,
      });
      // Apply this agent's write delta so live agents later in the run see a
      // consistent store. Additive apply preserves parallel-agent writes that
      // came from higher-callIndex agents finishing before this one.
      if (cached.storeDelta) store.applyDelta(cached.storeDelta);
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    return limiter(async () => {
      // PhaseGuard activation (see PhaseStateIntegration): agent() is the live
      // subagent spawn, so it inherits the state machine's gate. Checked inside
      // the limiter so the agentCount limit/budget gate stays atomic (no await
      // between the count check and `shared.agentCount++` above). Replay of a
      // journaled cache hit bypasses this entirely (the return above).
      await assertPhaseGateOpen();

      const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
      const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
      const maxAttempts = retryAttempts + 1;
      const retryBackoffMs = normalizeRetryBackoffMs(options.retryBackoffMs);

      safeCallback("onAgentStart", options.onAgentStart, {
        id: deltaKey,
        label,
        phase: assignedPhase,
        prompt,
        model: displayModel,
      });

      // Optional per-agent worktree isolation (deterministic name -> stable resume keys).
      // Precedence: explicit call-site isolation > agentDef isolation (resolvedIsolation is
      // computed at the call-hash site above so a change of isolation invalidates the
      // cached replay result — M5). Note: passing { isolation: undefined } falls through ??
      // to the def's value — there is no sentinel to suppress a def's isolation at the call
      // site. Remove the agentType or override with a def that has no isolation field if
      // opt-out is needed.
      let worktree: Worktree | undefined;
      if (resolvedIsolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
        if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
      }
      const runCwd = worktree?.isolated ? worktree.cwd : undefined;

      // Captured from the subagent's real session usage; falls back to an
      // estimate when the provider reports no usage (total === 0). Usage is reset
      // per retry attempt so a failed attempt does not double-count the next one.
      let usage: AgentUsage | undefined;
      // Fold one attempt's spend into the run-wide aggregate, enforcing the M26
      // invariant `total === input+output+cacheRead+cacheWrite` in this ONE place:
      // the component sum is the total whenever the provider reported a breakdown
      // (a provider total that disagrees with its own components is discarded); a
      // breakdown-less usage falls back to its reported total; a provider with no
      // usage at all falls back to the length-based estimate (the only
      // approximation allowed). The returned total also drives the run budget
      // (shared.spent), so budget and aggregate can never disagree.
      const recordTokens = (result: unknown): number => {
        let tokens: number;
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
          const components = usageComponentsTotal(usage);
          tokens =
            components > 0
              ? components
              : usage.total > 0
                ? usage.total
                : estimateTokens(result) + estimateTokens(prompt);
        } else {
          tokens = estimateTokens(result) + estimateTokens(prompt);
        }
        shared.tokenUsage.total += tokens;
        shared.spent += tokens;
        // M25: attribute spend to the phase this call was assigned to, so a
        // phase's sub-budget gate sees only its own agents' spend.
        if (assignedPhase) {
          state.phaseSpend.set(assignedPhase, (state.phaseSpend.get(assignedPhase) ?? 0) + tokens);
        }
        return tokens;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          usage = undefined;
          // This attempt's tool-call traces; the successful attempt's traces are
          // journaled, a failed attempt's traces surface the failing operation.
          let operations: OperationTrace[] = [];
          const externalSignal = options.signal;
          let onExternalAbort: (() => void) | undefined;
          let onRunFatal: (() => void) | undefined;
          try {
            throwIfAborted();
            // This agent's own fan-out already breached maxAgents while this
            // call sat queued behind the limiter; bail before spending on the
            // real API call instead of draining the whole reserved queue.
            if (batch?.cancelled) throw agentLimitError();

            // Per-attempt abort: on timeout we abort THIS agent so its session is
            // disposed and its heavy state (messages, etc.) released, instead of
            // leaving it streaming in the background — retries would otherwise
            // stack live sessions on top of each other (#109). Linked to BOTH the
            // run's external signal (outer abort — pause/stop/Esc) AND
            // shared.runFatalController (this run's fate has been sealed by a
            // sibling's non-recoverable error escaping the top-level script — see
            // SharedRuntime.runFatalController) so an in-flight sibling actually
            // winds down instead of running to completion on a doomed run. Both
            // links are torn down per attempt in finally so listeners don't accrue.
            const agentController = new AbortController();
            if (isAborted()) {
              agentController.abort();
            } else {
              if (externalSignal) {
                onExternalAbort = () => agentController.abort();
                externalSignal.addEventListener("abort", onExternalAbort, { once: true });
              }
              onRunFatal = () => agentController.abort();
              shared.runFatalController.signal.addEventListener("abort", onRunFatal, { once: true });
            }
            const runPromise = agentRunner.run(prompt, {
              label,
              // Identifiable name for persisted sessions (persistAgentSessions).
              sessionName: `workflow:${runId} ${label}`,
              schema: agentOptions.schema,
              signal: agentController.signal,
              instructions: buildAgentInstructions(assignedPhase, agentOptions, agentDef, resolvedIsolation),
              model: modelSpec,
              tier: agentOptions.tier,
              modelRegistry: options.modelRegistry,
              toolNames: agentDef?.tools,
              disallowedToolNames: agentDef?.disallowedTools,
              // Typed operation traces: the script line of THIS call (the
              // differentiator across journal entries) plus the callback that
              // delivers the per-tool-call {line, op, outcome} traces.
              scriptLine,
              onOperations: (traces) => {
                operations = traces;
              },
              // Prewalk session handoff: chain the handoff session at phase
              // boundaries (see chainHandoff) so phase N+1 inherits the phase N
              // trajectory instead of re-reading context.
              handoff: chainHandoff,
              onSwap: (info) => {
                log(
                  `first-edit swap: execution mode on session ${info.sessionId} ` +
                    `(${info.fromModel ?? "?"} → ${info.toModel ?? "?"})`,
                );
              },
              // Per-agent store tools track this agent's writes by the
              // run-unique deltaKey so the delta can be journaled and replayed
              // correctly on resume, even when a nested workflow() run shares
              // this store concurrently with the parent run.
              systemTools: createAgentStoreTools(store, deltaKey),
              cwd: runCwd,
              onModelResolved: (id: string) => {
                displayModel = id;
              },
              onModelFallback: ({ tier, requestedSpec }: { tier: string; requestedSpec: string }) => {
                // Untagged agents' implicit default tier degrading to the session
                // default must stay visible in the run's own log/event stream, not
                // just a console.warn (#131) — an explicit model/tier pin instead
                // throws MODEL_NOT_FOUND and never reaches this callback.
                log(`default "${tier}" tier model "${requestedSpec}" unavailable — using the session default`);
              },
              onUsage: (u: AgentUsage) => {
                usage = u;
              },
              onHistory: (history: AgentHistoryEntry[]) => {
                safeCallback("onAgentHistory", options.onAgentHistory, {
                  id: deltaKey,
                  label,
                  phase: assignedPhase,
                  history,
                });
              },
            });
            // After a timeout the run() promise still settles later, rejecting with
            // "aborted" once agentController fires; the race has already resolved,
            // so swallow that to avoid an unhandled rejection.
            runPromise.catch(() => {});
            const result = await withTimeout(runPromise, timeout, label, () => agentController.abort());

            throwIfAborted();
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            const tokens = recordTokens(result);
            safeCallback("onAgentJournal", options.onAgentJournal, {
              index: callIndex,
              runId,
              hash: callHash,
              result,
              storeDelta: store.commitDelta(deltaKey),
              // Typed operation traces for this call (absent when the runner
              // reported none).
              operations: operations.length ? operations : undefined,
            });
            safeCallback("onAgentEnd", options.onAgentEnd, {
              id: deltaKey,
              label,
              phase: assignedPhase,
              result,
              tokens,
              tokenUsage: usage,
              worktree: runCwd,
              model: displayModel,
            });
            return result;
          } catch (error) {
            if (isAborted()) throw error;

            const workflowError = wrapError(error, { agentLabel: label });
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            const tokens = recordTokens(null);
            // This attempt's store writes must not survive it — a failed
            // attempt shares this call's deltaKey with every other attempt
            // (retried or not), so without rolling back here its writes would
            // stay live in the store (visible to concurrently-running sibling
            // agents) and merge into whatever a later, successful attempt
            // commits — corrupting both the live run's state and the delta
            // that resume replay reconstructs from. Unconditional: this
            // covers the about-to-retry case AND the exhausted/non-recoverable
            // case, since neither leaves behind a call that "produced" a
            // result this attempt's writes should be attributed to.
            store.discardDelta(deltaKey);

            if (workflowError.recoverable && attempt < maxAttempts) {
              const delayMs = retryBackoffDelayMs(retryBackoffMs, attempt);
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying` +
                  (delayMs > 0 ? ` in ${delayMs}ms` : ""),
              );
              // This attempt's spend already accrued into shared.spent/tokenUsage
              // above (recordTokens) — but it will never reach onAgentEnd (only
              // the final attempt does), so report it on the dedicated channel
              // instead (see WorkflowRunOptions.onRetrySpend). M26: ship the FULL
              // breakdown, not a scalar, so a persisted aggregate keeps the
              // invariant total === input+output+cacheRead+cacheWrite across
              // retried attempts too. (`usage` is re-widened here — the CFA
              // narrows it to never after the onUsage closure assignment;
              // runtime value is the real attempt usage.)
              const attemptUsage = usage as AgentUsage | undefined;
              const retrySpend: AgentUsage = {
                input: attemptUsage?.input ?? 0,
                output: attemptUsage?.output ?? 0,
                cacheRead: attemptUsage?.cacheRead ?? 0,
                cacheWrite: attemptUsage?.cacheWrite ?? 0,
                total: tokens,
                cost: attemptUsage?.cost ?? 0,
              };
              safeCallback("onRetrySpend", options.onRetrySpend, retrySpend);
              // Exponential backoff before the next attempt: a provider mid-outage
              // gets spaced retries instead of an immediate hammer. Abort-aware — a
              // pause/stop/Esc or a sealed run fate during the wait bails out and
              // rethrows rather than sleeping through the abort (throwIfAborted
              // below also honors an abort that fired during the sleep).
              if (delayMs > 0) {
                await backoffSleep(delayMs, [options.signal, shared.runFatalController.signal]);
                throwIfAborted();
              }
              continue;
            }

            const failingOperation =
              operations.length > 0
                ? ([...operations].reverse().find((t) => t.outcome !== "ok") ?? operations[operations.length - 1])
                : undefined;
            // Record the failure for the manager's completion-time AGENT_EXHAUSTED
            // gate (and the tool's failure text). Covers BOTH the exhausted-
            // recoverable null return below AND a non-recoverable error absorbed
            // as a null item by parallel()/pipeline() — a throw never reaches the
            // gate, so every agent that ended with a null must be listed here.
            state.failedAgents.push({
              label,
              error: workflowError.message,
              errorCode: workflowError.code,
            });
            safeCallback("onAgentEnd", options.onAgentEnd, {
              id: deltaKey,
              label,
              phase: assignedPhase,
              result: null,
              tokens,
              tokenUsage: usage,
              worktree: runCwd,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
              failingOperation,
            });

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return null;
            }
            throw workflowError;
          } finally {
            // Drop this attempt's abort listeners so they don't accrue one entry
            // per attempt on the run's signal / runFatalController for the whole
            // run (#109 hygiene).
            if (onExternalAbort) externalSignal?.removeEventListener("abort", onExternalAbort);
            if (onRunFatal) shared.runFatalController.signal.removeEventListener("abort", onRunFatal);
          }
        }
        return null;
      } finally {
        // Always tear down the worktree, even on timeout/abort. First finalize any
        // agent edits (git add -A + commit --allow-empty, best-effort) so teardown
        // never silently destroys them; then honor the keepWorktree opt-in (retain
        // branch + path for inspection). Otherwise log what is being discarded
        // before removal (worktree-isolation:f2).
        if (worktree?.isolated) {
          const finalized = await finalizeWorktree(worktree);
          if (!finalized.ok) {
            const reason = finalized.reason ? ` (${finalized.reason})` : "";
            log(`worktree finalize failed for "${label}"; agent edits may be lost${reason}`);
          }
          if (agentOptions.keepWorktree) {
            log(`keeping worktree for "${label}": ${worktree.cwd} (branch ${worktree.branch ?? "<detached>"})`);
          } else {
            log(`discarding worktree for "${label}": ${worktree.cwd} (branch ${worktree.branch ?? "<detached>"})`);
            await removeWorktree(worktree);
          }
        }
      }
    });
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    // Batch-scoped cancellation: agent() calls made (directly or transitively)
    // from these thunks see this store via fanoutScope.getStore(). A breach in
    // THIS fan-out flips `cancelled` so its own still-queued agents bail, without
    // touching a sibling fan-out running concurrently or an enclosing one.
    const batch = { cancelled: false };
    return fanoutScope.run(batch, () =>
      Promise.all(
        thunks.map(async (thunk, index) => {
          try {
            return await thunk();
          } catch (error) {
            if (isAborted()) throw error;
            // A plain (non-WorkflowError) error is a script bug in this thunk —
            // propagate it instead of swallowing it into a null (M2): the same
            // bug in a directly-awaited agent() would fail the run, and a null
            // would silently corrupt the fan-out's result data. Only WorkflowError
            // carries the recoverable class that decides null-vs-throw (a
            // recoverable-exhausted agent() already RESOLVES null on its own, so
            // a WorkflowError reaching here is always a genuinely fatal class).
            if (!isWorkflowError(error)) throw error;
            const workflowError = error;
            // Non-recoverable failures (token budget / agent limit exhausted) must
            // halt the whole run, exactly like a directly-awaited agent() — not be
            // swallowed into a null in the result array.
            if (!workflowError.recoverable) {
              // Only a breached agent cap cancels the rest of this batch; the
              // token budget stays a soft gate by design (in-flight agents may
              // finish past it), and other non-recoverable errors don't imply
              // the rest of the batch is doomed.
              if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
              throw workflowError;
            }
            log(`parallel[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }),
      ),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    // Batch-scoped cancellation — see parallel() for the rationale.
    const batch = { cancelled: false };
    return fanoutScope.run(batch, () =>
      Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item;
          for (const stage of stages) {
            try {
              throwIfAborted();
              value = await stage(value, item, index);
              throwIfAborted();
            } catch (error) {
              if (isAborted()) throw error;
              // Plain (non-WorkflowError) errors are script bugs in this stage —
              // propagate them (M2), same rationale as parallel() above.
              if (!isWorkflowError(error)) throw error;
              const workflowError = error;
              // Non-recoverable failures halt the whole run (see parallel()).
              if (!workflowError.recoverable) {
                if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
                throw workflowError;
              }
              log(`pipeline[${index}] failed: ${workflowError.message}`);
              return null;
            }
          }
          return value;
        }),
      ),
    );
  };

  // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
  // run's limiter/counters/budget so the global caps hold. One level deep by
  // default; maxNestedWorkflowDepth (clamped to MAX_NESTED_WORKFLOW_DEPTH) is
  // the author-facing policy ceiling. The vm wrapper enforces the hard runaway
  // ceiling for anything that still gets past this check.
  const workflowFn = async (nameOrScript: string, childArgs?: unknown) => {
    throwIfAborted();
    if (shared.depth >= maxNestedWorkflowDepth) {
      throw new WorkflowError(
        maxNestedWorkflowDepth === 1
          ? "workflow() can nest only one level deep"
          : `workflow() nesting depth exceeded (max ${maxNestedWorkflowDepth})`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        {
          recoverable: false,
        },
      );
    }
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    const workflowName = String(nameOrScript);
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "workflow",
      stage: "start",
      name: workflowName,
      args: childArgs,
    });
    shared.depth++;
    try {
      // Propagate the resumeJournal into the child frame ONLY while the
      // parent's own longest-unchanged-prefix is still intact at the moment
      // of this workflow() call (state.firstMiss === Infinity, i.e. every
      // parent agent()/checkpoint() call BEFORE this one was a cache hit).
      // This is namespacing-safe (see JournalEntry.runId) but namespacing
      // alone is NOT sufficient: SharedStore content itself is not part of
      // any call's hash, so a cached child result was computed against
      // whatever store state the UPSTREAM parent calls had written at the
      // time it originally ran live. If an upstream parent call misses
      // (edited script) and re-runs live, it may write different store
      // values than it did originally — a child cached under the OLD store
      // state would then be replaying a result that's stale with respect to
      // the NEW live state, even though the child's own hash still matches.
      // The prefix contract already treats "this call sits after a miss" as
      // "must run live" for calls within one frame; a nested workflow() is
      // no exception; once anything upstream in the parent has missed, cut
      // the child off from the journal entirely so it runs fully live.
      const prefixIntact = state.firstMiss === Number.POSITIVE_INFINITY;
      const child = await runWorkflow(childScript, {
        ...options,
        args: childArgs,
        sharedRuntime: shared,
        // Propagate the parent's store so nested agents share the same key-value space.
        sharedStore: store,
        resumeJournal: prefixIntact ? options.resumeJournal : undefined,
        resumeFromRunId: undefined,
        // shared.nestedCallSeq, not shared.depth — see its doc comment: depth
        // returns to 0 between sequential sibling calls, which would otherwise
        // mint the same child runId (and hence colliding deltaKeys/event ids)
        // for two different children.
        runId: `${runId}-nested${++shared.nestedCallSeq}`,
        persistLogs: false,
      });
      // Merge the child frame's failures up so the top-level completion gate sees
      // them (a parallel-absorbed child failure is invisible to the parent's own
      // agent() bookkeeping).
      if (child.failedAgents?.length) {
        for (const f of child.failedAgents) {
          state.failedAgents.push({ ...f, nested: workflowName });
        }
      }
      return child.result;
    } finally {
      shared.depth--;
      safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
        type: "workflow",
        stage: "end",
        name: workflowName,
        args: childArgs,
      });
    }
  };

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  /**
   * Monotonic per-run counter for quality-helper invocations, embedded in agent
   * labels so the same helper called twice never reuses a label (L14) — labels
   * double as display identity, and duplicate labels across invocations make two
   * different votes indistinguishable in the run's agent list.
   */
  let qualityCallSeq = 0;

  /**
   * Per-vote tolerance wrapper (M4): a single reviewer/judge hitting the schema
   * wall (SCHEMA_NONCOMPLIANCE) or an execution failure (AGENT_EXECUTION_ERROR)
   * must not abort the whole verify()/judgePanel() — the documented contract is
   * "failed reviewers are omitted" — so those two classes log and yield a null
   * vote. Budget/limit/abort classes still fail the run: they are run-wide
   * conditions, not per-vote noise.
   */
  const tolerantVote = async (prompt: string, label: string, schema: TSchema | undefined): Promise<unknown> => {
    try {
      return await agent(prompt, { label, schema });
    } catch (error) {
      if (
        isWorkflowError(error) &&
        (error.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE ||
          error.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR)
      ) {
        log(`${label} omitted (${error.code}): ${error.message}`);
        return null;
      }
      throw error;
    }
  };

  /** Clamp a judge's raw score into [0, 1] (L15); a non-finite score counts as 0. */
  const clampScore = (value: unknown): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  };

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const callSeq = ++qualityCallSeq;
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "quality",
      stage: "start",
      helper: "verify",
    });
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            tolerantVote(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              // reviewer.callSeq order keeps the `verify <reviewer>` prefix stable
              // across invocations while the trailing counter makes labels unique (L14).
              `verify ${i + 1}.${callSeq}`,
              VERIFY_SCHEMA,
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    const verdict = {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      votes,
    };
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "quality",
      stage: "end",
      helper: "verify",
    });
    return verdict;
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const callSeq = ++qualityCallSeq;
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "quality",
      stage: "start",
      helper: "judgePanel",
    });
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  tolerantVote(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    // attempt.judge.callSeq order keeps the `judge <attempt>.<judge>`
                    // prefix stable across invocations (consumers group by it) while
                    // the trailing per-invocation counter makes labels unique (L14).
                    `judge ${idx + 1}.${j + 1}.${callSeq}`,
                    JUDGE_SCHEMA,
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          // Each judge's score is clamped to [0, 1] before averaging (L15) so a
          // single out-of-range score cannot skew a candidate's mean.
          const score = js.length ? js.reduce((s, v) => s + clampScore(v?.score), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "quality",
      stage: "end",
      helper: "judgePanel",
    });
    return best;
  };

  /**
   * Result of {@link loopUntilDry}: the accumulated items plus an honest
   * termination reason. A NULL round is a FAILED round (M3) — the round's
   * work could not complete (e.g. a recoverable-exhausted agent), which is
   * categorically different from a successful-but-empty round (dry).
   */
  interface LoopUntilDryResult {
    items: unknown[];
    /** "dry": K consecutive successful empty rounds; "maxRounds": cap hit;
     * "capacity": budget/agent-limit exhaustion broke the loop; "failed": a
     * round returned null/undefined. */
    termination: "dry" | "maxRounds" | "capacity" | "failed";
    /** How many rounds failed (returned null) before the loop stopped. */
    failedRounds: number;
  }

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }): Promise<LoopUntilDryResult> => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = normalizeBoundedCount(opts.consecutiveEmpty, 2, Number.MAX_SAFE_INTEGER);
    const maxRounds = normalizeBoundedCount(opts.maxRounds, 50, Number.MAX_SAFE_INTEGER);
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    let failedRounds = 0;
    let termination: LoopUntilDryResult["termination"] = "maxRounds";
    for (let r = 0; r < maxRounds; r++) {
      let items: unknown[] | null;
      try {
        items = (await opts.round(r)) ?? null;
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) {
          termination = "capacity";
          break;
        }
        throw error;
      }
      // null/undefined from the round = the round FAILED (its work did not
      // complete) — not dry. A dry round is a successful round that found
      // nothing new. Treating a failed round as dry would silently terminate
      // a loop whose work is genuinely incomplete (M3).
      if (items === null) {
        failedRounds++;
        termination = "failed";
        break;
      }
      const fresh = items.filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        if (dry >= consecutiveEmpty) {
          termination = "dry";
          break;
        }
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return { items: all, termination, failedRounds };
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = async (taskArgs: unknown, results: unknown) => {
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "quality",
      stage: "start",
      helper: "completenessCheck",
    });
    const verdict = await agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "quality",
      stage: "end",
      helper: "completenessCheck",
    });
    return verdict;
  };

  // ── Authoring helpers: deterministic, resume-safe combinators built purely ──
  // ── on agent()/parallel() (so callSeq ordering stays stable and resume      ──
  // ── keeps working). They never mint agent() calls of their own beyond what  ──
  // ── the author's callbacks request.                                         ──

  /**
   * Monotonic elapsed-milliseconds global, seeded at the TOP-LEVEL run start
   * (nested workflow() frames share the same seed via SharedRuntime). Runs on
   * the host clock: the vm determinism prelude blocks Date.now() inside
   * scripts, but this closure lives on the host and is injected as a global.
   *
   * Determinism contract: the value is wall-clock-dependent and is NEVER part
   * of any resume hash, so it must never be embedded in agent() prompts or fed
   * into anything that influences call identity — a resumed run replays cached
   * calls fast and would observe different elapsed values than the original
   * run did. Use an args-seeded counter for content that must be stable across
   * resume (see timeboxed's docs).
   */
  const elapsedMs = () => Math.max(0, Date.now() - shared.runStartedAtMs);

  /** One chunk whose work failed recoverably, with its stable identity. */
  interface ChunkedFailure {
    /** Zero-based chunk index — deterministic for a fixed item order + chunkSize. */
    index: number;
    /** The exact chunk whose mapper resolved null. */
    chunk: unknown[];
  }

  /**
   * Split a long input list into bounded chunks and run one unit of work per
   * chunk through parallel(). Closes the hand-chunking gap behind
   * completenessCheck's 4,000-char evidence truncation: authors chunk large
   * inputs instead of hand-rolling loops, and each chunk's agent() calls keep
   * stable resume hashes as long as the mapper embeds the chunk content and
   * chunkIndex in its prompts.
   *
   * Error contract: a recoverable-null chunk result stays null in `results`
   * AND is recorded in `failed` with its stable index and chunk (positional
   * integrity preserved for downstream mapping). Non-recoverable failures
   * (token budget / agent limit / abort) and plain mapper script errors
   * rethrow exactly like a directly-awaited parallel() fan-out (M2).
   */
  const chunked = async (
    items: unknown[],
    opts: {
      chunkSize: number;
      mapper: (chunk: unknown[], chunkIndex: number) => Promise<unknown> | unknown;
      synthesizer?: (
        results: Array<unknown | null>,
        meta: { failed: ChunkedFailure[]; chunkCount: number; items: unknown[] },
      ) => Promise<unknown> | unknown;
    },
  ): Promise<unknown> => {
    if (!Array.isArray(items)) throw new TypeError("chunked() expects an array of items");
    if (!opts || typeof opts.mapper !== "function")
      throw new TypeError("chunked() requires { mapper: (chunk, chunkIndex) => result }");
    const chunkSize = normalizeBoundedCount(opts.chunkSize, 1, Number.MAX_SAFE_INTEGER, "chunkSize");
    // Deterministic partitioning: identical item order + chunkSize always yield
    // identical chunk boundaries, so chunk-indexed agent() prompts hash stably.
    const chunks: unknown[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
    const results = await parallel(chunks.map((chunk, index) => async () => opts.mapper(chunk, index)));
    const failed: ChunkedFailure[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) failed.push({ index: i, chunk: chunks[i] });
    }
    if (opts.synthesizer !== undefined) {
      return opts.synthesizer(results, { failed, chunkCount: chunks.length, items });
    }
    return { results, failed, chunkCount: chunks.length };
  };

  interface RouteCase {
    /** Stable dispatch key; also the enum value the classifier must return. */
    key: string;
    /**
     * Eligibility guard: a case whose guard fails never reaches the
     * classification enum, so the enum only contains reachable keys and the
     * classification hash stays stable per value + case list.
     */
    when?: (value: unknown) => boolean | Promise<boolean>;
    /** Pure-JS action for the classified value; may call agent(). */
    run: (value: unknown) => Promise<unknown> | unknown;
  }

  interface RouteOutcome {
    /** Matched case key, or null when fallback dispatched. */
    key: string | null;
    /** The dispatched case's or fallback's result. */
    result: unknown;
    /** True when fallback ran instead of a case. */
    fallback: boolean;
    /** Why: a case matched, or the fallback reason. */
    reason: "none" | "no-eligible-case" | "classification-failed" | "unknown";
  }

  /**
   * One schema'd classification agent (enum of eligible case keys) followed by
   * pure-JS dispatch — automates the classify-and-act pattern's classification
   * step. The classification prompt embeds the value and the eligible key
   * list, so the resume hash is stable per value + case list; a changed value
   * or case list invalidates the cached classification exactly when it should.
   *
   * Fallback semantics: no eligible case (all when() guards fail) → fallback
   * with reason "no-eligible-case" and NO agent() call; a recoverable-null
   * classification (exhausted agent or schema/execution failure tolerated by
   * tolerantVote) → fallback with reason "classification-failed"; an
   * out-of-enum key (defensive; the enum schema should prevent it) → fallback
   * with reason "unknown". Budget/limit/abort failures always rethrow.
   */
  const route = async (
    value: unknown,
    opts: {
      cases: RouteCase[];
      fallback: (
        value: unknown,
        context: { reason: RouteOutcome["reason"]; classification: string | null },
      ) => Promise<unknown> | unknown;
    },
  ): Promise<RouteOutcome> => {
    const callSeq = ++qualityCallSeq;
    if (!opts || !Array.isArray(opts.cases) || opts.cases.length === 0)
      throw new TypeError("route() requires { cases: [{ key, run, when? }] } with at least one case");
    if (typeof opts.fallback !== "function")
      throw new TypeError("route() requires a fallback(value, context) function");
    const seenKeys = new Set<string>();
    for (const routeCase of opts.cases) {
      if (typeof routeCase.key !== "string" || !routeCase.key.trim())
        throw new TypeError("route() case keys must be nonblank strings");
      if (seenKeys.has(routeCase.key)) throw new TypeError(`route() duplicate case key "${routeCase.key}"`);
      seenKeys.add(routeCase.key);
      if (typeof routeCase.run !== "function")
        throw new TypeError(`route() case "${routeCase.key}" needs a run function`);
    }
    // Pure-JS eligibility first: guards run synchronously-or-async and decide
    // the enum, so the classifier never sees unreachable keys (and no agent is
    // spent when nothing is eligible).
    const eligible: RouteCase[] = [];
    for (const routeCase of opts.cases) {
      if (routeCase.when === undefined || (await routeCase.when(value))) eligible.push(routeCase);
    }
    if (eligible.length === 0) {
      const result = await opts.fallback(value, { reason: "no-eligible-case", classification: null });
      return { key: null, result, fallback: true, reason: "no-eligible-case" };
    }
    const keys = eligible.map((routeCase) => routeCase.key);
    const classification = await tolerantVote(
      `Classify the following value into exactly one of these categories: ${keys.join(
        ", ",
      )}. Reply with the matching category key.\n\nValue:\n${JSON.stringify(value)}`,
      `route ${callSeq}`,
      { type: "object", properties: { key: { type: "string", enum: keys } }, required: ["key"] },
    );
    if (classification === null) {
      const result = await opts.fallback(value, { reason: "classification-failed", classification: null });
      return { key: null, result, fallback: true, reason: "classification-failed" };
    }
    const returnedKey = (classification as { key?: unknown } | null)?.key;
    const matched =
      typeof returnedKey === "string" ? eligible.find((routeCase) => routeCase.key === returnedKey) : undefined;
    if (!matched) {
      const result = await opts.fallback(value, {
        reason: "unknown",
        classification: typeof returnedKey === "string" ? returnedKey : null,
      });
      return { key: null, result, fallback: true, reason: "unknown" };
    }
    return { key: matched.key, result: await matched.run(value), fallback: false, reason: "none" };
  };

  /**
   * Cooperative wall-clock bound for a unit of work. fn(context) checks
   * context.expired() / context.remaining() at its OWN decision points and
   * returns early with partial results; timeboxed itself never interrupts a
   * running fn (racing would abandon the vm script's continuation, which could
   * keep calling agent() after the run's drain has begun). After fn settles,
   * timedOut truthfully reports whether the deadline was exceeded.
   *
   * Resume note: the timedOut flag is timing-dependent and never journaled — a
   * resumed run replays cached agent() calls fast, so the same timeboxed() call
   * may NOT time out where the original run did. Treat it as steering, never
   * as part of run identity; never embed elapsed values in prompts/hashes.
   */
  const timeboxed = async <T>(
    fn: (context: { elapsed: () => number; remaining: () => number; expired: () => boolean }) => Promise<T> | T,
    opts: { maxElapsedMs: number },
  ): Promise<{ result: T; timedOut: boolean; elapsedMs: number; maxElapsedMs: number }> => {
    if (typeof opts?.maxElapsedMs !== "number" || !Number.isFinite(opts.maxElapsedMs))
      throw new TypeError(`timeboxed() requires a finite maxElapsedMs, got ${String(opts?.maxElapsedMs)}`);
    const maxElapsedMs = Math.max(0, Math.floor(opts.maxElapsedMs));
    const startedAt = Date.now();
    const localElapsed = () => Math.max(0, Date.now() - startedAt);
    const context = {
      elapsed: localElapsed,
      remaining: () => Math.max(0, maxElapsedMs - localElapsed()),
      expired: () => localElapsed() >= maxElapsedMs,
    };
    const result = await fn(context);
    const elapsed = localElapsed();
    return { result, timedOut: elapsed >= maxElapsedMs, elapsedMs: elapsed, maxElapsedMs };
  };

  interface ConsensusVote {
    verdict: boolean;
    reasoning?: string;
  }

  /**
   * Panel consensus with an agreement gate and optional arbitration. Each round
   * polls `panelists` (default 3) independently via parallel() + tolerantVote
   * with a structured { verdict, reasoning? } schema. A per-vote recoverable
   * null is omitted and SHRINKS the denominator (logged) — a failed panelist
   * never vetoes or dilutes the surviving votes. The pairwise agreement gate
   * passes when the largest mutually-agreeing group (every pair within it
   * agrees) covers at least agreeThreshold (default 0.66) of valid votes.
   * Rounds are bounded (default 2); after the budget an optional arbitrator —
   * typically one structured agent() call by the author — decides, otherwise
   * the disagreement is returned honestly with agreed: false.
   */
  const consensus = async (
    question: string,
    opts: {
      panelists?: number;
      rounds?: number;
      agreeThreshold?: number;
      arbitrator?: (context: {
        question: string;
        votes: Array<ConsensusVote | null>;
        rounds: number;
      }) => Promise<unknown> | unknown;
    } = {},
  ): Promise<{
    agreed: boolean;
    verdict: boolean | null;
    count: number;
    total: number;
    votes: Array<ConsensusVote | null>;
    rounds: number;
    omitted: number;
    arbitration?: unknown;
  }> => {
    const callSeq = ++qualityCallSeq;
    if (typeof question !== "string" || !question.trim())
      throw new TypeError("consensus() requires a nonblank question string");
    const panelists = normalizeBoundedCount(
      opts.panelists,
      CONSENSUS_DEFAULT_PANELISTS,
      Number.MAX_SAFE_INTEGER,
      "panelists",
    );
    const rounds = normalizeBoundedCount(opts.rounds, CONSENSUS_DEFAULT_ROUNDS, Number.MAX_SAFE_INTEGER, "rounds");
    const rawThreshold = opts.agreeThreshold ?? CONSENSUS_DEFAULT_AGREE_THRESHOLD;
    if (typeof rawThreshold !== "number" || !Number.isFinite(rawThreshold))
      throw new TypeError(`consensus() agreeThreshold must be finite, got ${String(rawThreshold)}`);
    const threshold = Math.max(0, Math.min(1, rawThreshold));
    let omitted = 0;
    let lastRound: Array<ConsensusVote | null> = [];
    let executedRounds = 0;
    safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
      type: "quality",
      stage: "start",
      helper: "consensus",
    });
    try {
      for (let round = 1; round <= rounds; round++) {
        executedRounds = round;
        const votes = (await parallel(
          Array.from(
            { length: panelists },
            (_v, i) => () =>
              tolerantVote(
                `Independent panelist ${i + 1} of ${panelists} (round ${round}). Do you AGREE or DISAGREE with the statement below? Reply with your verdict.\n\nStatement:\n${question}`,
                `consensus ${round}.${i + 1}.${callSeq}`,
                {
                  type: "object",
                  properties: { verdict: { type: "boolean" }, reasoning: { type: "string" } },
                  required: ["verdict"],
                },
              ),
          ),
        )) as Array<ConsensusVote | null>;
        lastRound = votes;
        const valid = votes.filter((vote): vote is ConsensusVote => vote !== null && typeof vote.verdict === "boolean");
        const invalid = votes.length - valid.length;
        if (invalid > 0) {
          omitted += invalid;
          log(
            `consensus round ${round}: ${invalid}/${votes.length} panelist vote(s) omitted (recoverable); ` +
              `denominator shrinks to ${valid.length}`,
          );
        }
        if (valid.length > 0) {
          const yes = valid.filter((vote) => vote.verdict).length;
          const no = valid.length - yes;
          const [value, count] = yes >= no ? [true, yes] : [false, no];
          if (count / valid.length >= threshold) {
            return { agreed: true, verdict: value, count, total: valid.length, votes, rounds: executedRounds, omitted };
          }
        }
      }
    } finally {
      safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
        type: "quality",
        stage: "end",
        helper: "consensus",
      });
    }
    const total = lastRound.filter((vote) => vote !== null && typeof vote.verdict === "boolean").length;
    if (opts.arbitrator !== undefined) {
      const arbitration = await opts.arbitrator({ question, votes: lastRound, rounds: executedRounds });
      return {
        agreed: false,
        verdict: null,
        count: 0,
        total,
        votes: lastRound,
        rounds: executedRounds,
        omitted,
        arbitration,
      };
    }
    return { agreed: false, verdict: null, count: 0, total, votes: lastRound, rounds: executedRounds, omitted };
  };

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE (L27): each attempt journals under its
  // own stable call index, so on resume the completed attempts REPLAY from the
  // journal and the chain resumes from the last journaled attempt — attempt N+1's
  // hash depends on N's live result, so only attempts that actually ran re-run.
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = normalizeBoundedCount(opts.attempts, 3, Number.MAX_SAFE_INTEGER);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      const accepted = !opts.until || opts.until(last);
      safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
        type: "control-attempt",
        helper: "retry",
        attempt: i + 1,
        accepted,
      });
      if (accepted) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ) => {
    const attempts = normalizeBoundedCount(opts.attempts, 3, Number.MAX_SAFE_INTEGER);
    let feedback: string | undefined;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      const verdict = await validator(last);
      const accepted = Boolean(verdict?.ok);
      safeCallback("onRuntimeEvent", options.onRuntimeEvent, {
        type: "control-attempt",
        helper: "gate",
        attempt: i + 1,
        accepted,
      });
      if (accepted) return { ok: true, value: last, attempts: i + 1 };
      feedback = verdict?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw agentLimitError();
    }
    const callIndex = state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions);
    // Namespaced by runId like agent()'s deltaKey — see JournalEntry.runId.
    const journalKey = `${runId}:${callIndex}`;
    const cached = options.resumeJournal?.get(journalKey);
    if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      return cached.result; // replay the journaled human reply
    }
    if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
    shared.agentCount++;

    let reply: unknown;
    if (options.checkpointGate) {
      // Visual approve/deny gate (e.g. the plannotator SSE bridge): publish the
      // checkpoint payload to the gate, then wait for the human verdict instead
      // of the inline confirm. Resume-safe: the journaled reply replays from the
      // cache hit above, so a re-run never re-blocks on the gate. Flush declared
      // stages first so an approval records against the current stage (approvePlan
      // is only valid at stage 2 of the phase state machine).
      await flushPhaseState();
      const plan = await options.checkpointGate.submitPlan({
        prompt: promptText,
        kind: checkpointOptions.kind ?? "confirm",
        choices: checkpointOptions.choices,
        default: checkpointOptions.default,
        runId,
        callIndex,
      });
      let approved: boolean;
      try {
        approved = await options.checkpointGate.waitForApproval(plan.id, checkpointOptions.timeoutMs, options.signal);
      } catch (error) {
        // A host abort surfaced by the gate is re-routed through the run's
        // canonical abort path (throwIfAborted below); any other gate failure
        // (bind error, I/O) propagates as-is.
        if (!(error instanceof Error && error.name === "AbortError" && options.signal?.aborted)) throw error;
        approved = false;
      }
      throwIfAborted();
      await recordGateVerdict(approved);
      // Approve/deny verdict mapping: a confirmed plan resolves true on approval
      // and false on denial/timeout; input/select checkpoints present the declared
      // default as the payload under review, so approval resolves that default.
      reply = approved
        ? checkpointOptions.kind === "confirm" || checkpointOptions.kind === undefined
          ? true
          : (checkpointOptions.default ?? true)
        : false;
    } else if (options.confirm) {
      reply = await options.confirm(promptText, checkpointOptions);
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint "${promptText}" needs human input but none is available (headless run)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
    } else {
      reply = checkpointOptions.default ?? true;
    }
    throwIfAborted();
    safeCallback("onAgentJournal", options.onAgentJournal, {
      index: callIndex,
      runId,
      hash: callHash,
      result: reply,
    });
    return reply;
  };

  const runtimeImplementations = {
    agent,
    parallel,
    pipeline,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    chunked,
    route,
    timeboxed,
    elapsedMs,
    consensus,
    retry,
    gate,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
  } satisfies WorkflowRuntimeImplementations;
  const { globals: projectGlobals, diagnostics: bindingDiagnostics } =
    WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(runtimeImplementations);
  for (const diagnostic of bindingDiagnostics) logger.warn(diagnostic.message);
  // ── Pre-run guards at the vm wrapper — the single choke point every script ──
  // ── execution (top-level and each nested workflow() frame) passes through. ──
  //
  // Runaway recursion ceiling: shared.depth counts live nested workflow()
  // frames (workflowFn increments it around the nested runWorkflow call). The
  // policy check above already caps nesting at maxNestedWorkflowDepth (default
  // 1); this is the hard ceiling that no future nesting path can slip past.
  // Deliberately NOT a sandbox claim — the vm is not a security boundary — it
  // only stops runaway recursion from piling frames up unbounded.
  if (shared.depth >= MAX_NESTED_WORKFLOW_DEPTH) {
    throw new WorkflowError(
      `workflow() recursion depth exceeded (max ${MAX_NESTED_WORKFLOW_DEPTH}) — runaway nested workflow() calls are blocked`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  // Optional advisory pre-run typecheck (opt-in, soft-fail): acorn parse already
  // catches syntax errors; this catches type errors before execution. Every
  // failure mode (no tsc toolchain, spawn error, timeout, tsc findings) logs a
  // warning and the run proceeds — see typecheckWorkflowScript.
  if (options.preRunTypecheck) {
    const outcome = await typecheckWorkflowScript({ meta, body }, { cwd: baseCwd });
    if (!outcome.ok) {
      log(
        `[warn] pre-run typecheck failed — continuing anyway (advisory; set preRunTypecheck: false to disable): ${outcome.detail}`,
      );
    }
  }
  const context = vm.createContext({
    ...projectGlobals,
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  try {
    const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    // Emit final token usage — guarded so a throwing onTokenUsage listener can
    // never fail a run that already completed (M1).
    safeCallback("onTokenUsage", options.onTokenUsage, shared.tokenUsage);

    return {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: shared.agentCount,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: shared.tokenUsage,
      // The manager's completion-time AGENT_EXHAUSTED gate + the tool's failure
      // text both read this; absent when every agent succeeded (undefined keys
      // are JSON-dropped, keeping lenient runs' persisted shape unchanged).
      failedAgents: state.failedAgents.length > 0 ? state.failedAgents : undefined,
    };
  } catch (error) {
    // This error just escaped THIS frame's own vm script execution completely
    // uncaught. For the top-level frame that means nothing anywhere in the
    // whole call chain (this script, any enclosing try/catch around a nested
    // workflow()/parallel()/agent()) caught it — the run's fate is genuinely
    // sealed now (see SharedRuntime.runFatalController). Sealing it here, not
    // inside agent()/parallel(), is what preserves parallel()'s "a thrown
    // thunk resolves to null without failing the others" contract and a
    // script's own try/catch around agent()/workflow(): both those cases are
    // swallowed well before an error would ever reach this catch. A NESTED
    // frame reaching here does NOT seal anything — the parent script may still
    // catch workflow()'s rejection and continue, so only isTopLevelRun acts.
    // Idempotent: if this is already an intentional pause/stop (options.signal
    // aborted) or a second escape after the fatal signal already fired,
    // aborting an already-aborted controller is a no-op.
    //
    // This also fires on a PROVIDER_USAGE_LIMIT escape (a quota/rate-limit
    // hit), not just a genuine bug — that error is non-recoverable too (see
    // errors.ts), so it escapes exactly like any other run-fatal error and
    // seals the same way. Deliberate tradeoff: any sibling still in flight
    // when the quota was hit gets aborted rather than allowed to finish and
    // journal — this stops burning an already-exhausted budget right now, at
    // the cost of that sibling's work being thrown away and re-run live when
    // the paused run resumes (it was never journaled, so it isn't cached).
    if (isTopLevelRun) shared.runFatalController.abort();
    throw error;
  } finally {
    // Persist any phase-state transitions queued by phase() declarations that
    // never reached an awaited flush point (a planning-only frame with no
    // checkpoint/agent) so the state file reflects the final declared stage.
    // Runs per frame: a nested workflow() inherits the integration via the
    // spread options, so each frame flushes its own queued transitions.
    // Best-effort: the state machine is persistence bookkeeping here, so a
    // rejected trailing transition (e.g. a backward stage declaration) is
    // logged, never allowed to fail an otherwise-completed run. Strict
    // enforcement happens at the checkpoint-gate/agent() flush points, which
    // throw.
    await flushPhaseState().catch((error: unknown) => {
      log(`phase state machine flush failed at run end: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Only the top-level frame drains/disposes (see isTopLevelRun) — a nested
    // workflow()'s in-flight agents are still tracked in this SAME shared set
    // and get drained once, here, when the whole run finishes.
    if (isTopLevelRun) {
      // Wait out every agent() call spawned anywhere in this run — including
      // ones the script never awaited — before the store goes away. Without
      // this, a forgotten `await agent(...)` could keep mutating store/journal
      // state after the run is marked complete/failed and torn down. Loop
      // (not a single Promise.allSettled) because draining can itself let a
      // still-running call schedule further work that adds to the set.
      //
      // Bounded, not indefinite. A run-fatal abort (see the catch above)
      // aborts the AbortSignal passed to each in-flight agent, but that is
      // cooperative — an agent runner that ignores its signal (or one still
      // waiting out a real subagent process that won't die) never settles on
      // its own. Combined with agentTimeoutMs: null (no hard timeout, the
      // default), a single hung, signal-ignoring, un-awaited agent() call
      // would wedge this drain — and therefore the whole run's completion —
      // forever. So the drain runs under a hard deadline: once drainTimeoutMs
      // (default DRAIN_ABORT_TIMEOUT_MS) has elapsed with agents still in
      // flight, runFatalController is aborted — the same cooperative abort a
      // run-fatal error uses, which every in-flight agent()'s per-attempt
      // AbortController is linked to — and the run completes without the
      // stragglers. Termination is guaranteed by the deadline itself; the
      // abort just winds cooperative agents down before the drain gives up.
      if (shared.inFlight.size > 0) {
        log(`waiting for ${shared.inFlight.size} outstanding agent() call(s) to settle before this run completes`);
      }
      const drainDeadline = Date.now() + drainTimeoutMs;
      while (shared.inFlight.size > 0) {
        if (Date.now() >= drainDeadline) {
          shared.runFatalController.abort();
          log(
            `drain deadline (${drainTimeoutMs}ms) reached with ${shared.inFlight.size} outstanding agent() call(s) ` +
              `still running; aborting them and completing the run — check for un-awaited agent() calls or a hung subagent`,
          );
          break;
        }
        await waitForInFlightSettlement(shared.inFlight, drainDeadline);
      }
      store.dispose();
      // Dispose any chained handoff session so it never outlives its run frame
      // (a no-op for injected test doubles without close()).
      try {
        agentRunner.close?.();
      } catch {
        // teardown is best-effort; never mask the run's own result/error
      }
    }
  }
}

export function parseWorkflowScript(script: string): {
  meta: WorkflowMeta;
  body: string;
  /**
   * Maps each body line (1-indexed) to the line of the ORIGINAL script it came
   * from — the meta export (and any leading comments) is stripped into `body`,
   * so body line numbers differ from script line numbers. The vm stack reports
   * WRAPPED line numbers (prelude + async wrapper + body), so tracing an
   * agent() call back to its script line needs this map AND the prelude offset
   * (see captureScriptLine).
   */
  bodyLineToScriptLine: number[];
} {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
    bodyLineToScriptLine: buildBodyLineToScriptLine(script, first.start, first.end),
  };
}

/**
 * Map each body line (1-indexed) to the original script line it came from.
 * See parseWorkflowScript's return doc. Walks the body once, tracking the
 * corresponding script cursor and jumping over the stripped meta segment.
 */
function buildBodyLineToScriptLine(script: string, metaStart: number, metaEnd: number): number[] {
  const map = [0];
  const bodyLen = script.length - (metaEnd - metaStart);
  let bodyLine = 1;
  // Script index of body char 0: the prefix (script[0..metaStart)) is empty
  // when metaStart === 0, so body char 0 is directly script[metaEnd].
  let scriptPos = metaStart === 0 ? metaEnd : 0;
  map[1] = lineOfIndex(script, scriptPos);
  for (let i = 0; i < bodyLen; i++) {
    if (script[scriptPos] === "\n") {
      bodyLine++;
      scriptPos++;
      map[bodyLine] = lineOfIndex(script, scriptPos);
    } else {
      scriptPos++;
    }
    // Body chars at/after metaStart map to script chars shifted by the
    // stripped segment — advance the cursor past it exactly once.
    if (scriptPos === metaStart) scriptPos = metaEnd;
  }
  return map;
}

/** 1-based line number of a character index in `text`. */
function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Recover the original workflow-script line of the agent() call currently
 * executing, from a fresh Error's stack. The script runs wrapped inside a
 * DETERMINISM_PRELUDE + async arrow, so vm frames report wrapped line numbers;
 * map back through the prelude offset and the body→script line map. Returns
 * undefined when the call site can't be attributed (never throws).
 */
function captureScriptLine(stack: string, scriptFilename: string, bodyLineToScriptLine: number[]): number | undefined {
  let wrappedLine: number | undefined;
  for (const frame of stack.split("\n")) {
    // vm frames are anonymous: `at trace_ok.js:19:17` (no parens). Host
    // frames carry the callee: `at agentImpl (F:\...\workflow.ts:661:7)`.
    const paren = frame.match(/\(([^()]+):(\d+):\d+\)$/);
    const bare = frame.match(/^ {4}at ([^ (]+):(\d+):\d+$/);
    const file = paren?.[1] ?? bare?.[1];
    if (file === undefined) continue;
    const line = Number(paren?.[2] ?? bare?.[2]);
    if (file === scriptFilename) {
      wrappedLine = line;
      break;
    }
    // Fallback: any bare-js frame (vm frames carry no directory) — host frames
    // have path separators and node internals have no .js extension.
    if (file.endsWith(".js") && !file.includes("/") && !file.includes("\\")) {
      wrappedLine = line;
      break;
    }
  }
  if (wrappedLine === undefined) return undefined;
  // wrapped = prelude + "\n(async () => {\n" + body + "\n})()"
  const bodyLine = wrappedLine - (DETERMINISM_PRELUDE.split("\n").length + 1);
  if (bodyLine < 1) return undefined;
  return bodyLineToScriptLine[bodyLine];
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  // Semaphore-style handoff (audit L1): the slot is taken (`active++`) BEFORE
  // the queued waiter is released, so there is no microtask window where a
  // caller sees a free slot that is already spoken for. The waiter must NOT
  // increment again when it wakes — `next()` already did it on its behalf.
  const next = () => {
    active--;
    const release = queue.shift();
    if (release) {
      active++;
      release();
    }
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/**
 * Stable identity hash for a checkpoint() call — a cache miss on resume when
 * anything that could change its outcome changes. Must cover every
 * CheckpointOptions field that participates in the outcome, not just
 * promptText/kind/choices:
 *   - `default` and `headless` decide the reply in the headless (no `confirm`
 *     threaded in) path — a script edited to change either must not resume
 *     with the OLD default/behavior's stale journaled reply.
 *   - `timeoutMs` bounds the interactive prompt; a host `confirm` may itself
 *     fall back to `default` when the human doesn't answer in time, so it can
 *     also affect the outcome and is included for the same reason.
 * NOTE: widening this hash is a one-time invalidation of any checkpoint
 * answers already persisted under the old (narrower) hash — on the first
 * resume after upgrading, those checkpoints will cache-miss and re-prompt (or
 * re-apply the default) once, live. That's intentional: a silently-stale
 * cached decision from before the identity surface was fixed is worse than a
 * one-time re-ask.
 */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
    default: options.default ?? null,
    headless: options.headless ?? "default",
    timeoutMs: options.timeoutMs ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  tierModel: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
  mainModel: string | undefined,
  isolation: "worktree" | undefined,
): string {
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    // Resolved tier→model (or default-tier model) the session WILL run this
    // agent on, computed from the model-tiers config + mainModel at call time
    // (resolveRoutingModelSignature). `model` above is left null precisely
    // when a tier is set (the model is resolved inside the session), so
    // WITHOUT this field the hash would stay identical across a tier-config
    // change and a stale journaled result would replay on resume
    // (routing-budgets:f1/i2). It mirrors only the file-driven resolution —
    // explicit model/agentType model/default tier — so it does not vary across
    // calls within one run for a fixed config.
    tierModel: tierModel ?? null,
    // The session default model (M5): an UNTAGGED agent with no phase route
    // and no tier config runs on the session's main model, so a default-model
    // change must invalidate its cached replay result too. Included only when
    // neither `model` nor `tierModel` encoded an explicit choice (both are
    // the session-default path); a tiered call's tierModel already falls back
    // to mainModel inside resolveRoutingModelSignature, so this field never
    // double-encodes.
    defaultModel: model == null && tierModel == null ? (mainModel ?? null) : null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    // Worktree isolation changes where the agent runs (a different working tree
    // with different file state), so a result computed in one environment must
    // not replay in another (M5).
    isolation: isolation ?? null,
    schema: options.schema ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Resolve the model spec a tier/routing-config-dependent agent() call will run
 * on, for the resume-replay identity hash. Mirrors the file-driven parts of
 * WorkflowAgent.run's `resolveAgentModelSpec`: explicit per-agent/agentType
 * model > configured tier model > configured default (medium) tier model > the
 * phase/`model` spec already computed by the call site (which itself encodes
 * the phase-routing config). The mainModel fallback matches the session's.
 *
 * Side-effect-free and deterministic over a fixed config: it reads only the
 * tier config and mainModel, never the live model registry, so it cannot vary
 * across calls within a single run — exactly the property the replay hash needs
 * (a miss must reflect a genuine config change, not registry drift).
 */
function resolveRoutingModelSignature(
  options: AgentOptions,
  agentDef: AgentDefinition | undefined,
  modelSpec: string | undefined,
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null,
): string | undefined {
  const explicitModel = options.model ?? agentDef?.model;
  if (explicitModel) return explicitModel;
  const config = loadConfig();
  if (options.tier) {
    return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
  }
  // Untagged agent with a tier config present: the session routes it through
  // the configured default ("medium") tier, so include that resolved model so
  // editing model-tiers.json invalidates untagged agents too.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return modelSpec;
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

function normalizeRetryBackoffMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_RETRY_BACKOFF_MS;
  return Math.min(MAX_RETRY_BACKOFF_MS, Math.floor(value));
}

/**
 * Exponential-backoff wait before retry #N (attempt N→N+1): base × 2^(N-1),
 * capped at 8× base so a long retry chain never stalls the run. Pure function
 * so the schedule is unit-testable without timers.
 */
export function retryBackoffDelayMs(baseMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), baseMs * 8);
}

/**
 * Sleep for `ms` while staying abort-aware (500-path hardening): resolve early
 * when any of `signals` fires (the run's external pause/stop/Esc signal or the
 * run-fatal controller), so a backoff wait never outlives the run it serves.
 * Zero/negative ms resolves immediately (tests disable backoff this way).
 */
function backoffSleep(ms: number, signals: ReadonlyArray<AbortSignal | undefined>): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const s of signals) s?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    for (const s of signals) {
      if (s?.aborted) {
        clearTimeout(timer);
        finish();
        return;
      }
      s?.addEventListener("abort", finish, { once: true });
    }
  });
}

/**
 * Clamp a user-supplied attempt/round/bound value (L13): undefined falls back
 * to `fallback`; a NON-finite value (NaN/±Infinity) throws a TypeError instead
 * of producing an unbounded loop; finite values are floored and clamped to
 * [1, max]. Shared by retry()/gate() attempts, loopUntilDry's
 * maxRounds/consecutiveEmpty, chunked()'s chunkSize, and consensus()'s
 * panelists/rounds. `what` names the bound in the error message.
 */
function normalizeBoundedCount(value: unknown, fallback: number, max: number, what = "attempts/rounds"): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`expected a finite number of ${what}, got ${String(value)}`);
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

/**
 * Wait for every in-flight agent() call to settle, but never past `deadline`.
 * The drain loop races Promise.allSettled against the remaining time instead of
 * awaiting it bare, so a single never-settling promise can't wedge the wait —
 * when the deadline fires we return and the loop decides whether to abort the
 * stragglers (see the drain in runWorkflow's finally). Deterministic: the
 * deadline, not a poll interval, bounds the wait.
 */
async function waitForInFlightSettlement(inFlight: Set<Promise<unknown>>, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return;
  await Promise.race([
    Promise.allSettled(Array.from(inFlight)),
    new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
  ]);
}

/**
 * Run a promise with a timeout.
 *
 * `onTimeout` fires when the deadline hits, BEFORE the timeout rejection wins the
 * race — the caller uses it to abort the underlying work (e.g. the subagent
 * session) so it can release its resources instead of streaming on in the
 * background with the whole session graph (messages, etc.) retained (#109). The
 * losing promise still settles later; the caller must swallow its rejection.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort cleanup; never let it mask the timeout error.
      }
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
