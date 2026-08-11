/**
 * Adversarial review mode for workflows.
 * Agents cross-check each other's findings for higher quality results.
 */

import { ADVERSARIAL_REVIEW_NUMERIC_ARGS, MAX_REFUTE_AGENTS, numericArgCoercionSource } from "./builtin-args.js";

export interface AdversarialReviewConfig {
  /** Number of independent reviewers per finding. */
  reviewerCount: number;
  /** Whether to filter out findings that don't survive cross-checking. */
  filterContested: boolean;
  /** Minimum agreement threshold (0-1). */
  agreementThreshold: number;
}

/**
 * T2-05: model-tier knob for the generated adversarial-review script — the
 * final consensus report is flagship synthesis work (default "big"); the
 * investigate/refute phases stay untagged (economy default, T2-03). Baked at
 * generation time so the script text (and resume hashes) is deterministic.
 */
export interface AdversarialReviewTierOptions {
  tierSynthesis?: string;
}

/**
 * Generate an adversarial-review workflow. The script is static and reads its
 * inputs from `args` (task/reviewers/threshold) — no string interpolation.
 *
 * Each finding is judged independently by N reviewers who are told to REFUTE it;
 * a finding survives only when the share of reviewers calling it real meets the
 * agreement threshold.
 */
export function generateAdversarialReviewWorkflow(options: AdversarialReviewTierOptions = {}): string {
  const tierSynthesis = JSON.stringify(options.tierSynthesis ?? "big");
  return `export const meta = {
  name: 'adversarial_review',
  description: 'Adversarial review: findings cross-checked by independent skeptics',
  phases: [
    { title: 'Investigate' },
    { title: 'Refute' },
    { title: 'Consensus' },
  ],
}

// reviewers/threshold/maxFindings come from the shared builtin-args coercion
// (baked into the script below) — never the || default pattern, which silently mangles a
// present falsy value (e.g. threshold: 0) and accepts out-of-range fan-out.
${numericArgCoercionSource(ADVERSARIAL_REVIEW_NUMERIC_ARGS)}

const task = (args && args.task) || ''

phase('Investigate')
const investigation = await agent(
  'Investigate the following and list concrete, individually-checkable findings:\\n' + task,
  { label: 'investigate', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } }
)
// agent() returns null on a recoverable failure (parallel() swallows failures
// as null too), and a non-array findings would crash .map below — guard exactly
// like deep-research.ts's planner. Refute/Consensus still produce a degraded
// report on an empty pool instead of a TypeError killing the whole run.
const rawFindings = (investigation && Array.isArray(investigation.findings))
  ? investigation.findings.filter((f) => typeof f === 'string' && f.trim().length > 0)
  : []
// i5: fan-out is findings x reviewers agents — cap the pool at maxFindings and
// log the degradation instead of silently truncating or fanning out unbounded.
const findings = rawFindings.slice(0, maxFindings)
if (rawFindings.length > maxFindings) {
  log(
    'Adversarial review: ' + rawFindings.length + ' findings surfaced; capping the refute phase at ' + maxFindings +
    ' findings to bound fan-out (' + (rawFindings.length - maxFindings) + ' findings are not cross-checked).'
  )
}
// i5: the refute fan-out is findings x reviewers agents. Bound the PRODUCT under
// MAX_REFUTE_AGENTS by cutting reviewers (never findings, which are already
// capped) — a research burst must not spawn hundreds of parallel refute agents.
// Logged so a reduced reviewer count is never silent.
const MAX_REFUTE_AGENTS = ${MAX_REFUTE_AGENTS}
const effectiveReviewers = findings.length > 0
  ? Math.min(reviewers, Math.ceil(MAX_REFUTE_AGENTS / findings.length))
  : 0
if (effectiveReviewers < reviewers) {
  log(
    'Adversarial review: ' + findings.length + ' findings x ' + reviewers + ' reviewers = ' +
    (findings.length * reviewers) + ' refute agents, exceeding the ' + MAX_REFUTE_AGENTS +
    ' budget — reducing reviewers to ' + effectiveReviewers +
    ' (' + (findings.length * effectiveReviewers) + ' agents).'
  )
}

phase('Refute')
// P12: the refute fan-out deliberately runs big headless batches (findings x
// reviewers can reach 250) — autoApproved preserves the builtin's unattended
// behavior under the fan-out approval gate.
const judged = await parallel(findings.map((f, i) => () =>
  parallel(Array.from({ length: effectiveReviewers }, (_, r) => () =>
    agent(
      'You are a skeptical reviewer. Try to REFUTE this finding for the task below. ' +
      'Default to real=false when uncertain. Investigate with the available tools if needed.\\n\\n' +
      'TASK: ' + task + '\\nFINDING: ' + f,
      { label: 'refute ' + (i + 1) + '.' + (r + 1), schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real'] } }
    )
  ), { autoApproved: true }).then((votes) => {
    // H6: a null vote (recoverable agent failure) is a FAILED vote, not a
    // missing one — it still occupies a reviewer slot, never counts as real,
    // and shrinks the survival ratio. Logged so silent reviewer loss is visible.
    const failedVotes = votes.filter((v) => v === null || v === undefined).length
    if (failedVotes > 0) {
      log(
        'Adversarial review: ' + failedVotes + ' of ' + votes.length + ' refute vote(s) for finding "' +
        f.slice(0, 60) + '" failed and count as real=false.'
      )
    }
    const realCount = votes.filter((v) => v && v.real).length
    const ratio = votes.length ? realCount / votes.length : 0
    return { finding: f, realVotes: realCount, totalVotes: votes.length, survives: ratio >= threshold }
  })
), { autoApproved: true })
const survivors = judged.filter((j) => j && j.survives)

phase('Consensus')
const report = await agent(
  'Write a final review report. Include ONLY the findings that survived adversarial review (listed below), ' +
  'each with a short justification. Note how many were discarded.\\n\\n' +
  'SURVIVING FINDINGS JSON:\\n' + JSON.stringify(survivors),
  { label: 'consensus', tier: ${tierSynthesis} }
)

return { total: findings.length, survivors, report }`;
}

/**
 * Generate a multi-perspective analysis workflow.
 *
 * `topic` and each `perspectives` entry are user-supplied strings baked
 * directly into the generated script's source, so every one is embedded via
 * JSON.stringify — a proper JS string literal that can't be broken out of by
 * a quote, backslash, or backtick in the value.
 */
export function generateMultiPerspectiveWorkflow(topic: string, perspectives: string[]): string {
  const perspectiveAgents = perspectives
    .map((p, i) => {
      const label =
        p
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 20) || `perspective-${i + 1}`;
      return `  () => agent(${JSON.stringify(`Analyze from ${p} perspective: `)} + topic, { label: ${JSON.stringify(label)} }),`;
    })
    .join("\n");

  return `export const meta = {
  name: 'multi_perspective_analysis',
  description: ${JSON.stringify(`Analyze from ${perspectives.length} different perspectives`)},
  phases: [
    { title: 'Perspective Analysis' },
    { title: 'Synthesis' },
  ],
};

phase('Perspective Analysis');
const topic = ${JSON.stringify(topic)};
// P12: caller-supplied perspectives can exceed the approval threshold headless —
// autoApproved keeps the builtin's unattended behavior under the fan-out gate.
const analyses = await parallel([
${perspectiveAgents}
], { autoApproved: true });

phase('Synthesis');
const synthesis = await agent(
  'Synthesize these different perspectives into a balanced analysis:\\n' +
  'Analyses: ' + JSON.stringify(analyses) + '\\n' +
  'Topic: ' + topic,
  { label: 'synthesizer' }
);

return { analyses, synthesis };`;
}
