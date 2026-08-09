/**
 * Deep research workflow.
 * Built-in workflow for comprehensive research across multiple sources.
 */

import { DEEP_RESEARCH_NUMERIC_ARGS, numericArgCoercionSource } from "./builtin-args.js";

export interface DeepResearchConfig {
  /** Number of distinct search angles/queries to explore. */
  angles: number;
  /** Minimum distinct sources required for a claim to survive cross-checking. */
  minSupport: number;
}

/**
 * T2-05: per-phase model-tier knobs for the generated deep-research script.
 * Defaults are the plan's cheapest-adequate routing (plan=small, gather=
 * medium, cross-check=big, report=big) so the DEFAULT generated script text is
 * deterministic — the resume hash of a fresh run is a pure function of the
 * generator version + these baked values.
 */
export interface DeepResearchTierOptions {
  tierPlan?: string;
  tierGather?: string;
  tierCrossCheck?: string;
  tierReport?: string;
}

/**
 * Generate a deep-research workflow that uses the real web_search/web_fetch tools.
 *
 * The script is static and reads its inputs from `args` (question/angles/minSupport),
 * so the question is never string-interpolated into source — no escaping hazards.
 * Inject the web tools at run time via the agent's `tools` option.
 *
 * T2-05: per-phase tiers are GENERATION-time options baked into the script text
 * (JSON.stringify — the multi-perspective precedent) so resume hashes stay
 * deterministic for a fixed generator version.
 */
export function generateDeepResearchWorkflow(options: DeepResearchTierOptions = {}): string {
  const tierPlan = JSON.stringify(options.tierPlan ?? "small");
  const tierGather = JSON.stringify(options.tierGather ?? "medium");
  const tierCrossCheck = JSON.stringify(options.tierCrossCheck ?? "big");
  const tierReport = JSON.stringify(options.tierReport ?? "big");
  return `export const meta = {
  name: 'deep_research',
  description: 'Deep research with real web search and cross-checked claims',
  phases: [
    { title: 'Queries' },
    { title: 'Gather' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

// angles/minSupport come from the shared builtin-args coercion (baked into
// the script below) — never the || default pattern, which silently mangles a present
// falsy value (e.g. angles: 0) and accepts out-of-range fan-out.
${numericArgCoercionSource(DEEP_RESEARCH_NUMERIC_ARGS)}

const question = (args && args.question) || ''

phase('Queries')
const plan = await agent(
  'You are planning web research for this question:\\n' + question +
  '\\n\\nProduce ' + angles + ' diverse, specific search queries that together cover the question from different angles.',
  { label: 'plan queries', tier: ${tierPlan}, schema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] } }
)
// The planner agent() can return null (e.g. a subagent that died on a terminal
// provider error) or omit a usable queries array. Mirror the null-tolerance the
// Gather phase uses below and fall back to the original question as a single
// query so research still proceeds (degraded) instead of crashing on plan.queries.
const planned = plan && Array.isArray(plan.queries) ? plan.queries.filter((q) => typeof q === 'string' && q.trim().length > 0) : []
// i5: the planner can emit far more queries than we can afford to fan out —
// cap at angles and log the degradation instead of silently dropping them.
const queries = (planned.length > 0 ? planned : [question]).slice(0, angles)
if (planned.length > angles) {
  log(
    'Deep research: planner produced ' + planned.length + ' queries; using the first ' + angles +
    ' to bound Gather fan-out (' + (planned.length - angles) + ' queries are not researched).'
  )
}

phase('Gather')
const gathered = await parallel(queries.map((q, i) => () =>
  agent(
    'Research this query using the web_search and web_fetch tools.\\nQuery: ' + q +
    '\\n\\nSteps: (1) call web_search with the query; (2) web_fetch the 2 most relevant result URLs; ' +
    '(3) extract concrete, verifiable factual claims, each tagged with the exact source URL it came from. ' +
    'Do NOT invent sources or claims — report only what the fetched pages actually say.',
    { label: 'research ' + (i + 1), tier: ${tierGather}, schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, claims: { type: 'array', items: { type: 'string' } } }, required: ['url', 'claims'] } } }, required: ['sources'] } }
  )
))
const allSources = gathered.filter(Boolean).flatMap((g) => (g && g.sources) || [])

phase('Verify')
// Token-economy cap for the embedded source list (T1-03): each claim is
// truncated to 400 chars and the list is bounded by a 4000-char total budget
// (max 40 sources) so the cross-check prompt can't re-bill unbounded JSON
// (measured up to 41K tokens). Deterministic — the same sources always yield
// the same prompt, so resume hashes stay stable; the cross-checker can
// web_fetch any URL to re-confirm truncated text.
const embeddedSources = []
let embedBudget = 4000
for (const s of allSources) {
  if (embeddedSources.length >= 40 || embedBudget <= 0) break
  const claims = (Array.isArray(s.claims) ? s.claims : []).map((c) => (typeof c === 'string' && c.length > 400 ? c.slice(0, 397) + '…' : c))
  const entry = { url: s.url, claims }
  const size = JSON.stringify(entry).length
  if (size > embedBudget) {
    if (embeddedSources.length === 0) {
      embeddedSources.push({ url: s.url, claims: claims.slice(0, 1).map((c) => (typeof c === 'string' && c.length > 200 ? c.slice(0, 197) + '…' : c)) })
    }
    break
  }
  embeddedSources.push(entry)
  embedBudget -= size
}
if (embeddedSources.length < allSources.length) {
  log(
    'Deep research: embedded ' + embeddedSources.length + ' of ' + allSources.length +
    ' sources for cross-check (token cap); tail sources are omitted — web_fetch any source URL to re-confirm.'
  )
}
const verdict = await agent(
  'You are a fact-checking cross-checker. Sources below list claims extracted from fetched pages.\\n' +
  'Group claims that assert the SAME fact into one normalized claim — paraphrase-equivalent wording, not identical text.\\n' +
  'A normalized claim survives ONLY when at least ' + minSupport + ' DISTINCT source URLs state it. There is no ' +
  'authoritative-source exception: one source never meets the threshold, no matter how authoritative it looks.\\n' +
  'When a claim is important or its source content is unclear, use web_fetch to re-fetch the source URL and confirm ' +
  'the page actually states the claim before counting it.\\n' +
  'Return:\\n' +
  '- supported: each normalized claim with the DISTINCT source URLs that state it (at least ' + minSupport + ').\\n' +
  '- discarded: claims found in fewer than ' + minSupport + ' sources, or whose sources you could not verify on the fetched pages.\\n' +
  '- conflicts: claims that contradict a supported claim, with the claim text and the contradictory evidence.\\n' +
  '\\n\\nSOURCES JSON:\\n' + JSON.stringify(embeddedSources),
  { label: 'cross-check', tier: ${tierCrossCheck}, schema: { type: 'object', properties: { supported: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } }, required: ['claim', 'sources'] } }, discarded: { type: 'array', items: { type: 'string' } }, conflicts: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, contradicting: { type: 'string' } }, required: ['claim'] } } }, required: ['supported'] } }
)
// minSupport is enforced HERE, deterministically, not only in the prompt: the
// cross-check LLM may still keep an under-supported claim or count the same
// page twice. Every supported claim must cite >= minSupport DISTINCT source
// URLs or it is moved to Conflicts (H5) — never silently dropped (M19).
const rawSupported = (verdict && Array.isArray(verdict.supported)) ? verdict.supported : []
const supported = []
const underSupported = []
for (const c of rawSupported) {
  if (!c || typeof c.claim !== 'string') continue
  const sources = Array.isArray(c.sources) ? c.sources.filter((u) => typeof u === 'string' && u.trim().length > 0) : []
  const distinct = new Set(sources)
  if (distinct.size >= minSupport) supported.push({ claim: c.claim, sources: Array.from(distinct) })
  else underSupported.push({ claim: c.claim, sources: Array.from(distinct) })
}
if (underSupported.length > 0) {
  log(
    'Deep research: ' + underSupported.length + ' claimed-supported claim(s) cited fewer than ' + minSupport +
    ' distinct source URLs — moved to Conflicts.'
  )
}
const verdictConflicts = (verdict && Array.isArray(verdict.conflicts))
  ? verdict.conflicts.filter((c) => c && typeof c.claim === 'string')
  : []
const discarded = (verdict && Array.isArray(verdict.discarded))
  ? verdict.discarded.filter((d) => typeof d === 'string' && d.trim().length > 0)
  : []
// Conflicts section = cross-check mismatches + discarded claims + claims whose
// support fell below minSupport. Contradictions and dropped claims must never
// silently vanish from the report (M19).
const conflicts = [
  ...verdictConflicts,
  ...underSupported.map((c) => ({ claim: c.claim, reason: 'fewer than ' + minSupport + ' distinct source URLs' })),
  ...discarded.map((d) => ({ claim: d, reason: 'discarded by cross-check' })),
]

phase('Report')
const report = await agent(
  'Write a concise, well-structured research report that answers the question using ONLY the supported claims below. ' +
  'Cite source URLs inline next to each claim. If the evidence is thin, say so explicitly. Include a short Conflicts ' +
  'section listing the entries below and why each was excluded — never present them as fact.\\n\\n' +
  'QUESTION: ' + question + '\\n\\nSUPPORTED CLAIMS JSON:\\n' + JSON.stringify(supported) +
  '\\n\\nCONFLICTS JSON:\\n' + JSON.stringify(conflicts),
  { label: 'write report', tier: ${tierReport} }
)

return { question, queries, supported, conflicts, report }`;
}

/**
 * Generate a codebase audit workflow.
 *
 * `scope` and each `checks` entry are user-supplied strings that get baked
 * directly into the generated script's source (unlike the runtime-args-driven
 * generators above), so every one is embedded via JSON.stringify — a proper JS
 * string literal that can't be broken out of by a quote, backslash, or
 * backtick in the value. Only the human-readable `meta.description` is
 * truncated for display; the operative `scope` used by the agents is always
 * the full, untruncated value.
 */
export function generateCodebaseAuditWorkflow(scope: string, checks: string[]): string {
  const displayScope = scope.length > 60 ? `${scope.slice(0, 60)}…` : scope;
  const checkAgents = checks
    .map((check, i) => {
      const label =
        check
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 20) || `check-${i + 1}`;
      return `  () => agent(${JSON.stringify(`Audit ${check} across: `)} + scope, { label: ${JSON.stringify(label)} }),`;
    })
    .join("\n");

  return `export const meta = {
  name: 'codebase_audit',
  description: ${JSON.stringify(`Codebase audit: ${displayScope}`)},
  phases: [
    { title: 'Individual Checks' },
    { title: 'Cross-Validation' },
    { title: 'Report' },
  ],
};

phase('Individual Checks');
const scope = ${JSON.stringify(scope)};
const findings = await parallel([
${checkAgents}
]);

phase('Cross-Validation');
const validated = await agent(
  'Cross-validate these audit findings. Remove false positives and confirm real issues:\\n' +
  JSON.stringify(findings),
  { label: 'validator' }
);

phase('Report');
const report = await agent(
  'Generate a prioritized audit report with actionable recommendations:\\n' + validated,
  { label: 'report-writer' }
);

return { findings, validated, report };`;
}
