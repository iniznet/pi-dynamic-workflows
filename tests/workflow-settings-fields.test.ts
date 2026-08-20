/**
 * Tests for workflow-settings-fields.ts (S1) — the field registry, input
 * validation, display strings, env-lock detection, and the form state model.
 *
 * Registry completeness is the exhaustiveness guard from design.md §3: the
 * registry must stay in sync with both WORKFLOW_ENV_VARS (cfg:77,
 * `as const satisfies Record<keyof WorkflowSettings, string>`) and the
 * WorkflowSettings interface — a drifted registry fails here loudly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORKFLOW_ENV_VARS } from "../src/config.js";
import {
  DEFAULT_PROVIDER_CONCURRENCY,
  DEFAULT_PROVIDER_WEIGHT,
  normalizeProviderPoolConfig,
} from "../src/gateway/provider-pool-config.js";
import type { WorkflowSettings } from "../src/workflow-settings.js";
import {
  FIELD_GROUPS,
  FIELD_REGISTRY,
  fieldDisplayValue,
  getEnvLockedKeys,
  getField,
  getProviderPoolEntryScalar,
  PROVIDER_POOL_ENTRY_SCALARS,
  ProviderPoolEditorModel,
  parseFieldInput,
  parseProviderPoolEntryScalar,
  providerPoolEntryDisplay,
  providerPoolInputOf,
  SettingsFormModel,
  type WorkflowSettingsField,
} from "../src/workflow-settings-fields.js";

function fieldOf(key: keyof WorkflowSettings): WorkflowSettingsField {
  const field = getField(key);
  assert.ok(field, `registry must contain a field for ${key}`);
  return field;
}

function entryScalarOf(key: Parameters<typeof getProviderPoolEntryScalar>[0]) {
  const scalar = getProviderPoolEntryScalar(key);
  assert.ok(scalar, `registry must contain an entry scalar for ${key}`);
  return scalar;
}

function parse(key: keyof WorkflowSettings, raw: string) {
  return parseFieldInput(fieldOf(key), raw);
}

function expectOk(key: keyof WorkflowSettings, raw: string): unknown {
  const result = parse(key, raw);
  assert.equal(result.ok, true, `expected "${raw}" to parse for ${key}, got ${JSON.stringify(result)}`);
  return (result as { ok: true; value: unknown }).value;
}

function expectError(key: keyof WorkflowSettings, raw: string): string {
  const result = parse(key, raw);
  assert.equal(result.ok, false, `expected "${raw}" to be rejected for ${key}`);
  return (result as { ok: false; error: string }).error;
}

describe("FIELD_REGISTRY completeness", () => {
  it("has exactly one entry per WorkflowSettings key, mirroring WORKFLOW_ENV_VARS", () => {
    const registryKeys = FIELD_REGISTRY.map((field) => field.key);
    assert.equal(registryKeys.length, 22, "registry must hold one row per settings key");
    assert.deepEqual(
      new Set(registryKeys),
      new Set(Object.keys(WORKFLOW_ENV_VARS)),
      "registry keys must equal the env-var map keys (exhaustiveness guard)",
    );
  });

  it("maps every key to its PI_WORKFLOW_* env var", () => {
    for (const field of FIELD_REGISTRY) {
      assert.equal(field.envVar, WORKFLOW_ENV_VARS[field.key], `envVar mismatch for ${field.key}`);
    }
  });

  it("uses unique keys and unique env vars", () => {
    const keys = new Set(FIELD_REGISTRY.map((field) => field.key));
    const envVars = new Set(FIELD_REGISTRY.map((field) => field.envVar));
    assert.equal(keys.size, FIELD_REGISTRY.length);
    assert.equal(envVars.size, FIELD_REGISTRY.length);
  });

  it("getField resolves every registered key and misses unknown ones", () => {
    for (const field of FIELD_REGISTRY) {
      assert.equal(getField(field.key), field);
    }
    assert.equal(getField("notARealKey" as keyof WorkflowSettings), undefined);
  });
});

describe("registry table conformance (design.md §3)", () => {
  it("clamps execution numbers to the verified bounds", () => {
    assert.equal(fieldOf("defaultConcurrency").min, 1);
    assert.equal(fieldOf("defaultConcurrency").max, 16);
    assert.equal(fieldOf("defaultAgentRetries").min, 0);
    assert.equal(fieldOf("defaultAgentRetries").max, 3);
    assert.equal(fieldOf("defaultAgentTimeoutMs").min, 1);
    assert.equal(fieldOf("defaultAgentTimeoutMs").max, Number.MAX_SAFE_INTEGER);
  });

  it("clamps progress/advanced numbers to the verified bounds", () => {
    assert.equal(fieldOf("progressPanelMaxAgents").min, 1);
    assert.equal(fieldOf("progressPanelMaxAgents").max, 1000);
    assert.equal(fieldOf("deliveredResultMaxChars").min, 1);
    assert.equal(fieldOf("deliveredResultMaxChars").max, 1_000_000);
  });

  it("marks the nullable number|null pairs", () => {
    assert.equal(fieldOf("defaultAgentTimeoutMs").nullable, true);
    assert.equal(fieldOf("defaultTokenBudget").nullable, true);
    assert.equal(fieldOf("defaultConcurrency").nullable, undefined);
  });

  it("declares enum options for progressPanelMode", () => {
    assert.equal(fieldOf("progressPanelMode").type, "enum");
    assert.deepEqual(fieldOf("progressPanelMode").options, ["compact", "detailed"]);
  });

  it("keeps the defaultDisplay per key", () => {
    assert.equal(fieldOf("keywordTriggerEnabled").defaultDisplay, "true");
    assert.equal(fieldOf("keywordTriggerWord").defaultDisplay, "workflow");
    assert.equal(fieldOf("defaultAgentTimeoutMs").defaultDisplay, "null (none)");
    assert.equal(fieldOf("defaultTokenBudget").defaultDisplay, "null (none)");
    assert.equal(fieldOf("tokenBudgetCountsCacheRead").defaultDisplay, "true");
    assert.equal(fieldOf("defaultConcurrency").defaultDisplay, "(manager default)");
    assert.equal(fieldOf("defaultAgentRetries").defaultDisplay, "0");
    assert.equal(fieldOf("progressPanelMode").defaultDisplay, "compact");
    assert.equal(fieldOf("progressPanelMaxAgents").defaultDisplay, "8");
    assert.equal(fieldOf("persistAgentSessions").defaultDisplay, "false");
    assert.equal(fieldOf("deliveredResultMaxChars").defaultDisplay, "400");
    assert.equal(fieldOf("excludeSubagentTools").defaultDisplay, "[] (none)");
    // P04 default flip: subagentExtensionTools defaults to on (fresh installs
    // get the captured codegraph_*/web/vision research tools).
    assert.equal(fieldOf("subagentExtensionTools").defaultDisplay, "on");
  });

  it("declares the four groups in order", () => {
    assert.deepEqual(FIELD_GROUPS, ["Trigger", "Execution", "Progress", "Advanced"]);
  });
});

describe("parseFieldInput", () => {
  it("parses booleans exactly", () => {
    assert.equal(expectOk("keywordTriggerEnabled", "true"), true);
    assert.equal(expectOk("keywordTriggerEnabled", "false"), false);
    expectError("keywordTriggerEnabled", "yes");
    expectError("keywordTriggerEnabled", "1");
  });

  it("parses enums by membership", () => {
    assert.equal(expectOk("progressPanelMode", "compact"), "compact");
    assert.equal(expectOk("progressPanelMode", "detailed"), "detailed");
    expectError("progressPanelMode", "full");
  });

  it("clamps numbers to max and floors fractional input", () => {
    assert.equal(expectOk("defaultConcurrency", "8"), 8);
    assert.equal(expectOk("defaultConcurrency", "40"), 16);
    assert.equal(expectOk("defaultConcurrency", "3.9"), 3);
    assert.equal(expectOk("defaultAgentRetries", "9"), 3);
    assert.equal(expectOk("defaultAgentRetries", "0"), 0);
    expectError("defaultConcurrency", "abc");
    expectError("defaultConcurrency", "Infinity");
  });

  it("rejects numbers below the field minimum (mirrors normalizeInteger drop)", () => {
    expectError("defaultConcurrency", "0");
    expectError("defaultAgentRetries", "-1");
    expectError("progressPanelMaxAgents", "0");
  });

  it("rejects malformed keyword words", () => {
    assert.equal(expectOk("keywordTriggerWord", "workflow"), "workflow");
    assert.equal(expectOk("keywordTriggerWord", "  pi-workflow  "), "pi-workflow");
    expectError("keywordTriggerWord", "");
    expectError("keywordTriggerWord", "   ");
    expectError("keywordTriggerWord", "/workflow");
    expectError("keywordTriggerWord", "pi workflow");
  });

  it("maps empty/null markers to null for nullable fields", () => {
    assert.equal(expectOk("defaultAgentTimeoutMs", ""), null);
    assert.equal(expectOk("defaultAgentTimeoutMs", "null"), null);
    assert.equal(expectOk("defaultTokenBudget", ""), null);
    assert.equal(expectOk("defaultAgentTimeoutMs", "60000"), 60000);
  });

  it("accepts the 0 tombstone for the token budget (save-path normalization handles it)", () => {
    assert.equal(expectOk("defaultTokenBudget", "0"), 0);
  });

  it("rejects 0 on other nullable fields (no save-path tombstone → a silent no-op edit)", () => {
    expectError("defaultAgentTimeoutMs", "0");
  });

  it("splits comma-separated tool names, trimming and dropping empties", () => {
    assert.deepEqual(expectOk("excludeSubagentTools", "web-search, editor, , mcp-bridge"), [
      "web-search",
      "editor",
      "mcp-bridge",
    ]);
    assert.deepEqual(expectOk("excludeSubagentTools", "  a  , b"), ["a", "b"]);
    assert.deepEqual(expectOk("excludeSubagentTools", ""), []);
    assert.deepEqual(expectOk("excludeSubagentTools", ",,,"), []);
  });

  it("parses subagentTools: the all literal, an allowlist, or the empty none mode", () => {
    // "all" is the special literal — saved as the string mode, not a name.
    assert.deepEqual(expectOk("subagentTools", "all"), "all");
    assert.deepEqual(expectOk("subagentTools", "  all  "), "all");
    // Comma-separated allowlist.
    assert.deepEqual(expectOk("subagentTools", "mcp_svelte_read_resource, mcp_other_x"), [
      "mcp_svelte_read_resource",
      "mcp_other_x",
    ]);
    // Empty input is the "none" side (MCP tools disabled for subagents).
    assert.deepEqual(expectOk("subagentTools", ""), []);
  });

  it("returns actionable error strings", () => {
    const error = expectError("keywordTriggerWord", "pi workflow");
    assert.ok(error.length > 0, "error message must be non-empty");
  });
});

describe("fieldDisplayValue", () => {
  it("round-trips cycler values losslessly", () => {
    assert.equal(fieldDisplayValue(fieldOf("keywordTriggerEnabled"), true), "true");
    assert.equal(fieldDisplayValue(fieldOf("keywordTriggerEnabled"), false), "false");
    assert.equal(fieldDisplayValue(fieldOf("progressPanelMode"), "compact"), "compact");
    assert.equal(fieldDisplayValue(fieldOf("progressPanelMode"), "detailed"), "detailed");
  });

  it("renders numbers as plain strings", () => {
    assert.equal(fieldDisplayValue(fieldOf("defaultConcurrency"), 4), "4");
  });

  it("handles null and undefined without throwing", () => {
    assert.doesNotThrow(() => fieldDisplayValue(fieldOf("defaultAgentTimeoutMs"), null));
    assert.doesNotThrow(() => fieldDisplayValue(fieldOf("defaultAgentTimeoutMs"), undefined));
  });
});

describe("SettingsFormModel", () => {
  const effective: WorkflowSettings = { defaultConcurrency: 4, progressPanelMode: "compact" };
  const envLocks: WorkflowSettings = { defaultConcurrency: 16 };

  function makeModel(): SettingsFormModel {
    return new SettingsFormModel({ ...effective }, { ...envLocks }, "global");
  }

  it("exposes the draft, scope, and locked keys", () => {
    const model = makeModel();
    assert.equal(model.scope, "global");
    assert.equal(model.draft.defaultConcurrency, 4);
    assert.ok(model.lockedKeys.has("defaultConcurrency"), "env-provided key must be locked");
    assert.equal(model.dirtyCount, 0);
    assert.equal(model.isDirty(), false);
  });

  it("stages values and marks them dirty", () => {
    const model = makeModel();
    model.stage("progressPanelMode", "detailed");
    assert.equal(model.draft.progressPanelMode, "detailed");
    assert.equal(model.dirtyCount, 1);
    assert.equal(model.isDirty(), true);
    assert.deepEqual(model.dirtyPayload(), { progressPanelMode: "detailed" });
  });

  it("ignores staged writes to env-locked keys", () => {
    const model = makeModel();
    model.stage("defaultConcurrency", 8);
    assert.equal(model.draft.defaultConcurrency, 4, "locked key must keep the env value");
    assert.equal(model.dirtyCount, 0);
    assert.deepEqual(model.dirtyPayload(), {});
  });

  it("excludes locked keys from the dirty payload", () => {
    const model = makeModel();
    model.stage("progressPanelMode", "detailed");
    model.stage("defaultConcurrency", 8);
    assert.equal(model.dirtyCount, 1);
    assert.deepEqual(model.dirtyPayload(), { progressPanelMode: "detailed" });
  });

  it("counts each dirty key once", () => {
    const model = makeModel();
    model.stage("progressPanelMode", "detailed");
    model.stage("progressPanelMode", "compact");
    assert.equal(model.dirtyCount, 1);
    assert.deepEqual(model.dirtyPayload(), { progressPanelMode: "compact" });
  });

  it("switches scope", () => {
    const model = makeModel();
    model.setScope("project");
    assert.equal(model.scope, "project");
    model.setScope("global");
    assert.equal(model.scope, "global");
  });
});

describe("getEnvLockedKeys", () => {
  it("locks keys whose env var parses to a value", () => {
    const env = {
      PI_WORKFLOW_DEFAULT_CONCURRENCY: "8",
      PI_WORKFLOW_KEYWORD_TRIGGER_ENABLED: "false",
      PI_WORKFLOW_PROGRESS_PANEL_MODE: "detailed",
      PI_WORKFLOW_EXCLUDE_SUBAGENT_TOOLS: "web-search, mcp-bridge",
      PI_WORKFLOW_DEFAULT_TOKEN_BUDGET: "null",
    };
    const locked = getEnvLockedKeys(env);
    assert.ok(locked.has("defaultConcurrency"));
    assert.ok(locked.has("keywordTriggerEnabled"));
    assert.ok(locked.has("progressPanelMode"));
    assert.ok(locked.has("excludeSubagentTools"));
    assert.ok(locked.has("defaultTokenBudget"));
    assert.equal(locked.size, 5);
  });

  it("ignores unparseable env values (lenient, like the load path)", () => {
    const env = {
      PI_WORKFLOW_DEFAULT_CONCURRENCY: "abc",
      PI_WORKFLOW_KEYWORD_TRIGGER_WORD: "pi workflow",
      PI_WORKFLOW_PROGRESS_PANEL_MODE: "bogus",
      PI_WORKFLOW_DEFAULT_AGENT_TIMEOUT_MS: "not-a-number",
    };
    assert.equal(getEnvLockedKeys(env).size, 0);
  });

  it("returns an empty set for an empty env", () => {
    assert.equal(getEnvLockedKeys({}).size, 0);
  });
});

describe("provider-pool entry scalars (PROVIDER_POOL_ENTRY_SCALARS)", () => {
  it("declares exactly the five editable entry keys in render order", () => {
    assert.deepEqual(
      PROVIDER_POOL_ENTRY_SCALARS.map((scalar) => scalar.key),
      ["modelId", "concurrency", "weight", "tpm", "cooldownMs"],
    );
    const tpm = PROVIDER_POOL_ENTRY_SCALARS.find((s) => s.key === "tpm");
    assert.equal(tpm?.nullable, true, "tpm is an optional cap: empty input clears it");
    assert.equal(tpm?.min, 1);
    const concurrency = PROVIDER_POOL_ENTRY_SCALARS.find((s) => s.key === "concurrency");
    assert.equal(concurrency?.min, 1);
  });

  it("looks up entry scalars by key", () => {
    assert.equal(getProviderPoolEntryScalar("concurrency")?.label, "Concurrency");
    assert.equal(getProviderPoolEntryScalar("bogus" as never), undefined);
  });

  it("parses the modelId alias as a trimmed non-empty string", () => {
    const ok = parseProviderPoolEntryScalar(entryScalarOf("modelId"), "  claude-3-5-sonnet  ");
    assert.deepEqual(ok, { ok: true, value: "claude-3-5-sonnet" });
    const empty = parseProviderPoolEntryScalar(entryScalarOf("modelId"), "   ");
    assert.equal(empty.ok, false);
  });

  it("parses bounded numbers with floor semantics", () => {
    const concurrency = entryScalarOf("concurrency");
    assert.deepEqual(parseProviderPoolEntryScalar(concurrency, "5.7"), { ok: true, value: 5 });
    assert.equal(parseProviderPoolEntryScalar(concurrency, "0").ok, false, "below-min input must reject");
    assert.equal(parseProviderPoolEntryScalar(concurrency, "abc").ok, false);
  });

  it('maps empty/"null" input on nullable caps to null (delete the key)', () => {
    const tpm = entryScalarOf("tpm");
    assert.deepEqual(parseProviderPoolEntryScalar(tpm, ""), { ok: true, value: null });
    assert.deepEqual(parseProviderPoolEntryScalar(tpm, "null"), { ok: true, value: null });
    assert.deepEqual(parseProviderPoolEntryScalar(tpm, "100000"), { ok: true, value: 100000 });
  });

  it("renders a compact per-provider row summary", () => {
    const entry = { provider: "anthropic-direct", modelId: "claude-sonnet-4", concurrency: 2, weight: 1 };
    assert.equal(providerPoolEntryDisplay("claude-sonnet-4", entry), "conc 2 · w 1");
    assert.equal(
      providerPoolEntryDisplay("claude-sonnet-4", { ...entry, modelId: "claude-3-5-sonnet" }),
      "alias claude-3-5-sonnet · conc 2 · w 1",
    );
    assert.equal(
      providerPoolEntryDisplay("claude-sonnet-4", {
        ...entry,
        modelId: "claude-3-5-sonnet",
        tpm: 100_000,
        cooldownMs: 30_000,
      }),
      "alias claude-3-5-sonnet · conc 2 · w 1 · tpm 100000 · cd 30s",
    );
    assert.equal(providerPoolEntryDisplay("claude-sonnet-4", undefined), "(missing)");
  });

  it("preserves empty model maps through normalize and the minimal input (add-then-save round-trip)", () => {
    const normalized = normalizeProviderPoolConfig({ models: { "gpt-5": {} } });
    assert.deepEqual(Object.keys(normalized.models), ["gpt-5"], "an added model must survive normalization");
    const editor = new ProviderPoolEditorModel({ models: { "gpt-5": {} } });
    assert.deepEqual(providerPoolInputOf(editor.config), { models: { "gpt-5": {} } }, "...and the minimal raw input");
    // Empty model maps are runtime-safe: the pool falls back to legacy
    // resolution for a model with no entries, so no routing is lost.
    assert.equal(editor.entry("gpt-5", "any-provider"), undefined);
  });
});

describe("ProviderPoolEditorModel.seedProvider", () => {
  it("creates the logical model map AND the provider entry with defaults", () => {
    const editor = new ProviderPoolEditorModel(undefined);
    editor.seedProvider("deepseek-v4-flash", "opencode-go", "deepseek-v4-flash");
    assert.deepEqual(editor.entry("deepseek-v4-flash", "opencode-go"), {
      provider: "opencode-go",
      modelId: "deepseek-v4-flash",
      concurrency: DEFAULT_PROVIDER_CONCURRENCY,
      weight: DEFAULT_PROVIDER_WEIGHT,
    });
    assert.deepEqual(editor.modelIds(), ["deepseek-v4-flash"], "model map created");
    assert.deepEqual(editor.providerIds("deepseek-v4-flash"), ["opencode-go"]);
  });

  it("records the explicit model id even when it differs from the logical id", () => {
    // The registry model id on a provider can diverge from the logical key
    // (e.g. an alias); the explicit parameter keeps that representable.
    const editor = new ProviderPoolEditorModel(undefined);
    editor.seedProvider("logical-model", "openrouter", "deepseek/deepseek-v4-flash");
    const entry = editor.entry("logical-model", "openrouter");
    assert.equal(entry?.provider, "openrouter");
    assert.equal(entry?.modelId, "deepseek/deepseek-v4-flash", "registry model id kept verbatim");
  });

  it("seeds multiple providers under one logical model (multi-provider routing)", () => {
    const editor = new ProviderPoolEditorModel(undefined);
    editor.seedProvider("gpt-5.5", "openai-codex", "gpt-5.5");
    editor.seedProvider("gpt-5.5", "openrouter", "gpt-5.5");
    assert.deepEqual(editor.providerIds("gpt-5.5"), ["openai-codex", "openrouter"]);
    assert.equal(editor.entry("gpt-5.5", "openai-codex")?.modelId, "gpt-5.5");
  });

  it("is idempotent: re-seeding an existing entry never overwrites it", () => {
    const editor = new ProviderPoolEditorModel(undefined);
    editor.seedProvider("gpt-5.5", "openai-codex", "gpt-5.5");
    editor.setEntryScalar("gpt-5.5", "openai-codex", "concurrency", 4);
    editor.seedProvider("gpt-5.5", "openai-codex", "gpt-5.5");
    assert.equal(
      editor.entry("gpt-5.5", "openai-codex")?.concurrency,
      4,
      "re-seed must not clobber user-tuned scalars",
    );
    assert.equal(editor.providerIds("gpt-5.5").length, 1, "no duplicate provider row");
  });

  it("is a no-op for an empty provider id (no model map is created)", () => {
    const editor = new ProviderPoolEditorModel(undefined);
    editor.seedProvider("gpt-5.5", "   ", "gpt-5.5");
    assert.deepEqual(editor.modelIds(), [], "no model key without a provider id");
    assert.equal(editor.entry("gpt-5.5", ""), undefined);
  });

  it("saves as the minimal raw input (defaults dropped, modelId == logical id)", () => {
    const editor = new ProviderPoolEditorModel(undefined);
    editor.seedProvider("gpt-5.5", "openai-codex", "gpt-5.5");
    assert.deepEqual(providerPoolInputOf(editor.config), { models: { "gpt-5.5": { "openai-codex": {} } } });
    // ...and normalizing that minimal input back re-fills the defaults, so the
    // seeded entry survives a save → load round-trip intact.
    const reloaded = normalizeProviderPoolConfig(providerPoolInputOf(editor.config));
    const entry = reloaded.models["gpt-5.5"]?.["openai-codex"];
    assert.equal(entry?.provider, "openai-codex");
    assert.equal(entry?.modelId, "gpt-5.5");
    assert.equal(entry?.concurrency, DEFAULT_PROVIDER_CONCURRENCY);
    assert.equal(entry?.weight, DEFAULT_PROVIDER_WEIGHT);
  });

  it("upsertProvider keeps its legacy shape via delegation (entry modelId = logical id)", () => {
    const editor = new ProviderPoolEditorModel(undefined);
    editor.upsertProvider("gpt-5.5", "openai-codex");
    assert.deepEqual(editor.entry("gpt-5.5", "openai-codex"), {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      concurrency: DEFAULT_PROVIDER_CONCURRENCY,
      weight: DEFAULT_PROVIDER_WEIGHT,
    });
  });
});
