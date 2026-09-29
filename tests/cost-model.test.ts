/**
 * cost:model — cheapest-first default tiering + big-thinks/cheap-does
 * role-split (cost governance slice A).
 *
 * Proves the game-change defaults and their safety gates:
 *  - ECONOMY-BY-DEFAULT: an untagged mechanical slice (scan/edit) under a
 *    configured model-tiers.json routes to the CHEAPEST configured tier when a
 *    genuinely cheaper model exists (never the old blanket "medium").
 *  - ROLE-SPLIT: a genuinely hard slice (synthesize/analyze/verify) escalates
 *    to the configured "big" tier — spend only when the slice earns it.
 *  - NO-DOWNGRADE-WHEN-NONE: when no cheaper model exists (single-model
 *    config, unpriced ties, empty registry), the CURRENT default behavior is
 *    kept byte-for-byte and a visible notice fires — never a silent quality
 *    loss.
 *  - EXPLICIT WINS: opts.model / opts.tier precedence is unchanged.
 *  - EXPOSURE: the decision carries the chosen tier + per-M-token prices, and
 *    runWorkflow surfaces the chosen tier on agent start/end events.
 *  - REPLAY SAFETY: a registry change invalidates a downgraded call's cached
 *    replay (the downgrade is registry-dependent) while a kept-default call
 *    replays stably (config-only).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { listAvailableModels, resolveAgentModelSpec } from "../src/agent.js";
import {
  cheapestTierModel,
  isGenuinelyCheaperModel,
  type ModelTierConfig,
  pricePerMTokOf,
  type RankableModel,
  resolveRoleSplitTier,
} from "../src/model-tier-config.js";
import { classifyTask, TaskClassification } from "../src/model-routing.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Three distinct-capability models with real per-M-token output prices. */
const PRICED = [
  { spec: "vend/mini", costOutput: 0.4, contextWindow: 8000 },
  { spec: "vend/mid", costOutput: 5, contextWindow: 128000 },
  { spec: "vend/flagship", costOutput: 75, contextWindow: 1_000_000 },
] satisfies RankableModel[];

/** A configured tier set mapping to exactly those three models. */
const CFG: ModelTierConfig = { tiers: { small: "vend/mini", medium: "vend/mid", big: "vend/flagship" } };

/** Minimal ModelRegistry projection — listAvailableModels only needs getAvailable(). */
function mockRegistry(
  models: Array<{ provider: string; id: string; costOutput?: number; contextWindow?: number }>,
): ModelRegistry {
  return {
    getAvailable: () =>
      models.map((m) => ({
        provider: m.provider,
        id: m.id,
        cost: m.costOutput === undefined ? undefined : { output: m.costOutput },
        contextWindow: m.contextWindow,
      })),
    find: () => undefined,
    getAll: () => [],
  } as unknown as ModelRegistry;
}

const pricedRegistry = () =>
  mockRegistry([
    { provider: "vend", id: "mini", costOutput: 0.4, contextWindow: 8000 },
    { provider: "vend", id: "mid", costOutput: 5, contextWindow: 128000 },
    { provider: "vend", id: "flagship", costOutput: 75, contextWindow: 1_000_000 },
  ]);
const pricedList = () => listAvailableModels(pricedRegistry());

// ─── resolveRoleSplitTier: the role-split decision ──────────────────────────

test("role-split: a mechanical slice downgrades to the cheapest tier when a cheaper model exists", () => {
  const decision = resolveRoleSplitTier(TaskClassification.EDIT, CFG, "vend/mid", PRICED);
  assert.equal(decision.tier, "small");
  assert.equal(decision.modelSpec, "vend/mini");
  assert.equal(decision.downgraded, true);
  assert.equal(decision.escalated, false);
  assert.equal(decision.keptDefault, false);
  // The exposure the user SEES: the chosen price vs the reference price.
  assert.equal(decision.pricePerMTok, 0.4);
  assert.equal(decision.referencePricePerMTok, 5);
  assert.match(decision.reason, /vend\/mini/);
});

test("role-split: SCAN is mechanical and downgrades too", () => {
  const decision = resolveRoleSplitTier(TaskClassification.SCAN, CFG, "vend/mid", PRICED);
  assert.equal(decision.tier, "small");
  assert.equal(decision.modelSpec, "vend/mini");
  assert.equal(decision.downgraded, true);
});

test("role-split: a hard slice (synthesize/analyze) escalates to the configured big tier", () => {
  for (const classification of [TaskClassification.SYNTHESIZE, TaskClassification.ANALYZE]) {
    const decision = resolveRoleSplitTier(classification, CFG, "vend/mid", PRICED);
    assert.equal(decision.tier, "big");
    assert.equal(decision.modelSpec, "vend/flagship");
    assert.equal(decision.escalated, true);
    assert.equal(decision.downgraded, false);
    assert.equal(decision.pricePerMTok, 75);
    assert.equal(decision.referencePricePerMTok, 5);
  }
});

test("role-split: a hard slice with no configured big tier keeps the current medium behavior", () => {
  const cfg: ModelTierConfig = { tiers: { small: "vend/mini", medium: "vend/mid" } };
  const decision = resolveRoleSplitTier(TaskClassification.SYNTHESIZE, cfg, "vend/mid", PRICED);
  assert.equal(decision.tier, "medium");
  assert.equal(decision.modelSpec, "vend/mid");
  assert.equal(decision.keptDefault, true);
  assert.equal(decision.escalated, false);
  assert.match(decision.reason, /no "big" tier is configured/);
});

test("role-split: a hard slice with NO big and NO medium falls to the session default (undefined)", () => {
  const cfg: ModelTierConfig = { tiers: { small: "vend/mini" } };
  const decision = resolveRoleSplitTier(TaskClassification.SYNTHESIZE, cfg, "vend/mid", PRICED);
  assert.equal(decision.tier, "medium");
  assert.equal(decision.modelSpec, undefined);
  assert.equal(decision.keptDefault, true);
});

// ─── no-downgrade safety gate ───────────────────────────────────────────────

test("no-downgrade: a single-model config keeps the current default (no cheaper model exists)", () => {
  const cfg: ModelTierConfig = { tiers: { small: "vend/mid", medium: "vend/mid", big: "vend/mid" } };
  const decision = resolveRoleSplitTier(TaskClassification.EDIT, cfg, "vend/mid", PRICED);
  assert.equal(decision.downgraded, false);
  assert.equal(decision.keptDefault, true);
  assert.equal(decision.modelSpec, "vend/mid");
  assert.match(decision.reason, /no cheaper model/);
});

test("no-downgrade: unpriced neutral-name models are NOT treated as cheaper (conservative)", () => {
  const unpriced = [
    { spec: "vend/alpha", contextWindow: 8000 },
    { spec: "vend/beta", contextWindow: 128000 },
  ] satisfies RankableModel[];
  const cfg: ModelTierConfig = { tiers: { small: "vend/alpha", medium: "vend/beta", big: "vend/beta" } };
  const decision = resolveRoleSplitTier(TaskClassification.EDIT, cfg, "vend/beta", unpriced);
  assert.equal(decision.downgraded, false);
  assert.equal(decision.keptDefault, true);
  assert.equal(decision.modelSpec, "vend/beta", "current medium behavior kept exactly");
});

test("no-downgrade: an empty registry falls back to name hints — hint-signaling models still route cheap, neutral ones never do", () => {
  // The registry is empty (no prices, no context windows), so the capability
  // rank degrades to the documented name-hint order: "mini" is a positive
  // cheapness signal, so the downgrade is legitimate (the model really is the
  // cheap one by name).
  const hinted = resolveRoleSplitTier(TaskClassification.EDIT, CFG, "vend/mid", []);
  assert.equal(hinted.downgraded, true);
  assert.equal(hinted.modelSpec, "vend/mini");
  // Neutral-name models give NO positive signal → conservative keptDefault.
  const neutral: ModelTierConfig = { tiers: { small: "vend/alpha", medium: "vend/beta", big: "vend/gamma" } };
  const neutralDecision = resolveRoleSplitTier(TaskClassification.EDIT, neutral, "vend/beta", []);
  assert.equal(neutralDecision.downgraded, false);
  assert.equal(neutralDecision.keptDefault, true);
  assert.equal(neutralDecision.modelSpec, "vend/beta");
});

test("no-downgrade: a price-reversed registry (cheapest named tier is NOT cheaper) keeps the default", () => {
  const reversed = [
    { spec: "vend/mini", costOutput: 50 },
    { spec: "vend/mid", costOutput: 5 },
  ] satisfies RankableModel[];
  const decision = resolveRoleSplitTier(TaskClassification.EDIT, CFG, "vend/mid", reversed);
  assert.equal(decision.downgraded, false);
  assert.equal(decision.keptDefault, true);
  assert.equal(decision.modelSpec, "vend/mid");
});

// ─── isGenuinelyCheaperModel / cheapestTierModel / pricePerMTokOf ───────────

test("isGenuinelyCheaperModel needs a positive signal (price or small-hint)", () => {
  // Same spec → never cheaper.
  assert.equal(isGenuinelyCheaperModel("vend/mid", "vend/mid", PRICED), false);
  // Known prices decide.
  assert.equal(isGenuinelyCheaperModel("vend/mini", "vend/mid", PRICED), true);
  assert.equal(isGenuinelyCheaperModel("vend/flagship", "vend/mid", PRICED), false);
  // Both prices unknown → name-hint fallback (mini beats neutral, never a tie).
  const unpriced = [{ spec: "vend/alpha-mini" }, { spec: "vend/beta" }] satisfies RankableModel[];
  assert.equal(isGenuinelyCheaperModel("vend/alpha-mini", "vend/beta", unpriced), true);
  assert.equal(isGenuinelyCheaperModel("vend/beta", "vend/beta", unpriced), false);
  // Price known on one side only → hint decides (conservative tie → false).
  const halfPriced = [{ spec: "vend/alpha-mini", costOutput: 0.4 }, { spec: "vend/beta" }] satisfies RankableModel[];
  assert.equal(isGenuinelyCheaperModel("vend/alpha-mini", "vend/beta", halfPriced), true);
  assert.equal(isGenuinelyCheaperModel("vend/beta", "vend/alpha-mini", halfPriced), false);
});

test("cheapestTierModel picks the price-cheapest configured tier deterministically", () => {
  assert.deepEqual(cheapestTierModel(CFG, "vend/mid", PRICED), { tier: "small", modelSpec: "vend/mini" });
  // A config without any resolvable tier yields undefined.
  assert.equal(cheapestTierModel({ tiers: {} }, "vend/mid", PRICED), undefined);
  // Tier mapping to the sentinel resolves through mainModel (no cheaper signal).
  const inherit = { tiers: { small: "inherit:main", medium: "vend/mid" } } as ModelTierConfig;
  assert.deepEqual(cheapestTierModel(inherit, "vend/mid", PRICED), { tier: "small", modelSpec: "vend/mid" });
});

test("pricePerMTokOf reads the registry projection only", () => {
  assert.equal(pricePerMTokOf("vend/mini", PRICED), 0.4);
  assert.equal(pricePerMTokOf("vend/absent", PRICED), undefined);
  assert.equal(pricePerMTokOf(undefined, PRICED), undefined);
});

// ─── resolveAgentModelSpec: live resolution end-to-end ──────────────────────

test("resolveAgentModelSpec: untagged mechanical slice is economy-by-default under a configured config", () => {
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => CFG, undefined, "scan the codebase for dead code", pricedList),
    "vend/mini",
  );
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => CFG, undefined, "refactor the loader", pricedList),
    "vend/mini",
  );
});

test("resolveAgentModelSpec: untagged hard slice escalates to the configured big tier", () => {
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => CFG, undefined, "synthesize the findings", pricedList),
    "vend/flagship",
  );
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => CFG, undefined, "review this PR", pricedList),
    "vend/flagship",
  );
});

test("resolveAgentModelSpec: 'verify'/'validate' slices classify as hard (final-verify role)", () => {
  assert.equal(classifyTask("runtime", "verify the build passes"), TaskClassification.ANALYZE);
  assert.equal(classifyTask("runtime", "validate the migration"), TaskClassification.ANALYZE);
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => CFG, undefined, "verify the build passes", pricedList),
    "vend/flagship",
  );
});

test("resolveAgentModelSpec: explicit model and explicit tier still win over the role-split", () => {
  assert.equal(resolveAgentModelSpec({ model: "explicit/model" }, "vend/mid", () => CFG), "explicit/model");
  assert.equal(resolveAgentModelSpec({ tier: "big" }, "vend/mid", () => CFG), "vend/flagship");
  assert.equal(resolveAgentModelSpec({ tier: "medium" }, "vend/mid", () => CFG), "vend/mid");
});

test("resolveAgentModelSpec: prompt-less untagged calls keep the configured medium default (backward compat)", () => {
  assert.equal(resolveAgentModelSpec({}, "vend/mid", () => CFG), "vend/mid");
});

test("resolveAgentModelSpec: no cheaper model keeps the current default AND fires the visible notice", () => {
  const single: ModelTierConfig = { tiers: { small: "vend/mid", medium: "vend/mid", big: "vend/mid" } };
  let notice: { tier: string; requestedSpec: string | undefined; reason: string } | undefined;
  assert.equal(
    resolveAgentModelSpec(
      {},
      "vend/mid",
      () => single,
      undefined,
      "scan the codebase for dead code",
      pricedList,
      undefined,
      undefined,
      (info) => {
        notice = info;
      },
    ),
    "vend/mid",
    "no cheaper model → the current default is kept, never a silent quality loss",
  );
  assert.ok(notice, "the no-downgrade notice fires");
  assert.equal(notice!.tier, "medium");
  assert.equal(notice!.requestedSpec, "vend/mid");
  assert.match(notice!.reason, /no cheaper model/);
});

test("resolveAgentModelSpec: medium missing but a cheaper tier exists still downgrades; no cheaper → session default", () => {
  const noMedium: ModelTierConfig = { tiers: { small: "vend/mini" } };
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => noMedium, undefined, "scan the codebase", pricedList),
    "vend/mini",
    "the cheapest configured tier is cheaper than the session default, so it wins",
  );
  const onlyMedium: ModelTierConfig = { tiers: { small: "vend/mid" } };
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => onlyMedium, undefined, "scan the codebase", pricedList),
    undefined,
    "no cheaper tier than the session default → session default (undefined) exactly as before",
  );
});

test("resolveAgentModelSpec: the downgraded tier's thinking cap is applied (cheap model, low thinking)", () => {
  const cfg: ModelTierConfig = {
    tiers: { small: "vend/mini:xhigh", medium: "vend/mid", big: "vend/flagship" },
    thinkingCaps: { small: "low" },
  };
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => cfg, undefined, "scan the codebase", pricedList),
    "vend/mini:low",
    "the economy tier's spec is thinking-capped by its tier cap",
  );
});

test("resolveAgentModelSpec: the no-config economy path is untouched (scan=small / edit=medium / synth=big)", () => {
  const economyDefaults = { small: "vend/mini", medium: "vend/mid", big: "vend/flagship" };
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => null, undefined, "scan the codebase", pricedList, () => ({
      tiers: economyDefaults,
    })),
    "vend/mini",
  );
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => null, undefined, "refactor the loader", pricedList, () => ({
      tiers: economyDefaults,
    })),
    "vend/mid",
  );
  assert.equal(
    resolveAgentModelSpec({}, "vend/mid", () => null, undefined, "synthesize the findings", pricedList, () => ({
      tiers: economyDefaults,
    })),
    "vend/flagship",
  );
});

// ─── runWorkflow: exposure + replay safety ───────────────────────────────────

const ROLE_SPLIT_SCRIPT = `export const meta = { name: 'cost_model', description: 'role split exposure' }
const a = await agent('scan the codebase for dead code', { label: 'mechanical' })
const b = await agent('synthesize the findings into the handoff plan', { label: 'hard' })
return { a, b }`;

test("runWorkflow surfaces the role-split tier on agent start/end events", async () => {
  const agent = { async run() { return "ok"; } };
  const seen: Array<{ tier?: string; model?: string }> = [];
  await runWorkflow(ROLE_SPLIT_SCRIPT, {
    agent,
    persistLogs: false,
    runId: "cost-model-events",
    mainModel: "vend/mid",
    loadTierConfig: () => CFG,
    modelRegistry: pricedRegistry(),
    onAgentEnd: (e) => seen.push({ tier: e.tier, model: e.model }),
  });
  // mechanical → cheapest tier; hard → big tier.
  assert.deepEqual(seen, [
    { tier: "small", model: "vend/mini" },
    { tier: "big", model: "vend/flagship" },
  ]);
});

test("a downgraded untagged call's cached replay is invalidated by a registry change (registry-dependent routing)", async () => {
  let calls = 0;
  const agent = { async run() { calls++; return "ok"; } };
  const journal = new Map<string, JournalEntry>();
  const RUN_ID = "cost-model-fp";
  const options = (registry: ModelRegistry) => ({
    agent,
    persistLogs: false,
    runId: RUN_ID,
    mainModel: "vend/mid",
    loadTierConfig: () => CFG,
    modelRegistry: registry,
    onAgentJournal: (e: JournalEntry) => journal.set(`${e.runId ?? RUN_ID}:${e.index}`, e),
  });
  const registryA = mockRegistry([
    { provider: "vend", id: "mini", costOutput: 0.4, contextWindow: 8000 },
    { provider: "vend", id: "mid", costOutput: 5, contextWindow: 128000 },
    { provider: "vend", id: "flagship", costOutput: 75, contextWindow: 1_000_000 },
  ]);
  const registryB = mockRegistry([
    // Same model set, but mini is no longer cheaper than mid — the downgrade
    // disappears, so a cached economy-tier replay must NOT survive.
    { provider: "vend", id: "mini", costOutput: 50, contextWindow: 8000 },
    { provider: "vend", id: "mid", costOutput: 5, contextWindow: 128000 },
    { provider: "vend", id: "flagship", costOutput: 75, contextWindow: 1_000_000 },
  ]);
  const registryC = mockRegistry([
    // mini got CHEAPER but is still the cheapest — the decision (downgrade to
    // vend/mini, tierModel identical to registryA) does NOT change, yet a
    // cached economy-tier replay must still be invalidated: the downgrade is
    // registry-dependent and the fingerprint is what catches it.
    { provider: "vend", id: "mini", costOutput: 0.3, contextWindow: 8000 },
    { provider: "vend", id: "mid", costOutput: 5, contextWindow: 128000 },
    { provider: "vend", id: "flagship", costOutput: 75, contextWindow: 1_000_000 },
  ]);
  const script = `export const meta = { name: 'cost_model_fp', description: 'fp' }
return await agent('scan the codebase for dead code', { label: 'x' })`;

  await runWorkflow(script, options(registryA));
  assert.equal(calls, 1, "first run executes live");
  await runWorkflow(script, { ...options(registryA), resumeJournal: journal });
  assert.equal(calls, 1, "same registry replays from cache");
  await runWorkflow(script, { ...options(registryB), resumeJournal: journal });
  assert.equal(calls, 2, "a registry change that kills the downgrade invalidates the cached economy-tier replay");
  await runWorkflow(script, { ...options(registryC), resumeJournal: journal });
  assert.equal(
    calls,
    3,
    "a price change that keeps the downgrade STILL invalidates the cached replay (registry fingerprint on downgraded calls)",
  );
});

test("a kept-default untagged call replays across a registry change (config-only routing, no fingerprint)", async () => {
  let calls = 0;
  const agent = { async run() { calls++; return "ok"; } };
  const journal = new Map<string, JournalEntry>();
  const single: ModelTierConfig = { tiers: { small: "vend/mid", medium: "vend/mid", big: "vend/mid" } };
  const options = (registry: ModelRegistry) => ({
    agent,
    persistLogs: false,
    runId: "cost-model-nofp",
    mainModel: "vend/mid",
    loadTierConfig: () => single,
    modelRegistry: registry,
    onAgentJournal: (e: JournalEntry) => journal.set(`${e.runId}:${e.index}`, e),
  });
  const registryA = mockRegistry([{ provider: "vend", id: "mini", costOutput: 0.4, contextWindow: 8000 }]);
  const registryB = mockRegistry([{ provider: "vend", id: "mini", costOutput: 0.4, contextWindow: 8000 }]);  const script = `export const meta = { name: 'cost_model_nofp', description: 'nofp' }
return await agent('scan the codebase for dead code', { label: 'x' })`;

  await runWorkflow(script, options(registryA));
  assert.equal(calls, 1);
  await runWorkflow(script, { ...options(registryB), resumeJournal: journal });
  assert.equal(calls, 1, "no cheaper model → kept default → resolution is config-only → replay is registry-independent");
});
