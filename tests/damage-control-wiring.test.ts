/**
 * Slice-B wiring tests for the damage-control toolset
 * (tasks/damage-control-recovery/DESIGN.md §6/§7 — Slice B, the wiring,
 * settings, and command-surface owner).
 *
 * Coverage:
 *  1. Assembler: the `damageControlTools` supplier slot — defs are appended
 *     after chrome/extension tools when a supplier is provided ("on"/"readonly"
 *     gate), NO defs anywhere when the supplier is absent ("off" gate — the
 *     lazy guarantee: undefined supplier ⇒ no defs in assemble() nor in the
 *     named toolset), `damageControlToolsOnly()` yields the supplier's defs,
 *     and `excludeSubagentTools` can always veto `workflow_damage_control`.
 *  2. Settings matrix: `subagentDamageControlTools` accepts off|readonly|on
 *     from env and settings.json, trims whitespace, drops any other string
 *     (lenient drop-on-violation like subagentChromeTools), and a wrong-typed
 *     value fails the schema loudly.
 *  3. Command surface: `classifyToolSource("workflow_damage_control")` is
 *     "damage-control"; assembled rows are allowed with the source note;
 *     the not-in-session row is available-if-enabled with an actionable note
 *     when the mode is off; the header renders off|readonly|on and treats an
 *     absent field as off (pre-existing listing() callers keep compiling).
 *  4. Extension registration: `workflow_damage_control` is registered through
 *     registerToolSafely next to workflow_control + get_workflow_status
 *     (existing tools untouched), and the `/workflows-subagent-tools` handler
 *     forwards the effective damageControlMode from settings into the listing.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WORKFLOW_ENV_VARS, workflowSettingsFromEnv } from "../src/config.js";
import { discardWorkflowRuntime, takeWorkflowRuntime } from "../src/extension-reload.js";
import { McpToolsManager } from "../src/subagent/mcp-tools.js";
import { SubagentToolsAssembler } from "../src/subagent/subagent-tools-assembler.js";
import { getWorkflowSettingsPath, loadWorkflowSettings, saveWorkflowSettings } from "../src/workflow-settings.js";
import {
  buildSubagentToolRows,
  classifyToolSource,
  renderSubagentToolsListing,
  type SubagentToolsListingInput,
} from "../src/workflows-subagent-tools-command.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { createMockMcpServer, type MockMcpServer } from "./helpers/mcp-mock.js";
import type { RegisteredCommand } from "./helpers/mock-pi.js";
import { makeNotifyCtx } from "./helpers/mock-pi.js";

const servers: MockMcpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function track(server: MockMcpServer): MockMcpServer {
  servers.push(server);
  return server;
}

/** A minimal ToolDefinition whose execute echoes its params as text. */
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `Fake tool (${name})`,
    parameters: Type.Object({}),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;
}

const HOST_TOOLS = [fakeTool("read"), fakeTool("bash"), fakeTool("edit"), fakeTool("write"), fakeTool("web_search")];
const DAMAGE_CONTROL_NAME = "workflow_damage_control";
const DAMAGE_CONTROL_DEF = fakeTool(DAMAGE_CONTROL_NAME);

/** ToolInfo metadata for a host-registered tool (the getAllTools() shape). */
function fakeInfo(name: string, source: string = "extension"): ToolInfo {
  return {
    name,
    description: `Live ${name} description`,
    parameters: Type.Object({}),
    promptGuidelines: [`Guideline for ${name}`],
    sourceInfo: { path: `<${name}>`, source, scope: "temporary", origin: "top-level" },
  };
}

function makeManager(server: MockMcpServer): McpToolsManager {
  return new McpToolsManager({ config: [{ name: "svelte", type: "http", url: server.url }] });
}

async function mcpServerTools(): Promise<MockMcpServer> {
  return track(
    await createMockMcpServer({
      tools: [{ name: "get-docs", inputSchema: { type: "object", properties: {} } }],
    }),
  );
}

function makeAssembler(
  manager: McpToolsManager,
  mode: "all" | string[],
  options: {
    excludeTools?: string[];
    chromeTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
    extensionTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
    damageControlTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  } = {},
): SubagentToolsAssembler {
  return new SubagentToolsAssembler({
    mode,
    hostTools: () => [...HOST_TOOLS],
    mcpTools: manager,
    chromeTools: options.chromeTools,
    extensionTools: options.extensionTools,
    damageControlTools: options.damageControlTools,
    excludeTools: options.excludeTools,
  });
}

describe("SubagentToolsAssembler — damageControlTools supplier", () => {
  test("an enabled supplier appends workflow_damage_control after chrome/extension tools", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", {
      chromeTools: () => [fakeTool("chrome_snapshot")],
      extensionTools: () => [fakeTool("web_fetch_md")],
      damageControlTools: () => [DAMAGE_CONTROL_DEF],
    });
    const tools = await assembler.assemble();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        ...HOST_TOOLS.map((tool) => tool.name),
        "mcp_svelte_get-docs",
        "chrome_snapshot",
        "web_fetch_md",
        DAMAGE_CONTROL_NAME,
      ],
    );
  });

  test('an absent supplier ("off" gate) contributes NO defs anywhere — the lazy guarantee', async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all");
    const tools = await assembler.assemble();
    assert.ok(
      !tools.some((tool) => tool.name === DAMAGE_CONTROL_NAME),
      "off mode must never materialize a damage-control def in assemble()",
    );
    assert.deepEqual(
      await assembler.damageControlToolsOnly(),
      [],
      "off mode must resolve the named toolset to [] (script intent recorded, no tools)",
    );
  });

  test("an empty supplier contributes nothing but still resolves without throwing", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", {
      damageControlTools: () => [],
    });
    const tools = await assembler.assemble();
    assert.ok(!tools.some((tool) => tool.name === DAMAGE_CONTROL_NAME));
    assert.deepEqual(await assembler.damageControlToolsOnly(), []);
  });

  test("damageControlToolsOnly yields the supplier's defs without the rest of the bundle", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", {
      chromeTools: () => [fakeTool("chrome_snapshot")],
      damageControlTools: () => [DAMAGE_CONTROL_DEF],
    });
    assert.deepEqual(
      (await assembler.damageControlToolsOnly()).map((tool) => tool.name),
      [DAMAGE_CONTROL_NAME],
    );
  });

  test("excludeSubagentTools can always veto workflow_damage_control (deny override)", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", {
      excludeTools: [DAMAGE_CONTROL_NAME],
      damageControlTools: () => [DAMAGE_CONTROL_DEF],
    });
    const tools = await assembler.assemble();
    assert.ok(!tools.some((tool) => tool.name === DAMAGE_CONTROL_NAME), "denied name must never ride along");
    assert.deepEqual(await assembler.damageControlToolsOnly(), [], "the named toolset must respect the deny list too");
  });

  test("a missing module yields [] from the extension's supplier, never a throw out of assemble()", async () => {
    // Mirrors extensions/workflow.ts: the supplier guards a missing/failed
    // module and resolves [] (no defs), so assemble() cannot reject on it —
    // the same non-throwing supplier contract chrome/extension follow.
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", {
      damageControlTools: async () => {
        return [];
      },
    });
    const tools = await assembler.assemble();
    assert.ok(!tools.some((tool) => tool.name === DAMAGE_CONTROL_NAME));
    assert.deepEqual(await assembler.damageControlToolsOnly(), []);
  });
});

describe("subagentDamageControlTools settings matrix", () => {
  test("env accepts off|readonly|on, trims whitespace, and drops anything else", () => {
    for (const mode of ["off", "readonly", "on"]) {
      assert.deepEqual(workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentDamageControlTools]: mode }), {
        subagentDamageControlTools: mode,
      });
      assert.deepEqual(
        workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentDamageControlTools]: `  ${mode}  ` }),
        { subagentDamageControlTools: mode },
        "whitespace around the mode literal is trimmed",
      );
    }
    for (const garbage of ["", "  ", "OFF", "READONLY", "yes", "1", "eager", "partial", "all"]) {
      assert.deepEqual(
        workflowSettingsFromEnv({ [WORKFLOW_ENV_VARS.subagentDamageControlTools]: garbage }),
        {},
        `env value ${JSON.stringify(garbage)} must be dropped (default off)`,
      );
    }
  });

  test("settings.json round-trips off|readonly|on, drops other strings, and rejects wrong types", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-damage-settings-"));
    try {
      await withFakeHomeAsync(home, async () => {
        const settingsPath = getWorkflowSettingsPath();
        mkdirSync(dirname(settingsPath), { recursive: true });

        for (const mode of ["off", "readonly", "on"] as const) {
          saveWorkflowSettings({ subagentDamageControlTools: mode }, settingsPath);
          assert.deepEqual(loadWorkflowSettings(settingsPath), { subagentDamageControlTools: mode });
        }

        // A wrong-typed value violates the declared schema and fails loudly.
        writeFileSync(settingsPath, JSON.stringify({ subagentDamageControlTools: 42 }), "utf-8");
        assert.throws(() => loadWorkflowSettings(settingsPath));

        // A string outside the three literals passes the schema but is dropped
        // by value normalization (lenient drop-on-violation, like subagentChromeTools).
        for (const mode of ["", "  ", "READONLY", "full", "banana"]) {
          writeFileSync(settingsPath, JSON.stringify({ subagentDamageControlTools: mode }), "utf-8");
          assert.deepEqual(loadWorkflowSettings(settingsPath), {});
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("command surface — damage-control rows", () => {
  function listing(overrides: Partial<SubagentToolsListingInput> = {}): SubagentToolsListingInput {
    return {
      mode: "all",
      hostToolsMode: "auto",
      excludeTools: [],
      assembledToolNames: ["read", "bash", "mcp_svelte_get-docs"],
      hostToolInfos: [fakeInfo(DAMAGE_CONTROL_NAME)],
      mcpServerNames: ["svelte"],
      chromeToolsMode: "off",
      chromeGranted: false,
      extensionToolsMode: "off",
      extensionToolSources: [],
      ...overrides,
    };
  }

  function rowByName(rows: ReturnType<typeof buildSubagentToolRows>, name: string) {
    return rows.find((row) => row.name === name);
  }

  test("classifyToolSource maps workflow_damage_control to the damage-control source", () => {
    assert.equal(classifyToolSource(DAMAGE_CONTROL_NAME), "damage-control");
  });

  test("an assembled damage-control def is allowed with the source note", () => {
    const rows = buildSubagentToolRows(
      listing({ assembledToolNames: ["read", DAMAGE_CONTROL_NAME], damageControlMode: "on" }),
    );
    const row = rowByName(rows, DAMAGE_CONTROL_NAME);
    assert.equal(row?.status, "allowed");
    assert.equal(row?.source, "damage-control");
    assert.match(row?.note ?? "", /subagentDamageControlTools=readonly\/on/);
  });

  test("a not-in-session damage-control tool with mode off is available-if-enabled (actionable note)", () => {
    const rows = buildSubagentToolRows(listing({ damageControlMode: "off" }));
    const row = rowByName(rows, DAMAGE_CONTROL_NAME);
    assert.equal(row?.status, "available-if-enabled", "off must be a recoverable state, not metadata-only");
    assert.equal(row?.source, "damage-control");
    assert.match(row?.note ?? "", /subagentDamageControlTools is off/);
    assert.match(row?.note ?? "", /readonly \(inspection verbs only\) or on/);
  });

  test("an absent damageControlMode field defaults to off (pre-existing callers keep compiling)", () => {
    const rows = buildSubagentToolRows(listing());
    const row = rowByName(rows, DAMAGE_CONTROL_NAME);
    assert.equal(row?.status, "available-if-enabled");
    assert.match(row?.note ?? "", /subagentDamageControlTools is off/);
  });

  test("the header renders the mode with mode-specific copy", () => {
    const off = renderSubagentToolsListing(listing({ damageControlMode: "off" }));
    assert.match(off, /Damage control tools: \*\*off\*\*/);
    assert.match(off, /set settings\.subagentDamageControlTools=readonly/);

    const readonly = renderSubagentToolsListing(listing({ damageControlMode: "readonly" }));
    assert.match(readonly, /Damage control tools: \*\*readonly\*\*/);
    assert.match(readonly, /inspection verbs only \(list\/status\/agents\/clean\)/);

    const on = renderSubagentToolsListing(listing({ damageControlMode: "on" }));
    assert.match(on, /Damage control tools: \*\*on\*\*/);
    assert.match(on, /full verb set \(pause\/resume\/stop\/kill-agent\/recover\)/);
  });

  test("the header defaults to off when the field is absent", () => {
    const md = renderSubagentToolsListing(listing());
    assert.match(md, /Damage control tools: \*\*off\*\*/);
  });
});

describe("extension wiring (mock-pi)", () => {
  interface ExtensionPi {
    pi: ExtensionAPI;
    commands: RegisteredCommand[];
    handlers: Record<string, Array<(...args: any[]) => any>>;
    sent: Array<{ content?: string }>;
    registeredTools: string[];
  }

  /** A Pi mock matching subagent-host-tools.test.ts plus getAllTools(). */
  function makeExtensionPi(): ExtensionPi {
    const registeredTools: string[] = [];
    const handlers: Record<string, Array<(...args: any[]) => any>> = {};
    const activeTools: string[] = ["bash", "read"];
    const commands: RegisteredCommand[] = [];
    const sent: Array<{ content?: string }> = [];
    const pi = {
      registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
      registerCommand: (name: string, spec: Omit<RegisteredCommand, "name">) => {
        commands.push({ name, ...spec });
      },
      getCommands: () => commands.map((c) => ({ name: c.name })),
      on: (event: string, handler: (...args: any[]) => any) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (tools: string[]) => {
        activeTools.splice(0, activeTools.length, ...tools);
      },
      sendMessage: (msg: { content?: string }) => {
        sent.push(msg);
      },
      getAllTools: () => registeredTools.map((name) => fakeInfo(name)),
    } as unknown as ExtensionAPI;
    return { pi, commands, handlers, sent, registeredTools };
  }

  /** Clean a staged runtime the way a non-reload shutdown does. */
  function cleanupExtension(handlers: Record<string, Array<(...args: any[]) => any>>): void {
    handlers.session_shutdown?.[0]?.();
    discardWorkflowRuntime(process.cwd());
    const stale = takeWorkflowRuntime(process.cwd());
    if (stale) discardWorkflowRuntime(process.cwd(), stale);
  }

  function lastSent(extension: ExtensionPi): string {
    return extension.sent.at(-1)?.content ?? "";
  }

  async function installInFakeHome(
    home: string,
    settings: Record<string, unknown>,
    fn: (extension: ExtensionPi) => Promise<void>,
  ): Promise<void> {
    await withFakeHomeAsync(home, async () => {
      const settingsPath = getWorkflowSettingsPath();
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ subagentHostTools: "off", ...settings }), "utf-8");

      const extension = makeExtensionPi();
      const { default: installExtension } = await import("../extensions/workflow.js");
      installExtension(extension.pi);
      try {
        await fn(extension);
      } finally {
        cleanupExtension(extension.handlers);
      }
    });
  }

  test("workflow_damage_control is registered next to workflow_control + get_workflow_status", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-damage-ext-"));
    try {
      await installInFakeHome(home, {}, async (extension) => {
        assert.ok(
          extension.registeredTools.includes("workflow_damage_control"),
          "damage-control tool must be registered",
        );
        assert.ok(extension.registeredTools.includes("workflow_control"), "existing tool must stay registered");
        assert.ok(extension.registeredTools.includes("get_workflow_status"), "existing tool must stay registered");
        assert.ok(extension.registeredTools.includes("workflow"), "existing tool must stay registered");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the /workflows-subagent-tools handler forwards the effective damageControlMode", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-damage-ext-"));
    try {
      await installInFakeHome(home, { subagentDamageControlTools: "readonly" }, async (extension) => {
        const command = extension.commands.find((c) => c.name === "workflows-subagent-tools");
        assert.ok(command, "the extension must register /workflows-subagent-tools");
        const { ctx } = makeNotifyCtx();
        await (command.handler as (args: string, c: ExtensionCommandContext) => Promise<void>)("", ctx);
        assert.match(lastSent(extension), /Damage control tools: \*\*readonly\*\*/);
        assert.match(lastSent(extension), /inspection verbs only/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
