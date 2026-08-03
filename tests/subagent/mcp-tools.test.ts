/**
 * McpToolsManager tests (design: tasks/subagent-tools-all/DESIGN.md §mcp-tools).
 *
 * Naming (`mcp_<server>_<tool>` with sanitization), per-server TTL caching
 * (a second list is served from cache), graceful offline (unreachable server →
 * empty list + one-time warning, never a throw), the per-server tools filter,
 * and the execute mapping (text content + structured content in `details` +
 * error flag).
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { McpServerConfig } from "../../src/subagent/mcp-config.js";
import { McpToolsManager } from "../../src/subagent/mcp-tools.js";
import { createMockMcpServer, jsonRpcError, jsonRpcResult, type MockMcpServer, sseWrap } from "../helpers/mcp-mock.js";

const servers: MockMcpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function track(server: MockMcpServer): MockMcpServer {
  servers.push(server);
  return server;
}

function config(server: MockMcpServer, extra: Partial<McpServerConfig> = {}): McpServerConfig[] {
  return [{ name: "svelte", type: "http", url: server.url, ...extra }];
}

function configFor(name: string, server: MockMcpServer): McpServerConfig[] {
  return [{ name, type: "http", url: server.url }];
}

/** Replace console.warn for the duration of a callback; returns captured lines. */
async function captureConsoleWarn<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("McpToolsManager", () => {
  test("tool names are mcp_<server>_<tool> with sanitization", async () => {
    const mock = track(
      await createMockMcpServer({
        tools: [
          {
            name: "get-documentation",
            description: "Get the Svelte docs for a section",
            inputSchema: { type: "object", properties: {} },
          },
          { name: "list/sections", inputSchema: { type: "object", properties: {} } },
        ],
      }),
    );
    const manager = new McpToolsManager({ config: configFor("svelte.dev", mock) });

    const tools = await manager.listSubagentTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["mcp_svelte_dev_get-documentation", "mcp_svelte_dev_list_sections"],
      "dots and slashes must be sanitized to underscores",
    );
    assert.equal(tools[0].label, "get-documentation");
    assert.equal(tools[0].description, "Get the Svelte docs for a section");
  });

  test("a per-server tools filter restricts the surfaced tools", async () => {
    const mock = track(
      await createMockMcpServer({
        tools: [
          { name: "alpha", inputSchema: { type: "object", properties: {} } },
          { name: "beta", inputSchema: { type: "object", properties: {} } },
        ],
      }),
    );
    const manager = new McpToolsManager({ config: config(mock, { tools: ["beta"] }) });

    const tools = await manager.listSubagentTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["mcp_svelte_beta"],
      "only allowlisted tool names may surface",
    );
  });

  test("the tool list is cached per server (no second fetch)", async () => {
    const mock = track(await createMockMcpServer());
    const manager = new McpToolsManager({ config: config(mock) });

    const first = await manager.listSubagentTools();
    const second = await manager.listSubagentTools();
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    const listRequests = mock.requests.filter((request) => request.parsed.method === "tools/list");
    assert.equal(listRequests.length, 1, "the second list must be served from cache");
  });

  test("the cache expires after the configured TTL", async () => {
    const mock = track(await createMockMcpServer());
    const manager = new McpToolsManager({ config: config(mock), listTtlMs: 5 });

    await manager.listSubagentTools();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await manager.listSubagentTools();
    const listRequests = mock.requests.filter((request) => request.parsed.method === "tools/list");
    assert.equal(listRequests.length, 2, "an expired cache must refetch");
  });

  test("an unreachable server yields an empty list, warns once, and never throws", async () => {
    const manager = new McpToolsManager({
      config: [
        {
          name: "offline-1",
          type: "http",
          url: "http://127.0.0.1:1/mcp",
        },
      ],
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const { value: first, warnings } = await captureConsoleWarn(() => manager.listSubagentTools());
    assert.deepEqual(first, [], "an offline server must contribute no tools");
    assert.equal(warnings.length, 1, "the offline server is warned exactly once");
    assert.match(warnings[0], /offline-1/);
    assert.match(warnings[0], /unavailable/);

    const { warnings: secondWarnings } = await captureConsoleWarn(() => manager.listSubagentTools());
    assert.deepEqual(secondWarnings, [], "a second list must not re-warn");
  });

  test("serverNames() lists configured servers without network access", async () => {
    const mock = track(await createMockMcpServer());
    const manager = new McpToolsManager({ config: config(mock) });
    assert.deepEqual(manager.serverNames(), ["svelte"]);
    assert.equal(mock.requests.length, 0, "serverNames must not touch the network");
  });

  test("disconnectAll() drops cached state and forces a refetch", async () => {
    const mock = track(await createMockMcpServer());
    const manager = new McpToolsManager({ config: config(mock) });

    await manager.listSubagentTools();
    manager.disconnectAll();
    await manager.listSubagentTools();
    const listRequests = mock.requests.filter((request) => request.parsed.method === "tools/list");
    assert.equal(listRequests.length, 2, "disconnectAll must invalidate the per-server cache");
  });

  test("execute maps MCP content, structured content and the error flag", async () => {
    const mock = track(
      await createMockMcpServer({
        tools: [{ name: "autofix", inputSchema: { type: "object", properties: { code: { type: "string" } } } }],
        callResult: {
          content: [{ type: "text", text: '{"issues":[]}' }],
          structuredContent: { issues: [], fixed: true },
          isError: false,
        },
      }),
    );
    const manager = new McpToolsManager({ config: config(mock) });
    const [tool] = await manager.listSubagentTools();

    const result = await tool.execute(
      "call-1",
      { code: "<script></script>" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.deepEqual(result.details, { issues: [], fixed: true }, "structured content must ride in details");
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, '{"issues":[]}');
    assert.equal(result.isError, false);
  });

  test("a failed tool call surfaces as an isError result with a message", async () => {
    const mock = track(
      await createMockMcpServer({
        tools: [{ name: "boom", inputSchema: { type: "object", properties: {} } }],
        respond: (request) => {
          const method = request.parsed.method as string;
          const id = request.parsed.id;
          const headers = { "Mcp-Session-Id": "sess-boom", "Content-Type": "text/event-stream" };
          if (method === "initialize") {
            return { headers, body: sseWrap(jsonRpcResult(id, { protocolVersion: "2025-03-26" })) };
          }
          if (method === "tools/list") {
            return { headers, body: sseWrap(jsonRpcResult(id, { tools: [{ name: "boom", inputSchema: {} }] })) };
          }
          // Server-side failure of the tool itself.
          return { status: 200, headers, body: sseWrap(jsonRpcError(id, -32000, "exploded")) };
        },
      }),
    );
    const manager = new McpToolsManager({ config: config(mock) });
    const [tool] = await manager.listSubagentTools();

    const result = await tool.execute("call-2", {} as never, undefined, undefined, undefined as never);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exploded/);
  });
});
