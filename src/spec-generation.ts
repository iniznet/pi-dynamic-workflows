/**
 * Spec-generation workflow (built-in pattern).
 *
 * Three drafters (product / technical / risk) each produce a full draft
 * specification for the topic in parallel; an adversarial requirements
 * reviewer finds conflicts/gaps and consolidates the drafts into a single
 * structured spec artifact; a finalize step renders the artifact in the
 * requested format (markdown prose or json).
 *
 * Like plan-then-execute, the generated script runs in a vm, so the pure
 * artifact normalizer below is ALSO emitted as a vm-embeddable JS source
 * string (normalizeSpecArtifactSource) — one contract, two copies kept
 * behaviorally identical by a parity test (see tests/slices/workflows/).
 */

/** Allowed render formats for the final artifact; anything else is rejected loudly. */
export const SPEC_GENERATION_FORMATS = ["markdown", "json"] as const;

export type SpecGenerationFormat = (typeof SPEC_GENERATION_FORMATS)[number];

/** Applied when the caller omits `format`. */
export const SPEC_GENERATION_DEFAULT_FORMAT: SpecGenerationFormat = "markdown";

/** One requirement of the consolidated spec artifact. */
export interface SpecRequirement {
  id: string;
  statement: string;
}

/**
 * The structured spec artifact contract: goal, requirements (each with a
 * unique id), constraints, acceptance criteria, risks, open questions.
 */
export interface SpecArtifact {
  goal: string;
  requirements: SpecRequirement[];
  constraints: string[];
  acceptanceCriteria: string[];
  risks: string[];
  openQuestions: string[];
}

/**
 * Defensive normalization of a (possibly LLM-shaped) spec into the artifact
 * contract. Guarantees: all six sections always present (missing ones become
 * empty arrays / empty goal); requirements keep only a concrete statement, and
 * every requirement gets a unique id — a missing or duplicate id is
 * deterministically reassigned REQ-N in input order (the artifact's
 * "requirements with IDs" promise is enforced here, not only in the reviewer
 * prompt).
 */
export function normalizeSpecArtifact(raw: unknown): SpecArtifact {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const goal = typeof record.goal === "string" ? record.goal.trim() : "";
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const requirements: SpecRequirement[] = [];
  const seenIds = new Set<string>();
  // REQ-N numbers only the auto-assigned ids, in input order, so a mix of
  // explicit and missing ids never skips a number.
  let autoAssigned = 0;
  if (Array.isArray(record.requirements)) {
    for (const rawRequirement of record.requirements) {
      const r = rawRequirement && typeof rawRequirement === "object" ? (rawRequirement as Record<string, unknown>) : {};
      const statement = typeof r.statement === "string" ? r.statement.trim() : "";
      if (!statement) continue;
      let id = typeof r.id === "string" ? r.id.trim() : "";
      if (!id || seenIds.has(id)) {
        autoAssigned++;
        id = `REQ-${autoAssigned}`;
      }
      seenIds.add(id);
      requirements.push({ id, statement });
    }
  }
  return {
    goal,
    requirements,
    constraints: asStringArray(record.constraints),
    acceptanceCriteria: asStringArray(record.acceptanceCriteria),
    risks: asStringArray(record.risks),
    openQuestions: asStringArray(record.openQuestions),
  };
}

/**
 * Emit the vm-embeddable equivalent of normalizeSpecArtifact for the generated
 * script (which runs in a vm and cannot import this module). Kept textually in
 * sync with the TS reference — the parity test in tests/slices/workflows/
 * executes BOTH copies against the same fixtures and asserts identical
 * outcomes, so a drift fails loudly instead of silently.
 */
export function normalizeSpecArtifactSource(): string {
  return [
    "const normalizeSpecArtifact = (raw) => {",
    "  const record = raw && typeof raw === 'object' ? raw : {}",
    "  const goal = typeof record.goal === 'string' ? record.goal.trim() : ''",
    "  const asStringArray = (value) => Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim().length > 0) : []",
    "  const requirements = []",
    "  const seenIds = new Set()",
    "  let autoAssigned = 0",
    "  if (Array.isArray(record.requirements)) {",
    "    for (const rawRequirement of record.requirements) {",
    "      const r = rawRequirement && typeof rawRequirement === 'object' ? rawRequirement : {}",
    "      const statement = typeof r.statement === 'string' ? r.statement.trim() : ''",
    "      if (!statement) continue",
    "      let id = typeof r.id === 'string' ? r.id.trim() : ''",
    "      if (!id || seenIds.has(id)) { autoAssigned++; id = 'REQ-' + autoAssigned }",
    "      seenIds.add(id)",
    "      requirements.push({ id, statement })",
    "    }",
    "  }",
    "  return { goal, requirements, constraints: asStringArray(record.constraints), acceptanceCriteria: asStringArray(record.acceptanceCriteria), risks: asStringArray(record.risks), openQuestions: asStringArray(record.openQuestions) }",
    "}",
  ].join("\n");
}

/** Documentation-only config shape; the generated script reads these from `args` at runtime. */
export interface SpecGenerationConfig {
  topic: string;
  audience?: string;
  format?: SpecGenerationFormat;
}

/**
 * T2-05: per-phase model-tier knobs for the generated spec-generation script.
 * Defaults: drafts=medium, reviewer=big, markdown writer=small. Baked at
 * generation time so the script text (and resume hashes) is deterministic.
 */
interface SpecGenerationTierOptions {
  tierDraft?: string;
  tierReview?: string;
  tierWriter?: string;
}

/**
 * Generate the spec-generation workflow script. The script is static and
 * reads its inputs from `args` (topic/audience/format) so nothing
 * caller-supplied is ever string-interpolated into source. The artifact
 * normalizer is embedded via normalizeSpecArtifactSource() (see module doc).
 * T2-05: per-phase tiers are baked at generation time (JSON.stringify).
 */
export function generateSpecGenerationWorkflow(options: SpecGenerationTierOptions = {}): string {
  const tierDraft = JSON.stringify(options.tierDraft ?? "medium");
  const tierReview = JSON.stringify(options.tierReview ?? "big");
  const tierWriter = JSON.stringify(options.tierWriter ?? "small");
  return `export const meta = {
  name: 'spec_generation',
  description: 'Draft a specification from product, technical, and risk perspectives, then adversarially review into a structured artifact',
  phases: [
    { title: 'Draft' },
    { title: 'Review' },
    { title: 'Finalize' },
  ],
}

// normalizeSpecArtifact mirrors src/spec-generation.ts (the unit-tested
// reference); a parity test keeps the two copies behaviorally identical. It
// enforces the artifact contract in the vm: all six sections present, and
// every requirement carries a unique id.
${normalizeSpecArtifactSource()}

const topic = (args && args.topic) || ''
const audience = (args && args.audience) || ''
const format = (args && args.format) || 'markdown'
const SUPPORTED_FORMATS = ['markdown', 'json']
if (!topic) {
  return { topic, audience, format, drafts: [], review: null, conflicts: [], gaps: [], spec: null, artifact: null, error: 'topic is required (a non-empty string)' }
}
if (SUPPORTED_FORMATS.indexOf(format) === -1) {
  return { topic, audience, format, drafts: [], review: null, conflicts: [], gaps: [], spec: null, artifact: null, error: 'format must be one of: ' + SUPPORTED_FORMATS.join(', ') }
}

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, statement: { type: 'string' } },
        required: ['id', 'statement'],
      },
    },
    constraints: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'requirements', 'constraints', 'acceptanceCriteria', 'risks', 'openQuestions'],
}

phase('Draft')
const audienceLine = audience ? '\\nTarget audience: ' + audience : ''
const draftResults = await parallel([
  () => agent(
    'You are a product drafter. Draft a complete product specification for the topic below: the goal, ' +
    'requirements (each with a short unique id and a testable statement), constraints, acceptance criteria, ' +
    'risks, and open questions. Focus on user value, scope, and what success looks like.' +
    '\\n\\nTOPIC: ' + topic + audienceLine,
    { label: 'draft product', tier: ${tierDraft}, schema: SPEC_SCHEMA }
  ),
  () => agent(
    'You are a technical drafter. Draft a complete technical specification for the topic below using the ' +
    'same sections: goal, requirements (each with a short unique id and a testable statement), constraints, ' +
    'acceptance criteria, risks, and open questions. Focus on architecture, interfaces, and technical feasibility.' +
    '\\n\\nTOPIC: ' + topic + audienceLine,
    { label: 'draft technical', tier: ${tierDraft}, schema: SPEC_SCHEMA }
  ),
  () => agent(
    'You are a risk drafter. Draft a complete specification for the topic below with a risk-first eye: ' +
    'requirements that mitigate the main risks (each with a short unique id and a testable statement), ' +
    'constraints, acceptance criteria, risks, and open questions.' +
    '\\n\\nTOPIC: ' + topic + audienceLine,
    { label: 'draft risk', tier: ${tierDraft}, schema: SPEC_SCHEMA }
  ),
])
// A null draft (recoverable agent failure) drops that perspective from the
// review — degraded, logged, never a crash on draft.spec downstream.
const drafts = draftResults.filter((d) => d && typeof d === 'object')
if (drafts.length < draftResults.length) {
  log('Spec generation: ' + (draftResults.length - drafts.length) + ' of ' + draftResults.length + ' perspective draft(s) failed; the review proceeds without them.')
}

phase('Review')
const reviewOut = await agent(
  'You are an adversarial requirements reviewer. Three drafters (product, technical, risk) produced draft ' +
  'specifications for the same topic. Identify conflicts between them, coverage gaps, ambiguous or untestable ' +
  'requirements, and missing acceptance criteria. Then produce the single consolidated specification: goal, ' +
  'requirements (each with a unique id and a concrete, testable statement), constraints, acceptance criteria, ' +
  'risks, and open questions.\\n\\n' +
  'TOPIC: ' + topic + audienceLine + '\\n\\nDRAFT SPECS JSON:\\n' + JSON.stringify(drafts),
  { label: 'requirements reviewer', tier: ${tierReview}, schema: { type: 'object', properties: { review: { type: 'string' }, conflicts: { type: 'array', items: { type: 'string' } }, gaps: { type: 'array', items: { type: 'string' } }, spec: SPEC_SCHEMA }, required: ['review', 'spec'] } }
)
const review = reviewOut && typeof reviewOut === 'object' ? reviewOut : null
// normalizeSpecArtifact enforces the artifact contract deterministically: the
// reviewer may omit a section or leave a requirement without a unique id, and
// the artifact must not. Missing sections degrade to empty arrays (logged),
// never a schema violation in the final result.
const spec = normalizeSpecArtifact(review && review.spec)
if (!spec.goal) log('Spec generation: reviewer returned no goal; the artifact has an empty goal section.')
if (spec.requirements.length === 0) log('Spec generation: reviewer returned no requirements; the artifact has an empty requirements section.')
const conflicts = (review && Array.isArray(review.conflicts)) ? review.conflicts.filter((c) => typeof c === 'string' && c.trim().length > 0) : []
const gaps = (review && Array.isArray(review.gaps)) ? review.gaps.filter((g) => typeof g === 'string' && g.trim().length > 0) : []

phase('Finalize')
// json is rendered deterministically in-script (no extra agent call); markdown
// gets a writer agent so the artifact reads like a document, not a dump.
const artifact = format === 'json'
  ? JSON.stringify(spec, null, 2)
  : await agent(
      'You are a spec writer. Write the final specification document in Markdown from the consolidated spec below. ' +
      'Structure it as: Goal, Requirements (id + statement), Constraints, Acceptance Criteria, Risks, Open Questions. ' +
      'Every requirement must keep its id.\\n\\n' +
      'TOPIC: ' + topic + audienceLine + '\\n\\nCONSOLIDATED SPEC JSON:\\n' + JSON.stringify(spec, null, 2),
      { label: 'spec writer', tier: ${tierWriter} }
    )

return { topic, audience, format, drafts, review: review ? review.review : null, conflicts, gaps, spec, artifact, error: '' }`;
}
