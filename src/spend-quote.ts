/**
 * Spend governance: quote-before-spend evaluation (slice C).
 *
 * Pure, side-effect-free evaluation of a pre-flight forecast's worst-case USD
 * against the run's spend ceiling (the "quoted value / tau threshold").
 * Deliberately a runtime leaf: it imports only config.ts at runtime and the
 * estimate types as type-only (erased), so BOTH the estimator
 * (estimate-forecast.ts — the --estimate surface) and the runtime
 * (workflow.ts — the launch gate) can consume it without forming an import
 * cycle (estimate-forecast.ts imports workflow.ts, so workflow.ts must never
 * statically import estimate-forecast.ts).
 *
 * Semantics (documented contract):
 *  - The gate is ARMABLE only when a spend ceiling resolves: an explicit
 *    `quotedValueUsd` (the run's worth — the ceiling is the value) or a
 *    positive `spendBudgetUsd` with a non-zero tau (ceiling = budget × tau,
 *    and tau = value ÷ budget, so the ceiling is at most the run's value).
 *  - tau = 0/null disables the gate → current behavior (no quote refusal).
 *  - Verdict: "off" (not armed) | "ok" (worst case within ceiling) |
 *    "warn" (over ceiling, mode "warn" → require confirmation) |
 *    "refuse" (over ceiling, mode "refuse" → refuse outright).
 *  - Never silent: an over-ceiling forecast is always at least "warn" when a
 *    ceiling is configured; "off" only when the user disabled the gate.
 */

import {
  DEFAULT_MODEL_PRICE_USD,
  DEFAULT_SPEND_QUOTE_GATE,
  DEFAULT_SPEND_TAU,
  type ModelPriceUsd,
  resolveSpendTau,
  type SpendQuoteGateMode,
} from "./config.js";
import type { WorkflowEstimate } from "./estimate-forecast.js";

/** The spend-quote knobs a forecast/gate consumes (subset of EstimateOptions). */
export interface SpendQuoteOptions {
  /** Base spend budget threshold (USD). 0/negative/absent = not set. */
  spendBudgetUsd?: number | null;
  /** The run's quoted value (USD) — an alternative ceiling; wins over budget × tau when set. */
  quotedValueUsd?: number | null;
  /** Tau multiplier (default DEFAULT_SPEND_TAU); 0/null disables the gate. */
  spendTau?: number | null;
  /** Gate mode (default DEFAULT_SPEND_QUOTE_GATE). */
  spendQuoteGate?: SpendQuoteGateMode;
}

/** The evaluated quote for one forecast. */
export interface SpendQuote {
  /** Effective spend ceiling (USD); null = gate disabled (current behavior). */
  ceilingUsd: number | null;
  /** "off" | "ok" | "warn" | "refuse". */
  verdict: SpendQuoteVerdict;
  /** Human reason — always present, explains the verdict. */
  reason: string;
  /** The worst-case USD the quote was compared against. */
  usdWorstCase: number;
  /** The minimum-case USD of the forecast (informational). */
  usdMin: number;
  /** The configured gate mode (for surfaces that want to echo it). */
  mode: SpendQuoteGateMode;
}

/** Verdict literal. */
export type SpendQuoteVerdict = "off" | "ok" | "warn" | "refuse";

/** True when the spend gate is armed (a ceiling resolves and mode != "off"). */
export function isSpendQuoteArmed(options: SpendQuoteOptions): boolean {
  return resolveSpendCeilingUsd(options) !== null;
}

/**
 * Resolve the spend ceiling (USD) from the quote options. null = disabled.
 * Pure function of the options — the single shared definition so the
 * estimator and the runtime gate can never disagree on the threshold.
 */
export function resolveSpendCeilingUsd(options: SpendQuoteOptions): number | null {
  const { spendBudgetUsd, quotedValueUsd, spendTau } = options;
  if (typeof quotedValueUsd === "number" && Number.isFinite(quotedValueUsd) && quotedValueUsd > 0) {
    return quotedValueUsd;
  }
  if (typeof spendBudgetUsd === "number" && Number.isFinite(spendBudgetUsd) && spendBudgetUsd > 0) {
    const tau = resolveSpendTau(spendTau);
    if (tau !== null) return spendBudgetUsd * tau;
  }
  return null;
}

/** The gate mode an option resolves to (defaults applied). */
export function resolveSpendQuoteMode(options: SpendQuoteOptions): SpendQuoteGateMode {
  return options.spendQuoteGate ?? DEFAULT_SPEND_QUOTE_GATE;
}

/** Format USD for a reason line (3 significant decimals — cents precision at sub-cent scale). */
export function formatQuoteUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Evaluate a forecast's worst-case USD against the spend ceiling. Pure and
 * deterministic. The estimate may carry its own quote fields (already
 * evaluated by the estimator) — this function re-derives the verdict from the
 * raw USD so callers with a bare estimate (the runtime gate) never depend on
 * the estimator having populated them.
 */
export function evaluateSpendQuote(
  estimate: Pick<WorkflowEstimate, "usdMin" | "usdWorstCase">,
  options: SpendQuoteOptions,
): SpendQuote {
  const ceilingUsd = resolveSpendCeilingUsd(options);
  const mode = resolveSpendQuoteMode(options);
  const usdWorstCase = estimate.usdWorstCase;
  const usdMin = estimate.usdMin;
  if (ceilingUsd === null || mode === "off") {
    return {
      ceilingUsd: null,
      verdict: "off",
      reason: "Spend quote gate is disabled (no spend budget/value configured, tau 0, or mode \"off\") — current behavior.",
      usdWorstCase,
      usdMin,
      mode,
    };
  }
  const within = usdWorstCase <= ceilingUsd;
  const ceilingLine = `ceiling ${formatQuoteUsd(ceilingUsd)}`;
  if (within) {
    return {
      ceilingUsd,
      verdict: "ok",
      reason: `Worst-case quote ${formatQuoteUsd(usdWorstCase)} is within the spend ${ceilingLine} — launch allowed.`,
      usdWorstCase,
      usdMin,
      mode,
    };
  }
  const action = mode === "refuse" ? "refusing launch" : "requires human confirmation before launch (refusing headless)";
  return {
    ceilingUsd,
    verdict: mode === "refuse" ? "refuse" : "warn",
    reason:
      `Worst-case quote ${formatQuoteUsd(usdWorstCase)} EXCEEDS the spend ${ceilingLine} (${mode} gate) — ${action}. ` +
      `Raise spendBudgetUsd/quotedValueUsd, raise spendTau, or pass spendQuoteGate "off" to override.`,
    usdWorstCase,
    usdMin,
    mode,
  };
}

/**
 * The estimator's per-1k price resolve used by the fold. Re-exported so the
 * estimate module and any consumer share one price story.
 */
export { DEFAULT_MODEL_PRICE_USD, resolveSpendTau, DEFAULT_SPEND_TAU };
export type { ModelPriceUsd };
