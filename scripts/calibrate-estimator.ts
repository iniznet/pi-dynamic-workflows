/**
 * T1-16 estimator calibration probe (read-only over persisted runs).
 *
 * The estimate-only token path (recordTokens in src/workflow.ts) approximates
 * an agent's input+output as `estimateTokens(prompt) + estimateTokens(result)`.
 * This probe validates that proxy against the 62.4% of persisted runs whose
 * providers DO report real usage, per segment class (prose / code / json /
 * tool), and derives per-segment chars-per-token divisors so the estimator can
 * be calibrated (see TOKEN_ESTIMATE_SEGMENT_DIVISORS in src/workflow.ts).
 *
 * For every agent with a provider-reported breakdown:
 *   actual    = tokenUsage.input + tokenUsage.output   (reported fresh spend)
 *   estimated = estimateTokens(prompt) + estimateTokens(result)
 * and each sample's chars are split by the segment class of prompt and result
 * (the SAME classification the runtime estimator applies to whole values).
 *
 * Output: per-class sample counts + baseline (chars/4) MAE + fitted divisors +
 * calibrated MAE, and a machine-readable JSON summary line. The persisted run
 * files are READ-ONLY — nothing is written anywhere.
 *
 * Run: npx tsx scripts/calibrate-estimator.ts
 *      PI_WORKFLOW_CALIBRATION_DIR=<dir> npx tsx scripts/calibrate-estimator.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimateTokens,
  estimateTokensDetailed,
  TOKEN_ESTIMATE_SEGMENT_DIVISORS,
  type TokenSegmentClass,
} from "../src/workflow.js";

const SEGMENTS: readonly TokenSegmentClass[] = ["prose", "code", "json", "tool"];
const DEFAULT_WORKFLOWS_DIR = "C:/Users/User/.pi/workflows";
const CALIBRATION_DIR = process.env.PI_WORKFLOW_CALIBRATION_DIR ?? DEFAULT_WORKFLOWS_DIR;

interface Sample {
  /** chars of the prompt, attributed to its segment class */
  promptChars: number;
  promptSegment: TokenSegmentClass;
  /** chars of the result, attributed to its segment class */
  resultChars: number;
  resultSegment: TokenSegmentClass;
  /** provider-reported input tokens */
  input: number;
  /** provider-reported output tokens */
  output: number;
  /** estimate-only proxy at the CURRENT (chars/4-flat baseline divisors below) estimator */
  estimatedBaseline: number;
}

/** Recursive walk for run JSON files under the workflows dir (skip .bak). */
function collectRunFiles(dir: string, depth = 0): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 6) out = out.concat(collectRunFiles(full, depth + 1));
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".bak")) {
      out.push(full);
    }
  }
  return out;
}

function collectSamples(): { samples: Sample[]; runsScanned: number; runsWithSamples: number } {
  const files = collectRunFiles(CALIBRATION_DIR);
  const samples: Sample[] = [];
  let runsScanned = 0;
  let runsWithSamples = 0;
  for (const file of files) {
    let run: {
      agents?: Array<{
        prompt?: string;
        result?: unknown;
        tokenUsage?: { input?: number; output?: number };
      }>;
    };
    try {
      run = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue; // malformed/truncated run file — skip silently (read-only probe)
    }
    runsScanned += 1;
    let runSamples = 0;
    for (const agent of run.agents ?? []) {
      const usage = agent.tokenUsage;
      const input = usage?.input ?? 0;
      const output = usage?.output ?? 0;
      if (!usage || input + output <= 0) continue;
      if (typeof agent.prompt !== "string" || agent.prompt.length === 0) continue;
      const promptDetail = estimateTokensDetailed(agent.prompt);
      const resultDetail = estimateTokensDetailed(agent.result);
      const estimatedBaseline = estimateTokens(agent.prompt) + estimateTokens(agent.result);
      samples.push({
        promptChars: promptDetail.chars,
        promptSegment: promptDetail.segment,
        resultChars: resultDetail.chars,
        resultSegment: resultDetail.segment,
        input,
        output,
        estimatedBaseline,
      });
      runSamples += 1;
    }
    if (runSamples > 0) runsWithSamples += 1;
  }
  return { samples, runsScanned, runsWithSamples };
}

/** chars per class for one sample (prompt chars + result chars under their classes). */
function classChars(s: Sample): Record<TokenSegmentClass, number> {
  const out: Record<TokenSegmentClass, number> = { prose: 0, code: 0, json: 0, tool: 0 };
  out[s.promptSegment] += s.promptChars;
  out[s.resultSegment] += s.resultChars;
  return out;
}

function totalChars(s: Sample): number {
  return s.promptChars + s.resultChars;
}

/** Mean absolute error of an estimator mapping chars→tokens. */
function maeOf(samples: Sample[], weight: (s: Sample) => number): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += Math.abs(s.input + s.output - weight(s));
  return sum / samples.length;
}

/** Mean absolute error bucketed by each sample's dominant segment class. */
function maeByClass(
  samples: Sample[],
  weight: (s: Sample) => number,
): Record<TokenSegmentClass, { count: number; mae: number }> {
  const out: Record<TokenSegmentClass, { count: number; mae: number }> = {
    prose: { count: 0, mae: 0 },
    code: { count: 0, mae: 0 },
    json: { count: 0, mae: 0 },
    tool: { count: 0, mae: 0 },
  };
  for (const s of samples) {
    const dominant = s.promptChars >= s.resultChars ? s.promptSegment : s.resultSegment;
    out[dominant].count += 1;
    out[dominant].mae += Math.abs(s.input + s.output - weight(s));
  }
  for (const cls of SEGMENTS) if (out[cls].count > 0) out[cls].mae /= out[cls].count;
  return out;
}

/**
 * Fit per-class chars→tokens weights via least squares on the normal equations
 * (XᵀX + ridge) w = Xᵀy, where each sample contributes its per-class char
 * counts and the provider-reported fresh spend. Returns the raw (unclamped)
 * weights plus the clamped divisor map (divisors clamped to [1.5, 12]; a class
 * with no observed chars keeps its baseline divisor 4). NOTE: the end-to-end
 * target (input+output) includes the system prompt / tool defs / history the
 * estimator cannot see, so this fit measures BUDGET accuracy, not text density
 * (see fitOutputDensity for the pure density read).
 */
function fitDivisors(samples: Sample[]): {
  raw: Record<TokenSegmentClass, number>;
  divisors: Record<TokenSegmentClass, number>;
} {
  const n = SEGMENTS.length;
  const a = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (const s of samples) {
    const chars = classChars(s);
    const actual = s.input + s.output;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i][j] += chars[SEGMENTS[i]] * chars[SEGMENTS[j]];
      b[i] += chars[SEGMENTS[i]] * actual;
    }
  }
  // Ridge: tiny diagonal regularization so a class that never appears stays
  // solvable (its weight stays 0 → falls back to the baseline divisor).
  for (let i = 0; i < n; i++) a[i][i] += 1e-6;
  const solved = solveLinear(a, b);
  const raw: Record<TokenSegmentClass, number> = { prose: 1 / 4, code: 1 / 4, json: 1 / 4, tool: 1 / 4 };
  const divisors: Record<TokenSegmentClass, number> = { prose: 4, code: 4, json: 4, tool: 4 };
  for (let i = 0; i < n; i++) {
    raw[SEGMENTS[i]] = solved[i];
    const chars = samples.reduce((sum, s) => sum + classChars(s)[SEGMENTS[i]], 0);
    if (chars <= 0) continue;
    // 1/12 ≤ weight ≤ 1/1.5 → divisors in [1.5, 12].
    const w = Math.min(1 / 1.5, Math.max(1 / 12, solved[i]));
    divisors[SEGMENTS[i]] = 1 / w;
  }
  return { raw, divisors };
}

/**
 * OUTPUT-ONLY text-density fit: result chars per class → provider-reported
 * OUTPUT tokens. No history/system overhead here — this isolates the pure text
 * density per segment (the plan's "code/JSON are denser than prose" claim).
 * Per class c, divisor_c = Σ resultChars / Σ output over samples whose RESULT
 * classifies as c — a stable pooled ratio (a sample whose result is empty or
 * whose provider reported no output contributes nothing).
 */
function fitOutputDensity(
  samples: Sample[],
): Record<TokenSegmentClass, { divisor: number; chars: number; raw: number }> {
  const sums: Record<TokenSegmentClass, { chars: number; tokens: number }> = {
    prose: { chars: 0, tokens: 0 },
    code: { chars: 0, tokens: 0 },
    json: { chars: 0, tokens: 0 },
    tool: { chars: 0, tokens: 0 },
  };
  for (const s of samples) {
    if (s.resultChars === 0 || s.output <= 0) continue;
    sums[s.resultSegment].chars += s.resultChars;
    sums[s.resultSegment].tokens += s.output;
  }
  const out: Record<TokenSegmentClass, { divisor: number; chars: number; raw: number }> = {
    prose: { divisor: 4, chars: 0, raw: 1 / 4 },
    code: { divisor: 4, chars: 0, raw: 1 / 4 },
    json: { divisor: 4, chars: 0, raw: 1 / 4 },
    tool: { divisor: 4, chars: 0, raw: 1 / 4 },
  };
  for (const cls of SEGMENTS) {
    const { chars, tokens } = sums[cls];
    out[cls].chars = chars;
    if (chars > 0 && tokens > 0) {
      const ratio = chars / tokens; // chars per output token (density)
      out[cls].divisor = Math.min(12, Math.max(1.5, ratio));
      out[cls].raw = tokens / chars; // tokens per char
    }
  }
  return out;
}

/** Gaussian elimination with partial pivoting on an n×n system. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot], m[col]];
    const pv = m[col][col];
    if (Math.abs(pv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / pv;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) x[i] = m[i][n] / (m[i][i] !== 0 ? m[i][i] : 1);
  return x;
}

/** Calibrated estimator weight for one sample under a divisor set. */
function calibratedWeight(divisors: Record<TokenSegmentClass, number>): (s: Sample) => number {
  return (s: Sample) => s.promptChars / divisors[s.promptSegment] + s.resultChars / divisors[s.resultSegment];
}

/** Baseline chars/4 weight. */
function baselineWeight(s: Sample): number {
  return totalChars(s) / 4;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "n/a";
}

function main(): void {
  const { samples, runsScanned, runsWithSamples } = collectSamples();
  if (samples.length === 0) {
    console.log(`calibrate-estimator: no samples found under ${CALIBRATION_DIR} (scanned ${runsScanned} runs)`);
    process.exit(1);
  }
  const { raw, divisors } = fitDivisors(samples);
  const outputDensity = fitOutputDensity(samples);
  // Shipped divisors = the constants baked into src/workflow.ts (the segment-
  // aware estimator the runtime actually uses). MAE against THESE is the
  // headline quality number; the fitted set is reported for comparison.
  const shippedWeight = calibratedWeight(TOKEN_ESTIMATE_SEGMENT_DIVISORS);
  const fittedWeight = calibratedWeight(divisors);
  const maeBaseline = maeOf(samples, baselineWeight);
  const maeShipped = maeOf(samples, shippedWeight);
  const maeFitted = maeOf(samples, fittedWeight);
  const baselineByClass = maeByClass(samples, baselineWeight);
  const shippedByClass = maeByClass(samples, shippedWeight);

  console.log(`calibrate-estimator: ${CALIBRATION_DIR}`);
  console.log(
    `  runs scanned: ${runsScanned}, runs with samples: ${runsWithSamples}, agent samples: ${samples.length}`,
  );
  console.log(
    `  provider-reported fresh spend (input+output) vs estimate-only proxy (estimateTokens(prompt)+estimateTokens(result))`,
  );
  console.log(`  MAE (chars/4 baseline):            ${fmt(maeBaseline)} tok`);
  console.log(
    `  MAE (shipped divisors):            ${fmt(maeShipped)} tok  <-- TOKEN_ESTIMATE_SEGMENT_DIVISORS in src/workflow.ts`,
  );
  console.log(`  MAE (unclamped end-to-end fit):    ${fmt(maeFitted)} tok`);
  console.log(
    `  shipped-vs-baseline MAE reduction: ${fmt(((maeBaseline - maeShipped) / Math.max(1, maeBaseline)) * 100)}%`,
  );
  console.log("  per-segment (dominant class bucketing):");
  for (const cls of SEGMENTS) {
    const b = baselineByClass[cls];
    const c = shippedByClass[cls];
    const chars = samples.reduce((sum, s) => sum + classChars(s)[cls], 0);
    console.log(
      `    ${cls.padEnd(5)} n=${String(b.count).padStart(4)} chars=${String(Math.round(chars)).padStart(9)} ` +
        `MAE ${fmt(b.mae)} -> ${fmt(c.mae)}  shippedDivisor=${TOKEN_ESTIMATE_SEGMENT_DIVISORS[cls].toFixed(2)} ` +
        `(fitDivisor=${divisors[cls].toFixed(2)}, raw w=${raw[cls].toFixed(4)})`,
    );
  }
  console.log("  OUTPUT-ONLY text density (result chars vs reported output; caveat: reported output includes");
  console.log("  reasoning + intermediate assistant turns + tool-call serialization, so these pooled ratios");
  console.log("  UNDER-count chars/token for the final text alone):");
  for (const cls of SEGMENTS) {
    const d = outputDensity[cls];
    console.log(
      `    ${cls.padEnd(5)} resultChars=${String(d.chars).padStart(9)} divisor=${d.divisor.toFixed(2)} (raw tok/char=${d.raw.toFixed(4)})`,
    );
  }
  console.log(
    `JSON ${JSON.stringify({
      dir: CALIBRATION_DIR,
      runsScanned,
      runsWithSamples,
      samples: samples.length,
      maeBaseline: Math.round(maeBaseline * 10) / 10,
      maeShipped: Math.round(maeShipped * 10) / 10,
      maeFitted: Math.round(maeFitted * 10) / 10,
      shippedDivisors: TOKEN_ESTIMATE_SEGMENT_DIVISORS,
      fitDivisors: Object.fromEntries(SEGMENTS.map((c) => [c, Math.round(divisors[c] * 100) / 100])),
      outputDensity: Object.fromEntries(SEGMENTS.map((c) => [c, Math.round(outputDensity[c].divisor * 100) / 100])),
    })}`,
  );
}

main();
