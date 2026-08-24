import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { describe, it } from "node:test";
import { WORKFLOW_SETTINGS_FILE } from "../src/config.js";
import {
  ConfigError,
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "../src/workflow-settings.js";
import { withFakeHome } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

async function withSettingsPath(fn: (settingsPath: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-settings-"));
  try {
    fn(join(dir, "nested", "settings.json"));
  } finally {
    await rmForce(dir);
  }
}

describe("workflow settings", () => {
  it("resolves the user-level settings path", () => {
    assert.ok(getWorkflowSettingsPath().endsWith(normalize(WORKFLOW_SETTINGS_FILE)));
  });

  it("returns empty settings when the file is missing", async () => {
    await withSettingsPath((settingsPath) => {
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("saves and loads keyword trigger preferences", async () => {
    await withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: false, keywordTriggerWord: "pi-workflow" }, settingsPath);

      assert.ok(existsSync(settingsPath), "settings file should be created");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {
        keywordTriggerEnabled: false,
        keywordTriggerWord: "pi-workflow",
      });
    });
  });

  it("normalizes keyword trigger word settings", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerWord: "  pi-workflow  " }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { keywordTriggerWord: "pi-workflow" });

      // String values that are invalid trigger words are dropped (still a
      // string, so the type schema passes and value normalization drops them).
      for (const keywordTriggerWord of ["", "   ", "/workflow", "pi workflow"]) {
        writeFileSync(settingsPath, JSON.stringify({ keywordTriggerWord }), "utf-8");
        assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      }

      // A non-string value is a schema violation and fails loudly.
      for (const keywordTriggerWord of [42, false, null, ["x"]]) {
        writeFileSync(settingsPath, JSON.stringify({ keywordTriggerWord }), "utf-8");
        assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
      }
    });
  });

  it("saves and loads default agent timeout preference", async () => {
    await withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ defaultAgentTimeoutMs: 600000 }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultAgentTimeoutMs: 600000 });

      saveWorkflowSettings({ defaultAgentTimeoutMs: null }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultAgentTimeoutMs: null });
    });
  });

  it("saves, loads, and normalizes defaultTokenBudget (#68)", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      saveWorkflowSettings({ defaultTokenBudget: 500_000 }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultTokenBudget: 500_000 });

      // null is a meaningful value: "explicitly no budget" (project override).
      saveWorkflowSettings({ defaultTokenBudget: null }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultTokenBudget: null });

      // Floats floor; zero/negative are dropped (numbers pass the type schema).
      writeFileSync(settingsPath, JSON.stringify({ defaultTokenBudget: 1000.9 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultTokenBudget: 1000 });
      writeFileSync(settingsPath, JSON.stringify({ defaultTokenBudget: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      // A wrong-typed value fails the declared schema loudly.
      writeFileSync(settingsPath, JSON.stringify({ defaultTokenBudget: "lots" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("loads and normalizes excludeSubagentTools, dropping non-string/blank entries (#107)", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: ["pi-subagents", "spawn"] }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { excludeSubagentTools: ["pi-subagents", "spawn"] });

      // Non-string and blank entries are filtered out.
      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: ["keep", 42, "", "  ", null] }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { excludeSubagentTools: ["keep"] });

      // An all-invalid (or empty) list yields no key at all.
      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: [1, 2, ""] }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      // A non-array value violates the declared schema and fails loudly.
      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: "nope" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("saves and loads subagentHostTools, dropping values outside auto|on|off", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      // All three mode literals round-trip.
      for (const mode of ["auto", "on", "off"] as const) {
        saveWorkflowSettings({ subagentHostTools: mode }, settingsPath);
        assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentHostTools: mode });
      }

      // A wrong-typed value violates the declared schema and fails loudly.
      writeFileSync(settingsPath, JSON.stringify({ subagentHostTools: 42 }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);

      // A string outside the three literals passes the schema but is dropped
      // by value normalization (lenient drop-on-violation, like the enums).
      for (const mode of ["", "  ", "AUTO", "eager", "banana"]) {
        writeFileSync(settingsPath, JSON.stringify({ subagentHostTools: mode }), "utf-8");
        assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      }
    });
  });

  it("saves and loads subagentTools: the all literal, allowlists, and the empty-allowlist none mode", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      // The "all" literal round-trips.
      saveWorkflowSettings({ subagentTools: "all" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentTools: "all" });

      // An allowlist round-trips; blank/non-string entries are dropped and
      // duplicates are collapsed while preserving order.
      saveWorkflowSettings(
        { subagentTools: ["mcp_svelte_read_resource", "  ", 42 as unknown as string, "mcp_svelte_read_resource"] },
        settingsPath,
      );
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentTools: ["mcp_svelte_read_resource"] });

      // The empty allowlist is the "none" side of the setting: MCP tools are
      // disabled for subagents (emitted as an explicit [] so the spread-merge
      // in loadWorkflowSettings actually overrides a global "all").
      saveWorkflowSettings({ subagentTools: [] }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentTools: [] });

      // A wrong-typed value violates the declared schema and fails loudly.
      writeFileSync(settingsPath, JSON.stringify({ subagentTools: 42 }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);

      // A string outside the "all" literal passes the schema but is dropped by
      // value normalization (lenient drop-on-violation, like subagentHostTools).
      writeFileSync(settingsPath, JSON.stringify({ subagentTools: "everything" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("saves and loads subagentExtensionTools: on/off literals and the known-source allowlist", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      // The "on"/"off" capture-mode literals round-trip.
      saveWorkflowSettings({ subagentExtensionTools: "on" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentExtensionTools: "on" });
      saveWorkflowSettings({ subagentExtensionTools: "off" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentExtensionTools: "off" });

      // A known-source allowlist round-trips (pi-vision-handoff included).
      saveWorkflowSettings({ subagentExtensionTools: ["pi-vision-handoff", "supi-web"] }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), {
        subagentExtensionTools: ["pi-vision-handoff", "supi-web"],
      });

      // Unknown/blank entries are dropped while preserving order; an
      // all-unknown allowlist normalizes away (no setting — the off side).
      // Written directly (not via saveWorkflowSettings): save merges with the
      // previous file contents, and a fully-dropped allowlist must leave NO
      // override — exactly what a raw file with only unknown ids proves.
      writeFileSync(settingsPath, JSON.stringify({ subagentExtensionTools: ["bogus"] }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      // The empty allowlist is the explicit "none" side.
      saveWorkflowSettings({ subagentExtensionTools: [] }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentExtensionTools: [] });

      // A wrong-typed value violates the declared schema and fails loudly.
      writeFileSync(settingsPath, JSON.stringify({ subagentExtensionTools: 42 }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("saves and loads subagentSkills: all|none (T-01 parity knob)", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      saveWorkflowSettings({ subagentSkills: "none" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentSkills: "none" });
      saveWorkflowSettings({ subagentSkills: "all" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentSkills: "all" });

      // A wrong-typed / out-of-enum value fails loudly (strict schema).
      writeFileSync(settingsPath, JSON.stringify({ subagentSkills: 42 }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("saves and loads defaultUntaggedTier: economy | inherit:main | tier name (DS-4)", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      saveWorkflowSettings({ defaultUntaggedTier: "economy" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultUntaggedTier: "economy" });
      saveWorkflowSettings({ defaultUntaggedTier: "inherit:main" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultUntaggedTier: "inherit:main" });
      // A literal tier name is a valid value too.
      saveWorkflowSettings({ defaultUntaggedTier: "fast-lane" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultUntaggedTier: "fast-lane" });

      // A wrong-typed value violates the declared schema and fails loudly.
      writeFileSync(settingsPath, JSON.stringify({ defaultUntaggedTier: 42 }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);

      // An empty string normalizes to "unset" (lenient drop, like other keys).
      writeFileSync(settingsPath, JSON.stringify({ defaultUntaggedTier: "   " }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("normalizes default concurrency and agent retries", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 4.9, defaultAgentRetries: 2.8 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 4, defaultAgentRetries: 2 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 99, defaultAgentRetries: 99 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 16, defaultAgentRetries: 3 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 0, defaultAgentRetries: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("merges project settings over global settings when cwd is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        const globalPath = getWorkflowSettingsPath();
        const projectPath = getWorkflowProjectSettingsPath(cwd);
        saveWorkflowSettings({ keywordTriggerEnabled: true, defaultAgentTimeoutMs: 600000 }, globalPath);
        saveWorkflowSettings({ keywordTriggerEnabled: false }, { cwd, settingsPath: globalPath, scope: "project" });

        assert.deepEqual(loadWorkflowSettings(globalPath), {
          keywordTriggerEnabled: true,
          defaultAgentTimeoutMs: 600000,
        });
        assert.deepEqual(loadWorkflowSettings({ cwd, settingsPath: globalPath, projectSettingsPath: projectPath }), {
          keywordTriggerEnabled: false,
          defaultAgentTimeoutMs: 600000,
        });
      });
    } finally {
      await rmForce(dir);
    }
  });

  it("saves cwd preferences globally without creating a project override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        saveWorkflowSettingsForCwd({ keywordTriggerEnabled: false }, cwd);

        assert.deepEqual(loadWorkflowSettings({ cwd }), { keywordTriggerEnabled: false });
        assert.equal(existsSync(getWorkflowProjectSettingsPath(cwd)), false);
      });
    } finally {
      await rmForce(dir);
    }
  });

  it("saves cwd preferences into an existing project override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        saveWorkflowSettings({ keywordTriggerEnabled: false }, { cwd, scope: "project" });

        saveWorkflowSettingsForCwd({ keywordTriggerEnabled: true }, cwd);

        assert.deepEqual(loadWorkflowSettings(), { keywordTriggerEnabled: true });
        assert.deepEqual(loadWorkflowSettings({ cwd }), { keywordTriggerEnabled: true });
        assert.deepEqual(loadWorkflowSettings({ projectSettingsPath: getWorkflowProjectSettingsPath(cwd) }), {
          keywordTriggerEnabled: true,
        });
      });
    } finally {
      await rmForce(dir);
    }
  });

  it("preserves unknown settings when saving known settings", async () => {
    await withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: true }, settingsPath);
      const current = JSON.parse(readFileSync(settingsPath, "utf-8"));
      writeFileSync(settingsPath, `${JSON.stringify({ ...current, theme: "dark" }, null, 2)}\n`, "utf-8");

      saveWorkflowSettings({ keywordTriggerEnabled: false }, settingsPath);

      assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf-8")), {
        keywordTriggerEnabled: false,
        theme: "dark",
      });
    });
  });

  it("saves and loads the progress panel mode", async () => {
    await withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ progressPanelMode: "detailed" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMode: "detailed" });

      saveWorkflowSettings({ progressPanelMode: "compact" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMode: "compact" });
    });
  });

  it("rejects an invalid progress panel mode", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ progressPanelMode: "verbose" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("clamps and floors progressPanelMaxAgents into [1, 1000]", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 12.7 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMaxAgents: 12 });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 5000 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMaxAgents: 1000 });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      // A string is a schema violation and fails loudly.
      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: "8" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("saves and loads persistAgentSessions", async () => {
    await withSettingsPath((settingsPath) => {
      assert.deepEqual(loadWorkflowSettings(settingsPath), {}, "absent by default");

      saveWorkflowSettings({ persistAgentSessions: true }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { persistAgentSessions: true });

      saveWorkflowSettings({ persistAgentSessions: false }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { persistAgentSessions: false });
    });
  });

  it("rejects non-boolean persistAgentSessions values with ConfigError", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      // Wrong-typed values violate the declared schema: a named ConfigError,
      // not a silent drop.
      for (const persistAgentSessions of ["true", 1, null]) {
        writeFileSync(settingsPath, JSON.stringify({ persistAgentSessions }), "utf-8");
        assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
      }
    });
  });

  it("clamps and floors deliveredResultMaxChars into [1, 1000000]", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 250.9 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { deliveredResultMaxChars: 250 });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 5_000_000 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { deliveredResultMaxChars: 1_000_000 });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      // A string is a schema violation and fails loudly.
      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: "400" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("project persistAgentSessions overrides the global setting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        const globalPath = getWorkflowSettingsPath();
        const projectPath = getWorkflowProjectSettingsPath(cwd);

        saveWorkflowSettings({ persistAgentSessions: false }, globalPath);
        saveWorkflowSettings({ persistAgentSessions: true }, { cwd, settingsPath: globalPath, scope: "project" });

        assert.deepEqual(loadWorkflowSettings(globalPath), { persistAgentSessions: false });
        assert.deepEqual(loadWorkflowSettings({ cwd, settingsPath: globalPath, projectSettingsPath: projectPath }), {
          persistAgentSessions: true,
        });
      });
    } finally {
      await rmForce(dir);
    }
  });

  it("a corrupted settings.json fails at load with ConfigError", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, "{not json", "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);

      // A JSON array (not an object) is not a valid settings document.
      writeFileSync(settingsPath, JSON.stringify([1, 2]), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("a wrong-typed settings value fails at load with ConfigError", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerEnabled: "off" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("an unknown settings key fails at load with ConfigError", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ bogusKey: "x" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("in-range but semantically invalid numbers are dropped, not fatal", async () => {
    await withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      // Numbers pass the type schema; value normalization drops out-of-range ones.
      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });
});
