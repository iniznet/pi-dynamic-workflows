/**
 * Impact-scoped work partitioning (built-in feature P08).
 *
 * codebase-audit and code-review gain an impact-analysis phase: ONE agent
 * (with the captured codegraph callers/callees defs — P04 toolset wiring —
 * plus read/grep/find) maps the change's impact radius and test scope, and
 * emits the parallel work partition. The fan-out that follows embeds the
 * partition in every worker prompt (impactScopeBlock), so each worker's
 * investigation is scoped by the impact analysis instead of re-deriving it.
 *
 * `injectImpactScopePhase` applies this phase to an EXISTING generated script
 * with a deterministic text transform (marker-validated, fail-loud on drift):
 *  1. prepend { title: 'Impact Analysis' } to the declared meta phases;
 *  2. insert the impact phase source before the body's first phase() call;
 *  3. apply the caller's fan-out prompt seams (ALL occurrences) so every
 *     worker prompt embeds the partition block;
 *  4. rewrite the return statement so the run result exposes the partition.
 *
 * The generated scripts run inside a vm and cannot import this module, so the
 * partition normalizer is ALSO emitted as a vm-embeddable JS source string
 * (normalizeImpactPartitionSource) — parity-tested against the TS reference.
 */

import { CODE_REVIEW_ANGLES } from "./code-review.js";

/** Cap on partition slices; more slices are dropped (deterministically, in input order). */
export const IMPACT_MAX_SLICES = 8;
/** Cap on scopedFiles/testScope entries per slice. */
export const IMPACT_MAX_FILES_PER_SLICE = 16;

/** One parallel work slice of the partition. */
export interface ImpactScopeSlice {
  /** Stable slice id, unique within the partition. */
  name: string;
  /** What this slice covers. */
  focus: string;
  /** Impact-radius files the slice should examine (deduped, capped). */
  scopedFiles: string[];
  /** Tests that cover this slice (deduped, capped). */
  testScope: string[];
}

/** The partition contract the impact-analysis agent emits. */
export interface ImpactPartition {
  slices: ImpactScopeSlice[];
}

function dedupeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) continue;
    const key = item.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Defensive normalization of raw impact-agent output into the partition
 * contract. Guarantees: every slice has a non-empty unique name and focus,
 * scopedFiles/testScope are deduped non-empty strings (capped), and the
 * partition is capped at IMPACT_MAX_SLICES. A malformed entry is dropped; a
 * non-array degrades to an empty partition (the fan-out then proceeds
 * unscoped, logged). Deterministic for a given input — resume's journal
 * replay requires it.
 */
export function normalizeImpactPartition(raw: unknown): ImpactPartition {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // The raw impact-agent output is { summary, partition: { slices } }; the
  // generated script passes impact.partition, but the normalizer also accepts
  // the unwrapped { slices } shape — lenient, deterministic either way.
  const nested =
    record.partition && typeof record.partition === "object" ? (record.partition as Record<string, unknown>) : null;
  const rawSlices = Array.isArray(record.slices)
    ? record.slices
    : nested && Array.isArray(nested.slices)
      ? nested.slices
      : [];
  const slices: ImpactScopeSlice[] = [];
  for (const rawSlice of rawSlices) {
    if (slices.length >= IMPACT_MAX_SLICES) break;
    const slice = rawSlice && typeof rawSlice === "object" ? (rawSlice as Record<string, unknown>) : {};
    const name = typeof slice.name === "string" ? slice.name.trim() : "";
    const focus = typeof slice.focus === "string" ? slice.focus.trim() : "";
    if (!name || !focus) continue;
    if (slices.some((existing) => existing.name === name)) continue;
    slices.push({
      name,
      focus,
      scopedFiles: dedupeStrings(slice.scopedFiles).slice(0, IMPACT_MAX_FILES_PER_SLICE),
      testScope: dedupeStrings(slice.testScope).slice(0, IMPACT_MAX_FILES_PER_SLICE),
    });
  }
  return { slices };
}

/**
 * Emit the vm-embeddable equivalent of normalizeImpactPartition for the
 * generated scripts (which run in a vm and cannot import this module). Kept
 * textually in sync with the TS reference — the parity test in
 * tests/slices/workflows/ executes BOTH copies against the same fixtures and
 * asserts identical outcomes, so a drift fails loudly instead of silently.
 */
export function normalizeImpactPartitionSource(): string {
  return [
    "const normalizeImpactPartition = (raw) => {",
    "  const record = raw && typeof raw === 'object' ? raw : {}",
    "  const nested = record.partition && typeof record.partition === 'object' ? record.partition : null",
    "  const rawSlices = Array.isArray(record.slices) ? record.slices : (nested && Array.isArray(nested.slices) ? nested.slices : [])",
    "  const slices = []",
    `  const MAX_SLICES = ${IMPACT_MAX_SLICES}`,
    `  const MAX_FILES = ${IMPACT_MAX_FILES_PER_SLICE}`,
    "  const dedupe = (value) => {",
    "    if (!Array.isArray(value)) return []",
    "    const seen = new Set()",
    "    const out = []",
    "    for (const item of value) {",
    "      if (typeof item !== 'string' || !item.trim()) continue",
    "      const key = item.trim()",
    "      if (seen.has(key)) continue",
    "      seen.add(key)",
    "      out.push(key)",
    "    }",
    "    return out",
    "  }",
    "  for (const rawSlice of rawSlices) {",
    "    if (slices.length >= MAX_SLICES) break",
    "    const s = rawSlice && typeof rawSlice === 'object' ? rawSlice : {}",
    "    const name = typeof s.name === 'string' ? s.name.trim() : ''",
    "    const focus = typeof s.focus === 'string' ? s.focus.trim() : ''",
    "    if (!name || !focus) continue",
    "    if (slices.some((existing) => existing.name === name)) continue",
    "    slices.push({ name: name, focus: focus, scopedFiles: dedupe(s.scopedFiles).slice(0, MAX_FILES), testScope: dedupe(s.testScope).slice(0, MAX_FILES) })",
    "  }",
    "  return { slices: slices }",
    "}",
  ].join("\n");
}

/** T2-05: the impact-analysis agent's tier knob (default medium). */
export interface ImpactAnalysisTierOptions {
  tierImpact?: string;
}

/**
 * Emit the vm-embeddable impact-analysis phase source: `phase('Impact
 * Analysis')` + ONE agent call (schema IMPACT_SCHEMA, target baked at
 * generation time via JSON.stringify — never caller-interpolated) + the
 * deterministic partition normalization + the capped `impactScopeBlock()`
 * renderer every fan-out worker prompt appends. The source is self-contained:
 * it defines its own schema and normalizer, so the same fragment can be
 * injected into any generated script.
 */
export function generateImpactAnalysisPhaseSource(options: { target: string; tierImpact?: string }): string {
  const target = JSON.stringify(options.target);
  const tierImpact = JSON.stringify(options.tierImpact ?? "medium");
  return [
    "phase('Impact Analysis')",
    "// Impact analysis (P08): ONE agent with the captured codegraph callers/callees",
    "// defs (P04 toolset wiring) + read/grep/find maps the change's impact radius and",
    "// test scope, then emits the parallel work partition. normalizeImpactPartition",
    "// enforces the contract deterministically — never an LLM verdict alone.",
    "const IMPACT_SCHEMA = {",
    "  type: 'object',",
    "  properties: {",
    "    summary: { type: 'string' },",
    "    partition: {",
    "      type: 'object',",
    "      properties: {",
    "        slices: {",
    "          type: 'array',",
    "          items: {",
    "            type: 'object',",
    "            properties: {",
    "              name: { type: 'string' },",
    "              focus: { type: 'string' },",
    "              scopedFiles: { type: 'array', items: { type: 'string' } },",
    "              testScope: { type: 'array', items: { type: 'string' } },",
    "            },",
    "            required: ['name', 'focus'],",
    "          },",
    "        },",
    "      },",
    "      required: ['slices'],",
    "    },",
    "  },",
    "  required: ['summary', 'partition'],",
    "}",
    normalizeImpactPartitionSource(),
    "const impact = await agent(",
    `  'You are an impact-analysis planner. ' + ${target} +`,
    "  'Use the codegraph_callers/codegraph_callees tools when available to trace the impact radius of the change (callers and callees of every touched symbol), ' +",
    "  'and read/grep/find to map the test scope (the tests that exercise the affected symbols). ' +",
    "  'Emit a partition of the work: slices that can proceed in parallel, each with a name, a focus (what the slice covers), ' +",
    "  'scopedFiles (the impact-radius files the slice should examine), and testScope (the tests covering the slice). ' +",
    "  'Keep slices coarse (2-6) and every file/test list concrete and grounded in what you observed.'",
    `  , { label: 'impact analysis', tier: ${tierImpact}, schema: IMPACT_SCHEMA }`,
    ")",
    "const impactPartition = normalizeImpactPartition(impact && impact.partition)",
    "if (impactPartition.slices.length === 0) {",
    "  log('Impact analysis: the planner emitted no partition slices; the fan-out proceeds unscoped (degraded).')",
    "}",
    "// Capped, deterministic renderer every fan-out worker prompt appends — pure",
    "// function of the normalized partition, so resume hashes stay stable.",
    "const impactScopeBlock = () => {",
    "  if (impactPartition.slices.length === 0) return ''",
    "  const capEntry = (s) => typeof s === 'string' && s.length > 160 ? s.slice(0, 157) + '…' : s",
    "  const lines = []",
    "  let budget = 2000",
    "  for (const s of impactPartition.slices) {",
    "    if (budget <= 0) break",
    "    const files = (s.scopedFiles && s.scopedFiles.length) ? ' files=[' + s.scopedFiles.map(capEntry).join(',') + ']' : ''",
    "    const tests = (s.testScope && s.testScope.length) ? ' tests=[' + s.testScope.map(capEntry).join(',') + ']' : ''",
    "    const line = '- ' + s.name + ': ' + capEntry(s.focus) + files + tests",
    "    if (line.length > budget) { if (lines.length === 0) lines.push(line.slice(0, 2000) + '…'); break }",
    "    lines.push(line)",
    "    budget -= line.length",
    "  }",
    "  return '\\n<impact-partition>\\n' + lines.join('\\n') + '\\n</impact-partition>\\n'",
    "}",
  ].join("\n");
}

/** One [marker, replacement] pair applied to the generated script. */
export type ImpactScopeSeam = readonly [marker: string, replacement: string];

/** Inputs to {@link injectImpactScopePhase}. */
export interface ImpactScopeInjection {
  /** The generated base script to wrap (must declare meta.phases + a phase() call). */
  baseScript: string;
  /** Impact-agent prompt target, baked into the phase source at generation time. */
  target: string;
  /** Fan-out prompt seams: every occurrence of `marker` becomes `replacement`. */
  promptSeams: ReadonlyArray<ImpactScopeSeam>;
  /** Return-statement seam: `marker` becomes `replacement` (exposes the partition). */
  returnSeam: ImpactScopeSeam;
  tierImpact?: string;
}

/**
 * Apply the impact-analysis phase to a generated script (P08). The transform
 * is deterministic and marker-validated: a missing meta.phases / phase() call /
 * prompt seam / return seam throws a descriptive Error (surfaced by the
 * registry resolve as a warning) instead of silently producing a broken
 * script, so a generator drift fails loudly. See the module doc for the four
 * steps.
 */
export function injectImpactScopePhase(injection: ImpactScopeInjection): string {
  const { baseScript, target, promptSeams, returnSeam, tierImpact } = injection;
  const META_MARKER = "phases: [";
  if (!baseScript.includes(META_MARKER)) {
    throw new Error("impact-scope: baseScript must declare meta.phases (marker not found)");
  }
  if (!baseScript.includes("phase('")) {
    throw new Error("impact-scope: baseScript must contain a phase('...') body call (marker not found)");
  }
  for (const [marker] of promptSeams) {
    if (!baseScript.includes(marker)) {
      throw new Error(`impact-scope: fan-out prompt seam not found in baseScript: ${marker}`);
    }
  }
  if (!baseScript.includes(returnSeam[0])) {
    throw new Error(`impact-scope: return seam not found in baseScript: ${returnSeam[0]}`);
  }

  let script = baseScript;
  // 1. Prepend the Impact Analysis phase to the declared meta phases.
  script = script.replace(META_MARKER, `${META_MARKER}\n    { title: 'Impact Analysis' },`);
  // 2. Insert the self-contained impact phase source before the body's first
  // phase() call (the meta block contains `phases:` but no `phase('`, so the
  // first occurrence is the body's first declared phase).
  const phaseCall = script.indexOf("phase('");
  const phaseSource = `${generateImpactAnalysisPhaseSource({ target, tierImpact })}\n`;
  script = `${script.slice(0, phaseCall)}${phaseSource}${script.slice(phaseCall)}`;
  // 3. Apply every fan-out prompt seam to ALL occurrences.
  for (const [marker, replacement] of promptSeams) {
    while (script.includes(marker)) script = script.replace(marker, replacement);
  }
  // 4. Expose the partition in the run result.
  const replaced = script.replace(returnSeam[0], returnSeam[1]);
  if (replaced === script) {
    throw new Error(`impact-scope: return seam replacement was a no-op: ${returnSeam[0]}`);
  }
  return replaced;
}

/**
 * The 8 code-review finder prompt seams: each finder prompt tail is
 * `... + base + shardBlock('<angle>'),` and gains the impact block:
 * `... + base + shardBlock('<angle>') + impactScopeBlock(),`.
 */
export function codeReviewImpactSeams(): ReadonlyArray<ImpactScopeSeam> {
  return CODE_REVIEW_ANGLES.map(
    (angle) => [`+ base + shardBlock('${angle}'),`, `+ base + shardBlock('${angle}') + impactScopeBlock(),`] as const,
  );
}

/** code-review's return statement seam: expose the partition in the run result. */
export const CODE_REVIEW_RETURN_SEAM: ImpactScopeSeam = [
  "return { total: allCandidates.length, verified: pool.length, surviving: surviving.length, findings: top, report: synthesis, diffTruncated }",
  "return { total: allCandidates.length, verified: pool.length, surviving: surviving.length, findings: top, report: synthesis, diffTruncated, impactPartition }",
];

/** codebase-audit's fan-out prompt seam (every check agent prompt gains the block). */
export const CODEBASE_AUDIT_PROMPT_SEAM: ImpactScopeSeam = [
  "+ scope, { label: ",
  "+ scope + impactScopeBlock(), { label: ",
];

/** codebase-audit's return statement seam: expose the partition in the run result. */
export const CODEBASE_AUDIT_RETURN_SEAM: ImpactScopeSeam = [
  "return { findings, validated, report };",
  "return { findings, validated, report, impactPartition };",
];
