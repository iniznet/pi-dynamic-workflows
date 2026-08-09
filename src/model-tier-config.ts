/**
 * Sentinel tier value usable as a model spec in model-tiers.json: the tier
 * resolves to the MAIN/active chat session model instead of a fixed provider
 * spec. PRD Task 3 requires `"big": "inherit:main"` so flagship phases track
 * the user's current session model. Kept as a named constant so the special
 * case in resolveTierModel (and its tests) never embeds the magic string.
 */
export const TIER_INHERIT_MAIN = "inherit:main";

/**
 * Model tier configuration for workflow subagent model routing.
 *
 * A tier is a named slot (small/medium/big) holding exactly ONE model spec
 * string (e.g. "openai/gpt-4.1-mini" or "openai-codex/gpt-5.5:xhigh").
 * When an agent() call specifies opts.tier, that single model is resolved with
 * Pi CLI-style parsing and used as the subagent's model/thinking level (unless
 * an explicit opts.model is given, which always wins — see agent.ts).
 *
 * This augments the phase-pattern routing in model-routing.ts: phase routing
 * maps workflow phases → models via the script's meta; tiers give scripts a
 * coarse, user-configurable small/medium/big knob that is independent of any
 * concrete provider/model id.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listAvailableModels } from "./agent.js";
import { MODEL_TIERS_FILE } from "./config.js";
// Type-only + a pure string helper: model-spec.ts never imports this module,
// so importing from it cannot create a cycle.
import type { ModelThinkingLevel } from "./model-spec.js";
import { splitModelSpecThinking } from "./model-spec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model tier configuration. Maps tier names (e.g. "small", "medium", "big")
 * to a single model spec string (e.g. "gpt-4.1-mini", "openai/gpt-4.1-mini",
 * or "openai-codex/gpt-5.5:xhigh").
 *
 * Optional `thinkingCaps` (T2-11): per-tier ceiling on the reasoning level a
 * tier-sourced model spec may carry. A tier whose resolved spec ends in a
 * `:thinking` suffix above its cap is coerced DOWN to the cap at tier
 * resolution time (never in model-spec.ts parsing — the parser is pinned by
 * tests/model-spec.test.ts). `null` = no cap (the spec's own suffix wins); a
 * tier absent from the map falls back to the built-in defaults
 * (small→"low", medium→"medium", big→unset). Explicit `opts.model` with a
 * `:thinking` suffix always wins over any cap (explicit > tier precedence).
 */
export interface ModelTierConfig {
  tiers: Record<string, string>;
  /** T2-11: tier name → reasoning ceiling (null = no cap). Invalid entries are dropped on load. */
  thinkingCaps?: Record<string, ModelThinkingLevel | null>;
}

/**
 * Built-in per-tier thinking ceilings applied when model-tiers.json carries no
 * `thinkingCaps` entry for a tier (T2-11): a "small" tier pinned to
 * `claude-opus:xhigh` must not pay flagship-reasoning output tokens for
 * scan/edit work, so it is coerced to "low"; "medium" to "medium"; "big" is
 * unset (no cap — synthesis phases keep whatever the tier spec asks for).
 */
export const DEFAULT_TIER_THINKING_CAPS: Record<string, ModelThinkingLevel | null> = {
  small: "low",
  medium: "medium",
  // big: unset
};

/** Reasoning levels in ascending intensity — the order `coerceSpecThinkingForTier` caps against. */
const THINKING_LEVEL_ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Effective thinking ceiling for a tier: an explicit `config.thinkingCaps[tier]`
 * entry (including `null` = no cap) wins; otherwise the built-in default for
 * the tier name (small→low, medium→medium, everything else unset).
 */
export function thinkingCapForTier(
  tier: string,
  config: ModelTierConfig | null | undefined,
): ModelThinkingLevel | null {
  if (config?.thinkingCaps && Object.hasOwn(config.thinkingCaps, tier)) {
    return config.thinkingCaps[tier] ?? null;
  }
  return DEFAULT_TIER_THINKING_CAPS[tier] ?? null;
}

/**
 * Cap a thinking level at a ceiling (lower of the two by THINKING_LEVEL_ORDER;
 * an "off"/undefined cap never raises anything). Pure and deterministic.
 */
export function capThinkingLevel(
  level: ModelThinkingLevel | undefined,
  cap: ModelThinkingLevel | null,
): ModelThinkingLevel | undefined {
  if (level === undefined || cap === null) return level;
  return THINKING_LEVEL_ORDER.indexOf(level) > THINKING_LEVEL_ORDER.indexOf(cap) ? cap : level;
}

/**
 * Coerce a TIER-SOURCED model spec's `:thinking` suffix down to the tier's
 * thinking ceiling (T2-11). Explicit `opts.model` specs are never passed here
 * — resolveAgentModelSpec returns them before the tier branches — so the
 * "explicit > tier" precedence is preserved structurally. A spec with no
 * suffix, a tier with no cap, or a suffix already at/below the cap is returned
 * byte-identical (resume-hash determinism).
 */
export function coerceSpecThinkingForTier(
  spec: string | undefined,
  tier: string,
  config: ModelTierConfig | null | undefined,
): string | undefined {
  if (!spec) return spec;
  const { modelSpec, thinkingLevel } = splitModelSpecThinking(spec);
  if (thinkingLevel === undefined) return spec;
  const cap = thinkingCapForTier(tier, config);
  const capped = capThinkingLevel(thinkingLevel, cap);
  return capped === thinkingLevel ? spec : `${modelSpec}:${capped}`;
}

/**
 * The minimal projection of a model that tier ranking needs. Deliberately NOT
 * the SDK's full `Model` type: tier logic depends only on these three fields,
 * so it stays decoupled from the SDK (no `@earendil-works/pi-ai` import here)
 * and is trivially unit-testable with plain objects. `agent.ts`'s
 * `listAvailableModels()` produces these from the live registry.
 */
export interface RankableModel {
  /** Canonical "provider/id" spec string. */
  spec: string;
  /** Per-token output price, if the registry reports one. Missing or 0 = unknown. */
  costOutput?: number;
  /** Context window size, if the registry reports one. */
  contextWindow?: number;
}

// ---------------------------------------------------------------------------
// Configuration path
// ---------------------------------------------------------------------------

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homedir(), MODEL_TIERS_FILE);
}

// ---------------------------------------------------------------------------
// Capability signal
// ---------------------------------------------------------------------------

/**
 * Words that identify small/cheap models (case-insensitive), used only as
 * a fallback capability hint when price signals are absent or tied. Matched at
 * token boundaries so a short hint like "mini" cannot misclassify a longer
 * name like "minimax-r1" as small.
 */
export const SMALL_MODEL_HINTS = ["mini", "flash", "haiku", "nano", "small"] as const;

/**
 * Words that identify large/capable models (case-insensitive), used only
 * as a fallback capability hint when price signals are absent or tied.
 */
export const BIG_MODEL_HINTS = ["opus", "pro", "ultra", "large", "plus"] as const;

/**
 * Word-boundary match for a hint inside a model spec (case-insensitive): the
 * hint must be surrounded by non-alphanumerics or the string edges. Matches
 * "gpt-4.1-mini" and "mini-pro" but not "minimax-r1" or "prompt-helper".
 */
function matchesWord(spec: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(spec);
}

/**
 * Fallback capability hint from a model's name: -1 for a small/cheap name, +1
 * for a large/capable name, 0 otherwise. If a name matches both sets, the small
 * hint wins (we never want a "mini"-labelled model to outrank a neutral or
 * clearly-large one). This is only a FALLBACK: `rankByCapability` prefers the
 * registry's price signal, which is robust to new vendor names (e.g. "fable",
 * "mimo") that match no hint and would otherwise all score 0.
 */
export function hintScore(spec: string): number {
  const lower = spec.toLowerCase();
  if (SMALL_MODEL_HINTS.some((hint) => matchesWord(lower, hint))) return -1;
  if (BIG_MODEL_HINTS.some((hint) => matchesWord(lower, hint))) return 1;
  return 0;
}

/**
 * Rank models from least → most capable.
 *
 * PRIMARY signal is output price (higher price ≈ more capable): within a single
 * registry, price tracks the vendor's capability tier far more robustly than
 * model-name substrings, and it works for models whose names match no hint.
 *
 * Models with an UNKNOWN price (missing or 0 — common for self-hosted
 * `models.json` entries) are NOT treated as "cheapest = weakest". Instead they
 * are projected onto the known price range via their substring hint: a
 * big-hint name lands at the top of the range, a small-hint name at the bottom,
 * a neutral name at the middle. When NO model has a known price at all, this
 * degrades to pure hint ordering (the previous behavior).
 *
 * The comparison is a single total order (projected cost → hint → contextWindow
 * → stable registry index), so the sort is transitive and stable.
 */
export function rankByCapability(models: readonly RankableModel[]): RankableModel[] {
  const knownCosts = models
    .map((m) => m.costOutput)
    .filter((c): c is number => typeof c === "number" && c > 0)
    .sort((a, b) => a - b);
  const hasPriceSignal = knownCosts.length > 0;
  const min = knownCosts[0];
  const max = knownCosts[knownCosts.length - 1];
  // LOWER median, not upper: with an even number of known costs the upper
  // middle index (Math.floor(len/2)) projects a neutral unknown-cost model to
  // the top half of the range — letting a free/self-hosted model tie (and
  // sometimes outrank) a paid flagship. The lower middle keeps the projection
  // conservative (L10).
  const median = knownCosts[Math.floor((knownCosts.length - 1) / 2)];

  // Project every model onto the price axis. Undefined only when there is no
  // price signal anywhere (all models unpriced) — then the sort falls through
  // to the hint comparison below.
  const costKey = (m: RankableModel): number | undefined => {
    if (typeof m.costOutput === "number" && m.costOutput > 0) return m.costOutput;
    if (!hasPriceSignal) return undefined;
    const hint = hintScore(m.spec);
    return hint > 0 ? max : hint < 0 ? min : median;
  };

  return models
    .map((m, index) => ({
      m,
      index,
      cost: costKey(m),
      hint: hintScore(m.spec),
      ctx: m.contextWindow ?? 0,
      priced: typeof m.costOutput === "number" && m.costOutput > 0,
    }))
    .sort((a, b) => {
      if (a.cost !== undefined && b.cost !== undefined && a.cost !== b.cost) return a.cost - b.cost;
      if (a.hint !== b.hint) return a.hint - b.hint;
      if (a.ctx !== b.ctx) return a.ctx - b.ctx;
      // A model with a REAL price wins a tie against a projected (unknown-cost)
      // model at the same cost: a free/self-hosted entry must never outrank a
      // paid model it merely projects onto (L10).
      if (a.priced !== b.priced) return a.priced ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.m);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Build a default tier config. When the available model registry is known,
 * spread it across tiers so small/medium/big routing is meaningful out of the
 * box. When the registry is empty or unavailable, fall back to the current Pi
 * model so fresh installs still get usable tier values.
 *
 * Models are first ranked least → most capable via `rankByCapability` (price
 * first, name-substring hint as fallback). Tiers are then assigned from this
 * single ranked pool with exclusion — each model is used for at most one tier —
 * so distinct tiers never collapse onto the same model and a weaker model can
 * never outrank a stronger one (no inversion):
 *
 *   - big    = the most capable model (last in the ranking)
 *   - small  = the least capable model (first in the ranking)
 *   - medium = the middle-ranked model
 *
 * When fewer than 3 distinct models are available, this degrades gracefully by
 * reusing the *strongest* available model for the higher tier(s):
 *
 *   - 2 models: small = weaker, medium = big = stronger
 *   - 1 / 0 models: small = medium = big = that model (or the current model /
 *     "" fallback)
 *
 * `availableModels` is injectable for testing and for callers that already
 * fetched the registry. When omitted, this reads from the live registry.
 */
export function buildDefaultTierConfig(
  currentModelSpec?: string,
  availableModels?: readonly RankableModel[],
): ModelTierConfig {
  const models = availableModels ?? listAvailableModels();
  const ranked = rankByCapability(models).map((m) => m.spec);

  if (ranked.length >= 3) {
    const small = ranked[0];
    const big = ranked[ranked.length - 1];
    const medium = ranked[Math.floor(ranked.length / 2)];
    return { tiers: { small, medium, big } };
  }
  if (ranked.length === 2) {
    const [weaker, stronger] = ranked;
    return { tiers: { small: weaker, medium: stronger, big: stronger } };
  }
  const fallback = ranked[0] ?? currentModelSpec ?? "";
  return {
    tiers: {
      small: fallback,
      medium: fallback,
      big: fallback,
    },
  };
}

/**
 * One-time notice shown when an agent requests `opts.tier` but no
 * model-tiers.json is configured — in that state tiers silently fall back to
 * the session model (see `resolveAgentModelSpec` in agent.ts), which is easy to
 * miss. This surfaces the fallback and the mapping the user *would* get by
 * configuring, using the same `buildDefaultTierConfig` ranking so the hint is
 * actionable. Pure/string-only so the caller owns how it's emitted.
 */
export function formatTierFallbackNotice(
  mainModel: string | undefined,
  availableModels: readonly RankableModel[],
): string {
  const fallback = mainModel ?? "the session default model";
  const suggested = buildDefaultTierConfig(mainModel, availableModels);
  const mapping = sortedTierNames(suggested)
    .map((tier) => `${tier}=${suggested.tiers[tier] || "?"}`)
    .join("  ");
  return (
    `[workflow] An agent requested opts.tier but no model-tiers.json is configured, so tiers currently ` +
    `fall back to ${fallback}. Run /workflows-models to configure them` +
    (mapping ? `. Suggested mapping from your available models: ${mapping}` : ".")
  );
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * True iff `value` is a usable tiers map: a plain (non-array) object with at
 * least one entry, every key and value a non-empty string. Anything else
 * (an array, `{}`, or a tier mapped to `""`) is treated as absent rather than
 * a truthy-but-broken config — resolveTierModel would silently resolve such
 * entries to `undefined`/`""` while the caller's "no model-tiers.json
 * configured" warning only fires on an exactly-null config.
 */
function isValidTiersMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([key, val]) => key.trim().length > 0 && typeof val === "string" && val.trim().length > 0);
}

/**
 * Load the model tier config from disk. Returns null if the file does not
 * exist or is unparseable (callers fall back to a default).
 *
 * T2-11: a present `thinkingCaps` map is validated/coerced leniently — valid
 * values (a `null` or a known THINKING_LEVELS member) are kept, everything
 * else is dropped on violation. An absent map is left absent (the loader
 * never injects defaults, so an existing config round-trips byte-identically
 * and the built-in caps still apply at resolution time via
 * `thinkingCapForTier`).
 */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!isValidTiersMap(parsed.tiers)) return null;
    const config = parsed as ModelTierConfig;
    const rawCaps = (parsed as Record<string, unknown>).thinkingCaps;
    if (rawCaps !== undefined) {
      if (!rawCaps || typeof rawCaps !== "object" || Array.isArray(rawCaps)) {
        delete (config as unknown as Record<string, unknown>).thinkingCaps;
      } else {
        const caps: Record<string, ModelThinkingLevel | null> = {};
        for (const [tier, value] of Object.entries(rawCaps as Record<string, unknown>)) {
          if (value === null) {
            caps[tier] = null;
          } else if (typeof value === "string" && (THINKING_LEVELS_SET as ReadonlySet<string>).has(value)) {
            caps[tier] = value as ModelThinkingLevel;
          }
          // Anything else (wrong type, unknown level) is dropped on violation.
        }
        config.thinkingCaps = caps;
      }
    }
    return config;
  } catch {
    return null;
  }
}

/** Set of valid thinking level literals (see model-spec.ts THINKING_LEVELS). */
const THINKING_LEVELS_SET: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Per-run memoized wrapper around `loadModelTierConfig`, used by the
 * resume-replay identity hash (workflow.ts) which resolves the tier→model
 * signature on EVERY agent() call — the raw loader pays existsSync +
 * readFileSync + JSON.parse per call, i.e. up to 1000 blocking sync reads per
 * run. This wrapper keeps ONE parsed copy per run: each call is a single cheap
 * statSync; the file is re-read+parsed only when its mtime/size changed.
 *
 * The config file is run-frozen by design, but the mtime/size guard keeps a
 * LONG (multi-hour interactive) run honest if the user edits the file
 * mid-run, while staying far cheaper than re-parsing on every call. Scope is
 * exactly one run: callers (workflow-manager, workflow.ts) create it at run
 * start, so two runs get two independent memos and a config change between
 * runs is always observed fresh. Mirrors the per-instance memoization
 * precedent in WorkflowAgent.loadTierConfig (agent.ts), extended with the
 * stat guard.
 */
export function createMemoizedLoadModelTierConfig(configPath?: string): () => ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  let cached: { mtimeMs: number; size: number; value: ModelTierConfig | null } | undefined;
  return () => {
    let mtimeMs = -1;
    let size = -1;
    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      // File absent/unreadable: drop any stale cache so a file that appears
      // mid-run is observed, then mirror loadModelTierConfig's null result.
      cached = undefined;
      return null;
    }
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.value;
    }
    const value = loadModelTierConfig(path);
    cached = { mtimeMs, size, value };
    return value;
  };
}

/**
 * Save a model tier config to disk. Creates parent directories if needed.
 *
 * Refuses a degenerate `tiers` (e.g. all-empty-string, from buildDefaultTierConfig
 * with an empty model registry) using the same isValidTiersMap check the loader
 * uses — otherwise the write side could produce exactly the shape loadModelTierConfig
 * now rejects on the next read, silently discarding the "saved" config.
 */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  if (!isValidTiersMap(config?.tiers)) {
    throw new Error(
      "Refusing to save a degenerate model tier config: tiers must be a non-empty map of tier name to a non-empty model spec string.",
    );
  }
  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Resolve / helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a tier name to its configured model spec, or undefined if the tier
 * is not configured.
 *
 * Special case (PRD Task 3 / audit G6): a tier whose configured spec is the
 * `inherit:main` sentinel resolves to the main/active chat session model id —
 * BEFORE the verbatim passthrough — so the sentinel can never reach the model
 * registry as a literal spec (which would throw MODEL_NOT_FOUND). When no main
 * model is known (undefined) the tier resolves to undefined, letting callers
 * fall back to the session default exactly as an unconfigured tier would.
 */
export function resolveTierModel(tier: string, config: ModelTierConfig, mainModel?: string): string | undefined {
  const spec = config.tiers[tier];
  if (spec === TIER_INHERIT_MAIN) return mainModel;
  return spec;
}

/** Return all tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}

/**
 * Human-readable per-tier cost preview for /workflows-models: each tier line
 * carries the configured model's output price and context window when the
 * registry reports them ("cost unknown" otherwise). T2-11: when the tier spec
 * carries a `:thinking` suffix or an explicit thinking cap is configured, the
 * line also shows the EFFECTIVE reasoning level after tier-cap coercion
 * ("thinking low (capped from xhigh)", "thinking off (capped from medium)",
 * or plainly "thinking xhigh" when no cap applies). Lines without a suffix and
 * without an explicit cap keep the pre-T2-11 format exactly. Pure — the
 * command renders the returned string directly.
 */
export function formatTierCostPreview(config: ModelTierConfig, models: readonly RankableModel[]): string {
  const bySpec = new Map(models.map((model) => [model.spec, model]));
  return sortedTierNames(config)
    .map((name) => {
      const modelSpec = config.tiers[name];
      const info = bySpec.get(modelSpec);
      const cost = typeof info?.costOutput === "number" && info.costOutput > 0 ? info.costOutput : undefined;
      const ctx = typeof info?.contextWindow === "number" && info.contextWindow > 0 ? info.contextWindow : undefined;
      const costText = cost === undefined ? "cost unknown" : `$${cost}/M output`;
      const ctxText = ctx === undefined ? "" : `, ${ctx} ctx`;
      const { thinkingLevel } = splitModelSpecThinking(modelSpec);
      const explicitCap = config.thinkingCaps && Object.hasOwn(config.thinkingCaps, name);
      const cap = thinkingCapForTier(name, config);
      const thinkingText =
        thinkingLevel === undefined && !explicitCap ? "" : `, thinking ${formatEffectiveThinking(thinkingLevel, cap)}`;
      return `${name} tier → ${modelSpec} (${costText}${ctxText}${thinkingText})`;
    })
    .join("\n");
}

/** Render the effective thinking level for a tier line (T2-11 preview). */
function formatEffectiveThinking(level: ModelThinkingLevel | undefined, cap: ModelThinkingLevel | null): string {
  const effective = capThinkingLevel(level, cap);
  const base = effective ?? "unset";
  if (level === undefined || effective === level) return base;
  return `${base} (capped from ${level})`;
}
