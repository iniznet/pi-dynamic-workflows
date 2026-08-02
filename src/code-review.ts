/**
 * Multi-angle parallel code review workflow.
 * 8 specialized finder agents (correctness, removed-behavior, call-site, reuse,
 * simplification, efficiency, altitude, security) → per-angle verify pass →
 * severity-ranked report.
 */

import { CODE_REVIEW_NUMERIC_ARGS, numericArgCoercionSource } from "./builtin-args.js";

/**
 * Hard cap on diff characters fed into the review. This bounds worst-case
 * prompt size across 8 parallel finders + a per-candidate verify pass, even
 * when the diff-source exec step (see builtin-commands.ts) already raised its
 * own maxBuffer and successfully read a very large diff. Oversized diffs are
 * truncated rather than rejected — findings in the untruncated prefix still
 * have value — and the truncation is surfaced to the user, not silent.
 */
export const MAX_DIFF_CHARS = 200_000;

/**
 * The eight review finder angles, ordered by report priority (security first,
 * then correctness, cleanup, altitude). `diffShard` deals segments of the diff
 * out to angles in this order (H7).
 */
export const CODE_REVIEW_ANGLES = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

export type CodeReviewAngle = (typeof CODE_REVIEW_ANGLES)[number];

/**
 * Split a unified diff into self-contained review segments. A segment is a
 * file header (`diff --git`/`index`/`---`/`+++` lines) followed by exactly one
 * hunk (`@@` line plus body), or the diff preamble before the first file.
 * Every hunk appears in exactly one segment; a multi-hunk file yields one
 * segment per hunk, so even a single-file diff can be sharded across angles.
 */
export function splitDiffSegments(diff: string): string[] {
  const lines = diff.split("\n");
  const segments: string[] = [];
  let fileHeader: string[] = [];
  let current: string[] = [];
  let headerOpen = false;

  const flush = (): void => {
    if (current.join("").length > 0) {
      segments.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    if (/^diff\s+/.test(line)) {
      // New file block: the previous segment is complete; a fresh header starts.
      flush();
      headerOpen = true;
      fileHeader = [line];
      current = [line];
    } else if (headerOpen && /^@@\s/.test(line)) {
      // First hunk of this file: header and hunk share one segment.
      headerOpen = false;
      current.push(line);
    } else if (headerOpen) {
      // Header continuation (index/---/+++ lines) or preamble before the first file.
      fileHeader.push(line);
      current.push(line);
    } else if (/^@@\s/.test(line)) {
      // A later hunk of the current file: start a new self-contained segment
      // that repeats the file header so a finder can judge the hunk alone.
      flush();
      current = [...fileHeader, line];
    } else {
      // Hunk body (context/added/removed lines).
      current.push(line);
    }
  }
  flush();
  return segments;
}

/**
 * Return the slice of `diff` assigned to `angle` (H7). Segments are dealt out
 * round-robin across the angles, so each angle sees a disjoint slice and the
 * union of all angles' slices covers every hunk of the diff. Repeated file
 * headers within one shard are collapsed to their first occurrence so a
 * multi-hunk file does not bloat its shard.
 */
export function diffShard(diff: string, angle: CodeReviewAngle): string {
  const angleIndex = CODE_REVIEW_ANGLES.indexOf(angle);
  if (angleIndex < 0) return diff;
  const picked = splitDiffSegments(diff).filter((_, i) => i % CODE_REVIEW_ANGLES.length === angleIndex);
  if (picked.length === 0) return "";
  const seenHeaders = new Set<string>();
  const out: string[] = [];
  for (const segment of picked) {
    const segLines = segment.split("\n");
    const headerEnd = segLines.findIndex((l) => /^@@\s/.test(l));
    if (headerEnd === -1) {
      out.push(segment);
      continue;
    }
    const header = segLines.slice(0, headerEnd).join("\n");
    if (seenHeaders.has(header)) {
      out.push(segLines.slice(headerEnd).join("\n"));
    } else {
      seenHeaders.add(header);
      out.push(segment);
    }
  }
  return out.join("\n");
}

/**
 * Emit the vm-embeddable equivalent of splitDiffSegments()/diffShard() plus a
 * shardFor(angle) helper bound to the script's own `diff` variable. The
 * generated script cannot import this module (it runs in a vm), so the two
 * implementations are kept textually in sync — same pattern as
 * numericArgCoercionSource in builtin-args.ts.
 */
function diffShardSource(): string {
  const angleChars = CODE_REVIEW_ANGLES.join("");
  const angleCount = CODE_REVIEW_ANGLES.length;
  return [
    "// Diff sharding (H7): mirrors src/code-review.ts splitDiffSegments/diffShard so",
    "// each review angle sees only a disjoint slice of the diff — the slices' union",
    "// is the full diff and no finder/verifier ever pays for hunks outside its angle.",
    "const splitDiffSegments = (diffText) => {",
    "  const lines = diffText.split('\\n')",
    "  const segments = []",
    "  let fileHeader = []",
    "  let current = []",
    "  let headerOpen = false",
    "  const flush = () => {",
    "    if (current.join('').length > 0) { segments.push(current.join('\\n')); current = [] }",
    "  }",
    "  for (const line of lines) {",
    "    if (/^diff\\s+/.test(line)) { flush(); headerOpen = true; fileHeader = [line]; current = [line] }",
    "    else if (headerOpen && /^@@\\s/.test(line)) { headerOpen = false; current.push(line) }",
    "    else if (headerOpen) { fileHeader.push(line); current.push(line) }",
    "    else if (/^@@\\s/.test(line)) { flush(); current = fileHeader.concat([line]) }",
    "    else { current.push(line) }",
    "  }",
    "  flush()",
    "  return segments",
    "}",
    "const shardFor = (angle) => {",
    `  const angleIndex = '${angleChars}'.indexOf(angle)`,
    `  if (angleIndex < 0) return diff`,
    `  const picked = splitDiffSegments(diff).filter((_, i) => i % ${angleCount} === angleIndex)`,
    `  if (picked.length === 0) return ''`,
    "  const seenHeaders = new Set()",
    "  const out = []",
    "  for (const segment of picked) {",
    "    const segLines = segment.split('\\n')",
    "    const headerEnd = segLines.findIndex((l) => /^@@\\s/.test(l))",
    "    if (headerEnd === -1) { out.push(segment); continue }",
    "    const header = segLines.slice(0, headerEnd).join('\\n')",
    "    if (seenHeaders.has(header)) { out.push(segLines.slice(headerEnd).join('\\n')) }",
    "    else { seenHeaders.add(header); out.push(segment) }",
    "  }",
    "  return out.join('\\n')",
    "}",
  ].join("\n");
}

/**
 * Generate a code-review workflow script.
 *
 * The workflow expects `args` to be passed with shape:
 *   { diff: string, diffSource?: string, diffTruncated?: boolean, diffLength?: number,
 *     maxCandidates?: number, verifyBatchSize?: number }
 *
 * `diffTruncated`/`diffLength` carry truncation provenance (builtins:i4): the
 * /code-review slash command truncates the diff before passing it in and flags
 * both; every other launch path passes the raw diff and the script computes
 * truncation itself. `maxCandidates`/`verifyBatchSize` bound the verify
 * fan-out (builtins:i2/i5) and are coerced by the shared builtin-args rules.
 *
 * The diff is SHARDED per angle (H7): each finder and each verifier sees only
 * the slice of the diff assigned to its angle, so a 200 KB diff costs roughly
 * a quarter of its previous context per run instead of duplicating the full
 * diff ~7× into every agent prompt.
 *
 * Model tier routing follows the spec:
 *   Finders A/B/C/H → medium (correctness + security)
 *   Finders D/E/F   → small  (cleanup)
 *   Finder  G       → big    (altitude / abstraction)
 *   Synthesis       → big
 */
export function generateCodeReviewWorkflow(): string {
  const angleListJs = `[${CODE_REVIEW_ANGLES.map((a) => JSON.stringify(a)).join(", ")}]`;
  return `export const meta = {
  name: 'code_review',
  description: 'Multi-angle parallel code review: 8 finder angles + verify pass → ranked findings',
  phases: [
    { title: 'Find' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

const MAX_DIFF_CHARS = ${MAX_DIFF_CHARS}
// maxCandidates/verifyBatchSize come from the shared builtin-args coercion
// (baked into the script below) — never the old || default pattern, which
// silently mangles a present falsy value and accepts out-of-range fan-out.
${numericArgCoercionSource(CODE_REVIEW_NUMERIC_ARGS)}
// Truncation provenance (builtins:i4): the /code-review slash command already
// truncated the diff and flags args.diffTruncated + args.diffLength; the
// workflow tool's name path passes the raw diff and the script computes
// truncation itself. Honour both so diffTruncated is accurate on every launch
// path — a truncated diff must never report itself as not truncated.
const rawDiff = (args && args.diff) || ''
const diffSource = (args && args.diffSource) || 'git diff HEAD'
const diffTruncated = (args && args.diffTruncated) === true || rawDiff.length > MAX_DIFF_CHARS
const diffOriginalLength = typeof (args && args.diffLength) === 'number' ? args.diffLength : rawDiff.length
const diff = diffTruncated ? rawDiff.slice(0, MAX_DIFF_CHARS) : rawDiff
if (diffTruncated) {
  const omitted = Math.max(0, diffOriginalLength - MAX_DIFF_CHARS)
  log(
    'Diff truncated for review: showing the first ' + MAX_DIFF_CHARS + ' of ' + diffOriginalLength +
    ' characters (' + omitted + ' omitted). Findings past the cut are not covered.'
  )
}
${diffShardSource()}
const shardBlock = (angle) => '\\n<diff source=\\"' + diffSource + '\\"' + (diffTruncated ? ' truncated=\\"true\\"' : '') + ' shard=\\"' + angle + '\\">\\n' +
  (shardFor(angle) || '(no diff hunks assigned to this review angle)') + '\\n</diff>\\n'
const candidateSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'summary', 'failure_scenario'],
      },
    },
  },
  required: ['candidates'],
}
const base = 'Use the read/grep tools to pull in any additional file context you need. ' +
  'Rate every candidate with a severity of critical, high, medium, or low.'

phase('Find')
const finders = await parallel([
  () => agent(
    'You are a line-by-line correctness scanner. Hunt ONLY for: inverted conditions, off-by-one errors, ' +
    'null/nil dereferences, wrong variable used, swallowed errors. For each candidate name the exact file, ' +
    'line number, severity, a one-line summary, and the concrete failure scenario. Return ONLY issues you can ' +
    'justify with a line in the diff slice shown below.' + base + shardBlock('A'),
    { label: 'A-line-scan', tier: 'medium', schema: candidateSchema }
  ),
  () => agent(
    'You are a removed-behavior auditor. For every deleted line or block in the diff slice: name the invariant ' +
    'or contract it enforced, then find where (or prove) that contract is re-established elsewhere. ' +
    'Report only gaps where the invariant is NOT re-established.' + base + shardBlock('B'),
    { label: 'B-removed-behavior', tier: 'medium', schema: candidateSchema }
  ),
  () => agent(
    'You are a cross-file call-site tracer. For each function/method whose signature or behavior changed ' +
    'in the diff slice: grep the codebase for callers, then check whether each call site is still correct after ' +
    'the change. Report only call sites that are now broken or need updating.' + base + shardBlock('C'),
    { label: 'C-cross-file-tracer', tier: 'medium', schema: candidateSchema }
  ),
  () => agent(
    'You are a reuse finder. Identify new code in the diff slice that duplicates existing helpers, utilities, ' +
    'or patterns already present in the codebase. Propose the existing symbol that should be used instead.' + base + shardBlock('D'),
    { label: 'D-reuse', tier: 'small', schema: candidateSchema }
  ),
  () => agent(
    'You are a simplification finder. Look for: redundant state that could be derived, copy-paste ' +
    'variation that could be a shared function, and dead code introduced by the diff slice.' + base + shardBlock('E'),
    { label: 'E-simplification', tier: 'small', schema: candidateSchema }
  ),
  () => agent(
    'You are an efficiency finder. Identify: redundant I/O or network calls, sequential work that could ' +
    'be parallel, and blocking operations on the startup or hot path introduced by the diff slice.' + base + shardBlock('F'),
    { label: 'F-efficiency', tier: 'small', schema: candidateSchema }
  ),
  () => agent(
    'You are an altitude reviewer. Assess whether the change is made at the RIGHT abstraction level. ' +
    'Look for: bandaids on shared infrastructure that should be fixed at the root, fixes in the wrong ' +
    'layer (e.g. compensating in the UI for a data model problem), or the change solving a symptom ' +
    'rather than the cause.' + base + shardBlock('G'),
    { label: 'G-altitude', tier: 'big', schema: candidateSchema }
  ),
  () => agent(
    'You are a security auditor (M20). Hunt ONLY for: injection flaws (SQL/command/path), unsafe deserialization, ' +
    'broken authentication/authorization or privilege escalation, secret or credential leakage, SSRF or URL ' +
    'fetching of attacker-controlled input, XSS/CSRF, insecure cryptography, and untrusted-data handling. ' +
    'For each candidate name the exact file, line number, severity, a one-line summary, and the concrete ' +
    'failure scenario. Return ONLY issues you can justify with a line in the diff slice shown below.' + base + shardBlock('H'),
    { label: 'H-security', tier: 'medium', schema: candidateSchema }
  ),
])

// Collect and deduplicate candidates across all finders
const allRaw = finders.flatMap((r, fi) => {
  const label = ${angleListJs}[fi]
  return ((r && r.candidates) || []).map((c) => ({ ...c, angle: label }))
})

// Deduplicate: same file + line + first 40 chars of summary → keep first
const seen = new Set()
const allCandidates = allRaw.filter((c) => {
  const key = (c.file || '') + ':' + (c.line || 0) + ':' + (c.summary || '').slice(0, 40)
  if (seen.has(key)) return false
  seen.add(key)
  return true
})

// i2: pre-cap the deduped candidate pool BEFORE any verify agent runs — a
// finder burst of hundreds must not translate into hundreds of verifier calls
// (the report only shows ~10 anyway). i5: the cap is logged, never silent.
const pool = allCandidates.slice(0, maxCandidates)
if (allCandidates.length > maxCandidates) {
  log(
    'Code review: ' + allCandidates.length + ' candidate findings after dedupe; capping the verify pass at ' +
    maxCandidates + ' (' + (allCandidates.length - maxCandidates) + ' candidates are not verified).'
  )
}
// Group candidates by angle so every verifier sees ONLY the diff slice of the
// angle it judges (H7) — a verifier never needs another angle's hunks, and a
// mixed-angle batch would force every verifier to pay for the whole diff.
const byAngle = new Map()
pool.forEach((c, i) => {
  const angle = typeof c.angle === 'string' && c.angle ? c.angle : 'A'
  const list = byAngle.get(angle) || []
  list.push({ index: i, candidate: c })
  byAngle.set(angle, list)
})
const verifyBatches = []
for (const angle of ${angleListJs}) {
  const items = byAngle.get(angle) || []
  for (let b = 0; b < Math.ceil(items.length / verifyBatchSize); b++) {
    verifyBatches.push({ angle, items: items.slice(b * verifyBatchSize, (b + 1) * verifyBatchSize) })
  }
}

phase('Verify')
// NOTE: deliberately NOT using the verify() stdlib helper here. verify() only
// returns a boolean real/not-real vote; this phase needs the 3-way
// CONFIRMED/PLAUSIBLE/REFUTED verdict so the synthesis report can hedge
// ("worth a second look" vs "will break"). Since only REFUTED is filtered out
// below, verify()'s boolean would collapse CONFIRMED and PLAUSIBLE into one
// bucket and lose that signal for no behavioral gain — verify({reviewers: 1})
// is already a single agent() call under the hood, same as this.
const batchResults = verifyBatches.length > 0
  ? await parallel(verifyBatches.map((batch, b) => () =>
      agent(
        'You are a verifier. For EACH finding below, determine whether it is CONFIRMED, PLAUSIBLE, or REFUTED. ' +
        'CONFIRMED = you can trace the exact failure in the diff slice shown. PLAUSIBLE = concern is valid but not certain. ' +
        'REFUTED = finding is wrong or already handled. Return one verdict object per finding, in the same order as listed.\\n\\n' +
        batch.items.map(({ candidate: c }, i) =>
          'FINDING ' + (i + 1) + ':\\nFile: ' + c.file + '\\nLine: ' + c.line +
          '\\nSeverity: ' + (c.severity || 'low') + '\\nSummary: ' + c.summary + '\\nFailure scenario: ' + c.failure_scenario
        ).join('\\n\\n') + '\\n\\n' + shardBlock(batch.angle),
        {
          label: 'verify-batch-' + (b + 1),
          schema: {
            type: 'object',
            properties: {
              verdicts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] }, reason: { type: 'string' } },
                  required: ['verdict'],
                },
              },
            },
            required: ['verdicts'],
          },
        }
      )
    ))
  : []
// Flatten batch verdicts back into pool order, preserving per-candidate slots:
// every batch carries the exact pool index of each candidate it judged, so a
// null batch (recoverable agent failure) or a short LLM output degrades only
// its own candidates to PLAUSIBLE and never shifts another batch's verdicts
// onto the wrong findings.
const verdicts = new Array(pool.length)
batchResults.forEach((out, b) => {
  const batch = verifyBatches[b]
  const returned = out && Array.isArray(out.verdicts) ? out.verdicts : []
  batch.items.forEach(({ index }, i) => {
    const slot = returned[i]
    verdicts[index] = slot && typeof slot === 'object' ? slot : { verdict: 'PLAUSIBLE' }
  })
})

const surviving = pool
  .map((c, i) => ({ ...c, verdict: (verdicts[i] && verdicts[i].verdict) || 'PLAUSIBLE', verifyReason: (verdicts[i] && verdicts[i].reason) || '' }))
  .filter((c) => c.verdict !== 'REFUTED')

// Rank: security (H) and correctness (A/B/C) before cleanup (D/E/F) before
// altitude (G); within an angle, higher severity first (M20). Cap at 10.
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const rankAngle = (a) => a === 'H' ? 0 : ['A','B','C'].includes(a) ? 1 : ['D','E','F'].includes(a) ? 2 : 3
const severityRank = (s) => (typeof s === 'string' && SEVERITY_RANK[s] !== undefined) ? SEVERITY_RANK[s] : 3
surviving.sort((a, b) => {
  const byAngle = rankAngle(a.angle) - rankAngle(b.angle)
  return byAngle !== 0 ? byAngle : severityRank(a.severity) - severityRank(b.severity)
})
const top = surviving.slice(0, 10)

phase('Report')
const synthesis = await agent(
  'You are a senior code reviewer writing the final report. Below are the verified findings from a ' +
  'multi-angle code review (already ranked by severity). Write a concise markdown report: ' +
  '1 sentence per finding with file, line, severity, and the failure scenario. Note the total found vs shown. ' +
  'Security (H) and correctness (A/B/C) come first, then cleanup (D/E/F), then altitude (G).\\n\\n' +
  'FINDINGS JSON:\\n' + JSON.stringify(top, null, 2),
  { label: 'synthesis', tier: 'big' }
)

return { total: allCandidates.length, verified: pool.length, surviving: surviving.length, findings: top, report: synthesis, diffTruncated }`;
}
