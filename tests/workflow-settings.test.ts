import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function withSettingsPath(fn: (settingsPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-settings-"));
  try {
    fn(join(dir, "nested", "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("workflow settings", () => {
  it("resolves the user-level settings path", () => {
    assert.ok(getWorkflowSettingsPath().endsWith(normalize(WORKFLOW_SETTINGS_FILE)));
  });

  it("returns empty settings when the file is missing", () => {
    withSettingsPath((settingsPath) => {
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("saves and loads keyword trigger preferences", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: false, keywordTriggerWord: "pi-workflow" }, settingsPath);

      assert.ok(existsSync(settingsPath), "settings file should be created");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {
        keywordTriggerEnabled: false,
        keywordTriggerWord: "pi-workflow",
      });
    });
  });

  it("normalizes keyword trigger word settings", () => {
    withSettingsPath((settingsPath) => {
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

  it("saves and loads default agent timeout preference", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ defaultAgentTimeoutMs: 600000 }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultAgentTimeoutMs: 600000 });

      saveWorkflowSettings({ defaultAgentTimeoutMs: null }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultAgentTimeoutMs: null });
    });
  });

  it("saves, loads, and normalizes defaultTokenBudget (#68)", () => {
    withSettingsPath((settingsPath) => {
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

  it("loads and normalizes excludeSubagentTools, dropping non-string/blank entries (#107)", () => {
    withSettingsPath((settingsPath) => {
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

  it("normalizes default concurrency and agent retries", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 4.9, defaultAgentRetries: 2.8 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 4, defaultAgentRetries: 2 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 99, defaultAgentRetries: 99 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 16, defaultAgentRetries: 3 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 0, defaultAgentRetries: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("merges project settings over global settings when cwd is provided", () => {
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves cwd preferences globally without creating a project override", () => {
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves cwd preferences into an existing project override", () => {
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves unknown settings when saving known settings", () => {
    withSettingsPath((settingsPath) => {
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

  it("saves and loads the progress panel mode", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ progressPanelMode: "detailed" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMode: "detailed" });

      saveWorkflowSettings({ progressPanelMode: "compact" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMode: "compact" });
    });
  });

  it("rejects an invalid progress panel mode", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ progressPanelMode: "verbose" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("clamps and floors progressPanelMaxAgents into [1, 1000]", () => {
    withSettingsPath((settingsPath) => {
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

  it("saves and loads persistAgentSessions", () => {
    withSettingsPath((settingsPath) => {
      assert.deepEqual(loadWorkflowSettings(settingsPath), {}, "absent by default");

      saveWorkflowSettings({ persistAgentSessions: true }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { persistAgentSessions: true });

      saveWorkflowSettings({ persistAgentSessions: false }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { persistAgentSessions: false });
    });
  });

  it("rejects non-boolean persistAgentSessions values with ConfigError", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      // Wrong-typed values violate the declared schema: a named ConfigError,
      // not a silent drop.
      for (const persistAgentSessions of ["true", 1, null]) {
        writeFileSync(settingsPath, JSON.stringify({ persistAgentSessions }), "utf-8");
        assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
      }
    });
  });

  it("clamps and floors deliveredResultMaxChars into [1, 1000000]", () => {
    withSettingsPath((settingsPath) => {
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

  it("project persistAgentSessions overrides the global setting", () => {
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupted settings.json fails at load with ConfigError", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, "{not json", "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);

      // A JSON array (not an object) is not a valid settings document.
      writeFileSync(settingsPath, JSON.stringify([1, 2]), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("a wrong-typed settings value fails at load with ConfigError", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerEnabled: "off" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("an unknown settings key fails at load with ConfigError", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ bogusKey: "x" }), "utf-8");
      assert.throws(() => loadWorkflowSettings(settingsPath), ConfigError);
    });
  });

  it("in-range but semantically invalid numbers are dropped, not fatal", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      // Numbers pass the type schema; value normalization drops out-of-range ones.
      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });
});
