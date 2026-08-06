import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRunOptions } from "../../../src/agent.js";
import {
  DEFAULT_EXCLUDED_SUBAGENT_TOOLS,
  listAvailableModelSpecs,
  resolveAgentModelSpec,
  resolvePromptAwareTier,
  subagentExcludedTools,
  WorkflowAgent,
} from "../../../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";
import { resolveModelSpecWithThinking } from "../../../src/model-spec.js";
import type { ModelTierConfig, RankableModel } from "../../../src/model-tier-config.js";
import { withFakeHome, withFakeHomeAsync } from "../../helpers/fake-home.js";

// Private methods used for testing - cast to this type to access them without `any`
type WorkflowAgentPrivates = {
  buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string;
  lastAssistantText(messages: unknown[]): string;
  finalAssistantText(messages: unknown[]): string;
  createSessionManager(): { isPersisted(): boolean; getCwd(): string };
};

// ═══════════════════════════════════════════════════════════════════════
// persistAgentSessions — in-memory by default, file-backed keyed by project cwd
// ═══════════════════════════════════════════════════════════════════════

test("WorkflowAgent uses an in-memory session manager by default", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
  assert.equal(manager.isPersisted(), false, "default must stay in-memory (back-compat)");
});

test("WorkflowAgent with persistAgentSessions=false explicitly stays in-memory", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", persistAgentSessions: false });
  const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
  assert.equal(manager.isPersisted(), false);
});

test("WorkflowAgent with persistAgentSessions=true creates a file-backed manager keyed by the project cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-agent-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
      const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
      assert.equal(manager.isPersisted(), true, "flag must yield a file-backed session manager");
      // Sessions must be keyed by the runner's project cwd — never a per-call
      // worktree cwd — so transcripts group under the project's session dir.
      // createSessionManager() takes no per-call cwd by design; assert the
      // manager saw the project cwd.
      assert.equal(manager.getCwd(), projectCwd);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkflowAgent degrades to in-memory when the session directory can't be created", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-agent-fail-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      // Pre-occupy the sessions directory with a plain file so the SDK's
      // mkdirSync(recursive) inside SessionManager.create() throws ENOTDIR —
      // simulating a permissions/disk-full failure at session-creation time.
      const sessionsPath = join(fakeHome, ".pi", "agent", "sessions");
      mkdirSync(dirname(sessionsPath), { recursive: true });
      writeFileSync(sessionsPath, "not a directory");

      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
        const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
        assert.equal(manager.isPersisted(), false, "must degrade to in-memory rather than throw");
        assert.ok(
          warnings.some((args) => String(args[0]).includes("persistAgentSessions")),
          "should log a warning about the degradation",
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listAvailableModelSpecs returns an array (empty when no auth configured)", () => {
  const result = listAvailableModelSpecs();
  assert.ok(Array.isArray(result), "should always return an array");
  // On CI or fresh installs there may be no models configured
  // The important thing is it doesn't throw
});

test("listAvailableModelSpecs entries have provider/model format when non-empty", () => {
  const result = listAvailableModelSpecs();
  for (const spec of result) {
    assert.ok(spec.includes("/"), `model spec "${spec}" should use provider/id format`);
    const [provider, id] = spec.split("/");
    assert.ok(provider.length > 0, "provider should not be empty");
    assert.ok(id.length > 0, "model id should not be empty");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveAgentModelSpec — model precedence: explicit model > tier > main model
// ═══════════════════════════════════════════════════════════════════════════

const tierConfig: ModelTierConfig = {
  tiers: { small: "vendor/small", medium: "vendor/medium", big: "vendor/big" },
};
const loadCfg = () => tierConfig;
const noCfg = () => null;

test("resolveAgentModelSpec: explicit model wins over tier (the precedence bug fix)", () => {
  // Even with a tier set AND a config that resolves it, an explicit model wins.
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", loadCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: explicit model wins even when no config exists", () => {
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", noCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: tier resolves from config when no explicit model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "big" }, "main/model", loadCfg), "vendor/big");
});

test("resolveAgentModelSpec: unconfigured tier (no config file) degrades to the main model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg), "main/model");
});

test("resolveAgentModelSpec: a tier key absent from the loaded config returns undefined — never the main model (billing guard)", () => {
  assert.equal(resolveAgentModelSpec({ tier: "unknown-tier" }, "main/model", loadCfg), undefined);
});

test("resolveAgentModelSpec: a tier configured to inherit:main resolves to the session's main model (G6)", () => {
  const inheritCfg = () => ({ tiers: { small: "vendor/small", big: "inherit:main" } });
  assert.equal(resolveAgentModelSpec({ tier: "big" }, "session/main-model", inheritCfg), "session/main-model");
  // An explicit model still wins over an inherit:main tier.
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "big" }, "session/main-model", inheritCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: an unknown tier name resolves to undefined even when a sibling tier uses inherit:main", () => {
  const cfg = () => ({ tiers: { small: "vendor/small", big: "inherit:main" } });
  assert.equal(resolveAgentModelSpec({ tier: "doesnotexist" }, "session/main-model", cfg), undefined);
});

test("resolvePromptAwareTier: classifies the prompt and picks the fitting tier from the ranked registry (i3)", () => {
  const models = [
    { spec: "vendor/a-mini", costOutput: 0.4 },
    { spec: "vendor/b-mid", costOutput: 5 },
    { spec: "vendor/c-opus", costOutput: 75 },
  ] satisfies RankableModel[];
  assert.equal(resolvePromptAwareTier("find the failing test", "main/model", models), "vendor/a-mini");
  assert.equal(resolvePromptAwareTier("refactor the loader", "main/model", models), "vendor/b-mid");
  assert.equal(resolvePromptAwareTier("synthesize the findings", "main/model", models), "vendor/c-opus");
});

test("resolvePromptAwareTier: degrades to mainModel on an empty registry", () => {
  assert.equal(resolvePromptAwareTier("synthesize the findings", "main/model", []), "main/model");
});

test("resolveAgentModelSpec: unconfigured tier with a prompt uses the prompt-aware default", () => {
  const models = [
    { spec: "vendor/a-mini", costOutput: 0.4 },
    { spec: "vendor/b-mid", costOutput: 5 },
    { spec: "vendor/c-opus", costOutput: 75 },
  ] satisfies RankableModel[];
  assert.equal(
    resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg, undefined, "find the failing test", () => models),
    "vendor/a-mini",
  );
  assert.equal(
    resolveAgentModelSpec({ tier: "big" }, "main/model", noCfg, undefined, "synthesize the findings", () => models),
    "vendor/c-opus",
  );
});

test("resolveAgentModelSpec: prompt-aware fallback degrades to mainModel on an empty registry", () => {
  assert.equal(
    resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg, undefined, "find the failing test", () => []),
    "main/model",
  );
});

test("resolveAgentModelSpec: an existing config still wins over the prompt-aware default", () => {
  const models = [{ spec: "vendor/a-mini", costOutput: 0.4 }];
  const cfg = {
    tiers: { small: "configured/small", medium: "configured/medium", big: "configured/big" },
  } satisfies ModelTierConfig;
  assert.equal(
    resolveAgentModelSpec(
      { tier: "big" },
      "main/model",
      () => cfg,
      undefined,
      "synthesize the findings",
      () => models,
    ),
    "configured/big",
  );
});

test("resolveAgentModelSpec: untagged agent defaults to the configured medium tier", () => {
  // The "set tier but nothing changed" fix: an agent with no model and no tier
  // falls back to the user's medium tier when a config exists.
  assert.equal(resolveAgentModelSpec({}, "main/model", loadCfg), "vendor/medium");
});

test("resolveAgentModelSpec: untagged agent with NO config falls through to session default", () => {
  assert.equal(resolveAgentModelSpec({}, "main/model", noCfg), undefined);
});

test("resolveAgentModelSpec: untagged agent with a config lacking a medium tier => session default", () => {
  const noMedium = () => ({ tiers: { small: "vendor/small" } });
  assert.equal(resolveAgentModelSpec({}, "main/model", noMedium), undefined);
});

test("resolveAgentModelSpec: tier with no main model and no config yields undefined", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, undefined, noCfg), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent#loadTierConfig — memoize model-tiers.json once per instance
// (perf fix: resolveAgentModelSpec's loadConfig previously re-read+parsed the
// file from disk on every run() call for any agent without an explicit
// options.model, which is a sync fs read on the hot per-agent path)
// ═══════════════════════════════════════════════════════════════════════════

type WorkflowAgentTierPrivates = {
  loadTierConfig(loader?: () => ModelTierConfig | null): ModelTierConfig | null;
};

test("WorkflowAgent#loadTierConfig: the loader is invoked at most once across repeated calls", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  let calls = 0;
  const loader = () => {
    calls++;
    return tierConfig;
  };

  const first = agent.loadTierConfig(loader);
  const second = agent.loadTierConfig(loader);
  // Even a loader that would blow up if called proves the memoized branch
  // never reaches the loader again.
  const third = agent.loadTierConfig(() => {
    throw new Error("loader must not be invoked again once memoized");
  });

  assert.equal(calls, 1, "the real loader should only run once");
  assert.deepEqual(first, tierConfig);
  assert.equal(second, first, "repeated calls must return the memoized value");
  assert.equal(third, first);
});

test("WorkflowAgent#loadTierConfig: a legitimately-null config (no file) is memoized too, not re-checked", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  let calls = 0;
  const loader = () => {
    calls++;
    return null;
  };

  assert.equal(agent.loadTierConfig(loader), null);
  assert.equal(agent.loadTierConfig(loader), null);
  assert.equal(calls, 1, "null is a valid memoized result, not a 'try again' signal");
});

test("WorkflowAgent#loadTierConfig: memoization is per-instance (two agents, two runs, don't leak into each other)", () => {
  const a = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  const b = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  const cfgA: ModelTierConfig = { tiers: { medium: "vendor-a/model" } };
  const cfgB: ModelTierConfig = { tiers: { medium: "vendor-b/model" } };

  assert.equal(
    a.loadTierConfig(() => cfgA),
    cfgA,
  );
  assert.equal(
    b.loadTierConfig(() => cfgB),
    cfgB,
  );
  // `a` stays pinned to cfgA even when handed a different loader later — a
  // fresh WorkflowAgent per run (the production lifetime; see workflow.ts's
  // `new WorkflowAgent(options)` per runWorkflow() call) means two runs with
  // different on-disk configs still each see their own correct snapshot,
  // without a process-global cache leaking state across them.
  assert.equal(
    a.loadTierConfig(() => cfgB),
    cfgA,
  );
});

test("WorkflowAgent.run(): tier routing resolves correctly through the real (non-injected) disk loader, read only once across two run() calls", async () => {
  // End-to-end proof that memoization doesn't break the real wiring: writes an
  // actual model-tiers.json to a fake home, runs two real subagents against a
  // faux (no-network) provider, and confirms both resolve the tier-configured
  // model AND that the underlying config object is reused (same reference)
  // across both run() calls rather than re-read/re-parsed.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-memo-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-memo-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
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
      core.setResponses([
        fauxAssistantMessage("tier-routed-first", { stopReason: "stop" }),
        fauxAssistantMessage("tier-routed-second", { stopReason: "stop" }),
      ]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const spy = test.mock.method(agent as unknown as WorkflowAgentTierPrivates, "loadTierConfig");

      const first = await agent.run("task one", { label: "a", tier: "medium" });
      const second = await agent.run("task two", { label: "b", tier: "medium" });

      assert.ok(first.includes("tier-routed-first"), "first agent should route through the tiered faux model");
      assert.ok(second.includes("tier-routed-second"), "second agent should route through the tiered faux model");

      assert.equal(spy.mock.callCount(), 2, "loadTierConfig() is called once per run(), as expected");
      const [firstResult, secondResult] = spy.mock.calls.map((c) => c.result);
      assert.equal(
        firstResult,
        secondResult,
        "the SAME config object must be reused across run() calls — the file was read/parsed only once",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): a tier configured to inherit:main resolves to the session's main model and completes (G6)", async () => {
  // PRD Task 3 acceptance: `"big": "inherit:main"` in model-tiers.json must
  // route the run through the active chat session model, not a literal spec
  // (which previously reached the registry and threw MODEL_NOT_FOUND).
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-inherit-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-inherit-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-inherit",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { big: "inherit:main" } }));

      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-inherit", {
        name: "Faux Test Inherit",
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
      core.setResponses([fauxAssistantMessage("inherited-main-answer", { stopReason: "stop" })]);

      // mainModel = the active chat session model; tier "big" must inherit it.
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        mainModel: "fauxtest-inherit/faux-model",
      });
      const text = await agent.run("task", { tier: "big", label: "inherit-main" });
      assert.ok(text.includes("inherited-main-answer"), "run should complete via the inherited session model");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): a genuinely unknown model spec behind another tier still throws MODEL_NOT_FOUND even when a sibling tier uses inherit:main (G6 scoping)", async () => {
  // The inherit:main special case must not swallow the fail-loud guarantee for
  // genuinely broken tier entries: only the exact sentinel may resolve to the
  // session model; anything else still throws MODEL_NOT_FOUND.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-inherit-dead-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-inherit-dead-cwd-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(
        join(tiersDir, "model-tiers.json"),
        JSON.stringify({ tiers: { big: "inherit:main", medium: "deadprov/ghost-model" } }),
      );

      const registry = {
        getAll: () => [{ provider: "fauxtest", id: "faux-model", name: "faux-model" } as any],
      } as any;

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest/faux-model" });
      await assert.rejects(agent.run("task", { tier: "medium", label: "scoped-tier" }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
        assert.equal(error.recoverable, false, "a broken tier pin is deterministic — retrying it is pointless");
        assert.match(error.message, /deadprov\/ghost-model/);
        assert.equal(error.agentLabel, "scoped-tier");
        return true;
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent.run(): opts.schema must be a top-level JSON object schema
// (#330 audit) — a non-object schema (e.g. array/primitive) would otherwise
// reach a strict OpenAI-compatible provider (DeepSeek) as an invalid tool
// parameters schema and fail with an opaque transport-level 400.
// ═══════════════════════════════════════════════════════════════════════════

test("WorkflowAgent.run() rejects a non-object top-level schema before touching the model registry", async () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  await assert.rejects(
    agent.run("task", { schema: Type.Array(Type.Object({ finding: Type.String() })) }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /opts\.schema must be a top-level JSON object schema/);
      assert.match(error.message, /got type: array/);
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent.run(): an unresolvable `model` spec must fail loud (#131) — no
// more silent fallback to the session default with only a console.warn.
// ═══════════════════════════════════════════════════════════════════════════

test("WorkflowAgent.run() throws MODEL_NOT_FOUND for an unresolvable model spec instead of silently using the session default", async () => {
  const registry = {
    getAll: () => [{ provider: "openrouter", id: "anthropic/claude-opus-4-8", name: "Claude" } as any],
    getAvailable: () => [],
    find: () => undefined,
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: registry });
  await assert.rejects(
    agent.run("task", { model: "totally-unknown/does-not-exist", label: "pin" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
      assert.equal(error.recoverable, false, "a bad pin is deterministic — retrying it is pointless");
      assert.match(error.message, /totally-unknown\/does-not-exist/);
      assert.equal(error.agentLabel, "pin");
      return true;
    },
  );
});

test("WorkflowAgent.run() still resolves a known model spec normally (no regression)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-model-pin-ok-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-model-pin-ok-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-pin",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-pin", {
        name: "Faux Test Pin",
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
      core.setResponses([fauxAssistantMessage("pinned-model-answer", { stopReason: "stop" })]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const text = await agent.run("task", { model: "fauxtest-pin/faux-model", label: "pin-ok" });
      assert.ok(text.includes("pinned-model-answer"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent.run(): asymmetric fail-loud behavior for a tier that resolves
// to an unavailable model (#131 follow-up) —
//   - an EXPLICIT tier (script wrote `tier: "x"`) is just as loud as an
//     explicit model pin: MODEL_NOT_FOUND, naming the tier and what it
//     resolved to.
//   - the IMPLICIT default "medium" tier an UNTAGGED agent (no model, no
//     tier) gets routed through never asked for that model, so it degrades
//     to the session default instead — but only after firing onModelFallback
//     so the degrade is still visible in the run's own log stream, not a
//     silent continuation.
// ═══════════════════════════════════════════════════════════════════════════

test("WorkflowAgent.run() throws MODEL_NOT_FOUND naming the tier when an EXPLICIT tier resolves to an unavailable model", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-explicit-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-explicit-cwd-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { big: "deadprov/ghost-model" } }));

      const registry = {
        getAll: () => [{ provider: "fauxtest", id: "faux-model", name: "faux-model" } as any],
      } as any;

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      await assert.rejects(agent.run("task", { tier: "big", label: "explicit-tier" }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /tier "big"/);
        assert.match(error.message, /model-tiers\.json/);
        assert.match(error.message, /deadprov\/ghost-model/);
        assert.equal(error.agentLabel, "explicit-tier");
        return true;
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): an untagged agent's IMPLICIT default medium tier degrades to the session default (not a throw) when it resolves to an unavailable model, and fires onModelFallback at most once per instance", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-implicit-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-implicit-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-implicit",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      // "medium" (the implicit default) resolves to a dead spec; the run must
      // still complete by falling back to the session default (the only
      // registered/available model here: fauxtest-implicit/faux-model).
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { medium: "deadprov/ghost-model" } }));

      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-implicit", {
        name: "Faux Test Implicit",
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
      core.setResponses([
        fauxAssistantMessage("untagged-first", { stopReason: "stop" }),
        fauxAssistantMessage("untagged-second", { stopReason: "stop" }),
      ]);

      const fallbacks: Array<{ tier: string; requestedSpec: string }> = [];
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const onModelFallback = (info: { tier: string; requestedSpec: string }) => fallbacks.push(info);

      const first = await agent.run("task one", { label: "untagged-1", onModelFallback });
      const second = await agent.run("task two", { label: "untagged-2", onModelFallback });

      assert.ok(first.includes("untagged-first"), "first untagged agent should still complete via session default");
      assert.ok(second.includes("untagged-second"), "second untagged agent should still complete via session default");
      assert.deepEqual(
        fallbacks,
        [{ tier: "medium", requestedSpec: "deadprov/ghost-model" }],
        "onModelFallback fires exactly once across both run() calls on the same instance",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run() still completes with a normal object schema (no regression)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-schema-ok-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-schema-ok-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-schema",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-schema", {
        name: "Faux Test Schema",
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
      core.setResponses([
        fauxAssistantMessage(fauxToolCall("structured_output", { verdict: "ok" }), { stopReason: "toolUse" }),
      ]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest-schema/faux-model" });
      const result = await agent.run("task", { schema: Type.Object({ verdict: Type.String() }) });

      assert.deepEqual(result, { verdict: "ok" });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent constructor accepts all option shapes without throwing", () => {
  const optionSets = [
    undefined,
    { cwd: "/tmp" },
    { cwd: "/tmp", instructions: "custom instruction" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test" },
    { cwd: "/tmp", excludeTools: ["pi-subagents"] },
    { cwd: "/tmp", mainModel: "openai/gpt-4.1" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test", mainModel: "openai/gpt-4.1" },
    {
      cwd: "/tmp",
      modelRegistry: {
        getAvailable: () => [{ provider: "mock", id: "model" }],
        find: () => undefined,
        getAll: () => [],
      } as any,
    },
  ];
  for (const opts of optionSets) {
    const agent = opts ? new WorkflowAgent(opts) : new WorkflowAgent();
    assert.ok(agent instanceof WorkflowAgent, `agent should be constructed for options: ${JSON.stringify(opts)}`);
  }
});

test("DEFAULT_EXCLUDED_SUBAGENT_TOOLS denies the recursive orchestration tools (#107)", () => {
  // Subagents must never see the globally-registered orchestration tools, or they
  // could start independent nested workflows that bypass the parent run's caps.
  // This is the always-on denylist folded into every subagent session; the guard
  // is a regression fence so it can't be silently narrowed.
  assert.deepEqual(DEFAULT_EXCLUDED_SUBAGENT_TOOLS, ["workflow", "workflow_control"]);
});

test("subagentExcludedTools always includes the defaults, plus caller/session names (#107)", () => {
  // This is what run() passes to createAgentSession as excludeTools. Fencing the
  // merge here catches a spread-order regression that drops the defaults — which
  // a deepEqual on the constant alone would miss.
  assert.deepEqual(subagentExcludedTools(), ["workflow", "workflow_control"]);
  assert.deepEqual(subagentExcludedTools(["pi-subagents"]), ["workflow", "workflow_control", "pi-subagents"]);
  const merged = subagentExcludedTools(["extra"], ["session-denied"]);
  assert.ok(merged.includes("workflow") && merged.includes("workflow_control"), "defaults are never dropped");
  assert.ok(merged.includes("session-denied") && merged.includes("extra"), "both caller lists are folded in");
});

test("the subagent resource loader is built once per run and shared across subagents (#109)", () => {
  // The #109 mitigation: one no-extensions loader per run, reused by every
  // subagent, instead of createAgentSession re-running every extension factory
  // (and rooting each disposed session) per subagent. Memoization is the invariant.
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  type Priv = { getSharedResourceLoader(agentDir: string): Promise<unknown> };
  const a = agent as unknown as Priv;
  const first = a.getSharedResourceLoader("/tmp/agentdir");
  const second = a.getSharedResourceLoader("/tmp/agentdir");
  assert.equal(first, second, "same promise — the loader is built once and shared, not rebuilt per subagent");
  // reload() may reject in a bare temp dir; we only assert memoization here.
  first.catch(() => {});
  second.catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════
// finalAssistantText — the unstructured result must come AFTER the last tool
// result, so stale progress text can't be reported as a completed answer (#111)
// ═══════════════════════════════════════════════════════════════════════

const progressThenToolResult = [
  { role: "assistant", content: [{ type: "text", text: "I'll inspect the repository now." }] },
  { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
  { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "command output" }] },
];

test("finalAssistantText rejects progress text before a terminal tool result (#111)", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const text = (agent as unknown as WorkflowAgentPrivates).finalAssistantText(progressThenToolResult);
  assert.equal(text, "", "text emitted before the final tool result is not a final answer");
});

test("finalAssistantText accepts a real assistant answer AFTER tools (#111)", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "Let me check." }] },
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "output" }] },
    { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] },
  ];
  const text = (agent as unknown as WorkflowAgentPrivates).finalAssistantText(messages);
  assert.equal(text, "The answer is 42.", "a genuine post-tool answer still counts");
});

test("finalAssistantText returns a plain answer when no tools were used (#111)", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [{ role: "assistant", content: [{ type: "text", text: "Direct answer." }] }];
  const text = (agent as unknown as WorkflowAgentPrivates).finalAssistantText(messages);
  assert.equal(text, "Direct answer.");
});

test("lastAssistantText stays lenient for schema prose extraction (unchanged by #111)", () => {
  // The schema path's JSON recovery may read the payload from any assistant
  // message, so lastAssistantText must NOT adopt finalAssistantText's stricter
  // "after the last tool result" rule.
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const text = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(progressThenToolResult);
  assert.equal(text, "I'll inspect the repository now.", "lastAssistantText still finds earlier assistant text");
});

test("WorkflowAgent reuses an injected ModelRegistry instead of building its own", async () => {
  const mockModel = { provider: "mock", id: "shared" } as any;
  const registry = {
    find: (provider: string, id: string) => (provider === "mock" && id === "shared" ? mockModel : undefined),
    getAvailable: () => [mockModel],
    getAll: () => [mockModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: registry });
  const resolvedRegistry = await (agent as any).getRegistry();
  assert.equal(resolvedRegistry, registry, "should hand back the injected registry");
  const resolved = resolveModelSpecWithThinking("mock/shared", resolvedRegistry);
  assert.equal(resolved.model, mockModel, "should resolve via the injected registry");
});

test("WorkflowAgent falls back to building a disk registry when no registry is injected", async () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  // Should not reject; getRegistry() lazily builds a ModelRegistry from disk
  // (async since pi 0.80.8: registries wrap an async-created ModelRuntime).
  await assert.doesNotReject(() => (agent as any).getRegistry());
});

test("WorkflowAgent.resolveModel resolves via a per-run registry when the constructor got none", async () => {
  // Regression test for the per-run `modelRegistry` AgentRunOptions field: a
  // model present only in a registry passed to run() (not the constructor)
  // must still resolve.
  const perRunModel = { provider: "router", id: "per-run-only" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "router" && id === "per-run-only" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
    getAll: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const resolved = resolveModelSpecWithThinking(
    "router/per-run-only",
    await (agent as any).getRegistry(perRunRegistry),
  );
  assert.equal(resolved.model, perRunModel, "should resolve via the per-run registry, not a disk registry");
});

test("WorkflowAgent.resolveModel: per-run registry takes precedence over the constructor's shared registry", async () => {
  const constructorModel = { provider: "ctor", id: "shared" } as any;
  const constructorRegistry = {
    find: (provider: string, id: string) => (provider === "ctor" && id === "shared" ? constructorModel : undefined),
    getAvailable: () => [constructorModel],
    getAll: () => [constructorModel],
  } as any;

  const perRunModel = { provider: "run", id: "override" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "run" && id === "override" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
    getAll: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  // The per-run registry, not the constructor's, is consulted when both are set.
  const resolved = resolveModelSpecWithThinking("run/override", await (agent as any).getRegistry(perRunRegistry));
  assert.equal(resolved.model, perRunModel, "per-run registry should win over the constructor's shared registry");
  // And the constructor registry is still used when no per-run registry is given.
  const fallback = resolveModelSpecWithThinking("ctor/shared", await (agent as any).getRegistry());
  assert.equal(fallback.model, constructorModel, "constructor registry should still apply without a per-run override");
});

test("WorkflowAgent.getRegistry: per-run registry wins, then constructor's shared registry, then disk", async () => {
  const constructorRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  const perRunRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  assert.equal(await (agent as any).getRegistry(perRunRegistry), perRunRegistry);
  assert.equal(await (agent as any).getRegistry(), constructorRegistry);

  const bareAgent = new WorkflowAgent({ cwd: "/tmp" });
  await assert.doesNotReject(() => (bareAgent as any).getRegistry());
});
