/**
 * Spec-conformance workflow (built-in pattern P07).
 *
 * Audits an implementation workspace against a specification: per-requirement
 * MECHANICAL evidence mapping (named symbols, registrations, probed behavior
 * via bash+grep), missing/extra detection, and a scored conformance report.
 * Every requirement needs mechanical evidence — never an LLM's unbacked claim
 * (fabric-spec acceptance-ledger model).
 *
 * Closes the loop with spec-generation: the spec artifact contract is REUSED
 * (normalizeSpecArtifact from spec-generation.ts), so a spec-generation output
 * (or any artifact with the same shape) audits directly.
 *
 * The generated script runs in a vm and cannot import this module, so the
 * normalizers below are ALSO emitted as vm-embeddable JS source strings
 * (conformanceNormalizersSource) — the parity-test pattern shared with
 * spec-generation.ts / plan-then-execute.ts.
 */

import { type NumericArgSpec, numericArgCoercionSource } from "./builtin-args.js";
import { provenanceContentId, provenanceContentIdSource } from "./durable-store.js";
import { normalizeSpecArtifact, normalizeSpecArtifactSource } from "./spec-generation.js";

/**
 * V2-N2: the machine-captured workspace state the trend ledger keys on — the
 * N01 fingerprint contract (workflow-manager.ts captureWorkspaceFingerprint)
 * reproduced in the vm from a bash-captured agent step's verbatim output.
 * `gitStatus` is sorted so the canonical form is independent of git's own
 * output ordering for a fixed workspace state.
 */
export interface WorkspaceFingerprintCapture {
  treeHash: string | null;
  gitStatus: string[];
}

/**
 * Defensive normalization of a bash-captured workspace fingerprint step
 * (`{ exitCode?, output }` from the agent relaying `git rev-parse HEAD^{tree}`
 * + `git status --porcelain -uall`). The FIRST non-blank output line must be a
 * 40-hex git tree hash (anything else — a git error, an empty repo — means the
 * workspace is not fingerprint-able) and the remaining lines are the sorted
 * porcelain status. Status lines are NOT trimmed: the ` XY path` leading-space
 * column is significant (` M file` worktree-modified vs `M  file` staged) and
 * must stay part of the canonical form. A non-verifiable capture degrades to
 * null: the trend ledger is then SKIPPED (logged), never fabricated.
 */
export function normalizeWorkspaceFingerprint(raw: unknown): WorkspaceFingerprintCapture | null {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const output = typeof record.output === "string" ? record.output : "";
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const nonBlank = lines.filter((line) => line.length > 0);
  if (nonBlank.length === 0) return null;
  const first = nonBlank[0];
  if (!/^[0-9a-f]{40}$/.test(first)) return null;
  // The porcelain status lines keep their original leading-space column; the
  // rows start after the FIRST non-blank raw line (the tree hash).
  const rawLines = output.split(/\r?\n/);
  const firstRaw = rawLines.findIndex((line) => line.trim().length > 0);
  const statusRows = rawLines.slice(firstRaw + 1).filter((line) => line.trim().length > 0);
  return { treeHash: first, gitStatus: statusRows.sort() };
}

/**
 * The deterministic fingerprint key for the trend ledger: the content-derived
 * id of the canonical `{ treeHash, gitStatus }` capture. The SAME workspace
 * state always yields the SAME key, so score records dedupe across runs;
 * a changed workspace produces a distinct key (a fresh trend line). Null when
 * the capture is not fingerprint-able.
 */
export function workspaceFingerprintKey(fp: WorkspaceFingerprintCapture | null): string | null {
  if (!fp) return null;
  return provenanceContentId({ source: "workspace-fingerprint", treeHash: fp.treeHash, gitStatus: fp.gitStatus });
}

/**
 * Emit the vm-embeddable equivalents of {@link normalizeWorkspaceFingerprint}
 * and {@link workspaceFingerprintKey} for the generated script. Kept textually
 * in sync with the TS references — the parity test in
 * tests/slices/workflows/ executes BOTH copies against the same fixtures.
 */
export function workspaceFingerprintSource(): string {
  return [
    "const normalizeWorkspaceFingerprint = (raw) => {",
    "  const record = raw && typeof raw === 'object' ? raw : {}",
    "  const output = typeof record.output === 'string' ? record.output : ''",
    "  const lines = output.split(/\\r?\\n/).map((l) => l.trim())",
    "  const nonBlank = lines.filter((l) => l.length > 0)",
    "  if (nonBlank.length === 0) return null",
    "  const first = nonBlank[0]",
    "  if (!/^[0-9a-f]{40}$/.test(first)) return null",
    "  // Porcelain status rows keep their leading-space XY column (staged vs worktree-modified).",
    "  const rawLines = output.split(/\\r?\\n/)",
    "  const firstRaw = rawLines.findIndex((l) => l.trim().length > 0)",
    "  const statusRows = rawLines.slice(firstRaw + 1).filter((l) => l.trim().length > 0)",
    "  return { treeHash: first, gitStatus: statusRows.sort() }",
    "}",
    "const workspaceFingerprintKey = (fp) => {",
    "  if (!fp) return null",
    "  return provenanceContentId({ source: 'workspace-fingerprint', treeHash: fp.treeHash, gitStatus: fp.gitStatus })",
    "}",
  ].join("\n");
}

/** Bounds the per-requirement evidence fan-out (token economy: one agent per requirement). */
export const SPEC_CONFORMANCE_NUMERIC_ARGS: readonly NumericArgSpec[] = [
  { name: "maxRequirements", default: 12, min: 1, max: 30, integer: true },
];

/** One mechanical evidence entry for a requirement (fabric-spec acceptance ledger). */
export interface ConformanceEvidence {
  kind: "symbol" | "registration" | "behavior" | "probe";
  target: string;
  detail: string;
  probeCommand?: string;
  probeExitCode?: number;
  probeOutput?: string;
}

/** The normalized spec projection the audit operates on. */
export interface ConformanceSpec {
  goal: string;
  requirements: Array<{ id: string; statement: string }>;
}

const EVIDENCE_KINDS = new Set(["symbol", "registration", "behavior", "probe"]);

/**
 * Defensive normalization of raw evidence into the mechanical-evidence
 * contract. Guarantees: only the four kinds survive, every entry has a
 * non-empty target, duplicates (same kind + target) are dropped first-wins,
 * and probe capture fields are kept only when they are well-typed. A raw
 * non-array degrades to [] — a requirement with no mechanical evidence scores
 * missing (never a fabricated entry).
 */
export function normalizeConformanceEvidence(raw: unknown): ConformanceEvidence[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ConformanceEvidence[] = [];
  for (const entry of raw) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const kind =
      typeof record.kind === "string" && EVIDENCE_KINDS.has(record.kind as ConformanceEvidence["kind"])
        ? (record.kind as ConformanceEvidence["kind"])
        : null;
    const target = typeof record.target === "string" && record.target.trim() ? record.target.trim() : null;
    if (!kind || !target) continue;
    const key = `${kind}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const probeExitCode =
      typeof record.probeExitCode === "number" && Number.isFinite(record.probeExitCode)
        ? record.probeExitCode
        : undefined;
    const probeOutput =
      typeof record.probeOutput === "string" && record.probeOutput.length > 2000
        ? `${record.probeOutput.slice(0, 2000)}…`
        : typeof record.probeOutput === "string"
          ? record.probeOutput
          : undefined;
    out.push({
      kind,
      target,
      detail: typeof record.detail === "string" ? record.detail : "",
      ...(typeof record.probeCommand === "string" ? { probeCommand: record.probeCommand } : {}),
      ...(probeExitCode !== undefined ? { probeExitCode } : {}),
      ...(probeOutput !== undefined ? { probeOutput } : {}),
    });
  }
  return out;
}

/**
 * Map a parallel() evidence batch back onto requirements by position. Every
 * result slot corresponds to the requirement at the same index (the fan-out is
 * built by mapping over requirements), so a null result (recoverable agent
 * failure) degrades only its own requirement to zero evidence — never shifts
 * another requirement's evidence onto the wrong requirement.
 */
export function normalizeEvidenceResults(
  results: readonly unknown[],
  requirements: readonly { id: string }[],
): Record<string, ConformanceEvidence[]> {
  const byId: Record<string, ConformanceEvidence[]> = {};
  results.forEach((out, i) => {
    const requirement = requirements[i];
    if (!requirement) return;
    // The evidence agent returns { requirementId, evidence: [...] } — the
    // evidence ARRAY is the mechanical-evidence contract input.
    const record = out && typeof out === "object" ? (out as Record<string, unknown>) : {};
    byId[requirement.id] = normalizeConformanceEvidence(record.evidence);
  });
  return byId;
}

/**
 * Lenient spec extraction for the audit: accepts a raw artifact
 * ({ goal, requirements: [{id, statement}] }), a spec-generation RUN RESULT
 * ({ spec: {...}, artifact, ... } — the .spec field is unwrapped), or any
 * object shape normalizeSpecArtifact understands. Requirements always come
 * back with deterministic unique ids (REQ-N reassignment, input order).
 */
export function normalizeConformanceSpec(raw: unknown): ConformanceSpec {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const artifactRaw = record.spec !== undefined ? record.spec : raw;
  const artifact = normalizeSpecArtifact(artifactRaw);
  return { goal: artifact.goal, requirements: artifact.requirements };
}

/**
 * Emit the vm-embeddable equivalents of normalizeConformanceSpec (built on the
 * embedded normalizeSpecArtifact copy) and normalizeEvidenceResults for the
 * generated script (which runs in a vm and cannot import this module). Kept
 * textually in sync with the TS references — the parity test executes BOTH
 * copies against the same fixtures and asserts identical outcomes.
 */
export function conformanceNormalizersSource(): string {
  return [
    "// normalizeSpecArtifact mirrors src/spec-generation.ts (the unit-tested",
    "// reference); a parity test keeps the two copies behaviorally identical.",
    normalizeSpecArtifactSource(),
    // V2-N5: the deterministic content-derived id used for machine-gate ledger
    // records — identical algorithm to the host settle sites (durable-store.ts).
    provenanceContentIdSource(),
    "const computeProvenanceId = provenanceContentId",
    // V2-N2: the workspace-fingerprint normalizer + key (N01 contract, vm copy).
    workspaceFingerprintSource(),
    "const normalizeConformanceSpec = (raw) => {",
    "  const record = raw && typeof raw === 'object' ? raw : {}",
    "  const artifactRaw = record.spec !== undefined ? record.spec : raw",
    "  const artifact = normalizeSpecArtifact(artifactRaw)",
    "  return { goal: artifact.goal, requirements: artifact.requirements }",
    "}",
    "const EVIDENCE_KINDS = ['symbol', 'registration', 'behavior', 'probe']",
    "const normalizeConformanceEvidence = (raw) => {",
    "  if (!Array.isArray(raw)) return []",
    "  const seen = new Set()",
    "  const out = []",
    "  for (const entry of raw) {",
    "    const record = entry && typeof entry === 'object' ? entry : {}",
    "    const kind = (typeof record.kind === 'string' && EVIDENCE_KINDS.indexOf(record.kind) !== -1) ? record.kind : null",
    "    const target = (typeof record.target === 'string' && record.target.trim()) ? record.target.trim() : null",
    "    if (!kind || !target) continue",
    "    const key = kind + ':' + target",
    "    if (seen.has(key)) continue",
    "    seen.add(key)",
    "    const probeExitCode = (typeof record.probeExitCode === 'number' && Number.isFinite(record.probeExitCode)) ? record.probeExitCode : undefined",
    "    const probeOutput = typeof record.probeOutput === 'string' ? (record.probeOutput.length > 2000 ? record.probeOutput.slice(0, 2000) + '…' : record.probeOutput) : undefined",
    "    const entryOut = { kind: kind, target: target, detail: typeof record.detail === 'string' ? record.detail : '' }",
    "    if (typeof record.probeCommand === 'string') entryOut.probeCommand = record.probeCommand",
    "    if (probeExitCode !== undefined) entryOut.probeExitCode = probeExitCode",
    "    if (probeOutput !== undefined) entryOut.probeOutput = probeOutput",
    "    out.push(entryOut)",
    "  }",
    "  return out",
    "}",
    "const normalizeEvidenceResults = (results, reqs) => {",
    "  const byId = {}",
    "  results.forEach((out, i) => {",
    "    const requirement = reqs[i]",
    "    if (!requirement) return",
    "    const record = out && typeof out === 'object' ? out : {}",
    "    byId[requirement.id] = normalizeConformanceEvidence(record.evidence)",
    "  })",
    "  return byId",
    "}",
  ].join("\n");
}

/**
 * T2-05: per-phase model-tier knobs for the generated spec-conformance script.
 * Defaults: evidence = medium (symbol/probe work), auditor = medium, report =
 * small (renders machine-computed statuses). Baked at generation time.
 */
export interface SpecConformanceTierOptions {
  tierEvidence?: string;
  tierAudit?: string;
  tierReport?: string;
}

/** Documentation-only config shape; the generated script reads these from `args` at runtime. */
export interface SpecConformanceConfig {
  /** Spec artifact (or spec-generation run result) to audit against. */
  spec: unknown;
  /** Workspace sub-path the evidence agents audit (default "."). */
  workspace?: string;
  /** Caps how many requirements get an evidence agent. */
  maxRequirements?: number;
}

/**
 * Generate the spec-conformance workflow script. The script is static and
 * reads its inputs from `args` (spec/workspace/maxRequirements), so nothing
 * caller-supplied is ever string-interpolated into source. The normalizers are
 * embedded via conformanceNormalizersSource() (see module doc).
 */
export function generateSpecConformanceWorkflow(options: SpecConformanceTierOptions = {}): string {
  const tierEvidence = JSON.stringify(options.tierEvidence ?? "medium");
  const tierAudit = JSON.stringify(options.tierAudit ?? "medium");
  const tierReport = JSON.stringify(options.tierReport ?? "small");
  return `export const meta = {
  name: 'spec_conformance',
  description: 'Audit an implementation workspace against a spec: per-requirement mechanical evidence, missing/extra detection, scored conformance report',
  phases: [
    { title: 'Requirements' },
    { title: 'Evidence' },
    { title: 'Audit' },
    { title: 'Report' },
  ],
}

// maxRequirements comes from the shared builtin-args coercion (baked below).
${numericArgCoercionSource(SPEC_CONFORMANCE_NUMERIC_ARGS)}
${conformanceNormalizersSource()}

const rawSpec = (args && args.spec) || null
const workspace = (args && args.workspace) || '.'
// A JSON string (e.g. a saved spec-generation artifact) parses into the same
// object shape; a parse failure degrades to an explicit error result, never a
// silent empty audit.
let parsedSpec = null
if (typeof rawSpec === 'string') {
  try { parsedSpec = JSON.parse(rawSpec) } catch (e) { parsedSpec = null }
} else {
  parsedSpec = rawSpec
}
const spec = normalizeConformanceSpec(parsedSpec)
if (spec.requirements.length === 0) {
  return { spec: { goal: '', requirementCount: 0 }, perRequirement: [], covered: 0, total: 0, score: 0, missing: [], extras: [], report: null, error: 'spec must contain at least one requirement (requirements with unique ids)' }
}
// Token economy: the evidence fan-out is capped at maxRequirements (one agent
// per requirement); the cap is logged, never silent (i5 pattern).
const requirements = spec.requirements.slice(0, maxRequirements)
if (spec.requirements.length > maxRequirements) {
  log('Spec conformance: the spec has ' + spec.requirements.length + ' requirements; auditing the first ' + maxRequirements + ' (' + (spec.requirements.length - maxRequirements) + ' are not audited).')
}
// T2-07: the full spec registers into the run's shared context ONCE; evidence
// agents get their own requirement inline + the pointer for the full spec.
const specCtx = ctx(JSON.stringify(spec))

// Deterministic prompt-embedding cap (T1-03 pattern): pure function of the
// input, so the same evidence always yields the same prompt (resume-stable).
const cap = (value, maxChars) => {
  const text = value === null || value === undefined ? '(none)' : (typeof value === 'string' ? value : JSON.stringify(value))
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

// V2-N2: capture the workspace fingerprint ONCE at audit start (a bash-captured
// agent step relays 'git rev-parse HEAD^{tree}' + 'git status --porcelain -uall'
// verbatim; normalizeWorkspaceFingerprint is a MACHINE decision — the first
// line must be a 40-hex tree hash). Non-git / unavailable workspaces degrade
// to null and the trend ledger is skipped (logged), never fabricated. The step
// is a normal journaled agent() call, so a resumed run replays it.
const fingerprintStep = await agent(
  'Run the following shell commands with the bash tool and report their REAL exit status and FULL standard output verbatim (do not summarize, do not truncate, do not invent output).\\n\\nCommands:\\n1. git rev-parse HEAD^{tree}\\n2. git status --porcelain -uall',
  { label: 'workspace fingerprint', tier: 'small', toolNames: ['bash'], schema: { type: 'object', properties: { exitCode: { type: 'number' }, output: { type: 'string' } }, required: ['output'] } }
)
const workspaceFp = normalizeWorkspaceFingerprint(fingerprintStep)
const fingerprintKey = workspaceFingerprintKey(workspaceFp)
if (!fingerprintKey) {
  log('Spec conformance: the workspace is not fingerprint-able (not a git repo, or git unavailable); the conformance-trend ledger is skipped.')
}

const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    requirementId: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['symbol', 'registration', 'behavior', 'probe'] },
          target: { type: 'string' },
          detail: { type: 'string' },
          probeCommand: { type: 'string' },
          probeExitCode: { type: 'number' },
          probeOutput: { type: 'string' },
        },
        required: ['kind', 'target', 'detail'],
      },
    },
  },
  required: ['requirementId', 'evidence'],
}
const EXTRAS_SCHEMA = {
  type: 'object',
  properties: {
    extras: {
      type: 'array',
      items: {
        type: 'object',
        properties: { what: { type: 'string' }, reason: { type: 'string' } },
        required: ['what', 'reason'],
      },
    },
  },
  required: ['extras'],
}

phase('Evidence')
// One evidence agent per requirement (parallel, P12 autoApproved): each returns
// MECHANICAL evidence only — named symbols (grep + file:line), registrations,
// or probed behavior (bash + real exit code/output). normalizeEvidenceResults
// enforces the contract deterministically; a requirement with zero surviving
// evidence is scored missing.
const evidenceResults = await parallel(requirements.map((req, i) => () =>
  agent(
    'You are a conformance evidence auditor. For the requirement below, find MECHANICAL evidence in the workspace that it is implemented. ' +
    'Mechanical evidence means: named symbols that exist (grep for the symbol and report the matching file:line), registrations (config entries, routes, DI bindings), ' +
    'or probed behavior (run a command with bash and report its real exit code + output). Use the read/grep/find/bash tools. ' +
    'Return every piece of evidence you actually observed — NEVER invent symbols, registrations, or probe output. ' +
    'If you find no mechanical evidence, return an empty evidence array (the requirement is then scored missing).' +
    '\\n\\nWORKSPACE: ' + workspace +
    '\\nREQUIREMENT: ' + JSON.stringify(req) +
    '\\nFULL SPEC (call store_get on the pointer if referenced): ' + specCtx,
    { label: 'evidence ' + (i + 1), tier: ${tierEvidence}, schema: EVIDENCE_SCHEMA }
  )
), { autoApproved: true })
const evidenceByReq = normalizeEvidenceResults(evidenceResults, requirements)

phase('Audit')
// Missing is a MACHINE decision: a requirement with zero mechanical evidence is
// missing, period. Extras (implemented-but-not-required behaviors) need the
// auditor's review of the implementation surface against the spec.
const missing = requirements.filter((req) => (evidenceByReq[req.id] || []).length === 0).map((req) => req.id)
const audit = await agent(
  'You are a spec-conformance auditor. The spec below lists requirements; the evidence ledger shows the mechanical evidence found for each requirement in the workspace. ' +
  'Identify EXTRAS: behaviors or features implemented in the workspace that are NOT required by the spec (scope creep), each with a one-line reason grounded in the workspace. ' +
  'Do NOT list unimplemented requirements (those are MISSING and already tracked). Return extras only when you have concrete mechanical basis.' +
  '\\n\\nWORKSPACE: ' + workspace +
  '\\nSPEC: ' + specCtx +
  '\\nEVIDENCE LEDGER: ' + cap(evidenceByReq, 4000),
  { label: 'auditor', tier: ${tierAudit}, schema: EXTRAS_SCHEMA }
)
const extras = (audit && Array.isArray(audit.extras))
  ? audit.extras.filter((e) => e && typeof e.what === 'string' && e.what.trim().length > 0)
  : []

phase('Report')
// The score is MACHINE-computed from the mechanical evidence ledger — the
// report writer renders it, never changes it.
const perRequirement = requirements.map((req) => ({
  id: req.id,
  statement: req.statement,
  status: (evidenceByReq[req.id] || []).length > 0 ? 'covered' : 'missing',
  evidence: evidenceByReq[req.id] || [],
}))
const covered = perRequirement.filter((r) => r.status === 'covered').length
const score = requirements.length > 0 ? Math.round((covered / requirements.length) * 100) : 0
// V2-N5: record each requirement's machine verdict into the run's provenance
// ledger (content-derived ids — same requirement + same verdict dedupes on
// replay; a changed verdict produces a distinct entry). The score payload
// rides in the detail field for lineage queries. Best-effort: a ledger write
// must never fail the audit.
for (const pr of perRequirement) {
  try {
    await durableStore.record({
      id: computeProvenanceId({ source: 'spec-conformance', req: pr.id, phase: 'Report', status: pr.status, evidenceCount: (pr.evidence || []).length }),
      source: 'spec-conformance',
      file: pr.id,
      phase: 'Report',
      detail: { status: pr.status, score, covered, total: requirements.length, evidenceCount: (pr.evidence || []).length },
    })
  } catch (e) {
    log('spec-conformance: provenance record failed (audit continues): ' + String(e))
  }
}
// V2-N2: conformance-trend ledger — fingerprint-keyed scores with a delta vs
// the last audit of the SAME fingerprint (read-only compare over the durable
// provenance ledger's DETERMINISTIC timestamps; this run's own record is
// excluded by its content-derived id). The trend record is durableStore state
// — putOnce + record dedupe make replay idempotent — NEVER resume identity.
let trend = null
if (fingerprintKey) {
  const runId = (typeof steerPlan !== 'undefined' && steerPlan && typeof steerPlan.read === 'function') ? steerPlan.read().runId : null
  if (runId) {
    const trendId = computeProvenanceId({ source: 'spec-conformance-trend', runId, fingerprint: fingerprintKey, score, covered, total: requirements.length })
    let priorEntries = []
    try {
      priorEntries = (typeof durableStore.ledgerEntries === 'function' ? durableStore.ledgerEntries() : [])
        .filter((e) => e && e.source === 'spec-conformance-trend' && e.file === fingerprintKey && e.id !== trendId)
    } catch (e) {
      priorEntries = []
    }
    priorEntries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    const prior = priorEntries.length > 0 ? priorEntries[priorEntries.length - 1] : null
    const priorDetail = (prior && prior.detail && typeof prior.detail === 'object') ? prior.detail : null
    const priorScore = (priorDetail && typeof priorDetail.score === 'number') ? priorDetail.score : null
    const scoreDelta = priorScore === null ? null : score - priorScore
    const priorStatusOf = (reqId) => {
      if (!priorDetail || !Array.isArray(priorDetail.perRequirement)) return null
      const row = priorDetail.perRequirement.find((p) => p && p.id === reqId)
      return row && typeof row.status === 'string' ? row.status : null
    }
    const regression = perRequirement.filter((r) => r.status === 'missing' && priorStatusOf(r.id) === 'covered').map((r) => r.id)
    const improvement = perRequirement.filter((r) => r.status === 'covered' && priorStatusOf(r.id) === 'missing').map((r) => r.id)
    const trendRecord = {
      fingerprint: fingerprintKey,
      runId,
      score,
      covered,
      total: requirements.length,
      priorScore,
      scoreDelta,
      regression,
      improvement,
      perRequirement: perRequirement.map((r) => ({ id: r.id, status: r.status })),
    }
    try {
      await durableStore.record({ id: trendId, source: 'spec-conformance-trend', file: fingerprintKey, phase: 'Report', detail: trendRecord })
      await durableStore.putOnce('conformanceTrend:' + runId, 'conformanceTrend:' + runId, trendRecord)
    } catch (e) {
      log('spec-conformance: trend ledger write failed (audit continues): ' + String(e))
    }
    trend = trendRecord
    if (priorScore !== null) {
      log('Spec conformance trend: score ' + score + '% vs prior ' + priorScore + '% on the same workspace fingerprint' + (scoreDelta !== null ? ' (delta ' + (scoreDelta >= 0 ? '+' : '') + scoreDelta + ')' : '') + (regression.length > 0 ? '; REGRESSIONS: ' + regression.join(', ') : '') + (improvement.length > 0 ? '; improvements: ' + improvement.join(', ') : ''))
    } else {
      log('Spec conformance trend: first audit recorded for this workspace fingerprint (score ' + score + '%).')
    }
  } else {
    log('Spec conformance: no run identity available; the conformance-trend ledger is skipped.')
  }
}
const report = await agent(
  'You are a spec-conformance report writer. Write a concise conformance report for this spec audit: per-requirement status (covered/missing), the mechanical evidence for each covered requirement, ' +
  'the missing list, the extras list, and the overall conformance score. Be factual — the score and statuses below are machine-computed from the evidence ledger; do not change them.' +
  '\\n\\nSCORE: ' + score + '% (' + covered + '/' + requirements.length + ' requirements covered)' +
  '\\nPER-REQUIREMENT: ' + cap(perRequirement, 5000) +
  '\\nMISSING: ' + JSON.stringify(missing) +
  '\\nEXTRAS: ' + JSON.stringify(extras),
  { label: 'report writer', tier: ${tierReport} }
)

return { spec: { goal: spec.goal, requirementCount: requirements.length }, perRequirement, covered, total: requirements.length, score, missing, extras, report, trend }`;
}
