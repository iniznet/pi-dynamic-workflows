/**
 * Debug-loop workflow (built-in pattern P03).
 *
 * hypothesize → reproduce → fix → verify, machine-gated end-to-end:
 *  1. Hypothesize: an agent isolates the bug and names the failing
 *     reproduction command (or the caller supplies one via args.reproduce).
 *  2. Reproduce: a bash-captured subagent runs the command and reports its
 *     REAL exit status + full output — the machine evidence that the bug is
 *     present, and the evidence the fixer is gated on.
 *  3. Fix: a fixer agent (gated on the reproduce evidence) edits the code so
 *     the reproduction command should exit 0.
 *  4. Verify: loopUntilDry IS the loop engine — each round re-runs the
 *     reproduction command as a bash-captured subagent and machine-validates
 *     its exit code with a pure-JS predicate (never an LLM verdict). A green
 *     round stops the loop (the successful-empty round, consecutiveEmpty: 1);
 *     a red round feeds its captured failure evidence into the next fix and
 *     the loop stops after K rounds, failing CLOSED. Every round's evidence
 *     lands in the artifact — which is why the loop is hand-rolled on
 *     agent({toolNames}) + output validation rather than testGate: testGate's
 *     result carries only the FINAL attempt's test capture, and P03 requires
 *     per-step evidence.
 *
 * Per-step evidence is included in the final artifact: hypothesis, baseline
 * reproduction capture, and one {attempt, passed, exitCode, detail, output}
 * entry per fix/verify round.
 *
 * The generated script runs inside a vm and cannot import this module, so
 * nothing caller-supplied is ever string-interpolated into source (the bug
 * text travels via the runtime's ctx() shared-context mechanism). The script
 * is deterministic: every agent() call journals under a stable label, and all
 * prompt embeddings are pure functions of journaled inputs.
 */

import { type NumericArgSpec, numericArgCoercionSource } from "./builtin-args.js";

/** Bounds for the fix→verify rework loop (K rounds) — mirrors gate()'s attempts cap. */
export const DEBUG_LOOP_NUMERIC_ARGS: readonly NumericArgSpec[] = [
  { name: "maxRounds", default: 3, min: 1, max: 6, integer: true },
];

/**
 * T2-05: per-phase model-tier knobs for the generated debug-loop script.
 * Defaults: hypothesize/fix = medium (debugging judgement), reproduce = small
 * (a bash relay needs no reasoning tier). Baked at generation time so the
 * script text (and resume hashes) is deterministic per generator version.
 */
export interface DebugLoopTierOptions {
  tierHypothesize?: string;
  tierReproduce?: string;
  tierFix?: string;
}

/** Documentation-only config shape; the generated script reads these from `args` at runtime. */
export interface DebugLoopConfig {
  /** Description of the bug to isolate and fix. */
  bug: string;
  /** Optional pre-known reproduction command (the hypothesis agent may also name one). */
  reproduce?: string;
  /** K rounds of fix→verify rework. */
  maxRounds?: number;
}

/**
 * Generate the debug-loop workflow script. The script is static and reads its
 * inputs from `args` (bug/reproduce/maxRounds) so nothing caller-supplied is
 * ever string-interpolated into source. maxRounds is coerced by the shared
 * builtin-args rules (baked in below).
 */
export function generateDebugLoopWorkflow(options: DebugLoopTierOptions = {}): string {
  const tierHypothesize = JSON.stringify(options.tierHypothesize ?? "medium");
  const tierReproduce = JSON.stringify(options.tierReproduce ?? "small");
  const tierFix = JSON.stringify(options.tierFix ?? "medium");
  return `export const meta = {
  name: 'debug_loop',
  description: 'Hypothesize the root cause of a bug, reproduce it with machine evidence, fix it, and machine-verify the fix (bounded rework)',
  phases: [
    { title: 'Hypothesize' },
    { title: 'Reproduce' },
    { title: 'Fix' },
    { title: 'Verify' },
  ],
}

// maxRounds comes from the shared builtin-args coercion (baked in below) — never
// the || default pattern, which silently mangles a present falsy value.
${numericArgCoercionSource(DEBUG_LOOP_NUMERIC_ARGS)}

const bug = (args && args.bug) || ''
// T2-07: register the bug text into the run's shared context ONCE via ctx() and
// embed the compact pointer in every agent prompt that needs it (the runtime
// emits the full text into the first agent's instructions and gives later
// agents a store-key note) — the fix loop must not re-embed the whole bug
// report per round.
const bugCtx = ctx(bug)
const givenRepro = (args && args.reproduce) || ''
if (!bug) {
  return { bug, hypothesis: null, baseline: null, attempts: [], fixed: false, rounds: 0, lastFix: null, termination: 'invalid-args', error: 'bug is required (a non-empty string)' }
}

const HYPOTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    symptom: { type: 'string' },
    rootCauseHypothesis: { type: 'string' },
    reproCommand: { type: 'string' },
    expectedBehavior: { type: 'string' },
  },
  required: ['symptom', 'rootCauseHypothesis', 'reproCommand', 'expectedBehavior'],
}
// The reproduce/verify capture contract — the SAME shape testGate's machine
// predicate validates, so one normalizer covers baseline and per-round evidence.
const REPRO_SCHEMA = {
  type: 'object',
  properties: { exitCode: { type: 'number' }, output: { type: 'string' } },
  required: ['output'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    change: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['change'],
}

// Deterministic prompt-embedding cap (T1-03 pattern): a pure function of the
// input, so the same evidence always yields the same prompt and resume hashes
// stay stable. Trims prompt text only — schemas and result shapes are untouched.
const cap = (value, maxChars) => {
  const text = value === null || value === undefined ? '(none)' : (typeof value === 'string' ? value : JSON.stringify(value))
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

phase('Hypothesize')
const hypothesis = await agent(
  'You are a debugger isolating a bug. Analyze the bug report below, inspect the relevant code and tests with the read/grep/find tools, and form a root-cause hypothesis. ' +
  'Emit: symptom (what is observed), rootCauseHypothesis (the most likely cause, naming the file and symbol involved), ' +
  'reproCommand (a single shell command that runs the failing test or branch command — it must be reproducible and exit non-zero while the bug is present), ' +
  'expectedBehavior (what a fixed run should report).' +
  '\\n\\nBUG: ' + bugCtx,
  { label: 'hypothesize', tier: ${tierHypothesize}, schema: HYPOTHESIS_SCHEMA }
)
// The hypothesis's repro command wins; a caller-supplied args.reproduce is the
// fallback when the agent named none (or the hypothesis failed recoverably).
const reproCommand = (hypothesis && typeof hypothesis.reproCommand === 'string' && hypothesis.reproCommand.trim())
  ? hypothesis.reproCommand.trim()
  : givenRepro

phase('Reproduce')
// Machine evidence capture: a bash-captured subagent relays the command's REAL
// exit status + full output verbatim — never an LLM verdict about the output.
const baseline = reproCommand
  ? await agent(
      'Run the reproduction command below with the bash tool and report its REAL exit status and FULL standard output verbatim (do not summarize, do not truncate, do not invent output).' +
      '\\n\\nCommand:\\n\`\`\`\\n' + reproCommand + '\\n\`\`\`',
      { label: 'reproduce baseline', tier: ${tierReproduce}, toolNames: ['bash'], schema: REPRO_SCHEMA }
    )
  : null
const baselineGreen = !!(baseline && baseline.exitCode === 0)
if (baselineGreen) log('Debug loop: the reproduction command already exits 0 — it may not reproduce the bug; the fix loop will still attempt a fix against the reported symptom.')
if (!reproCommand) log('Debug loop: no reproduction command available (hypothesis and args.reproduce both empty) — there is nothing to machine-verify.')

phase('Fix')
const fixPrompt = (feedback) =>
  'You are a fixer. The bug below has a hypothesized root cause and a reproduction command. ' +
  'Use the read/grep/find/bash tools to inspect the code, run the reproduction command yourself with bash to see the failing output, then implement the minimal fix so the command exits 0. ' +
  'Return: change (a short description), files (the files you edited), and notes (anything the verifier must know).' +
  '\\n\\nBUG: ' + bugCtx +
  '\\nHYPOTHESIS: ' + cap(hypothesis, 2000) +
  '\\nBASELINE REPRODUCTION EVIDENCE: ' + cap(baseline, 2000) +
  (feedback ? '\\n\\nPREVIOUS VERIFICATION FEEDBACK (the fix is still failing):\\n' + feedback : '')

phase('Verify')
// loopUntilDry IS the loop engine: each round is one fix + one machine re-run
// of the reproduction command (bash-captured subagent, pure-JS exit-code
// validation — never an LLM verdict). A round returns its fix+evidence item
// ONLY while the command still exits non-zero; a GREEN round returns [] — the
// successful-empty round that stops the loop (consecutiveEmpty: 1). Every
// round's evidence lands in the artifact; the termination reason tells the
// honest story ("dry" = fixed, "maxRounds" = K rounds exhausted while red,
// "capacity"/"costSaturated" = the run's budget cut the loop short).
let loopFeedback
let lastAttempt = null
// Without a reproduction command there is nothing to machine-verify: the loop
// degrades to an explicit no-repro result (logged above), never a broken run.
const loop = reproCommand
  ? await loopUntilDry({
  round: async (r) => {
    const fix = await agent(fixPrompt(loopFeedback), { label: 'fix ' + (r + 1), phase: 'Fix', tier: ${tierFix}, schema: FIX_SCHEMA })
    const verify = await agent(
      'Verification re-run (attempt ' + (r + 1) + '). Run this command with the bash tool and report its REAL exit status and FULL standard output verbatim (do not summarize, do not truncate, do not invent output).' +
      '\\n\\nCommand:\\n\`\`\`\\n' + reproCommand + '\\n\`\`\`',
      { label: 'verify ' + (r + 1), phase: 'Verify', tier: ${tierReproduce}, toolNames: ['bash'], schema: REPRO_SCHEMA }
    )
    const passed = !!(verify && verify.exitCode === 0)
    lastAttempt = { fix, verify, passed }
    if (passed) {
      log('Debug loop: verification green on round ' + (r + 1) + ' — the fix holds.')
      return []
    }
    const exitNote = verify && typeof verify.exitCode === 'number' ? 'exit code ' + verify.exitCode : 'no exit code captured'
    log('Debug loop: round ' + (r + 1) + ' verification failed (' + exitNote + '); reworking the fix.')
    loopFeedback = 'The reproduction command exited non-zero (' + exitNote + '). Captured output:\\n' + (verify && typeof verify.output === 'string' ? cap(verify.output, 2000) : '(no output)')
    return [{ round: r + 1, fix, verify }]
  },
  key: (item) => 'red-' + item.round,
  consecutiveEmpty: 1,
  maxRounds,
  })
  : { items: [], termination: 'no-repro', failedRounds: 0 }
const fixed = loop.termination === 'dry'
const attempts = loop.items.map((item, i) => ({
  attempt: item.round,
  passed: false,
  exitCode: item.verify && typeof item.verify.exitCode === 'number' ? item.verify.exitCode : null,
  detail: item.verify && typeof item.verify.exitCode === 'number' ? 'exit code ' + item.verify.exitCode : 'no exit code captured',
  output: item.verify && typeof item.verify.output === 'string' ? item.verify.output.slice(0, 2000) : '',
}))
if (lastAttempt && lastAttempt.passed) {
  attempts.push({
    attempt: loop.items.length + 1,
    passed: true,
    exitCode: lastAttempt.verify && typeof lastAttempt.verify.exitCode === 'number' ? lastAttempt.verify.exitCode : null,
    detail: 'passed',
    output: lastAttempt.verify && typeof lastAttempt.verify.output === 'string' ? lastAttempt.verify.output.slice(0, 2000) : '',
  })
}
if (!fixed) log('Debug loop: the fix did not verify green within ' + maxRounds + ' round(s) (' + loop.termination + '); per-attempt evidence is in the result.')

return { bug, hypothesis, baseline, reproCommand, baselineGreen, fixed, rounds: attempts.length, attempts, lastFix: lastAttempt ? lastAttempt.fix : null, termination: fixed ? 'green' : loop.termination }`;
}
