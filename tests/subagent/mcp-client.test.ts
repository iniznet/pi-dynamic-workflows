/**
 * McpHttpClient tests (design: tasks/subagent-tools-all/DESIGN.md §mcp-client).
 *
 * Wire behavior covered against a node:http mock speaking the svelte-server
 * protocol: initialize handshake with Mcp-Session-Id capture and echo,
 * SSE-wrapped responses with a plain-JSON fallback, protocol-version
 * negotiation fallback (2025-03-26 → 2024-11-05), one-shot re-init on a dead
 * session (HTTP 404), caller-signal and client-timeout aborts, and user header
 * value redaction in every error string.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { McpAbortError, McpHttpClient, McpRpcError, McpTimeoutError } from "../../src/subagent/mcp-client.js";
import type { McpServerConfig } from "../../src/subagent/mcp-config.js";
import { createMockMcpServer, jsonRpcError, jsonRpcResult, type MockMcpServer, sseWrap } from "../helpers/mcp-mock.js";

const servers: MockMcpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function track(server: MockMcpServer): MockMcpServer {
  servers.push(server);
  return server;
}

/** A server config pointing at a mock server, with optional overrides. */
function serverConfig(server: MockMcpServer, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: "mock", type: "http", url: server.url, ...extra };
}

function methodRequests(server: MockMcpServer, method: string) {
  return server.requests.filter((request) => request.parsed.method === method);
}

describe("McpHttpClient", () => {
  test("initialize performs the handshake and captures the session id", async () => {
    const mock = track(await createMockMcpServer({ sessionId: "sess-42" }));
    const client = new McpHttpClient(serverConfig(mock));

    await client.initialize();
    assert.equal(client.isInitialized(), true);

    const handshake = methodRequests(mock, "initialize");
    assert.equal(handshake.length, 1);
    assert.equal(handshake[0].method, "POST");
    assert.equal(handshake[0].url, "/mcp");
    assert.equal(handshake[0].headers["content-type"], "application/json");
    assert.equal(handshake[0].headers.accept, "application/json, text/event-stream");
    const params = handshake[0].parsed.params as Record<string, unknown>;
    assert.equal(handshake[0].parsed.jsonrpc, "2.0");
    assert.equal(params.protocolVersion, "2025-03-26");
    assert.deepEqual(params.capabilities, {});
    assert.equal((params.clientInfo as Record<string, unknown>).name, "pi-dynamic-workflows");
    client.close();
  });

  test("the session id is echoed on subsequent requests", async () => {
    const mock = track(await createMockMcpServer({ sessionId: "sess-echo" }));
    const client = new McpHttpClient(serverConfig(mock));

    await client.initialize();
    await client.listTools();

    const listRequest = methodRequests(mock, "tools/list")[0];
    assert.equal(listRequest.headers["mcp-session-id"], "sess-echo");
    client.close();
  });

  test("listTools parses an SSE-wrapped response into tool info", async () => {
    const mock = track(
      await createMockMcpServer({
        tools: [
          { name: "alpha", description: "First tool", inputSchema: { type: "object", properties: { a: {} } } },
          { name: "beta" },
        ],
      }),
    );
    const client = new McpHttpClient(serverConfig(mock));

    const tools = await client.listTools();
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "alpha");
    assert.equal(tools[0].description, "First tool");
    assert.deepEqual(tools[0].inputSchema, { type: "object", properties: { a: {} } });
    assert.equal(tools[1].name, "beta");
    assert.equal(tools[1].description, undefined);
    assert.deepEqual(tools[1].inputSchema, { type: "object", properties: {} }, "missing schema gets an empty default");
    client.close();
  });

  test("a plain-JSON response (non-SSE) is parsed as a fallback", async () => {
    const mock = track(
      await createMockMcpServer({
        respond: (request) => {
          const method = request.parsed.method as string;
          const id = request.parsed.id;
          const headers = { "Content-Type": "application/json" };
          if (method === "initialize") {
            return { headers, body: JSON.stringify(jsonRpcResult(id, { protocolVersion: "2025-03-26" })) };
          }
          if (method === "tools/list") {
            return {
              headers,
              body: JSON.stringify(jsonRpcResult(id, { tools: [{ name: "plain", inputSchema: { type: "object" } }] })),
            };
          }
          return { status: 400, headers, body: JSON.stringify(jsonRpcError(id, -32601, "unknown")) };
        },
      }),
    );
    const client = new McpHttpClient(serverConfig(mock));

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["plain"],
    );
    client.close();
  });

  test("initialize negotiates the fallback protocol version on a rejection", async () => {
    const mock = track(
      await createMockMcpServer({
        respond: (request) => {
          const method = request.parsed.method as string;
          const id = request.parsed.id;
          const headers = { "Mcp-Session-Id": "neg-1" };
          if (method === "initialize") {
            const version = (request.parsed.params as Record<string, unknown>).protocolVersion;
            if (version === "2025-03-26") {
              return { status: 200, headers, body: sseWrap(jsonRpcError(id, -32601, "method not found")) };
            }
            return { status: 200, headers, body: sseWrap(jsonRpcResult(id, { protocolVersion: version })) };
          }
          return { status: 200, headers, body: sseWrap(jsonRpcResult(id, { tools: [] })) };
        },
      }),
    );
    const client = new McpHttpClient(serverConfig(mock));

    await client.initialize();
    assert.equal(client.isInitialized(), true);
    const handshakes = methodRequests(mock, "initialize");
    assert.equal(handshakes.length, 2, "the primary + fallback both run");
    assert.equal((handshakes[0].parsed.params as Record<string, unknown>).protocolVersion, "2025-03-26");
    assert.equal((handshakes[1].parsed.params as Record<string, unknown>).protocolVersion, "2024-11-05");
    client.close();
  });

  test("an HTTP 404 on tools/call re-initializes once and retries", async () => {
    let calls = 0;
    const mock = track(
      await createMockMcpServer({
        respond: (request) => {
          const method = request.parsed.method as string;
          const id = request.parsed.id;
          const headers = { "Mcp-Session-Id": "sess-retry" };
          if (method === "initialize") {
            return { status: 200, headers, body: sseWrap(jsonRpcResult(id, { protocolVersion: "2025-03-26" })) };
          }
          if (method === "tools/call") {
            calls++;
            if (calls === 1) {
              // Dead session: the server no longer recognizes the session id.
              return { status: 404, headers, body: "session not found" };
            }
            return {
              status: 200,
              headers,
              body: sseWrap(jsonRpcResult(id, { content: [{ type: "text", text: "retried ok" }] })),
            };
          }
          return { status: 200, headers, body: sseWrap(jsonRpcResult(id, { tools: [] })) };
        },
      }),
    );
    const client = new McpHttpClient(serverConfig(mock));

    const result = await client.callTool("alpha", {});
    assert.equal(result.content[0].text, "retried ok");
    assert.equal(calls, 2, "the call must be retried after the 404");
    assert.equal(methodRequests(mock, "initialize").length, 2, "a fresh initialize must follow the 404");
    client.close();
  });

  test("a caller AbortSignal cancels an in-flight request", async () => {
    const mock = track(
      await createMockMcpServer({
        respond: () => new Promise<never>(() => {}), // hang forever
      }),
    );
    const client = new McpHttpClient(serverConfig(mock));

    await assert.rejects(
      client.listTools(AbortSignal.timeout(60)),
      (error: unknown) => error instanceof McpAbortError,
      "an external abort must surface as McpAbortError",
    );
    client.close();
  });

  test("a request missing the client timeout rejects with McpTimeoutError", async () => {
    const mock = track(
      await createMockMcpServer({
        respond: () => new Promise<never>(() => {}), // hang forever
      }),
    );
    const client = new McpHttpClient(serverConfig(mock), { timeoutMs: 60 });

    await assert.rejects(
      client.initialize(),
      (error: unknown) => error instanceof McpTimeoutError,
      "the client-side deadline must surface as McpTimeoutError",
    );
    client.close();
  });

  test("user header values are redacted from error messages", async () => {
    const client = new McpHttpClient(
      {
        name: "mock",
        type: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: { authorization: "Bearer super-secret-token-abc123" },
      },
      {
        fetchImpl: async () => {
          throw new Error("fetch failed: 401 Unauthorized with Bearer super-secret-token-abc123");
        },
      },
    );

    await assert.rejects(client.listTools(), (error: unknown) => {
      assert.ok(error instanceof McpRpcError);
      const message = (error as McpRpcError).message;
      assert.ok(!message.includes("super-secret-token-abc123"), `secret leaked: ${message}`);
      assert.ok(message.includes("[redacted]"), `expected a redaction marker in: ${message}`);
      return true;
    });
    client.close();
  });

  test("close() forgets session state and the next call re-initializes", async () => {
    const mock = track(await createMockMcpServer({ sessionId: "sess-close" }));
    const client = new McpHttpClient(serverConfig(mock));

    await client.initialize();
    client.close();
    assert.equal(client.isInitialized(), false);
    await client.initialize();
    assert.equal(methodRequests(mock, "initialize").length, 2, "a fresh handshake must run after close()");
    client.close();
  });
});
