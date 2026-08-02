/**
 * Slice W — settings clearing semantics (M9).
 *
 * Covers: explicit `excludeSubagentTools: []` clears a previously-saved list,
 * the `null` tombstone clears in settings.json, `defaultTokenBudget: 0` clears
 * a previously-saved budget, and project overrides can wipe global values.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
} from "../../../src/workflow-settings.js";
import { withFakeHome } from "../../helpers/fake-home.js";

function withSettingsPath(fn: (settingsPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-settings-support-"));
  try {
    fn(join(dir, "nested", "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("settings clearing (M9)", () => {
  it("excludeSubagentTools: [] clears a previously-saved exclusion list", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ excludeSubagentTools: ["pi-subagents", "spawn"] }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { excludeSubagentTools: ["pi-subagents", "spawn"] });

      // Before the fix the empty array was dropped by normalization and the
      // spread-merge left the old list in place — the blocked tool stayed
      // denied silently.
      saveWorkflowSettings({ excludeSubagentTools: [] }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), { excludeSubagentTools: [] });
    });
  });

  it("a null tombstone written directly into settings.json loads as cleared", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: null }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { excludeSubagentTools: [] });
    });
  });

  it("defaultTokenBudget: 0 clears a previously-saved budget", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ defaultTokenBudget: 500_000 }, settingsPath);
      assert.equal(loadWorkflowSettings(settingsPath).defaultTokenBudget, 500_000);

      // 0 is the "clear" tombstone: it persists as the null "no budget" value
      // (so a project override can wipe a global budget), not as a dropped key.
      saveWorkflowSettings({ defaultTokenBudget: 0 }, settingsPath);
      assert.equal(loadWorkflowSettings(settingsPath).defaultTokenBudget, null);
      assert.equal(JSON.parse(readFileSync(settingsPath, "utf-8")).defaultTokenBudget, null);
    });
  });

  it("a project-level empty exclusion list overrides a global exclusion list", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-settings-override-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        const globalPath = getWorkflowSettingsPath();
        const projectPath = getWorkflowProjectSettingsPath(cwd);
        saveWorkflowSettings({ excludeSubagentTools: ["pi-subagents"] }, globalPath);
        saveWorkflowSettings({ excludeSubagentTools: [] }, { cwd, settingsPath: globalPath, scope: "project" });

        const merged = loadWorkflowSettings({ cwd, settingsPath: globalPath, projectSettingsPath: projectPath });
        assert.deepEqual(
          merged.excludeSubagentTools,
          [],
          "the project override must wipe the global exclusion list, not inherit it",
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a project-level defaultTokenBudget: 0 overrides a global budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-settings-budget-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        const globalPath = getWorkflowSettingsPath();
        const projectPath = getWorkflowProjectSettingsPath(cwd);
        saveWorkflowSettings({ defaultTokenBudget: 500_000 }, globalPath);
        saveWorkflowSettings({ defaultTokenBudget: 0 }, { cwd, settingsPath: globalPath, scope: "project" });

        const merged = loadWorkflowSettings({ cwd, settingsPath: globalPath, projectSettingsPath: projectPath });
        assert.equal(merged.defaultTokenBudget, null, "a project-level 0 must clear the global budget");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
