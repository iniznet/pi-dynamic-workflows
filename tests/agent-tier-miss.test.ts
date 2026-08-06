import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveAgentModelSpec, WorkflowAgent } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { ModelTierConfig } from "../src/model-tier-config.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tier key-miss billing guard (#audit: model-tier-leak)
// ═══════════════════════════════════════════════════════════════════════════
// Root cause fixed: an explicit tier whose KEY is absent from the loaded
// model-tiers.json previously fell back to the MAIN agent's model via
// `?? mainModel` (silently — no warning, and the registry-miss throw could
// never fire because the main model is always registry-present). Every such
// subagent session bound and BILLED the main agent's model. The contract now
// is: key-miss resolves to undefined at the unit level and throws a named
// MODEL_NOT_FOUND at run() level; only the documented degrades survive
// (no-config fresh install → mainModel; untagged implicit-medium → session
// default).

const tierConfig: ModelTierConfig = {
  tiers: { small: "vendor/small", medium: "vendor/medium", big: "vendor/big" },
};
const loadCfg = () => tierConfig;
const noCfg = () => null;

test("resolveAgentModelSpec: tier key absent from a PRESENT config returns undefined — never the main model", () => {
  // The billing guard at the unit level: a configured-but-key-missing tier
  // must not collapse onto the main agent's model.
  assert.equal(resolveAgentModelSpec({ tier: "doesnotexist" }, "main/model", loadCfg), undefined);
  // ...even when mainModel is set and a sibling tier exists.
  const partial = () => ({ tiers: { small: "vendor/small", big: "inherit:main" } } as ModelTierConfig);
  assert.equal(resolveAgentModelSpec({ tier: "medium" }, "session/main-model", partial), undefined);
});

test("resolveAgentModelSpec: NO config file at all still degrades an explicit tier to the main model (fresh-install, documented)", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg), "main/model");
});

test("resolveAgentModelSpec: untagged agent with a config lacking the medium key returns undefined (session default path)", () => {
  const cfg = () => ({ tiers: { small: "vendor/small" } } as ModelTierConfig);
  assert.equal(resolveAgentModelSpec({}, "main/model", cfg), undefined);
});

test("WorkflowAgent.run(): an explicit tier whose key is missing from model-tiers.json throws MODEL_NOT_FOUND (never bills the main model)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-miss-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-miss-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      // Config exists but contains NO "small" key — the requested tier is a
      // key-miss, which must throw rather than silently substitute mainModel.
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { medium: "fauxtest/faux-model" } }));

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
      const registry = new ModelRegistry(runtime);
      // mainModel is registry-present — the OLD code would silently bind it
      // here; the guard must fire before any session is created.
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest/faux-model" });

      await assert.rejects(agent.run("task", { tier: "small", label: "tier-miss" }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
        assert.equal(error.recoverable, false, "a missing tier key is deterministic — retrying is pointless");
        assert.match(error.message, /not configured in model-tiers.json/);
        assert.match(error.message, /\/workflows-models/, "the remedy must be named");
        assert.equal(error.agentLabel, "tier-miss");
        return true;
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): an UNTAGGED agent (no tier) with a config lacking the medium key still degrades to the session default without throwing", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-medium-miss-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-medium-miss-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      // Config exists but has NO "medium" key — the implicit default tier for
      // untagged agents is absent, so the run must fall to the session default
      // (mainModel), NOT throw.
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { small: "fauxtest/faux-model" } }));

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
      const registry = new ModelRegistry(runtime);
      core.setResponses([fauxAssistantMessage("session-default-answer", { stopReason: "stop" })]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest/faux-model" });

      const text = await agent.run("task", { label: "untagged-medium-miss" });
      assert.ok(text.includes("session-default-answer"), "untagged run should complete via the session default");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): regression — an explicit tier PRESENT in config but unavailable in the registry still throws MODEL_NOT_FOUND", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-registry-miss-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-registry-miss-cwd-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      // The tier key EXISTS, but its model spec is not in the registry — the
      // existing fail-loud registry throw (agent.ts run()) must still fire.
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { medium: "deadprov/ghost-model" } }));

      const registry = {
        getAll: () => [{ provider: "fauxtest", id: "faux-model", name: "faux-model" } as any],
      } as any;

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest/faux-model" });
      await assert.rejects(agent.run("task", { tier: "medium", label: "registry-miss" }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /deadprov\/ghost-model/);
        return true;
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});