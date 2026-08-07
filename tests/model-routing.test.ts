import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTask,
  type ModelRoutingConfig,
  parseModelRoutingFromMeta,
  resolveModelForPhase,
  TaskClassification,
  tierNameForClassification,
  tierNameForTask,
} from "../src/model-routing.js";

test("resolveModelForPhase returns default when no phases match", () => {
  assert.equal(resolveModelForPhase("Discovery", { defaultModel: "default-model", routes: [] }), "default-model");
});

test("resolveModelForPhase returns undefined when no default and no routes", () => {
  assert.equal(resolveModelForPhase("Discovery", { routes: [] }), undefined);
});

test("resolveModelForPhase returns defaultModel when phase is undefined", () => {
  assert.equal(resolveModelForPhase(undefined, { defaultModel: "m", routes: [] }), "m");
});

test("resolveModelForPhase matches a phase title EXACTLY (no fuzzy substring)", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [{ phasePattern: "Research", model: "explorer-model" }],
  };
  assert.equal(resolveModelForPhase("Research", config), "explorer-model");
  // "Deep Research" must NOT fuzzy-match the "Research" route — falls to default.
  assert.equal(resolveModelForPhase("Deep Research", config), "default-model");
  // case-sensitive
  assert.equal(resolveModelForPhase("research", config), "default-model");
});

test("resolveModelForPhase prefers an exact route over the default", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [{ phasePattern: "Scan", model: "scan-model" }],
  };
  assert.equal(resolveModelForPhase("Scan", config), "scan-model");
});

test("resolveModelForPhase uses the first matching route", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [
      { phasePattern: "Scan", model: "scan-model" },
      { phasePattern: "Scan", model: "other-model" },
    ],
  };
  assert.equal(resolveModelForPhase("Scan", config), "scan-model");
});

test("resolveModelForPhase uses regex when useRegex is true", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "phase-\\d+", model: "regex-model", useRegex: true }],
  };
  assert.equal(resolveModelForPhase("phase-3", config), "regex-model");
  assert.equal(resolveModelForPhase("phase-42", config), "regex-model");
  assert.equal(resolveModelForPhase("Not Matching", config), undefined);
});

test("resolveModelForPhase handles invalid regex gracefully (skips)", () => {
  const config: ModelRoutingConfig = {
    defaultModel: "default-model",
    routes: [{ phasePattern: "[invalid", model: "bad", useRegex: true }],
  };
  assert.equal(resolveModelForPhase("anything", config), "default-model");
});

test("resolveModelForPhase regex is case-insensitive", () => {
  const config: ModelRoutingConfig = {
    routes: [{ phasePattern: "^scan", model: "m", useRegex: true }],
  };
  assert.equal(resolveModelForPhase("SCAN", config), "m");
});

test("parseModelRoutingFromMeta extracts routes from phases", () => {
  const config = parseModelRoutingFromMeta([
    { title: "Scan", model: "fast-model" },
    { title: "Analyze" },
    { title: "Report", model: "slow-model" },
  ]);
  assert.equal(config.routes.length, 2);
  assert.equal(config.routes[0].phasePattern, "Scan");
  assert.equal(config.routes[0].model, "fast-model");
  assert.equal(config.routes[1].phasePattern, "Report");
  assert.equal(config.routes[1].model, "slow-model");
});

test("parseModelRoutingFromMeta carries meta.model as the default", () => {
  const config = parseModelRoutingFromMeta([{ title: "Scan", model: "fast" }], "meta-default");
  assert.equal(config.defaultModel, "meta-default");
  // A phase with no exact route resolves to the meta default.
  assert.equal(resolveModelForPhase("Unrouted", config), "meta-default");
  assert.equal(resolveModelForPhase("Scan", config), "fast");
});

test("parseModelRoutingFromMeta returns empty routes / no default when nothing declared", () => {
  const config = parseModelRoutingFromMeta(undefined);
  assert.deepEqual(config.routes, []);
  assert.equal(config.defaultModel, undefined);
});

test("parseModelRoutingFromMeta returns empty routes when phases have no models", () => {
  assert.deepEqual(parseModelRoutingFromMeta([{ title: "Scan" }, { title: "Report" }]).routes, []);
});

// ─── classifyTask (folded from engine/tier-router.ts, P2-1) ────────────────

test("classifyTask defaults to EDIT for a neutral prompt", () => {
  assert.equal(classifyTask("3", "finish the migration"), TaskClassification.EDIT);
});

test("classifyTask scans early reconnaissance phases by scan keywords", () => {
  assert.equal(classifyTask("0", "find the failing test"), TaskClassification.SCAN);
  assert.equal(classifyTask("phase-1", "grep for TODO markers"), TaskClassification.SCAN);
});

test("classifyTask maps synthesize and analyze keywords by prompt (any phase)", () => {
  assert.equal(classifyTask("3", "synthesize the findings"), TaskClassification.SYNTHESIZE);
  assert.equal(classifyTask("2", "review this PR"), TaskClassification.ANALYZE);
});

test("tierNameForClassification maps scan to small, edit to medium, analysis to big", () => {
  assert.equal(tierNameForClassification(TaskClassification.SCAN), "small");
  assert.equal(tierNameForClassification(TaskClassification.EDIT), "medium");
  assert.equal(tierNameForClassification(TaskClassification.ANALYZE), "big");
  assert.equal(tierNameForClassification(TaskClassification.SYNTHESIZE), "big");
});

test("tierNameForTask classifies the prompt and returns the fitting tier (i3 wiring)", () => {
  assert.equal(tierNameForTask("3", "synthesize the findings"), "big");
  assert.equal(tierNameForTask("2", "review this PR"), "big");
  assert.equal(tierNameForTask("0", "find the failing test"), "small");
  assert.equal(tierNameForTask("3", "refactor the loader"), "medium");
});

test("classifyTask keyword matching is case-insensitive substring matching", () => {
  assert.equal(classifyTask("3", "IMPLEMENT the loader"), TaskClassification.EDIT);
  assert.equal(classifyTask("0", "Summarize phase 1"), TaskClassification.SYNTHESIZE);
});

test("classifyTask prioritizes synthesize/analyze over scan for non-early phases", () => {
  // The early-phase branch returns SCAN before falling through to prompt-wide
  // rules; outside phases 0/1 the prompt-wide synthesize rule wins instead.
  assert.equal(classifyTask("0", "scan for final summary"), TaskClassification.SCAN);
  assert.equal(classifyTask("2", "scan for final summary"), TaskClassification.SYNTHESIZE);
});

// ─── GAP-2: pipeline-stage-aware early-phase classification ─────────────────

test("classifyTask early-phase identifiers phase-0/phase1 classify scan prompts to SCAN", () => {
  assert.equal(classifyTask("phase-0", "scan the imports"), TaskClassification.SCAN);
  assert.equal(classifyTask("phase1", "scan the imports"), TaskClassification.SCAN);
});

test("classifyTask early-phase branch: an edit prompt in phase 0/1 classifies to EDIT", () => {
  assert.equal(classifyTask("0", "edit the loader"), TaskClassification.EDIT);
  assert.equal(classifyTask("1", "edit the loader"), TaskClassification.EDIT);
});

test("classifyTask early-phase scan priority beats the prompt-level synthesize rule (GAP-2 signal)", () => {
  // The exact divergence prompt-aware tier routing threads the pipeline stage
  // to exploit: inside phases 0/1 (wayfinder/prewalk) a recon prompt that also
  // uses synthesize phrasing stays SCAN (cheap tier); outside those phases the
  // prompt-wide synthesize rule escalates it to SYNTHESIZE (big tier).
  assert.equal(classifyTask("0", "scan the codebase and synthesize a ticket list"), TaskClassification.SCAN);
  assert.equal(classifyTask("1", "scan the codebase and synthesize a ticket list"), TaskClassification.SCAN);
  assert.equal(classifyTask("2", "scan the codebase and synthesize a ticket list"), TaskClassification.SYNTHESIZE);
  assert.equal(
    classifyTask("runtime", "scan the codebase and synthesize a ticket list"),
    TaskClassification.SYNTHESIZE,
  );
});

test("tierNameForTask maps early-phase recon to the small tier (GAP-2)", () => {
  assert.equal(tierNameForTask("0", "scan the codebase and synthesize a ticket list"), "small");
  assert.equal(tierNameForTask("1", "scan the codebase for failing tests"), "small");
  assert.equal(tierNameForTask("phase-0", "find the failing test"), "small");
  assert.equal(tierNameForTask("runtime", "scan the codebase and synthesize a ticket list"), "big");
});
