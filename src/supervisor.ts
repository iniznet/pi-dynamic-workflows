/**
 * Run-scoped supervisor (P02): the `supervised-run` builtin pattern's runtime
 * + generator.
 *
 * After each work-agent settle, an ECONOMY supervisor agent (pure-reasoning:
 * `toolNames: []` + structured verdict schema, `tier: "small"`) checks progress
 * against a concrete measurable completion criterion using the run's own settle
 * events (onAgentStart/onAgentEnd with phase/result/error — the deterministic,
 * journal-replayable projection of the run's History/Phase surfaces). On
 * drift/stall it injects ONE corrective agent; on verified completion it
 * declares done and stops the run.
 *
 * Resume safety: every supervisor turn and every corrective agent is a
 * journaled POSITIONAL agent() call (callIndex allocated by the run's callSeq).
 * The supervisor prompt is a pure function of (task, criterion, observations),
 * where the observation log is rebuilt byte-identically on resume from the
 * journaled settle events — so the turn's prompt hash matches and the call
 * replays from the journal exactly like any other agent() call. Verdict parsing
 * is a total, pure function of the journaled raw result, so control flow
 * (correction/done) replays identically. Deliberately NO new AgentOptions
 * fields: the hashAgentCall field set is untouched (RUN RESUME INVARIANT), and
 * the budget knob is READ-ONLY (supervisor turns fold into the run's token
 * spend like every agent(); the loop stops early when the budget is spent).
 *
 * Future note (NOT this slice): durable cross-process residency — a supervisor
 * alive after the host exits — would require an RpcClient-spawned pi child
 * (dist/modes/rpc/rpc-client.d.ts); pi 0.83.0 has no resident-actor API, so v1
 * is strictly in-run. Documented, not implemented.
 */

import { type NumericArgSpec, numericArgCoercionSource } from "./builtin-args.js";
import { DEFAULT_HELPER_TIER, DEFAULT_TEST_GATE_TOOL } from "./config.js";
import { isWorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  buildTestGatePrompt,
  machineValidateTest,
  TEST_GATE_OUTPUT_SCHEMA,
  type TestGateAssert,
  type TestGateTool,
  validateTestGateTests,
} from "./test-gate.js";
import type { AgentOptions, WorkflowRuntimeEvent } from "./workflow.js";

/** Bounds for the supervised-run fix→check rework loop (supervisor turns). */
export const SUPERVISED_RUN_NUMERIC_ARGS: readonly NumericArgSpec[] = [
  { name: "maxRounds", default: 5, min: 1, max: 12, integer: true },
];

/** Default supervisor-turn cap when the script/caller declares none. */
export const SUPERVISOR_DEFAULT_MAX_ROUNDS = 5;

/** Stable label prefix for the supervisor's own turns (display only — never hashed). */
export const SUPERVISOR_LABEL_PREFIX = "supervisor";

/** Stable label prefix for corrective agents injected by the supervisor. */
export const SUPERVISOR_CORRECTION_LABEL_PREFIX = "corrective";

/**
 * Structured verdict the supervisor agent must return. A module-level constant
 * so the JSON-serialized identity (`schema` is part of hashAgentCall) is
 * byte-stable across runs and resumes.
 */
export const SUPERVISOR_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["done", "continue"],
      description:
        '"done" = the concrete measurable completion criterion is verified met; "continue" = more work is required.',
    },
    reason: {
      type: "string",
      description:
        "Evidence-based assessment of progress against the completion criterion (what is verified, what is still missing).",
    },
    correction: {
      type: ["string", "null"],
      description:
        'ONE concrete corrective instruction steering the next work agent back on track; null when status is "done" or no correction is needed.',
    },
  },
  required: ["status", "reason", "correction"],
} as const;

/** One settle-path event the run feeds the supervisor (deterministic projection). */
export interface SupervisorSettleEvent {
  kind: "start" | "end";
  /** `${runId}:${callIndex}` delta key — the call's stable positional identity. */
  id: string;
  label: string;
  phase?: string;
  /** start only: the agent's prompt. */
  prompt?: string;
  /** end only: the settled result (raw — journal-replayable). */
  result?: unknown;
  /** end only: recorded token spend (excluded from prompts — see buildSupervisorPrompt). */
  tokens?: number;
  /** start/end: model label (excluded from prompts — live/replay values can differ). */
  model?: string;
  /** end only: failure detail. */
  error?: string;
  errorCode?: WorkflowErrorCode;
}

/** A recorded observation; fields in fixed order for deterministic serialization. */
export interface SupervisorObservation {
  seq: number;
  kind: "start" | "end";
  /** callIndex parsed from the delta key. */
  call: number;
  label: string;
  phase?: string;
  result?: unknown;
  tokens?: number;
  model?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
}

/**
 * Per-run observation log the settle-path tap feeds. The prompt builder only
 * ever embeds fields that are byte-identical between a live settle and a
 * journal-replayed settle (call/label/phase/result/error) — tokens and model
 * are recorded for the outcome summary but NEVER join a prompt, or a resumed
 * run's supervisor call would hash differently and re-run live.
 */
export interface SupervisorController {
  readonly observations: readonly SupervisorObservation[];
  /** Append one settle-path event (sync, never throws). */
  record(event: SupervisorSettleEvent): void;
  /** Observations recorded at/after the given callIndex (invocation-scoped view). */
  snapshotSince(callIndex: number): readonly SupervisorObservation[];
}

const parseCallIndex = (id: string): number => {
  const separator = id.lastIndexOf(":");
  const suffix = separator >= 0 ? id.slice(separator + 1) : id;
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) ? parsed : -1;
};

/** Create the per-run supervisor observation controller. */
export function createSupervisorController(): SupervisorController {
  const observations: SupervisorObservation[] = [];
  let seq = 0;
  return {
    get observations() {
      return observations;
    },
    record(event: SupervisorSettleEvent): void {
      observations.push({
        seq: seq++,
        kind: event.kind,
        call: parseCallIndex(event.id),
        label: event.label,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        ...(event.kind === "end" ? { result: event.result } : {}),
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
      });
    },
    snapshotSince(callIndex: number): readonly SupervisorObservation[] {
      const from = observations.findIndex((entry) => entry.call >= callIndex);
      return from < 0 ? [] : observations.slice(from);
    },
  };
}

/** Parsed supervisor verdict — a TOTAL, pure function of the raw agent result. */
export interface SupervisorVerdict {
  status: "done" | "continue";
  reason: string;
  /** ONE corrective instruction; null when done or no correction is needed. */
  correction: string | null;
}

/**
 * Parse the supervisor agent's raw result into a verdict. Every input maps to a
 * well-defined verdict (null/non-object/missing status → an empty "continue"
 * round), so control flow is deterministic over the journaled result on resume.
 */
export function parseSupervisorVerdict(result: unknown): SupervisorVerdict {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { status: "continue", reason: "(unparsable supervisor verdict)", correction: null };
  }
  const record = result as Record<string, unknown>;
  const status = record.status;
  const reason = typeof record.reason === "string" ? record.reason : "";
  if (status === "done") {
    return { status: "done", reason, correction: null };
  }
  if (status === "continue") {
    const correction = typeof record.correction === "string" ? record.correction : null;
    return { status: "continue", reason, correction: correction?.trim() ? correction : null };
  }
  return { status: "continue", reason: `(unknown supervisor status: ${String(status)})`, correction: null };
}

/**
 * V2-N1 machine completion criteria. The verdict a script-side criterion
 * function may return: a boolean predicate (`true` = done, `false` =
 * continue) or a structured verdict mirroring the LLM verdict shape.
 * `correction` is a DETERMINISTIC corrective instruction supplied by the
 * script author — never an LLM verdict.
 */
export interface MachineCriterionVerdict {
  status: "done" | "continue";
  reason?: string;
  correction?: string | null;
}

/**
 * Script-side pure predicate: a function of the (journal-rebuilt, deterministic)
 * observation log that returns the continue/done predicate. Must be a PURE
 * function of its input — replay determinism requires it (the same observations
 * must always produce the same verdict).
 */
export type MachineCriterionFunction = (
  observations: readonly SupervisorObservation[],
) => boolean | MachineCriterionVerdict;

/**
 * V2-N1 testGate-style machine criterion spec: ONE machine-checked
 * postcondition run as a subagent step (the P01 mechanism — bash/grep tool +
 * capture schema) whose acceptance is decided by the PURE machineValidateTest
 * predicate, never an LLM verdict. `args` is the command (bash tool) or
 * pattern (grep tool); `assert` follows the shared TestGateAssert contract
 * (absent defaults to `{ exitCode: 0 }`).
 */
export interface MachineCriterionSpec {
  tool?: TestGateTool;
  args: string;
  assert?: TestGateAssert;
}

/**
 * The widened criterion union (V2-N1). A string is the original LLM mode — the
 * supervisor agent checks it with a structured verdict and generates
 * corrections. A machine criterion (function or spec) REPLACES the LLM
 * supervisor turn with a deterministic continue/done predicate: verifiable
 * criteria spend no supervisor-agent tokens and replay identically.
 */
export type SupervisedRunCriterion = string | MachineCriterionFunction | MachineCriterionSpec;

/** How the completion criterion is evaluated (LLM verdict vs machine predicate). */
export type SupervisedRunCriterionMode = "llm" | "machine-function" | "machine-test";

/**
 * Classify + validate the script-supplied criterion into its supervision mode
 * (V2-N1). Throws a TypeError on garbage or a malformed machine-test spec
 * (loud script bug — never silently falls back to the LLM path). The machine
 * modes return the raw criterion value; the string mode returns the trimmed
 * non-empty text.
 */
export function resolveSupervisedRunCriterion(criterion: unknown): {
  mode: SupervisedRunCriterionMode;
  value: SupervisedRunCriterion;
} {
  if (typeof criterion === "string") {
    if (!criterion.trim()) throw new TypeError("supervisedRun requires a non-empty string criterion");
    return { mode: "llm", value: criterion };
  }
  if (typeof criterion === "function") {
    return { mode: "machine-function", value: criterion as MachineCriterionFunction };
  }
  if (criterion !== null && typeof criterion === "object") {
    const spec = criterion as Record<string, unknown>;
    const tool: unknown = spec.tool ?? DEFAULT_TEST_GATE_TOOL;
    if (tool !== "bash" && tool !== "grep") {
      throw new TypeError(`supervisedRun machine-test criterion tool must be "bash" or "grep", got ${String(tool)}`);
    }
    if (typeof spec.args !== "string" || !spec.args.trim()) {
      throw new TypeError("supervisedRun machine-test criterion requires a non-empty string args");
    }
    // The shared testGate contract validates the assert shape — loud on a
    // malformed spec so a broken criterion cannot silently accept/reject.
    const assert = spec.assert as TestGateAssert | undefined;
    validateTestGateTests([{ command: spec.args, assert }], tool);
    const validated: MachineCriterionSpec = { tool, args: spec.args, ...(assert !== undefined ? { assert } : {}) };
    return { mode: "machine-test", value: validated };
  }
  throw new TypeError(
    "supervisedRun criterion must be a non-empty string, a pure function of observations, or a { tool, args, assert } machine-test spec",
  );
}

/**
 * Deterministic, bounded renderer of the criterion for agent prompts. A
 * string embeds as-is (capped); a machine criterion renders as a fixed label
 * plus the spec's command/assert — NEVER the function body (embedding script
 * source would make the task-prompt hash depend on code text, not behavior).
 */
export function describeCriterion(criterion: SupervisedRunCriterion): string {
  if (typeof criterion === "string") return capEmbedded(criterion, 2000);
  if (typeof criterion === "function") {
    return "(machine completion criterion: a script-side pure predicate over the observed run events)";
  }
  const tool = criterion.tool ?? DEFAULT_TEST_GATE_TOOL;
  const assert = criterion.assert === undefined ? "{ exitCode: 0 }" : JSON.stringify(criterion.assert);
  return `(machine completion criterion: run ${tool} command \`${capEmbedded(criterion.args, 400)}\` and require ${assert})`;
}

/**
 * Normalize a machine criterion function's return value into a
 * SupervisorVerdict. TOTAL and pure — every input maps to a well-defined
 * verdict, so the machine continue/done control flow is deterministic over
 * the journal-rebuilt observations (exactly like parseSupervisorVerdict for
 * LLM mode). A `correction` string from the script is the deterministic
 * corrective channel; absent/null means an empty continue round.
 */
export function normalizeMachineFunctionVerdict(raw: unknown): SupervisorVerdict {
  if (typeof raw === "boolean") {
    return raw
      ? { status: "done", reason: "machine completion criterion satisfied", correction: null }
      : { status: "continue", reason: "machine completion criterion not yet satisfied", correction: null };
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.status === "done") {
      return { status: "done", reason: typeof record.reason === "string" ? record.reason : "", correction: null };
    }
    if (record.status === "continue") {
      const correction = typeof record.correction === "string" ? record.correction : null;
      return {
        status: "continue",
        reason: typeof record.reason === "string" ? record.reason : "",
        correction: correction?.trim() ? correction : null,
      };
    }
  }
  return { status: "continue", reason: "(machine criterion returned no usable verdict)", correction: null };
}

/** Options for one `supervisedRun` invocation (script-facing runtime global). */
export interface SupervisedRunOptions {
  /** The work to complete (fed to the task agent and every supervisor prompt). */
  task: string;
  /**
   * The completion criterion. LLM mode (string): the supervisor agent checks
   * it with a structured verdict and generates corrections. V2-N1 machine
   * modes: a script-side PURE function of observations or a testGate-style
   * { tool, args, assert } spec — the deterministic continue/done predicate
   * then REPLACES the LLM supervisor turn (no supervisor-agent spend; a
   * machine-mode failure injects a corrective agent carrying the deterministic
   * machine detail).
   */
  criterion: SupervisedRunCriterion;
  /** Bounded supervisor turns (default SUPERVISOR_DEFAULT_MAX_ROUNDS). */
  maxRounds?: number;
  /** Task agent label (default "task"). */
  taskLabel?: string;
  /** Task agent tier (default: run default — omitted). */
  taskTier?: string;
  /** Explicit task phase (default: the run's current phase). */
  taskPhase?: string;
  /** Supervisor vote tier (default "small" — the economy helper tier). */
  supervisorTier?: string;
  /** Supervisor tool allowlist (default [] — pure-reasoning; read-only tools opt-in). */
  supervisorTools?: string[];
  /** Corrective agent tier (default: taskTier, else run default). */
  correctionTier?: string;
}

/** Structured outcome the script returns as the run result. */
export interface SupervisedRunOutcome {
  /** The final work-agent result (the task agent, or the last corrective agent). */
  result: unknown;
  supervisor: {
    /** Supervisor turns executed. */
    rounds: number;
    /** V2-N1: how the completion criterion was evaluated this run. */
    mode: SupervisedRunCriterionMode;
    /** Whether the supervisor verified the completion criterion met. */
    declaredDone: boolean;
    /** How the loop ended. */
    termination: "declared-done" | "max-rounds" | "budget-exhausted";
    /** The last parsed verdict (null when no turn ran). */
    finalVerdict: SupervisorVerdict | null;
    /** Every turn's parsed verdict, in order. */
    verdicts: SupervisorVerdict[];
    /** Corrective agents injected (one per continue-with-correction turn). */
    corrections: number;
    /** Bounded observation summary (settle event log for the artifact). */
    observations: Array<{
      seq: number;
      kind: "start" | "end";
      call: number;
      label: string;
      phase?: string;
      summary: string;
    }>;
  };
}

/** Read-only run budget surface the supervisor loop consults (never mutates). */
export interface SupervisorBudget {
  total: number | null;
  remaining(): number;
}

/** Run context bindRunSupervisor needs — all supplied from runWorkflow's closure. */
export interface RunSupervisorContext {
  controller: SupervisorController;
  agent: (prompt: string, options?: AgentOptions) => Promise<unknown>;
  budget: SupervisorBudget;
  log: (message: string) => void;
  /** Guarded host callback dispatch for the supervisor's runtime trace. */
  onRuntimeEvent?: (event: WorkflowRuntimeEvent) => void;
}

/** Deterministic prompt-embedding cap (T1-03 pattern): same input → same prompt. */
const capEmbedded = (value: unknown, maxChars: number): string => {
  const text =
    value === null || value === undefined ? "(none)" : typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
};

/** The deterministic observation projection a supervisor prompt may embed. */
const promptSafeObservation = (entry: SupervisorObservation): string => {
  if (entry.kind === "start") {
    return `- #${entry.call} START ${entry.label}${entry.phase ? ` (phase: ${entry.phase})` : ""}`;
  }
  const outcome =
    entry.error !== undefined
      ? `FAILED: ${capEmbedded(entry.error, 400)}`
      : `result: ${capEmbedded(entry.result, 1200)}`;
  return `- #${entry.call} END ${entry.label}${entry.phase ? ` (phase: ${entry.phase})` : ""} → ${outcome}`;
};

/** Build the delegated work agent's prompt (deterministic inputs only). */
export function buildTaskPrompt(task: string, criterion: SupervisedRunCriterion): string {
  return (
    "You are the delegated work agent in a supervised run. Complete the task below. " +
    "A supervisor will verify your work against the completion criterion after you settle — " +
    "make the result verifiable against it.\n\n" +
    `TASK:\n${task}\n\n` +
    `COMPLETION CRITERION (the supervisor will check this):\n${describeCriterion(criterion)}`
  );
}

/** Build the supervisor's pure-reasoning check prompt (deterministic inputs only). */
export function buildSupervisorPrompt(
  task: string,
  criterion: string,
  observations: readonly SupervisorObservation[],
  round: number,
): string {
  const log = observations.map((entry) => promptSafeObservation(entry)).join("\n");
  return (
    "You are the supervisor of a delegated work run. Your ONLY job is to check progress against the concrete measurable " +
    "completion criterion below and return a structured verdict. Do not do the work yourself.\n\n" +
    `TASK:\n${capEmbedded(task, 4000)}\n\n` +
    `COMPLETION CRITERION (a verdict of "done" is only valid when every part of this is verifiably met):\n${capEmbedded(criterion, 2000)}\n\n` +
    `OBSERVED RUN EVENTS SO FAR (agent settles with phases):\n${log.length > 0 ? log : "(no agents have settled yet)"}\n\n` +
    `Supervision round ${round}. ` +
    'Return { status: "done" | "continue", reason, correction }. ' +
    'Use "done" only when the criterion is verifiably met. Use "continue" with EXACTLY ONE concrete correction ' +
    "instruction (what the next work agent should do) when progress has drifted or stalled; correction must be null when done " +
    "or when no correction is needed."
  );
}

/** Build the corrective agent's work prompt (deterministic inputs only). */
export function buildCorrectionPrompt(
  task: string,
  criterion: SupervisedRunCriterion,
  verdict: SupervisorVerdict,
  observations: readonly SupervisorObservation[],
): string {
  const tail = observations
    .slice(-4)
    .map((entry) => promptSafeObservation(entry))
    .join("\n");
  return (
    "You are the corrective work agent in a supervised run. The previous attempt drifted from or stalled against the " +
    "completion criterion; implement exactly the correction below, then keep the task's other requirements intact.\n\n" +
    `TASK:\n${capEmbedded(task, 4000)}\n\n` +
    `COMPLETION CRITERION:\n${describeCriterion(criterion)}\n\n` +
    `SUPERVISOR CORRECTION (do this):\n${capEmbedded(verdict.correction, 2000)}\n\n` +
    `SUPERVISOR REASON:\n${capEmbedded(verdict.reason, 1000)}\n\n` +
    `RECENT RUN EVENTS:\n${tail.length > 0 ? tail : "(none)"}`
  );
}

const summarizeObservations = (
  entries: readonly SupervisorObservation[],
): SupervisedRunOutcome["supervisor"]["observations"] =>
  entries.map((entry) => {
    const summary =
      entry.kind === "end"
        ? entry.error !== undefined
          ? `error: ${capEmbedded(entry.error, 600)}`
          : `result: ${capEmbedded(entry.result, 600)}`
        : "(started)";
    return {
      seq: entry.seq,
      kind: entry.kind,
      call: entry.call,
      label: entry.label,
      ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
      summary,
    };
  });

/**
 * Bind the `supervisedRun` runtime global. Every turn is a journaled positional
 * agent() call — the same resume machinery as any script-authored agent().
 */
export function bindRunSupervisor(
  ctx: RunSupervisorContext,
): (options: SupervisedRunOptions) => Promise<SupervisedRunOutcome> {
  return async (options: SupervisedRunOptions): Promise<SupervisedRunOutcome> => {
    const task = typeof options.task === "string" ? options.task : "";
    if (!task.trim()) {
      throw new Error("supervisedRun requires non-empty string options.task and a non-empty criterion");
    }
    // V2-N1: resolve the criterion mode UP FRONT (before any agent() call) so a
    // malformed machine spec fails loud before a task-agent turn is spent, and
    // the mode — a pure function of the script input — stays deterministic on
    // resume (the same script always picks the same mode and the same number of
    // positional agent() calls).
    const { mode: criterionMode, value: criterion } = resolveSupervisedRunCriterion(options.criterion);
    const maxRounds = Math.max(
      1,
      Math.min(SUPERVISOR_DEFAULT_MAX_ROUNDS, Math.floor(options.maxRounds ?? SUPERVISOR_DEFAULT_MAX_ROUNDS)),
    );
    // Invocation-scoped observation view: only settles recorded from this call
    // index onward (agents that settled before supervisedRun stay out of the
    // supervisor's view). Sequential regime: within a supervisedRun loop every
    // turn is awaited, so observations append in call order and the snapshot is
    // deterministic on resume.
    const existing = ctx.controller.observations;
    const startCall = existing.length > 0 ? existing[existing.length - 1].call + 1 : 0;
    const observe = () => ctx.controller.snapshotSince(startCall);

    const taskLabel = options.taskLabel ?? "task";
    const taskResult = await ctx.agent(buildTaskPrompt(task, criterion), {
      ...(options.taskLabel !== undefined ? { label: options.taskLabel } : { label: taskLabel }),
      ...(options.taskTier !== undefined ? { tier: options.taskTier } : {}),
      ...(options.taskPhase !== undefined ? { phase: options.taskPhase } : {}),
    });

    // V2-N1 machine-test mode: run ONE testGate-style postcondition as a
    // subagent step (the P01 mechanism — bash/grep tool + capture schema) and
    // machine-validate the capture. The step is a journaled positional agent()
    // call whose prompt/toolNames/schema are deterministic (already hashAgentCall
    // fields — the field set is untouched), so it replays from the journal
    // exactly like testGate's own steps. A failed test injects a corrective
    // agent carrying the DETERMINISTIC machine failure detail (never an LLM
    // correction).
    const evaluateMachineTestRound = async (round: number, spec: MachineCriterionSpec): Promise<SupervisorVerdict> => {
      const tool: TestGateTool = spec.tool ?? DEFAULT_TEST_GATE_TOOL;
      const tests = validateTestGateTests([{ command: spec.args, assert: spec.assert }], tool);
      const test = tests[0];
      let step: unknown = null;
      try {
        step = await ctx.agent(buildTestGatePrompt(test, tool), {
          label: `${SUPERVISOR_LABEL_PREFIX} test ${round}`,
          tier: options.supervisorTier ?? DEFAULT_HELPER_TIER,
          schema: TEST_GATE_OUTPUT_SCHEMA,
          toolNames: [tool],
        });
      } catch (error) {
        // A test step hitting the schema wall / execution failure must not abort
        // the run: it degrades to a failed test (empty continue round). Run-wide
        // conditions (budget/limit/abort) still throw.
        if (
          !isWorkflowError(error) ||
          (error.code !== WorkflowErrorCode.SCHEMA_NONCOMPLIANCE &&
            error.code !== WorkflowErrorCode.AGENT_EXECUTION_ERROR)
        ) {
          throw error;
        }
        ctx.log(`supervisedRun: machine test round ${round} omitted (${error.code})`);
        step = null;
      }
      const outcome = machineValidateTest(step, test.assert);
      if (outcome.passed) {
        return { status: "done", reason: `machine postcondition verified: ${test.command}`, correction: null };
      }
      return {
        status: "continue",
        reason: `machine postcondition not met: ${outcome.detail}`,
        correction:
          `The machine postcondition is not met: ${outcome.detail}\n` +
          `Rework the result so \`${test.command}\` passes ${JSON.stringify(test.assert)}.`,
      };
    };

    // LLM mode: the unchanged supervisor agent() turn. Kept byte-identical so
    // existing LLM-mode runs and their journals replay exactly as before.
    const evaluateLlmRound = async (
      round: number,
      observations: readonly SupervisorObservation[],
      criterionText: string,
    ): Promise<SupervisorVerdict> => {
      let raw: unknown;
      try {
        raw = await ctx.agent(buildSupervisorPrompt(task, criterionText, observations, round), {
          label: `${SUPERVISOR_LABEL_PREFIX} ${round}`,
          tier: options.supervisorTier ?? DEFAULT_HELPER_TIER,
          schema: SUPERVISOR_VERDICT_SCHEMA,
          toolNames: options.supervisorTools ?? [],
        });
      } catch (error) {
        // A supervisor vote hitting the schema wall / execution failure must
        // not abort the run: it degrades to an empty "continue" round (bounded
        // by maxRounds). Run-wide conditions (budget/limit/abort) still throw.
        if (
          !isWorkflowError(error) ||
          (error.code !== WorkflowErrorCode.SCHEMA_NONCOMPLIANCE &&
            error.code !== WorkflowErrorCode.AGENT_EXECUTION_ERROR)
        ) {
          throw error;
        }
        ctx.log(`supervisedRun: supervisor turn ${round} omitted (${error.code})`);
        raw = null;
      }
      return parseSupervisorVerdict(raw);
    };

    const verdicts: SupervisorVerdict[] = [];
    let finalVerdict: SupervisorVerdict | null = null;
    let declaredDone = false;
    let termination: SupervisedRunOutcome["supervisor"]["termination"] = "max-rounds";
    let corrections = 0;
    let lastWorkResult: unknown = taskResult;

    for (let round = 1; round <= maxRounds; round += 1) {
      // Run-budget interplay: supervisor turns count against the run budget
      // like every agent(); when the budget is spent, stop supervising instead
      // of letting the next agent() throw TOKEN_BUDGET_EXHAUSTED.
      if (ctx.budget.total !== null && ctx.budget.remaining() <= 0) {
        ctx.log(`supervisedRun: run token budget exhausted after ${round - 1} supervisor turn(s) — stopping`);
        termination = "budget-exhausted";
        break;
      }
      const observations = observe();
      ctx.onRuntimeEvent?.({ type: "supervisor", stage: "start", round });
      // V2-N1: the verdict path branches on the criterion. Machine modes replace
      // the LLM supervisor turn with a deterministic predicate — a script-side
      // pure function of the (journal-rebuilt) observations, or a machine-test
      // subagent step — so verifiable criteria never spend a supervisor turn.
      // Skipping the supervisor agent() call keeps call indices deterministic:
      // the same script always skips the same calls (the mode is a pure function
      // of the script input, and machine verdicts are pure functions of the
      // journaled observations).
      let verdict: SupervisorVerdict;
      if (typeof criterion === "function") {
        verdict = normalizeMachineFunctionVerdict(criterion(observations));
      } else if (typeof criterion === "object") {
        verdict = await evaluateMachineTestRound(round, criterion);
      } else {
        verdict = await evaluateLlmRound(round, observations, criterion);
      }
      ctx.onRuntimeEvent?.({ type: "supervisor", stage: "end", round });
      verdicts.push(verdict);
      finalVerdict = verdict;
      if (verdict.status === "done") {
        declaredDone = true;
        termination = "declared-done";
        ctx.log(`supervisedRun: supervisor declared the completion criterion met after ${round} turn(s)`);
        break;
      }
      if (verdict.correction !== null) {
        corrections += 1;
        lastWorkResult = await ctx.agent(buildCorrectionPrompt(task, criterion, verdict, observe()), {
          label: `${SUPERVISOR_CORRECTION_LABEL_PREFIX} ${round}`,
          ...(options.correctionTier !== undefined
            ? { tier: options.correctionTier }
            : options.taskTier !== undefined
              ? { tier: options.taskTier }
              : {}),
        });
      } else {
        ctx.log(`supervisedRun: supervisor turn ${round} continued without a correction (empty round)`);
      }
    }

    ctx.log(
      `supervisedRun: finished after ${verdicts.length} supervisor turn(s), ${corrections} correction(s), ` +
        `termination=${termination}`,
    );
    return {
      result: lastWorkResult,
      supervisor: {
        rounds: verdicts.length,
        mode: criterionMode,
        declaredDone,
        termination,
        finalVerdict,
        verdicts,
        corrections,
        observations: summarizeObservations(ctx.controller.observations),
      },
    };
  };
}

// ─── supervised-run builtin generator ───────────────────────────────────────────

/** Documentation-only config shape; the generated script reads these from `args`. */
export interface SupervisedRunConfig {
  /** The work to complete. */
  task: string;
  /** The concrete measurable completion criterion the supervisor verifies. */
  criterion: string;
  /** Bounded supervisor turns. */
  maxRounds?: number;
}

/**
 * Generate the supervised-run workflow script. The script is static and reads
 * its inputs from `args` (task/criterion/maxRounds) so nothing caller-supplied
 * is ever string-interpolated into source; the task/criterion texts pass RAW
 * into the supervisedRun runtime global (which embeds bounded copies in the
 * supervisor/corrective prompts via capEmbedded).
 */
export function generateSupervisedRunWorkflow(): string {
  return `export const meta = {
  name: 'supervised_run',
  description: 'Delegate a task to a work agent and supervise it with an economy supervisor agent that checks progress against a concrete measurable completion criterion after every settle, injecting one corrective agent on drift/stall and declaring done when the criterion is met',
  phases: [
    { title: 'Execute' },
  ],
}

// maxRounds comes from the shared builtin-args coercion (baked in below) — never
// the || default pattern, which silently mangles a present falsy value.
${numericArgCoercionSource(SUPERVISED_RUN_NUMERIC_ARGS)}

const task = (args && args.task) || ''
const criterion = (args && args.criterion) || ''
if (!task || !criterion) {
  return { task, criterion, outcome: null, error: 'task and criterion are required (non-empty strings)' }
}
// The task/criterion texts pass RAW into supervisedRun (never string-
// interpolated into this script); the supervisor prompts embed bounded copies
// of them per turn (capEmbedded), so no caller-supplied text is ever injected
// into the script source and the run stays fully deterministic.

phase('Execute')
const outcome = await supervisedRun({
  task,
  criterion,
  maxRounds,
})
return outcome`;
}
