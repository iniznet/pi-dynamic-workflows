/**
 * Plan-then-execute workflow (built-in pattern).
 *
 * A planner agent decomposes an objective into dependency-ordered steps via a
 * structured-output schema; a verifier agent gates each step with a bounded
 * rework loop (rejected steps are rewritten from the verifier's feedback and
 * re-judged, up to a hard attempt budget); an optional execute phase runs each
 * accepted step's implementation in dependency order; a report agent
 * consolidates plan/verdicts/results into the run result.
 *
 * The generated script runs inside a vm and cannot import this module, so the
 * ordering validator below is ALSO emitted as a vm-embeddable JS source string
 * (orderStepsByDependenciesSource) — the same pattern as
 * numericArgCoercionSource / diffShardSource. The TS reference implementation
 * is what the unit tests exercise; a parity test runs the embedded copy
 * against the same fixtures so the two can never drift silently.
 */

import { type NumericArgSpec, numericArgCoercionSource } from "./builtin-args.js";

/** maxSteps bounds how many planned steps the Verify/Execute phases touch (fan-out cap). */
export const PLAN_THEN_EXECUTE_NUMERIC_ARGS: readonly NumericArgSpec[] = [
  { name: "maxSteps", default: 10, min: 1, max: 25, integer: true },
];

/** Re-plan budget: a structurally invalid plan (cycle, duplicates, unknown deps) is replanned once. */
export const PLAN_THEN_EXECUTE_MAX_PLAN_ATTEMPTS = 2;

/**
 * Per-step gate budget (gate() attempts): attempt 0 judges the step as
 * planned; attempts 1..N-1 rewrite the step from verifier feedback and
 * re-judge. 3 = one planned round + up to two reworks.
 */
export const PLAN_THEN_EXECUTE_MAX_REWORK_ATTEMPTS = 3;

/** One step of a dependency-ordered plan as emitted by the planner agent. */
export interface PlanStep {
  /** Stable slug referenced by dependsOn; unique within the plan. */
  id: string;
  title: string;
  description: string;
  /** Ids of steps that must complete before this one (dependencies precede dependents). */
  dependsOn: string[];
}

export interface StepsOrderingOutcome {
  ok: boolean;
  /** Topologically sorted steps (every dependency before its dependents) when ok. */
  steps: PlanStep[];
  /** Human-readable rejection reason when !ok (malformed entry, duplicate, unknown dep, cycle). */
  error?: string;
}

/**
 * Defensive normalization + dependency-ordered topological sort of raw planner
 * output (Kahn's algorithm). This is the plan's hard contract: every step
 * needs a non-empty id/title/description, ids are unique, every dependsOn
 * entry references a known step, and the dependency graph is acyclic. A valid
 * (possibly empty) step list is returned in dependency order; the script layer
 * treats an empty plan as a degraded outcome. Deterministic for a given input
 * (input order breaks ties), which resume's journal replay requires.
 */
export function orderStepsByDependencies(rawSteps: unknown[]): StepsOrderingOutcome {
  const steps: PlanStep[] = [];
  for (const raw of rawSteps) {
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (!id || !title || !description) {
      return { ok: false, steps: [], error: "every step needs a non-empty id, title, and description" };
    }
    if (steps.some((s) => s.id === id)) {
      return { ok: false, steps: [], error: `duplicate step id: ${id}` };
    }
    // Duplicate dep ids are harmless to ordering but bloat the executor's
    // dependency-result lookups, so they are deduped (order preserved).
    const dependsOn = Array.isArray(record.dependsOn)
      ? Array.from(new Set(record.dependsOn.filter((d): d is string => typeof d === "string" && d.trim().length > 0)))
      : [];
    steps.push({ id, title, description, dependsOn });
  }
  const ids = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        return { ok: false, steps: [], error: `step ${step.id} depends on unknown step ${dep}` };
      }
    }
  }
  // Kahn's algorithm over a mutable work list: repeatedly emit the first step
  // whose remaining dependencies are all satisfied.
  const pending = steps.map((s) => ({ step: s, deps: [...s.dependsOn] }));
  const ordered: PlanStep[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((w) => w.deps.length === 0);
    if (index === -1) return { ok: false, steps: [], error: "step dependencies contain a cycle" };
    const [done] = pending.splice(index, 1);
    ordered.push(done.step);
    for (const w of pending) w.deps = w.deps.filter((d) => d !== done.step.id);
  }
  return { ok: true, steps: ordered };
}

/**
 * Emit the vm-embeddable equivalent of orderStepsByDependencies for the
 * generated script (which runs in a vm and cannot import this module). Kept
 * textually in sync with the TS reference — the parity test in
 * tests/slices/workflows/ executes BOTH copies against the same fixtures and
 * asserts identical outcomes, so a drift fails loudly instead of silently.
 */
export function orderStepsByDependenciesSource(): string {
  return [
    "const orderStepsByDependencies = (rawSteps) => {",
    "  const steps = []",
    "  for (const raw of rawSteps) {",
    "    const record = raw && typeof raw === 'object' ? raw : {}",
    "    const id = typeof record.id === 'string' ? record.id.trim() : ''",
    "    const title = typeof record.title === 'string' ? record.title.trim() : ''",
    "    const description = typeof record.description === 'string' ? record.description.trim() : ''",
    "    if (!id || !title || !description) return { ok: false, steps: [], error: 'every step needs a non-empty id, title, and description' }",
    "    if (steps.some((s) => s.id === id)) return { ok: false, steps: [], error: 'duplicate step id: ' + id }",
    "    const dependsOn = Array.isArray(record.dependsOn) ? Array.from(new Set(record.dependsOn.filter((d) => typeof d === 'string' && d.trim().length > 0))) : []",
    "    steps.push({ id, title, description, dependsOn })",
    "  }",
    "  const ids = new Set(steps.map((s) => s.id))",
    "  for (const step of steps) {",
    "    for (const dep of step.dependsOn) {",
    "      if (!ids.has(dep)) return { ok: false, steps: [], error: 'step ' + step.id + ' depends on unknown step ' + dep }",
    "    }",
    "  }",
    "  const pending = steps.map((s) => ({ step: s, deps: s.dependsOn.slice() }))",
    "  const ordered = []",
    "  while (pending.length > 0) {",
    "    const index = pending.findIndex((w) => w.deps.length === 0)",
    "    if (index === -1) return { ok: false, steps: [], error: 'step dependencies contain a cycle' }",
    "    const done = pending.splice(index, 1)[0]",
    "    ordered.push(done.step)",
    "    for (const w of pending) w.deps = w.deps.filter((d) => d !== done.step.id)",
    "  }",
    "  return { ok: true, steps: ordered }",
    "}",
  ].join("\n");
}

/** Documentation-only config shape; the generated script reads these from `args` at runtime. */
export interface PlanThenExecuteConfig {
  objective: string;
  context?: string;
  maxSteps?: number;
  execute?: boolean;
}

/**
 * Generate the plan-then-execute workflow script. The script is static and
 * reads its inputs from `args` (objective/context/maxSteps/execute) so nothing
 * caller-supplied is ever string-interpolated into source. The ordering
 * validator is embedded via orderStepsByDependenciesSource() (see module doc).
 */
export function generatePlanThenExecuteWorkflow(): string {
  return `export const meta = {
  name: 'plan_then_execute',
  description: 'Decompose an objective into dependency-ordered steps, gate each step with a verifier (bounded rework), optionally execute. Pauses for human approval before starting agent work',
  gate: 'approve',
  phases: [
    { title: 'Plan' },
    { title: 'Verify' },
    { title: 'Execute' },
    { title: 'Report' },
  ],
}

// maxSteps comes from the shared builtin-args coercion (baked in below) — never
// the || default pattern, which silently mangles a present falsy value and
// accepts out-of-range fan-out.
${numericArgCoercionSource(PLAN_THEN_EXECUTE_NUMERIC_ARGS)}

// Bounded budgets baked in as constants so the generated script never drifts
// from the reviewed values.
const MAX_PLAN_ATTEMPTS = ${PLAN_THEN_EXECUTE_MAX_PLAN_ATTEMPTS}
const MAX_REWORK_ATTEMPTS = ${PLAN_THEN_EXECUTE_MAX_REWORK_ATTEMPTS}

// orderStepsByDependencies mirrors src/plan-then-execute.ts (the unit-tested
// reference); a parity test keeps the two copies behaviorally identical. It
// enforces the plan contract in the vm: non-empty id/title/description,
// unique ids, known dependencies, cycle-free dependency order.
${orderStepsByDependenciesSource()}

const objective = (args && args.objective) || ''
const context = (args && args.context) || ''
const execute = (args && args.execute) === true
if (!objective) {
  return { objective, plan: [], planError: 'objective is required (a non-empty string)', verdicts: [], results: [], report: null }
}

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'title', 'description'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    feedback: { type: 'string' },
  },
  required: ['ok'],
}
const PLAN_SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: STEP_SCHEMA } },
  required: ['steps'],
}

phase('Plan')
const contextLine = context ? '\\nAdditional context: ' + context : ''
let planError = ''
let steps = []
// Bounded replan: a structurally invalid plan (cycle, duplicate id, unknown
// dependency, malformed step) is rejected and the planner gets the rejection
// reason as feedback once. A second structural failure degrades the run into
// an explicit planError result instead of crashing the script on plan.steps.
for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt++) {
  const rejectionLine = planError
    ? '\\n\\nYour previous plan was REJECTED for the following reason: ' + planError + '. Fix the plan and resubmit it.'
    : ''
  const plan = await agent(
    'You are a planning agent. Decompose the objective into a dependency-ordered plan of concrete steps. ' +
    'Each step MUST have: id (a short kebab-case slug), title, description (what to do and what done looks like), ' +
    'dependsOn (the ids of steps that must complete first; only steps defined elsewhere in the plan). ' +
    'Steps must be topologically ordered — every dependency must come before the step that depends on it. ' +
    'Emit at most ' + maxSteps + ' steps; fewer is better when the objective is small.' +
    '\\n\\nOBJECTIVE: ' + objective + contextLine + rejectionLine,
    { label: 'planner ' + (attempt + 1), schema: PLAN_SCHEMA }
  )
  const rawSteps = (plan && Array.isArray(plan.steps)) ? plan.steps : []
  const ordering = orderStepsByDependencies(rawSteps)
  if (ordering.ok) {
    steps = ordering.steps
    planError = ''
    break
  }
  planError = ordering.error || 'plan is not a valid dependency-ordered step list'
  log('Plan-then-execute: plan rejected (' + planError + '); replanning (attempt ' + (attempt + 1) + ' of ' + MAX_PLAN_ATTEMPTS + ')')
}
if (steps.length === 0) {
  log('Plan-then-execute: no valid plan after ' + MAX_PLAN_ATTEMPTS + ' attempt(s) (' + (planError || 'planner returned no steps') + ') — nothing to verify or execute.')
  return { objective, plan: [], planError: planError || 'planner returned no steps', verdicts: [], results: [], report: null }
}
const workSteps = steps.slice(0, maxSteps)
if (steps.length > maxSteps) {
  log('Plan-then-execute: planner emitted ' + steps.length + ' steps; capping verify/execute at the first ' + maxSteps + ' in dependency order (' + (steps.length - maxSteps) + ' steps are not touched).')
}

phase('Verify')
const verdicts = []
const accepted = new Map()
for (const step of workSteps) {
  // gate() is the per-step rework loop: attempt 0 presents the step as planned,
  // later attempts rewrite it from the verifier's feedback. Every rework and
  // every verification is a real agent() call, so each journals under a stable
  // callSeq and resume replays completed attempts instead of re-running them.
  const outcome = await gate(
    (feedback, attempt) => attempt === 0
      ? { id: step.id, title: step.title, description: step.description, dependsOn: step.dependsOn }
      : agent(
          'You are a step rewriter. The planned step below was REJECTED by a verifier. ' +
          'Rewrite ONLY its description so it addresses the feedback; keep id, title, and dependsOn unchanged.\\n\\n' +
          'OBJECTIVE: ' + objective + '\\nSTEP: ' + JSON.stringify(step) +
          '\\nVERIFIER FEEDBACK: ' + (feedback || ''),
          { label: 'rework ' + step.id, schema: STEP_SCHEMA }
        ),
    async (candidate) => {
      const verdict = await agent(
        'You are a step verifier. Decide whether the planned step below is well-defined, correctly scoped, ' +
        'moves the objective forward, and lists complete dependencies. Return ok:true ONLY when it is ready ' +
        'to be executed as written; otherwise ok:false with concrete, actionable feedback.\\n\\n' +
        'OBJECTIVE: ' + objective + '\\nSTEP: ' + JSON.stringify(candidate),
        { label: 'verify ' + step.id, schema: VERIFY_SCHEMA }
      )
      if (verdict && verdict.ok === true) return { ok: true }
      return { ok: false, feedback: (verdict && typeof verdict.feedback === 'string' && verdict.feedback.trim()) || 'step rejected without feedback' }
    },
    { attempts: MAX_REWORK_ATTEMPTS }
  )
  verdicts.push({ id: step.id, ok: outcome.ok, attempts: outcome.attempts, step: outcome.value })
  if (outcome.ok) accepted.set(step.id, outcome.value)
  else log('Plan-then-execute: step "' + step.id + '" failed verification after ' + outcome.attempts + ' attempt(s); it will not be executed.')
}

const results = []
if (execute) {
  phase('Execute')
  // Only steps that PASSED the verifier gate run; a rejected step's work is
  // not attempted. Steps execute in dependency order, so every completed
  // dependency's result is already available when its dependent starts.
  for (const step of workSteps) {
    if (!accepted.has(step.id)) continue
    const finalStep = accepted.get(step.id)
    const depResults = step.dependsOn
      .map((depId) => results.find((r) => r.id === depId))
      .filter((r) => r && r.value !== null && r.value !== undefined)
    const value = await agent(
      'You are an implementer. Execute the step below against the objective using the available tools, ' +
      'then return the concrete result of this step.\\n\\n' +
      'OBJECTIVE: ' + objective + '\\nSTEP: ' + JSON.stringify(finalStep) +
      '\\nRESULTS OF COMPLETED DEPENDENCY STEPS: ' + (depResults.length ? JSON.stringify(depResults) : '(none)'),
      { label: 'execute ' + step.id }
    )
    results.push({ id: step.id, value })
  }
}

phase('Report')
const report = await agent(
  'You are a report writer. Write the final report for this plan-then-execute run: the objective, ' +
  'the dependency-ordered plan, the verification verdict per step (including steps rejected after bounded rework and why), ' +
  'the execution results (if any), and recommended next actions.\\n\\n' +
  'OBJECTIVE: ' + objective + '\\nPLAN: ' + JSON.stringify(workSteps) +
  '\\nVERDICTS: ' + JSON.stringify(verdicts) + '\\nRESULTS: ' + JSON.stringify(results),
  { label: 'report writer' }
)

return { objective, plan: workSteps, planError, verdicts, results, report }`;
}
