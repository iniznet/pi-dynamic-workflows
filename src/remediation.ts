/**
 * V2-P06 — review→remediation loop with per-finding lifecycle.
 *
 * The `review-remediate` builtin (builtin-workflows.ts) runs the full
 * code-review machinery (8 finders + verify + synthesis), then adds a
 * remediation loop: every surviving finding gets a durable lifecycle record
 * (open → in-progress → fixed → verified → closed, with wontfix as the
 * accepted side-branch), a gated fix pass, a per-finding RE-REVIEW whose
 * machine test (testGate) closes the verify step, and a COMPLIANCE pass that
 * asserts zero open/in-progress/fixed findings — a MACHINE assertion over the
 * run's lifecycle evidence, never an LLM assertion (the V2 note).
 *
 * Lifecycle records are durableStore state (project-scoped, cross-run
 * queryable) via `putOnce` with stable ids — REPLAY-IDEMPOTENT by construction
 * (a re-executed transition is a no-op), and NEVER part of any agent() call's
 * resume identity. The loop's CONTROL FLOW is a pure function of the run's
 * journaled review result (each run re-reviews all findings), so cached-prefix
 * replay keeps call indices aligned — durable writes never branch the loop.
 *
 * Status transitions are MACHINE-verifiable via {@link canTransitionFinding}
 * (a pure predicate, embedded in the generated script too) and the verify step
 * is machine evidence: testGate runs the fix's `verifyCommand` and requires
 * exit 0 before a finding may move fixed → verified.
 *
 * The transform `injectRemediationLoop` wraps an EXISTING generated code-review
 * script deterministically (marker-validated, fail-loud on drift): it replaces
 * the review's return statement with `const reviewResult = { ... }`, appends
 * the Remediate / Re-Review / Compliance phases, and re-exposes the result
 * with the remediation artifact. The same transform works on the
 * impact-scoped variant (code-review + injectImpactScopePhase), so the builtin
 * composes P08 and V2-P06.
 */

import { provenanceContentId, provenanceContentIdSource } from "./durable-store.js";

/** The closed lifecycle vocabulary (task contract: open/in-progress/fixed/verified/closed). */
export const FINDING_LIFECYCLE_STATUSES = ["open", "in-progress", "fixed", "wontfix", "verified", "closed"] as const;

export type FindingLifecycleStatus = (typeof FINDING_LIFECYCLE_STATUSES)[number];

/** One durable lifecycle record for a finding. */
export interface FindingLifecycleRecord {
  /** Content-derived stable finding id (same finding in any run → same id). */
  id: string;
  file: string;
  line?: number;
  severity?: string;
  summary: string;
  angle?: string;
  status: FindingLifecycleStatus;
  /** How many remediation rounds this record reflects. */
  rounds: number;
  /** The fix's machine verification command when a fix was proposed. */
  verifyCommand?: string;
}

/**
 * The machine-verifiable transition table (task contract). `fixed` may fall
 * back to `in-progress` when the re-review machine gate reopens the finding
 * for rework; `wontfix` is the accepted side-branch; only `verified`/`wontfix`
 * reach `closed` (the compliance acceptance). Everything else is an invalid
 * transition — a script that attempts one logs the violation and keeps the
 * prior status (never silently rewrites lifecycle state).
 */
export const FINDING_TRANSITIONS: Readonly<Record<FindingLifecycleStatus, readonly FindingLifecycleStatus[]>> = {
  open: ["in-progress", "wontfix"],
  "in-progress": ["fixed", "wontfix"],
  fixed: ["verified", "in-progress"],
  wontfix: ["closed"],
  verified: ["closed"],
  closed: [],
};

/** Whether `from -> to` is a machine-legal lifecycle transition. */
export function canTransitionFinding(from: FindingLifecycleStatus, to: FindingLifecycleStatus): boolean {
  return FINDING_TRANSITIONS[from].includes(to);
}

/** A finding as the review phase emits it. */
export interface ReviewFinding {
  file: string;
  line?: number;
  severity?: string;
  summary: string;
  angle?: string;
  failure_scenario?: string;
}

/**
 * Content-derived stable finding id: the SAME finding (same file/line/severity/
 * summary/angle) yields the SAME id in any run, so lifecycle records and
 * provenance entries dedupe across runs and replay. A changed finding produces
 * a DISTINCT id (a new lifecycle, never a silent rewrite of the old one).
 */
export function findingContentId(finding: ReviewFinding): string {
  return provenanceContentId({
    source: "review-finding",
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    summary: finding.summary,
    angle: finding.angle,
  });
}

/**
 * Defensive normalization of raw review findings into the finding contract:
 * every entry needs a non-empty `file` and `summary`; numeric `line` and
 * `severity`/`angle`/`failure_scenario` strings survive when well-typed; a
 * duplicate finding (same content-derived id) is dropped first-wins; a
 * non-array degrades to [] (a finding-less review remediates nothing and the
 * compliance pass trivially passes — zero open findings). Deterministic for a
 * given input — resume's journal replay requires it.
 */
export function normalizeFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ReviewFinding[] = [];
  for (const entry of raw) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const file = typeof record.file === "string" && record.file.trim() ? record.file.trim() : "";
    const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : "";
    if (!file || !summary) continue;
    const finding: ReviewFinding = { file, summary };
    if (typeof record.line === "number" && Number.isFinite(record.line)) finding.line = record.line;
    if (typeof record.severity === "string" && record.severity.trim()) finding.severity = record.severity.trim();
    if (typeof record.angle === "string" && record.angle.trim()) finding.angle = record.angle.trim();
    if (typeof record.failure_scenario === "string" && record.failure_scenario.trim()) {
      finding.failure_scenario = record.failure_scenario.trim();
    }
    const id = findingContentId(finding);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(finding);
  }
  return out;
}

/**
 * Emit the vm-embeddable equivalents of the lifecycle machinery for the
 * generated script (which runs in a vm and cannot import this module):
 * provenanceContentId (the same content-derived algorithm the host uses),
 * findingContentId, canTransitionFinding, and normalizeFindings. Kept
 * textually in sync with the TS references — the parity test in
 * tests/slices/workflows/ executes BOTH copies against the same fixtures.
 */
export function remediationNormalizersSource(): string {
  return [
    "// provenanceContentId mirrors src/durable-store.ts (the unit-tested",
    "// reference); a parity test keeps the two copies behaviorally identical.",
    provenanceContentIdSource(),
    "const computeProvenanceId = provenanceContentId",
    "const findingContentId = (f) => computeProvenanceId({ source: 'review-finding', file: f.file, line: f.line, severity: f.severity, summary: f.summary, angle: f.angle })",
    "const FINDING_STATUSES = ['open', 'in-progress', 'fixed', 'wontfix', 'verified', 'closed']",
    "const FINDING_TRANSITIONS = { 'open': ['in-progress', 'wontfix'], 'in-progress': ['fixed', 'wontfix'], 'fixed': ['verified', 'in-progress'], 'wontfix': ['closed'], 'verified': ['closed'], 'closed': [] }",
    "const canTransitionFinding = (from, to) => {",
    "  const targets = FINDING_TRANSITIONS[from]",
    "  return !!targets && targets.indexOf(to) !== -1",
    "}",
    "const normalizeFindings = (raw) => {",
    "  if (!Array.isArray(raw)) return []",
    "  const seen = new Set()",
    "  const out = []",
    "  for (const entry of raw) {",
    "    const record = entry && typeof entry === 'object' ? entry : {}",
    "    const file = (typeof record.file === 'string' && record.file.trim()) ? record.file.trim() : ''",
    "    const summary = (typeof record.summary === 'string' && record.summary.trim()) ? record.summary.trim() : ''",
    "    if (!file || !summary) continue",
    "    const finding = { file: file, summary: summary }",
    "    if (typeof record.line === 'number' && Number.isFinite(record.line)) finding.line = record.line",
    "    if (typeof record.severity === 'string' && record.severity.trim()) finding.severity = record.severity.trim()",
    "    if (typeof record.angle === 'string' && record.angle.trim()) finding.angle = record.angle.trim()",
    "    if (typeof record.failure_scenario === 'string' && record.failure_scenario.trim()) finding.failure_scenario = record.failure_scenario.trim()",
    "    const id = findingContentId(finding)",
    "    if (seen.has(id)) continue",
    "    seen.add(id)",
    "    out.push(finding)",
    "  }",
    "  return out",
    "}",
  ].join("\n");
}

/** Default bounded remediation rounds (fix→verify rework per finding). */
export const DEFAULT_REMEDIATION_ROUNDS = 2;
/** Cap on remediation rounds (keeps the per-finding loop bounded — N03 discipline). */
export const MAX_REMEDIATION_ROUNDS = 4;

/** Inputs to {@link injectRemediationLoop}. */
export interface RemediationInjection {
  /** The generated code-review base script (plain or impact-scoped) to wrap. */
  baseScript: string;
  /** Doc-only note for authors; unused by the transform (kept for symmetry). */
  label?: string;
}

/**
 * The remediation phase source appended after the review's return statement is
 * replaced: per-finding fix agents (journaled, schema-bound), a testGate
 * re-review that machine-closes the verify step, and the machine compliance
 * assertion. Self-contained (defines its own schemas and normalizers), so the
 * same fragment works on the plain and the impact-scoped code-review script.
 */
function remediationPhaseSource(): string {
  return `
${remediationNormalizersSource()}

const remediationRounds = (typeof (args && args.remediationRounds) === 'number' && Number.isFinite(args.remediationRounds))
  ? Math.max(1, Math.min(${MAX_REMEDIATION_ROUNDS}, Math.floor(args.remediationRounds)))
  : ${DEFAULT_REMEDIATION_ROUNDS}
const remediationFindings = normalizeFindings(reviewResult.findings || [])
const findingLifecycle = []

// Deterministic prompt-embedding cap (T1-03 pattern) — same finding, same
// prompt; resume hashes stay stable.
const capFinding = (value, maxChars) => {
  const text = value === null || value === undefined ? '(none)' : (typeof value === 'string' ? value : JSON.stringify(value))
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

// Lifecycle writes are durableStore state via putOnce — REPLAY-IDEMPOTENT (a
// re-executed transition is a no-op) and NEVER part of any agent() resume
// identity. The transition guard reads the run's OWN in-memory lifecycle array
// (a pure function of the journaled review result), never a cross-run read, so
// cached-prefix replay keeps call indices aligned.
const lifecycleKey = (id) => 'finding:' + id
const recordLifecycle = async (id, record) => {
  // The LATEST record for the finding drives the transition guard (the array is
  // in push order — the reverse find is deterministic per run).
  const previous = [...findingLifecycle].reverse().find((r) => r.id === id)
  if (previous && !canTransitionFinding(previous.status, record.status)) {
    log('Remediation: illegal lifecycle transition ' + previous.status + ' -> ' + record.status + ' rejected for finding ' + id.slice(0, 8))
    return previous
  }
  const next = { ...record, rounds: previous ? Math.max(previous.rounds, record.rounds) : record.rounds }
  findingLifecycle.push(next)
  try {
    await durableStore.putOnce('finding:' + id + ':' + record.status, lifecycleKey(id), next)
  } catch (e) {
    log('Remediation: lifecycle write failed (run continues): ' + String(e))
  }
  return next
}
const openLifecycle = (f, index) => ({
  id: findingContentId(f),
  file: f.file,
  line: f.line,
  severity: f.severity,
  summary: f.summary,
  angle: f.angle,
  status: 'open',
  rounds: 0,
})
const openRecord = remediationFindings.map(openLifecycle)

phase('Remediate')
// Open records first (machine step over the normalized findings).
for (const f of openRecord) {
  await recordLifecycle(f.id, f)
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    change: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    verifyCommand: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['change', 'verifyCommand'],
}
const RE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['confirmed'],
}
const fixPrompt = (f, feedback) =>
  'You are a remediation fixer. The finding below came from a code review of the change in this workspace. ' +
  'Use the read/grep/find/bash tools to inspect the affected code and implement the minimal fix that resolves the finding. ' +
  'Return: change (a short description), files (the files you edited), verifyCommand (ONE shell command that MACHINE-VERIFIES the finding is resolved — it must exit 0 only when the fix is in place), notes (anything the re-reviewer must know).' +
  '\\n\\nFINDING: ' + capFinding(f, 1500) +
  (feedback ? '\\n\\nPREVIOUS VERIFICATION FEEDBACK (the machine test still fails):\\n' + feedback : '')
const reReviewPrompt = (f, verifyCommand, feedback) =>
  'You are a remediation re-reviewer. Re-check the finding below against the CURRENT tree: confirm the fix is in place so the machine verification command exits 0. ' +
  'If the machine test below fails, inspect why and re-apply/repair the fix. Report confirmed (boolean) + notes.' +
  '\\n\\nFINDING: ' + capFinding(f, 1500) +
  '\\nMACHINE VERIFICATION COMMAND: ' + verifyCommand +
  (feedback ? '\\n\\nFEEDBACK:\\n' + feedback : '')

for (let i = 0; i < remediationFindings.length; i++) {
  const f = remediationFindings[i]
  // open -> in-progress (remediation started).
  await recordLifecycle(openRecord[i].id, { ...openRecord[i], status: 'in-progress', rounds: openRecord[i].rounds + 1 })
  const fix = await agent(fixPrompt(f), { label: 'fix ' + (i + 1), phase: 'Remediate', tier: 'medium', schema: FIX_SCHEMA })
  const verifyCommand = (fix && typeof fix.verifyCommand === 'string' && fix.verifyCommand.trim())
    ? fix.verifyCommand.trim()
    : ''
  const verifyAvailable = verifyCommand.length > 0
  if (!verifyAvailable) {
    log('Remediation: finding ' + openRecord[i].id.slice(0, 8) + ' produced no machine verification command; it stays fixed-but-unverified (remediation incomplete).')
  }
  // in-progress -> fixed (the fixer proposed a concrete change + verify command).
  await recordLifecycle(openRecord[i].id, { ...openRecord[i], status: 'fixed', rounds: openRecord[i].rounds + 1, verifyCommand: verifyCommand || undefined })
  if (!verifyAvailable) continue
  // Re-Review: testGate CLOSES the verify step — the machine test runs the
  // fix's verifyCommand and requires exit 0 before the finding may move to
  // verified. The gate's thunk re-confirms/re-applies the fix per attempt
  // (bounded rework, feedback fed from the failing machine test).
  phase('Re-Review')
  const reReview = await testGate(
    (feedback, attempt) => agent(reReviewPrompt(f, verifyCommand, feedback), {
      label: 're-review ' + (i + 1) + '.' + (attempt + 1),
      phase: 'Re-Review',
      tier: 'medium',
      schema: RE_REVIEW_SCHEMA,
    }),
    {
      tests: [{ command: verifyCommand, assert: { exitCode: 0 } }],
      postconditions: ['the finding must be resolved so the machine verification command exits 0'],
      attempts: remediationRounds,
      phase: 'Re-Review',
    },
  )
  if (reReview.ok) {
    // fixed -> verified (machine evidence only).
    await recordLifecycle(openRecord[i].id, { ...openRecord[i], status: 'verified', rounds: openRecord[i].rounds + 1, verifyCommand })
  } else {
    // fixed stays fixed-not-verified; remediation exhausted for this finding.
    log('Remediation: finding ' + openRecord[i].id.slice(0, 8) + ' did not pass the machine verification within ' + remediationRounds + ' round(s); it stays fixed-but-unverified.')
  }
}

phase('Compliance')
// The compliance verdict is MACHINE: zero findings whose CURRENT (latest)
// lifecycle status is open / in-progress / fixed (wontfix is accepted, verified
// is done). The latest status per finding is a pure function of the run's own
// transition trail — never an LLM assertion.
const latestByFinding = new Map()
for (const rec of findingLifecycle) latestByFinding.set(rec.id, rec)
const complianceOpen = [...latestByFinding.values()].filter((r) => r.status === 'open' || r.status === 'in-progress' || r.status === 'fixed').length
const compliancePassed = complianceOpen === 0
if (!compliancePassed) {
  log('Remediation compliance: ' + complianceOpen + ' finding(s) remain open/in-progress/fixed — the compliance pass FAILED (remediation incomplete).')
}
// Accept compliant findings: verified -> closed and wontfix -> closed (machine
// transitions; the lifecycle stays durable for cross-run queries).
for (const rec of [...latestByFinding.values()]) {
  if ((rec.status === 'verified' || rec.status === 'wontfix') && canTransitionFinding(rec.status, 'closed')) {
    await recordLifecycle(rec.id, { ...rec, status: 'closed', rounds: rec.rounds })
  }
}
const lifecycleSummary = [...findingLifecycle]

return {
  total: reviewResult.total,
  verified: reviewResult.verified,
  surviving: reviewResult.surviving,
  findings: reviewResult.findings,
  report: reviewResult.report,
  diffTruncated: reviewResult.diffTruncated,
  ...(reviewResult.impactPartition !== undefined ? { impactPartition: reviewResult.impactPartition } : {}),
  remediation: {
    findings: remediationFindings,
    lifecycle: lifecycleSummary,
    compliance: { passed: compliancePassed, open: complianceOpen },
    rounds: remediationRounds,
  },
}`;
}

/**
 * Apply the remediation loop to a generated code-review script (plain or
 * impact-scoped). Deterministic and marker-validated: a missing review return
 * statement throws a descriptive Error (surfaced by the registry resolve as a
 * warning) instead of silently producing a broken script, so a generator drift
 * fails loudly. The transform:
 *  1. appends the Remediate / Re-Review / Compliance phases to meta.phases;
 *  2. replaces the review's `return { ... }` statement with `const reviewResult = { ... };`
 *  3. appends the remediation phase source + the final return with the
 *     remediation artifact.
 */
export function injectRemediationLoop(injection: RemediationInjection): string {
  const { baseScript } = injection;
  const META_MARKER = "phases: [";
  if (!baseScript.includes(META_MARKER)) {
    throw new Error("remediation: baseScript must declare meta.phases (marker not found)");
  }
  const PHASES_TAIL = "{ title: 'Report' },\n  ],";
  if (!baseScript.includes(PHASES_TAIL)) {
    throw new Error("remediation: baseScript must end its phases list with the Report phase (marker not found)");
  }
  const RETURN_MARKER = "return { total: allCandidates.length";
  let script = baseScript;
  // 1. Append the remediation phases to the declared meta phases (BEFORE the
  // return-statement index is computed: the append shifts every later line).
  if (!baseScript.includes(RETURN_MARKER)) {
    throw new Error("remediation: baseScript must contain the code-review return statement (marker not found)");
  }
  script = script.replace(
    PHASES_TAIL,
    `{ title: 'Report' },\n    { title: 'Remediate' },\n    { title: 'Re-Review' },\n    { title: 'Compliance' },\n  ],`,
  );
  // 2. Turn the review's return statement into the reviewResult binding (the
  // marker is recomputed on the phases-appended script).
  const returnIndex = script.indexOf(RETURN_MARKER);
  const lineEndAt = script.indexOf("\n", returnIndex);
  const returnLine = script.slice(returnIndex, lineEndAt === -1 ? script.length : lineEndAt);
  const reviewBinding = `const reviewResult = ${returnLine.slice("return ".length)};`;
  // 3. Append the remediation phase source + the final return.
  const injected = `${reviewBinding}\n${remediationPhaseSource()}`;
  script = `${script.slice(0, returnIndex)}${injected}${script.slice(lineEndAt === -1 ? script.length : lineEndAt)}`;
  return script;
}
