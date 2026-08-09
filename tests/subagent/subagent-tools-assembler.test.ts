/**
 * SubagentToolsAssembler tests (design: tasks/subagent-tools-all/DESIGN.md
 * §assembly): the merged default toolset = host bundle + MCP tools per the
 * subagentTools mode ("all" | allowlist | []), with the always-on
 * workflow/workflow_control denial + settings.excludeSubagentTools applied to
 * the MCP additions, and graceful offline degradation (never throws).
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { McpToolsManager } from "../../src/subagent/mcp-tools.js";
import { SubagentToolsAssembler } from "../../src/subagent/subagent-tools-assembler.js";
import { createMockMcpServer, type MockMcpServer } from "../helpers/mcp-mock.js";

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

function makeManager(server: MockMcpServer): McpToolsManager {
  return new McpToolsManager({ config: [{ name: "svelte", type: "http", url: server.url }] });
}

function makeAssembler(
  manager: McpToolsManager,
  mode: "all" | string[],
  excludeTools: string[] = [],
  chromeTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>,
  extensionTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>,
): SubagentToolsAssembler {
  return new SubagentToolsAssembler({
    mode,
    hostTools: () => [...HOST_TOOLS],
    mcpTools: manager,
    chromeTools,
    extensionTools,
    excludeTools,
  });
}

async function mcpServerTools(): Promise<MockMcpServer> {
  return track(
    await createMockMcpServer({
      tools: [
        { name: "get-docs", inputSchema: { type: "object", properties: {} } },
        { name: "read-resource", inputSchema: { type: "object", properties: {} } },
      ],
    }),
  );
}

describe("SubagentToolsAssembler", () => {
  test('"all" mode merges the host bundle with every MCP tool', async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all");
    const tools = await assembler.assemble();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...HOST_TOOLS.map((tool) => tool.name), "mcp_svelte_get-docs", "mcp_svelte_read-resource"],
    );
  });

  test("an allowlist keeps only the listed mcp_* tools on top of the host bundle", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), ["mcp_svelte_get-docs"]);
    const tools = await assembler.assemble();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...HOST_TOOLS.map((tool) => tool.name), "mcp_svelte_get-docs"],
    );
  });

  test("an empty allowlist exposes no MCP tools (host bundle unchanged)", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), []);
    const tools = await assembler.assemble();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      HOST_TOOLS.map((tool) => tool.name),
    );
  });

  test("workflow/workflow_control and settings.excludeSubagentTools names are never assembled", async () => {
    const manager = makeManager(await mcpServerTools());
    const assembler = makeAssembler(manager, "all", ["mcp_svelte_get-docs"]);
    const tools = await assembler.assemble();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...HOST_TOOLS.map((tool) => tool.name), "mcp_svelte_read-resource"],
      "the excluded mcp tool must not ride along in all mode",
    );
    assert.ok(!tools.some((tool) => tool.name === "workflow" || tool.name === "workflow_control"));
  });

  test("mcpToolsOnly returns mode-filtered MCP tools without the host bundle", async () => {
    const manager = makeManager(await mcpServerTools());
    const all = makeAssembler(manager, "all");
    assert.deepEqual(
      (await all.mcpToolsOnly()).map((tool) => tool.name),
      ["mcp_svelte_get-docs", "mcp_svelte_read-resource"],
    );
    const allow = makeAssembler(manager, ["mcp_svelte_read-resource"]);
    assert.deepEqual(
      (await allow.mcpToolsOnly()).map((tool) => tool.name),
      ["mcp_svelte_read-resource"],
    );
    const none = makeAssembler(manager, []);
    assert.deepEqual(await none.mcpToolsOnly(), []);
  });

  test("an unreachable server degrades to host-only tools, never throwing", async () => {
    const assembler = new SubagentToolsAssembler({
      mode: "all",
      hostTools: () => [...HOST_TOOLS],
      // Port 1 refuses connections; the manager warns once and skips the server.
      mcpTools: new McpToolsManager({ config: [{ name: "dead", type: "http", url: "http://127.0.0.1:1" }] }),
    });
    const tools = await assembler.assemble();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      HOST_TOOLS.map((tool) => tool.name),
    );
  });

  test("a chrome supplier contributes NO chrome tools to the default assemble() (T1-09 per-task split)", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", [], () => [
      fakeTool("chrome_snapshot"),
      fakeTool("chrome_click"),
    ]);
    const tools = await assembler.assemble();
    // Chrome defs are per-task only: they never ride the default merge (an
    // untagged run must not pay the ~5.5 ktok/turn chrome defs).
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...HOST_TOOLS.map((tool) => tool.name), "mcp_svelte_get-docs", "mcp_svelte_read-resource"],
    );
    assert.ok(!tools.some((tool) => tool.name.startsWith("chrome_")), "no chrome defs in the default toolset");
  });

  test("an empty/absent chrome supplier contributes no chrome tools", async () => {
    const none = makeAssembler(makeManager(await mcpServerTools()), "all");
    const tools = await none.assemble();
    assert.ok(!tools.some((tool) => tool.name.startsWith("chrome_")));
    const empty = makeAssembler(makeManager(await mcpServerTools()), "all", [], () => []);
    assert.deepEqual(
      (await empty.assemble()).filter((tool) => tool.name.startsWith("chrome_")),
      [],
    );
  });

  test("chrome-tag wiring: chromeToolsOnly is the ONLY channel chrome defs attach through (T1-09)", async () => {
    // Setting on + grant held: per-task toolset resolves the chrome set; the
    // default assemble() stays chrome-free.
    const on = makeAssembler(makeManager(await mcpServerTools()), "all", [], () => [fakeTool("chrome_launch")]);
    assert.deepEqual(
      (await on.chromeToolsOnly()).map((tool) => tool.name),
      ["chrome_launch"],
    );
    assert.ok(!(await on.assemble()).some((tool) => tool.name === "chrome_launch"));
    // Setting off (no supplier): no defs anywhere, including the named toolset.
    const off = makeAssembler(makeManager(await mcpServerTools()), "all");
    assert.deepEqual(await off.chromeToolsOnly(), []);
    assert.deepEqual(
      (await off.assemble()).filter((tool) => tool.name.startsWith("chrome_")),
      [],
    );
  });

  test("excluded names are stripped from the chrome toolset too (chromeToolsOnly respects the deny list)", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", ["chrome_click"], () => [
      fakeTool("chrome_snapshot"),
      fakeTool("chrome_click"),
    ]);
    const tools = await assembler.assemble();
    assert.ok(!tools.some((tool) => tool.name.startsWith("chrome_")), "default toolset stays chrome-free");
    const chromeOnly = await assembler.chromeToolsOnly();
    assert.deepEqual(
      chromeOnly.map((tool) => tool.name),
      ["chrome_snapshot"],
      "the per-task toolset keeps the allowed chrome tools and strips the denied one",
    );
  });

  test("an extension supplier appends captured extension tools after MCP tools (chrome stays per-task)", async () => {
    const assembler = makeAssembler(
      makeManager(await mcpServerTools()),
      "all",
      [],
      () => [fakeTool("chrome_snapshot")],
      () => [fakeTool("web_fetch_md"), fakeTool("codegraph_search")],
    );
    const tools = await assembler.assemble();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        ...HOST_TOOLS.map((tool) => tool.name),
        "mcp_svelte_get-docs",
        "mcp_svelte_read-resource",
        "web_fetch_md",
        "codegraph_search",
      ],
    );
    assert.deepEqual(
      (await assembler.chromeToolsOnly()).map((tool) => tool.name),
      ["chrome_snapshot"],
      "the chrome supplier feeds the per-task toolset only",
    );
  });

  test("an absent/empty extension supplier contributes no extension tools", async () => {
    const none = makeAssembler(makeManager(await mcpServerTools()), "all");
    const tools = await none.assemble();
    assert.ok(!tools.some((tool) => tool.name === "web_fetch_md" || tool.name === "codegraph_search"));
    const empty = makeAssembler(makeManager(await mcpServerTools()), "all", [], undefined, () => []);
    assert.deepEqual(
      (await empty.assemble()).filter((tool) => tool.name === "web_fetch_md" || tool.name === "codegraph_search"),
      [],
    );
  });

  test("extensionToolsOnly yields the supplier's defs without the host/MCP/chrome bundle", async () => {
    const assembler = makeAssembler(
      makeManager(await mcpServerTools()),
      "all",
      [],
      () => [fakeTool("chrome_snapshot")],
      () => [fakeTool("web_fetch_md"), fakeTool("web_docs_search")],
    );
    assert.deepEqual(
      (await assembler.extensionToolsOnly()).map((tool) => tool.name),
      ["web_fetch_md", "web_docs_search"],
    );
    const without = makeAssembler(makeManager(await mcpServerTools()), "all");
    assert.deepEqual(await without.extensionToolsOnly(), []);
  });

  test("excluded names are stripped from the extension set too", async () => {
    const assembler = makeAssembler(makeManager(await mcpServerTools()), "all", ["web_docs_search"], undefined, () => [
      fakeTool("web_fetch_md"),
      fakeTool("web_docs_search"),
    ]);
    const tools = await assembler.assemble();
    assert.ok(tools.some((tool) => tool.name === "web_fetch_md"));
    assert.ok(!tools.some((tool) => tool.name === "web_docs_search"));
  });
});
