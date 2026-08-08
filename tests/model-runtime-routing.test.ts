/**
 * Guards the pi >= 0.80.8 subagent routing contract end-to-end.
 *
 * WorkflowAgent shares the HOST session's model catalog with each subagent by
 * reaching through the ModelRegistry facade's PRIVATE `runtime` field (see
 * runtimeOf in src/agent.ts) and passing that ModelRuntime to
 * createAgentSession. That access is cast through `unknown`, so a pi upgrade
 * renaming the field breaks routing SILENTLY: tsc stays green, mock-based
 * tests stay green, and subagents just fall back to a default-built runtime in
 * which extension-registered providers (e.g. ollama) do not exist.
 *
 * These tests are the loud tripwire: they use the real installed pi classes,
 * and the end-to-end test gives the subagent NO session.modelRuntime override,
 * so the scripted faux provider is reachable ONLY via runtimeOf(). If pi
 * renames the internals, this file fails and the fix is to update runtimeOf().
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  listAvailableModels,
  resolveAgentModelSpec,
  resolvePromptAwareTier,
  runtimeOf,
  WorkflowAgent,
} from "../src/agent.js";
import { buildDefaultTierConfig, type RankableModel } from "../src/model-tier-config.js";
import { WorkflowStateManager } from "../src/phases/state-machine.js";
import { runWorkflow } from "../src/workflow.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

test("runtimeOf reaches the ModelRuntime behind pi's real ModelRegistry facade (pi-internals contract)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-runtimeof-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      const registry = new ModelRegistry(runtime);
      assert.equal(
        runtimeOf(registry),
        runtime,
        "ModelRegistry's private `runtime` field no longer exposes its ModelRuntime — pi internals changed; update runtimeOf() in src/agent.ts",
      );
    });
  } finally {
    await rmForce(home);
  }
});

test("runtimeOf degrades to undefined (no throw) on a registry without a runtime field", () => {
  const mock = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as unknown as ModelRegistry;
  assert.equal(runtimeOf(mock), undefined);
});

test("a shared host ModelRegistry routes subagents to extension-registered providers (no session override)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-routing-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-routing-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest", {
        name: "Faux Test",
        // Required by custom-model validation; never dialed — streamSimple intercepts.
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      // The extension's exact wiring (extensions/workflow.ts session_start →
      // manager.setModelRegistry → WorkflowAgentOptions.modelRegistry): the
      // host registry facade is shared, and there is NO session.modelRuntime
      // override — the subagent can only reach "fauxtest" via runtimeOf().
      const registry = new ModelRegistry(runtime);
      core.setResponses([fauxAssistantMessage("routed-through-extension-provider", { stopReason: "stop" })]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const text = await agent.run("do the task", { label: "routing probe", model: "fauxtest/faux-model" });
      assert.ok(
        typeof text === "string" && text.includes("routed-through-extension-provider"),
        `subagent did not stream through the extension-registered provider (got: ${String(text).slice(0, 120)})`,
      );
    });
  } finally {
    await rmForce(home, cwd);
  }
});

// ─── GAP-2: pipeline-stage-aware prompt-tier routing ─────────────────────────

/**
 * Faux registry projection: three distinct-capability models so the ranked
 * default tier map (buildDefaultTierConfig) yields distinct small/big specs.
 * Distinct output costs make the rank deterministic (price signal dominates).
 */
const TIER_MODELS = [
  { spec: "fauxtest/faux-mini", costOutput: 1, contextWindow: 8000 },
  { spec: "fauxtest/faux-mid", costOutput: 2, contextWindow: 128000 },
  { spec: "fauxtest/faux-flagship", costOutput: 100, contextWindow: 1000000 },
] satisfies RankableModel[];

/** A recon prompt that ALSO uses synthesize phrasing — the GAP-2 divergence. */
const RECON_PROMPT = "scan the codebase and synthesize a ticket list";
const MAIN_MODEL = "fauxtest/faux-mid";

function expectedTierMap(): { small: string; medium: string; big: string } {
  const config = buildDefaultTierConfig(MAIN_MODEL, TIER_MODELS);
  return { small: config.tiers.small, medium: config.tiers.medium, big: config.tiers.big };
}

test("resolvePromptAwareTier threads the pipeline stage into classification (GAP-2)", () => {
  const tiers = expectedTierMap();
  // Early phase ("0"/"1"): the scan keyword wins before prompt-level rules,
  // keeping recon on the cheap tier despite its synthesize phrasing.
  assert.equal(resolvePromptAwareTier(RECON_PROMPT, MAIN_MODEL, TIER_MODELS, undefined, "0"), tiers.small);
  assert.equal(resolvePromptAwareTier(RECON_PROMPT, MAIN_MODEL, TIER_MODELS, undefined, "1"), tiers.small);
  // A post-pipeline stage is not early: prompt-level synthesize wins → big.
  assert.equal(resolvePromptAwareTier(RECON_PROMPT, MAIN_MODEL, TIER_MODELS, undefined, "2"), tiers.big);
  // Backward compatibility: no stage (or an explicit "runtime") classifies
  // exactly as the pre-fix hardcode did.
  assert.equal(resolvePromptAwareTier(RECON_PROMPT, MAIN_MODEL, TIER_MODELS), tiers.big);
  assert.equal(resolvePromptAwareTier(RECON_PROMPT, MAIN_MODEL, TIER_MODELS, undefined, "runtime"), tiers.big);
});

test("resolveAgentModelSpec threads the pipeline stage into the prompt-aware fallback (GAP-2)", () => {
  const tiers = expectedTierMap();
  const resolveWithStage = (phase?: string) =>
    resolveAgentModelSpec(
      { tier: "small" },
      MAIN_MODEL,
      () => null,
      undefined,
      RECON_PROMPT,
      () => TIER_MODELS,
      undefined,
      phase,
    );
  assert.equal(resolveWithStage("0"), tiers.small);
  assert.equal(resolveWithStage("1"), tiers.small);
  assert.equal(resolveWithStage(undefined), tiers.big, "no stage keeps the pre-fix runtime classification");
});

test("a pipeline run routes wayfinder/prewalk recon to the small tier and post-pipeline synthesis to big (GAP-2)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-gap2-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-gap2-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [
      { id: "faux-mini", name: "Faux Mini", contextWindow: 8000, maxTokens: 4096 },
      { id: "faux-mid", name: "Faux Mid", contextWindow: 128000, maxTokens: 4096 },
      { id: "faux-flagship", name: "Faux Flagship", contextWindow: 1000000, maxTokens: 8192 },
    ],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest", {
        name: "Faux Test",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      // Mark the faux provider configured so listAvailableModels (getAvailable)
      // sees its three models — the prompt-aware fallback ranks them.
      await runtime.setRuntimeApiKey("fauxtest", "faux-key");
      const registry = new ModelRegistry(runtime);
      core.setResponses([
        fauxAssistantMessage("recon done", { stopReason: "stop" }),
        fauxAssistantMessage("synthesis done", { stopReason: "stop" }),
      ]);

      const stateManager = new WorkflowStateManager(cwd);
      const script = `export const meta = { name: 'gap2', description: 'pipeline tier routing' }
const recon = await agent('${RECON_PROMPT}', { tier: 'small', label: 'wayfinder-recon' })
const final = await agent('summarize the session into the handoff plan', { tier: 'big', label: 'final-synthesis' })
return { recon, final }`;

      const resolvedByLabel = new Map<string, string>();
      const result = await runWorkflow<{ recon: string; final: string }>(script, {
        cwd,
        agent: new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: MAIN_MODEL }),
        persistLogs: false,
        runId: "gap2-pipeline",
        mainModel: MAIN_MODEL,
        loadTierConfig: () => null,
        pipeline: {
          stateManager,
          dir: cwd,
          prompt: "Add a /health endpoint returning JSON status with uptime and latency metrics",
        },
        onAgentEnd: (e) => {
          resolvedByLabel.set(e.label, e.model ?? "");
        },
      });

      const tiers = buildDefaultTierConfig(MAIN_MODEL, listAvailableModels(registry)).tiers;
      const pipelineState = await stateManager.getState();
      assert.equal(pipelineState.activePhase, 2, "the pipeline advanced through wayfinder/prewalk to Phase 2");
      assert.equal(
        resolvedByLabel.get("wayfinder-recon"),
        tiers.small,
        "wayfinder/prewalk recon must classify to the small tier — its synthesize phrasing must not escalate it",
      );
      assert.equal(resolvedByLabel.get("final-synthesis"), tiers.big, "post-pipeline synthesis stays on the big tier");
      assert.ok(
        typeof result.result === "object" && result.result !== null && result.result.recon.includes("recon done"),
        "the recon subagent actually streamed through the faux provider",
      );
    });
  } finally {
    await rmForce(home, cwd);
  }
});
