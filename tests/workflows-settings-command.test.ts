/**
 * Tests for workflows-settings-command.ts (S3) — registration, arg routing,
 * the ConfigError gate, the three tiers (TUI form / dialog / print), and the
 * merge-write save path. Uses the shared mock-pi registry helper and temp
 * settings files injected through WorkflowSettingsCommandOptions (the same
 * injection the existing workflow-settings.test.ts uses).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadWorkflowSettings, type WorkflowSettings } from "../src/workflow-settings.js";
import { FIELD_REGISTRY } from "../src/workflow-settings-fields.js";
import {
  buildSettingsStatusMarkdown,
  registerWorkflowSettingsCommand,
  runWorkflowSettingsCommand,
} from "../src/workflows-settings-command.js";
import { makeCommandRegistryPi } from "./helpers/mock-pi.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Temp-dir helper: awaits the async body before cleaning up. */
async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pwf-settings-command-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Minimal pi stub that records sendMessage payloads. */
function makeSendingPi() {
  const sent: Array<{ customType?: string; content?: string; display?: boolean }> = [];
  const pi = {
    sendMessage: (message: { customType?: string; content?: string; display?: boolean }) => {
      sent.push(message);
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

/** A ui stub whose methods throw when the tier under test must not call them. */
function noPromptsUi() {
  return {
    select: () => {
      throw new Error("dialog tier must not run");
    },
    input: () => {
      throw new Error("dialog tier must not run");
    },
    custom: () => {
      throw new Error("form tier must not run");
    },
    notify: () => {},
  };
}

describe("registerWorkflowSettingsCommand", () => {
  it("registers exactly the workflows-settings command with a description", () => {
    const { pi, commands } = makeCommandRegistryPi();
    registerWorkflowSettingsCommand(pi);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.name, "workflows-settings");
    assert.ok(commands[0]?.description, "description must not be empty");
  });

  it("is idempotent against an already-registered name", () => {
    const { pi, commands } = makeCommandRegistryPi(["workflows-settings"]);
    registerWorkflowSettingsCommand(pi);
    assert.equal(commands.length, 0, "must not re-register an existing name");
  });

  it("is idempotent across repeated calls", () => {
    const { pi, commands } = makeCommandRegistryPi();
    registerWorkflowSettingsCommand(pi);
    registerWorkflowSettingsCommand(pi);
    assert.equal(commands.length, 1);
  });

  it("offers status/paths argument completions filtered by prefix", () => {
    const { pi, commands } = makeCommandRegistryPi();
    registerWorkflowSettingsCommand(pi);
    const firstCommand = commands[0] as unknown as {
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
    };
    const completions = firstCommand?.getArgumentCompletions?.("st") ?? [];
    assert.deepEqual(completions, [{ value: "status", label: "status" }]);
    const emptyPrefix = firstCommand?.getArgumentCompletions?.("") ?? [];
    assert.deepEqual(
      emptyPrefix.map((c: { value: string }) => c.value),
      ["status", "paths"],
    );
  });
});

describe("print tier (status/print/paths args)", () => {
  it("status prints the effective settings markdown with both file paths", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "global", "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 4 }), "utf-8");
      const projectPath = join(dir, "project", "settings.json");
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(projectPath, JSON.stringify({ progressPanelMode: "detailed" }), "utf-8");

      const { pi, sent } = makeSendingPi();
      const ctx = { cwd: dir, ui: noPromptsUi() } as unknown as ExtensionCommandContext;

      await runWorkflowSettingsCommand(pi, ctx, "status", { settingsPath, projectSettingsPath: projectPath });

      assert.equal(sent.length, 1);
      const message = sent[0];
      assert.equal(message?.customType, "workflows-settings");
      assert.ok(message?.content, "status content must not be empty");
      assert.match(message?.content ?? "", /## Effective workflow settings/);
      for (const field of FIELD_REGISTRY) {
        assert.match(
          message?.content ?? "",
          new RegExp(`- ${escapeRegExp(field.label)}:`),
          `status must list the ${field.key} row`,
        );
      }
      assert.match(message?.content ?? "", new RegExp(`Global file: ${escapeRegExp(settingsPath)}`));
      assert.match(message?.content ?? "", new RegExp(`Project file: ${escapeRegExp(projectPath)}`));
    });
  });

  it("status marks env-locked keys and applies env overrides", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 4 }), "utf-8");

      const { pi, sent } = makeSendingPi();
      const ctx = { cwd: dir, ui: noPromptsUi() } as unknown as ExtensionCommandContext;

      await runWorkflowSettingsCommand(pi, ctx, "print", {
        settingsPath,
        env: { PI_WORKFLOW_DEFAULT_CONCURRENCY: "16" },
      });

      const content = sent[0]?.content ?? "";
      const concurrencyRow = content.split("\n").find((line) => line.includes("Max concurrent agents"));
      assert.ok(concurrencyRow, "concurrency row must be present");
      assert.match(concurrencyRow, /16/, "env override must win at load");
      assert.match(concurrencyRow, /🔒 env/, "env-locked keys must be flagged");
    });
  });

  it("paths prints only the two file locations", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const projectPath = join(dir, "project.json");
      const { pi, sent } = makeSendingPi();
      const ctx = { cwd: dir, ui: noPromptsUi() } as unknown as ExtensionCommandContext;

      await runWorkflowSettingsCommand(pi, ctx, "paths", { settingsPath, projectSettingsPath: projectPath });

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.customType, "workflows-settings");
      assert.equal(sent[0]?.content, `Global file: ${settingsPath}\nProject file: ${projectPath}`);
    });
  });

  it("buildSettingsStatusMarkdown lists every key with defaults and lock markers", () => {
    const effective: WorkflowSettings = { defaultConcurrency: 4, progressPanelMode: "compact" };
    const envLocks: WorkflowSettings = { defaultConcurrency: 16 };
    const markdown = buildSettingsStatusMarkdown(effective, envLocks, {
      globalPath: "/g/settings.json",
      projectPath: "/p/settings.json",
    });
    for (const field of FIELD_REGISTRY) {
      assert.match(markdown, new RegExp(`- ${escapeRegExp(field.label)}:`));
    }
    assert.match(markdown, /\(default\)/, "unset keys must be marked with the default");
    assert.match(markdown, /🔒 env/);
    assert.match(markdown, /Global file: \/g\/settings\.json/);
    assert.match(markdown, /Project file: \/p\/settings\.json/);
    assert.match(markdown, /interactive editor/);
  });
});

describe("ConfigError gate", () => {
  it("notifies the error verbatim and prints the paths without prompting", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "bad.json");
      writeFileSync(settingsPath, JSON.stringify({ bogus: 1 }), "utf-8");

      const notified: Array<{ message: string; type?: string }> = [];
      const { pi, sent } = makeSendingPi();
      const ctx = {
        cwd: dir,
        ui: {
          ...noPromptsUi(),
          notify: (message: string, type?: string) => notified.push({ message, type }),
        },
      } as unknown as ExtensionCommandContext;

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      assert.equal(notified.length, 1);
      assert.match(notified[0]?.message ?? "", /Unknown key "bogus"/);
      assert.equal(notified[0]?.type, "error");
      assert.equal(sent.length, 1);
      assert.match(sent[0]?.content ?? "", new RegExp(`Global file: ${escapeRegExp(settingsPath)}`));
      assert.match(sent[0]?.content ?? "", /Unknown key "bogus"/);
    });
  });

  it("surfaces malformed JSON as ConfigError", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "bad.json");
      writeFileSync(settingsPath, "{ not json", "utf-8");

      const notified: Array<{ message: string; type?: string }> = [];
      const { pi } = makeSendingPi();
      const ctx = {
        cwd: dir,
        ui: { ...noPromptsUi(), notify: (message: string, type?: string) => notified.push({ message, type }) },
      } as unknown as ExtensionCommandContext;

      await runWorkflowSettingsCommand(pi, ctx, "status", { settingsPath });

      assert.equal(notified.length, 1);
      assert.match(notified[0]?.message ?? "", /not valid JSON/);
    });
  });

  it("rejects a wrong-typed value as ConfigError without prompting", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "bad.json");
      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: "abc" }), "utf-8");

      const notified: Array<{ message: string; type?: string }> = [];
      const { pi, sent } = makeSendingPi();
      const ctx = {
        cwd: dir,
        ui: {
          ...noPromptsUi(),
          notify: (message: string, type?: string) => notified.push({ message, type }),
        },
      } as unknown as ExtensionCommandContext;

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      assert.equal(notified.length, 1);
      assert.match(notified[0]?.message ?? "", /Key "defaultConcurrency".*must be number, got string/);
      assert.equal(notified[0]?.type, "error");
      assert.equal(sent.length, 1, "the paths message must still print");
      assert.match(sent[0]?.content ?? "", /must be number, got string/);
    });
  });
});

describe("TUI form tier save", () => {
  it("saves the form result payload merged, pretty, newline-terminated", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ defaultAgentRetries: 1 }), "utf-8");

      const notified: Array<{ message: string; type?: string }> = [];
      const ui = {
        custom: async <T>() => ({ cancelled: false, settings: { defaultConcurrency: 4 }, scope: "global" }) as T,
        notify: (message: string, type?: string) => notified.push({ message, type }),
      };
      const ctx = {
        cwd: dir,
        mode: "tui",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      const written = readFileSync(settingsPath, "utf-8");
      assert.equal(written, `${JSON.stringify({ defaultAgentRetries: 1, defaultConcurrency: 4 }, null, 2)}\n`);
      assert.equal(notified.length, 1);
      assert.equal(notified[0]?.message, `Workflow settings saved (global): ${settingsPath}`);
      assert.equal(notified[0]?.type, "info");
    });
  });

  it("writes the project file for a project-scoped form result", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const projectPath = join(dir, "project", "settings.json");
      const notified: Array<{ message: string }> = [];
      const ui = {
        custom: async <T>() =>
          ({ cancelled: false, settings: { progressPanelMode: "detailed" }, scope: "project" }) as T,
        notify: (message: string) => notified.push({ message }),
      };
      const ctx = {
        cwd: dir,
        mode: "tui",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath, projectSettingsPath: projectPath });

      assert.ok(existsSync(projectPath), "project settings file must be written");
      assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf-8")), { progressPanelMode: "detailed" });
      assert.equal(notified[0]?.message, `Workflow settings saved (project): ${projectPath}`);
      assert.equal(existsSync(settingsPath), false, "global file must stay untouched");
    });
  });

  it("does not write when the form result is cancelled with no staged changes", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const notified: Array<{ message: string; type?: string }> = [];
      const ui = {
        custom: async <T>() => ({ cancelled: true, settings: {}, scope: "global" }) as T,
        notify: (message: string, type?: string) => notified.push({ message, type }),
      };
      const ctx = {
        cwd: dir,
        mode: "tui",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      assert.equal(existsSync(settingsPath), false);
      assert.equal(notified.length, 0, "cancelling a clean form must stay silent");
    });
  });
});

describe("save round-trip", () => {
  it("save then load returns the same values for every field type", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const payload: WorkflowSettings = {
        keywordTriggerEnabled: false,
        keywordTriggerWord: "probe",
        defaultAgentTimeoutMs: 90_000,
        defaultConcurrency: 4,
        defaultAgentRetries: 2,
        progressPanelMode: "detailed",
        progressPanelMaxAgents: 20,
        persistAgentSessions: true,
        deliveredResultMaxChars: 5_000,
        excludeSubagentTools: ["tool-a", " tool-b "],
      };
      const ui = {
        custom: async <T>() => ({ cancelled: false, settings: payload, scope: "global" }) as T,
        notify: () => {},
      };
      const ctx = {
        cwd: dir,
        mode: "tui",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      const loaded = loadWorkflowSettings({ settingsPath, cwd: dir });
      // Lossless round-trip: the save path persists values verbatim; trimming
      // happens at edit time in parseFieldInput, not on disk.
      assert.deepEqual(loaded, payload);
    });
  });

  it("round-trips the token-budget 0 tombstone as null", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const ui = {
        custom: async <T>() => ({ cancelled: false, settings: { defaultTokenBudget: 0 }, scope: "global" }) as T,
        notify: () => {},
      };
      const ctx = {
        cwd: dir,
        mode: "tui",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      assert.deepEqual(loadWorkflowSettings({ settingsPath, cwd: dir }), { defaultTokenBudget: null });
    });
  });
});

describe("dialog tier (hasUI without tui)", () => {
  it("prompts in registry order, skipping locked rows, and saves once", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const notified: Array<{ message: string; type?: string }> = [];

      let selectCall = 0;
      let inputCall = 0;
      const selects: string[] = [];
      const ui = {
        select: async (label: string) => {
          selects.push(label);
          selectCall++;
          if (selectCall === 1) return "Global"; // scope
          if (selectCall === 2) return "false"; // keywordTriggerEnabled
          return undefined;
        },
        input: async () => {
          inputCall++;
          return inputCall === 4 ? "12" : undefined; // defaultConcurrency (4th free-text row)
        },
        notify: (message: string, type?: string) => notified.push({ message, type }),
      };
      const ctx = {
        cwd: dir,
        mode: "rpc",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath, env: { PI_WORKFLOW_DEFAULT_AGENT_RETRIES: "2" } });

      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.deepEqual(written, { keywordTriggerEnabled: false, defaultConcurrency: 12 });
      assert.equal(selects[0], "Save scope");
      assert.equal(selects[1], `${FIELD_REGISTRY[0]?.label} (current: true)`);
      assert.ok(
        notified.some((n) => n.message === `Workflow settings saved (global): ${settingsPath}`),
        "save must be confirmed",
      );
    });
  });

  it("never offers Project scope to an untrusted project", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const notified: Array<{ message: string; type?: string }> = [];
      const scopeOptions: string[][] = [];
      const ui = {
        select: async (_label: string, options: string[]) => {
          scopeOptions.push(options);
          return undefined; // abort at the scope prompt
        },
        input: async () => undefined,
        notify: (message: string, type?: string) => notified.push({ message, type }),
      };
      const ctx = {
        cwd: dir,
        mode: "rpc",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      assert.deepEqual(scopeOptions, [["Global"]]);
      assert.ok(notified.some((n) => /no scope selected/.test(n.message)));
      assert.equal(existsSync(settingsPath), false);
    });
  });

  it("re-prompts once on invalid free-text input before skipping", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      const notified: Array<{ message: string; type?: string }> = [];

      let selectCall = 0;
      let inputCall = 0;
      const ui = {
        select: async () => {
          selectCall++;
          return selectCall === 1 ? "Global" : undefined;
        },
        input: async () => {
          inputCall++;
          if (inputCall === 2) return "not-a-number"; // defaultAgentTimeoutMs: invalid
          if (inputCall === 3) return "60000"; // re-prompt: valid
          return undefined;
        },
        notify: (message: string, type?: string) => notified.push({ message, type }),
      };
      const ctx = {
        cwd: dir,
        mode: "rpc",
        hasUI: true,
        isProjectTrusted: () => false,
        ui,
      } as unknown as ExtensionCommandContext;
      const { pi } = makeSendingPi();

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.deepEqual(written, { defaultAgentTimeoutMs: 60000 });
      assert.ok(
        notified.some((n) => n.type === "warning"),
        "invalid input must warn before re-prompting",
      );
    });
  });
});

describe("print tier (no UI)", () => {
  it("only sends the status message without any dialog calls", async () => {
    await withTempDirAsync(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 4 }), "utf-8");

      const { pi, sent } = makeSendingPi();
      const ctx = {
        cwd: dir,
        mode: "print",
        hasUI: false,
        ui: noPromptsUi(),
      } as unknown as ExtensionCommandContext;

      await runWorkflowSettingsCommand(pi, ctx, "", { settingsPath });

      assert.equal(sent.length, 1);
      assert.match(sent[0]?.content ?? "", /## Effective workflow settings/);
    });
  });
});
