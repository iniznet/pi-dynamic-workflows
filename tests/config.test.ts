/**
 * Config-layer tests: the PI_WORKFLOW_* env override layer and the
 * config-level validation helpers (entry-config:i2).
 *
 * The env layer is a pure, injectable parser: every test passes an explicit
 * env object so the ambient process.env can never leak into assertions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEnvSettingsOverride,
  DEFAULT_SUBAGENT_EXTENSION_TOOLS,
  DEFAULT_SUBAGENT_SKILLS,
  MAX_AGENT_RETRIES,
  MAX_CONCURRENCY,
  normalizeKeywordTriggerWord,
  WORKFLOW_ENV_PREFIX,
  WORKFLOW_ENV_VARS,
  workflowSettingsFromEnv,
} from "../src/config.js";
import type { WorkflowSettings } from "../src/workflow-settings.js";

test("workflowSettingsFromEnv parses every PI_WORKFLOW_* key", () => {
  const env = {
    [WORKFLOW_ENV_VARS.keywordTriggerEnabled]: "true",
    [WORKFLOW_ENV_VARS.keywordTriggerWord]: "  brainstorm  ",
    [WORKFLOW_ENV_VARS.defaultAgentTimeoutMs]: "120000",
    [WORKFLOW_ENV_VARS.defaultTokenBudget]: "500000",
    [WORKFLOW_ENV_VARS.defaultConcurrency]: "8",
    [WORKFLOW_ENV_VARS.defaultAgentRetries]: "2",
    [WORKFLOW_ENV_VARS.progressPanelMode]: "detailed",
    [WORKFLOW_ENV_VARS.progressPanelMaxAgents]: "12",
    [WORKFLOW_ENV_VARS.persistAgentSessions]: "false",
    [WORKFLOW_ENV_VARS.deliveredResultMaxChars]: "1000",
    [WORKFLOW_ENV_VARS.excludeSubagentTools]: " pi-subagents,  my-tool ,",
    [WORKFLOW_ENV_VARS.subagentHostTools]: "off",
    [WORKFLOW_ENV_VARS.subagentTools]: "mcp_svelte_read_resource, mcp_other_tool",
  };
  assert.deepEqual(workflowSettingsFromEnv(env), {
    keywordTriggerEnabled: true,
    keywordTriggerWord: "brainstorm",
    defaultAgentTimeoutMs: 120000,
    defaultTokenBudget: 500000,
    defaultConcurrency: 8,
    defaultAgentRetries: 2,
    progressPanelMode: "detailed",
    progressPanelMaxAgents: 12,
    persistAgentSessions: false,
    deliveredResultMaxChars: 1000,
    excludeSubagentTools: ["pi-subagents", "my-tool"],
    subagentHostTools: "off",
    subagentTools: ["mcp_svelte_read_resource", "mcp_other_tool"],
  });
});

test("an empty env yields no overrides at all", () => {
  assert.deepEqual(workflowSettingsFromEnv({}), {});
});

test("defaultUntaggedTier parses from its PI_WORKFLOW_* env var (DS-4)", () => {
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.defaultUntaggedTier]: "inherit:main" }), {
    defaultUntaggedTier: "inherit:main",
  });
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.defaultUntaggedTier]: "  fast-lane  " }), {
    defaultUntaggedTier: "fast-lane",
  });
  // Empty/whitespace-only env values are dropped (unset → the run default).
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.defaultUntaggedTier]: "   " }), {});
});

test("missing env keys are skipped, not defaulted", () => {
  const env = { [WORKFLOW_ENV_VARS.defaultConcurrency]: "4" };
  const parsed = workflowSettingsFromEnv(env);
  assert.deepEqual(parsed, { defaultConcurrency: 4 });
});

test("invalid values are dropped, never coerced or crashing", () => {
  const env = {
    [WORKFLOW_ENV_VARS.keywordTriggerEnabled]: "yes", // not true/false
    [WORKFLOW_ENV_VARS.keywordTriggerWord]: "/not-a-trigger", // starts with /
    [WORKFLOW_ENV_VARS.defaultAgentTimeoutMs]: "abc",
    [WORKFLOW_ENV_VARS.defaultTokenBudget]: "NaN",
    [WORKFLOW_ENV_VARS.defaultConcurrency]: "0", // below min 1
    [WORKFLOW_ENV_VARS.defaultAgentRetries]: "-3",
    [WORKFLOW_ENV_VARS.progressPanelMode]: "verbose", // not an enum value
    [WORKFLOW_ENV_VARS.progressPanelMaxAgents]: "0",
    [WORKFLOW_ENV_VARS.persistAgentSessions]: "1", // not true/false
    [WORKFLOW_ENV_VARS.deliveredResultMaxChars]: "-5",
    [WORKFLOW_ENV_VARS.excludeSubagentTools]: "  , ,",
    [WORKFLOW_ENV_VARS.subagentHostTools]: "garbage", // not a mode literal
  };
  assert.deepEqual(workflowSettingsFromEnv(env), {});
});

test("subagentHostTools env accepts only auto|on|off and ignores anything else", () => {
  for (const mode of ["auto", "on", "off"]) {
    assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentHostTools]: mode }), {
      subagentHostTools: mode,
    });
    assert.deepEqual(
      workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentHostTools]: `  ${mode}  ` }),
      { subagentHostTools: mode },
      "whitespace around the mode literal is trimmed",
    );
  }
  for (const garbage of ["", "AUTO", "yes", "1", "eager", "disabled"]) {
    assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentHostTools]: garbage }), {});
  }
});

test("subagentTools env accepts the all literal or a comma-separated allowlist", () => {
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentTools]: "all" }), { subagentTools: "all" });
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentTools]: "  all  " }), {
    subagentTools: "all",
  });
  assert.deepEqual(
    workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentTools]: "mcp_a_x, mcp_b_y , mcp_a_x" }),
    { subagentTools: ["mcp_a_x", "mcp_b_y"] },
    "allowlist names are trimmed and deduped",
  );
  // Anything else (empty or whitespace-only) is dropped — the file value
  // still applies. (Any non-empty non-"all" string is a valid allowlist,
  // including a single name, so there is no other garbage input.)
  for (const garbage of ["", "  "]) {
    assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentTools]: garbage }), {});
  }
});

test("subagentExtensionTools default is on (P04 default-flip knob)", () => {
  // The single knob shared by the runtime gate (extensions/workflow.ts
  // `?? DEFAULT_SUBAGENT_EXTENSION_TOOLS`) and the settings UI default display
  // (workflow-settings-fields.ts). Fresh installs get the captured research
  // tools (codegraph_*/web/vision) unless the user opts out with off.
  assert.equal(DEFAULT_SUBAGENT_EXTENSION_TOOLS, "on");
});

test("subagentSkills default is none (context-cost scoped loading) and env accepts all|none", () => {
  // Context-cost default flip: "none" strips the ~3.1 ktok skill-stub block via
  // noSkills (passive/mechanical slices must not pay it); "all" stays the
  // opt-in that keeps the SDK skill-stub block for slices that need discovery
  // in the system prompt (e.g. svelte editing).
  assert.equal(DEFAULT_SUBAGENT_SKILLS, "none");
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentSkills]: "none" }), {
    subagentSkills: "none",
  });
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentSkills]: "  all  " }), {
    subagentSkills: "all",
  });
  // Anything else drops to the file value (lenient drop-on-violation).
  for (const garbage of ["", "  ", "some", "true", "1"]) {
    assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentSkills]: garbage }), {});
  }
});

test("subagentExtensionTools env accepts on|off or a comma-separated known-source allowlist", () => {
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentExtensionTools]: "on" }), {
    subagentExtensionTools: "on",
  });
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentExtensionTools]: "  off  " }), {
    subagentExtensionTools: "off",
  });
  assert.deepEqual(
    workflowSettingsFromEnv({
      [WORKFLOW_ENV_VARS.subagentExtensionTools]: "pi-vision-handoff, supi-web , pi-vision-handoff",
    }),
    { subagentExtensionTools: ["pi-vision-handoff", "supi-web"] },
    "known source ids are trimmed and deduped",
  );
  // Unknown ids are dropped leniently; an all-unknown allowlist yields no
  // override (the file value still applies).
  assert.deepEqual(
    workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentExtensionTools]: "pi-vision-handoff, bogus" }),
    { subagentExtensionTools: ["pi-vision-handoff"] },
  );
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentExtensionTools]: "bogus" }), {});
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentExtensionTools]: "" }), {});
});

test("hostActors env is a strict on|off gate (V2-P12 default off)", () => {
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.hostActors]: "on" }), { hostActors: "on" });
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.hostActors]: "  off  " }), { hostActors: "off" });
  // Anything else (or nothing) drops to the default-off side — no observer
  // registration, no actor manager.
  for (const garbage of ["", "  ", "auto", "true", "1"]) {
    assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.hostActors]: garbage }), {});
  }
  assert.deepEqual(workflowSettingsFromEnv({}), {});
});

test("integer bounds are clamped to the config ceilings", () => {
  const env = {
    [WORKFLOW_ENV_VARS.defaultConcurrency]: "999",
    [WORKFLOW_ENV_VARS.defaultAgentRetries]: "99",
    [WORKFLOW_ENV_VARS.progressPanelMaxAgents]: "99999",
    [WORKFLOW_ENV_VARS.deliveredResultMaxChars]: "999999999",
  };
  assert.deepEqual(workflowSettingsFromEnv(env), {
    defaultConcurrency: MAX_CONCURRENCY,
    defaultAgentRetries: MAX_AGENT_RETRIES,
    progressPanelMaxAgents: 1000,
    deliveredResultMaxChars: 1_000_000,
  });
});

test("fractional env numbers floor to integers (mirrors settings.json normalization)", () => {
  const env = {
    [WORKFLOW_ENV_VARS.defaultConcurrency]: "4.9",
    [WORKFLOW_ENV_VARS.defaultAgentTimeoutMs]: "12345.9",
  };
  assert.deepEqual(workflowSettingsFromEnv(env), {
    defaultConcurrency: 4,
    defaultAgentTimeoutMs: 12345,
  });
});

test("empty string or 'null' env means explicit null (cancels a file-level budget/timeout)", () => {
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.defaultTokenBudget]: "" }), {
    defaultTokenBudget: null,
  });
  assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.defaultAgentTimeoutMs]: "NULL" }), {
    defaultAgentTimeoutMs: null,
  });
});

test("applyEnvSettingsOverride: env wins per key, file values survive untouched keys", () => {
  const fileSettings: WorkflowSettings = {
    defaultConcurrency: 4,
    defaultTokenBudget: 1000,
    keywordTriggerWord: "workflow",
    persistAgentSessions: true,
  };
  const env = {
    [WORKFLOW_ENV_VARS.defaultConcurrency]: "8",
    [WORKFLOW_ENV_VARS.persistAgentSessions]: "false",
  };
  assert.deepEqual(applyEnvSettingsOverride(fileSettings, env), {
    defaultConcurrency: 8,
    defaultTokenBudget: 1000,
    keywordTriggerWord: "workflow",
    persistAgentSessions: false,
  });
});

test("applyEnvSettingsOverride with an empty env is an identity merge", () => {
  const fileSettings: WorkflowSettings = { defaultAgentRetries: 1, progressPanelMode: "compact" };
  assert.deepEqual(applyEnvSettingsOverride(fileSettings, {}), fileSettings);
});

test("applyEnvSettingsOverride never mutates the input settings object", () => {
  const fileSettings: WorkflowSettings = { defaultConcurrency: 4 };
  const snapshot = { ...fileSettings };
  applyEnvSettingsOverride(fileSettings, { [WORKFLOW_ENV_VARS.defaultConcurrency]: "16" });
  assert.deepEqual(fileSettings, snapshot);
});

test("WORKFLOW_ENV_VARS maps every WorkflowSettings key and uses the documented prefix", () => {
  const settingsKeys: Array<keyof WorkflowSettings> = [
    "keywordTriggerEnabled",
    "keywordTriggerWord",
    "defaultAgentTimeoutMs",
    "defaultTokenBudget",
    "tokenBudgetCountsCacheRead",
    "defaultConcurrency",
    "defaultAgentRetries",
    "progressPanelMode",
    "progressPanelMaxAgents",
    "persistAgentSessions",
    "deliveredResultMaxChars",
    "maxAgentResultChars",
    "maxTotalOutputChars",
    "fanOutApprovalThreshold",
    "excludeSubagentTools",
    "subagentHostTools",
    "subagentTools",
    "subagentChromeTools",
    "subagentSkills",
    "defaultUntaggedTier",
    "subagentExtensionTools",
    "subagentDamageControlTools",
    "hostActors",
    "commandIdleTimeoutMs",
    "commandHardTimeoutMs",
    "agentIdleTimeoutMs",
    "agentIdleRetries",
    "providerPool",
  ];
  for (const key of settingsKeys) {
    assert.ok(
      WORKFLOW_ENV_VARS[key].startsWith(WORKFLOW_ENV_PREFIX),
      `${key} env var ${WORKFLOW_ENV_VARS[key]} must use the ${WORKFLOW_ENV_PREFIX} prefix`,
    );
  }
  assert.equal(
    Object.keys(WORKFLOW_ENV_VARS).length,
    settingsKeys.length,
    "adding a WorkflowSettings key must come with an env mapping (satisfies guard)",
  );
});

test("normalizeKeywordTriggerWord rejects slash-prefixed, whitespace, and empty words", () => {
  assert.equal(normalizeKeywordTriggerWord("  brainstorm  "), "brainstorm");
  assert.equal(normalizeKeywordTriggerWord("/workflow"), undefined);
  assert.equal(normalizeKeywordTriggerWord("two words"), undefined);
  assert.equal(normalizeKeywordTriggerWord(""), undefined);
  assert.equal(normalizeKeywordTriggerWord("   "), undefined);
  assert.equal(normalizeKeywordTriggerWord(42), undefined);
});
