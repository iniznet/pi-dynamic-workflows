/**
 * Unit tests for MCPBridge.
 */

import assert from "node:assert";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MCPBridge } from "../../src/gateway/mcp-bridge.js";
import type { ToolCallResult, ToolExecutor } from "../../src/gateway/types.js";
import { TOOL_TIMEOUT } from "../../src/gateway/types.js";

// Each test instantiates a fresh bridge, and every bridge registers process
// lifecycle listeners; lift the default cap so the accumulated instances in
// this single test process don't trip MaxListenersExceededWarning.
process.setMaxListeners(64);

const LENGTH_PREFIX_SIZE = 4;

/** Helper to send a JSON-RPC request and receive the response. */
function sendRequest(socket: Socket, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(request);
    const messageBuffer = Buffer.from(json, "utf-8");
    const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
    lengthPrefix.writeUInt32BE(messageBuffer.length, 0);
    socket.write(Buffer.concat([lengthPrefix, messageBuffer]));

    let buffer = Buffer.alloc(0);

    // Guard timer: released once a response (or error) arrives so tests don't
    // leak a live timer per request.
    const fallbackTimer = setTimeout(() => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      reject(new Error("Request timed out"));
    }, 5000);

    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length >= LENGTH_PREFIX_SIZE) {
        const messageLength = buffer.readUInt32BE(0);
        if (buffer.length >= LENGTH_PREFIX_SIZE + messageLength) {
          const responseBuffer = buffer.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + messageLength);
          clearTimeout(fallbackTimer);
          socket.removeListener("data", onData);
          try {
            resolve(JSON.parse(responseBuffer.toString("utf-8")));
          } catch (e) {
            reject(e);
          }
        }
      }
    }

    function onError(err: Error) {
      clearTimeout(fallbackTimer);
      socket.removeListener("data", onData);
      reject(err);
    }

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

describe("MCPBridge", () => {
  let bridge: MCPBridge;
  let tools: Map<string, ToolExecutor>;

  beforeEach(() => {
    tools = new Map([
      [
        "echo",
        async (args) => ({
          content: JSON.stringify(args),
          isError: false,
        }),
      ],
      [
        "error-tool",
        async () => ({
          content: "Tool failed",
          isError: true,
        }),
      ],
    ]);
  });

  afterEach(async () => {
    if (bridge) {
      await bridge.stop();
    }
  });

  it("should start and provide a socket path", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socketPath = bridge.getSocketPath();
    assert.ok(socketPath, "Socket path should be defined");
    assert.ok(typeof socketPath === "string", "Socket path should be a string");
  });

  it("should respond to tool.list requests", async () => {
    bridge = new MCPBridge({
      tools,
      toolDefs: [{ name: "echo", description: "Echo tool", inputSchema: {}, source: "host" }],
    });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.list",
      params: {},
      id: "test-1",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      result: [{ name: "echo", description: "Echo tool", inputSchema: {}, source: "host" }],
      id: "test-1",
    });

    socket.destroy();
  });

  it("should execute tool.call requests", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "echo", args: { hello: "world" } },
      id: "test-2",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      result: { content: JSON.stringify({ hello: "world" }), isError: false },
      id: "test-2",
    });

    socket.destroy();
  });

  it("should return error for non-existent tools", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "nonexistent", args: {} },
      id: "test-3",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      result: { content: "Tool not found: nonexistent", isError: true },
      id: "test-3",
    });

    socket.destroy();
  });

  it("should return error for tool execution failures", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "error-tool", args: {} },
      id: "test-4",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      result: { content: "Tool failed", isError: true },
      id: "test-4",
    });

    socket.destroy();
  });

  it("should respond to ping requests", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "ping",
      params: {},
      id: "test-5",
    });

    const result = (response as any).result;
    assert.ok(result.pong === true, "Should respond with pong");
    assert.ok(typeof result.timestamp === "number", "Should include timestamp");

    socket.destroy();
  });

  it("should handle multiple concurrent connections", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socketPath = bridge.getSocketPath();

    // Create multiple connections
    const sockets = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const socket = new Socket();
        await new Promise<void>((resolve) => socket.connect(socketPath, resolve));
        return socket;
      }),
    );

    // Send requests concurrently
    const responses = await Promise.all(
      sockets.map((socket, i) =>
        sendRequest(socket, {
          jsonrpc: "2.0",
          method: "tool.call",
          params: { toolName: "echo", args: { index: i } },
          id: `concurrent-${i}`,
        }),
      ),
    );

    // Verify all responses
    responses.forEach((response, i) => {
      assert.deepStrictEqual(response, {
        jsonrpc: "2.0",
        result: { content: JSON.stringify({ index: i }), isError: false },
        id: `concurrent-${i}`,
      });
    });

    sockets.forEach((s) => {
      s.destroy();
    });
  });

  it("should return error for unknown methods", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "unknown.method",
      params: {},
      id: "test-6",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found: unknown.method" },
      id: "test-6",
    });

    socket.destroy();
  });

  it("should handle malformed JSON gracefully", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    // Send malformed JSON
    const malformed = Buffer.from("not valid json");
    const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
    lengthPrefix.writeUInt32BE(malformed.length, 0);
    socket.write(Buffer.concat([lengthPrefix, malformed]));

    // Should receive a parse error response
    const response = await new Promise<unknown>((resolve) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= LENGTH_PREFIX_SIZE) {
          const messageLength = buffer.readUInt32BE(0);
          if (buffer.length >= LENGTH_PREFIX_SIZE + messageLength) {
            const responseBuffer = buffer.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + messageLength);
            socket.removeListener("data", onData);
            resolve(JSON.parse(responseBuffer.toString("utf-8")));
          }
        }
      };
      socket.on("data", onData);
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Invalid JSON" },
      id: 0,
    });

    socket.destroy();
  });

  it("clears the per-call timeout timer once the call completes (zero leaked timers)", async () => {
    let releaseExecutor!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    tools.set("slow", async () => {
      await gate;
      return { content: "done", isError: false };
    });

    bridge = new MCPBridge({ tools, timeout: 100 });
    await bridge.start();

    // Success path: the timer is armed while the call is in flight…
    const pending = (bridge as any).handleToolCall({ toolName: "slow", args: {} });
    assert.strictEqual(bridge.pendingTimeoutCount, 1, "timeout timer should be armed while the call is in flight");

    // …and cleared once the call completes.
    releaseExecutor();
    const result = (await pending) as ToolCallResult;
    assert.strictEqual(result.content, "done");
    assert.strictEqual(bridge.pendingTimeoutCount, 0, "timeout timer must be cleared after a successful call");

    // Error path: an executor that rejects must release its timer too.
    tools.set("thrower", async () => {
      throw new Error("boom");
    });
    const failed = (await (bridge as any).handleToolCall({ toolName: "thrower", args: {} })) as ToolCallResult;
    assert.strictEqual(failed.isError, true);
    assert.strictEqual(bridge.pendingTimeoutCount, 0, "timeout timer must be cleared after an executor failure");
  });

  it("surfaces timeouts as a TOOL_TIMEOUT JSON-RPC error, not a content string", async () => {
    tools.set("never-returns", async () => {
      // Simulates a tool that hangs beyond the configured deadline.
      await new Promise<void>(() => {});
      return { content: "unreachable", isError: false };
    });

    bridge = new MCPBridge({ tools, timeout: 50 });
    await bridge.start();

    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "never-returns", args: {} },
      id: "test-timeout",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      error: {
        code: TOOL_TIMEOUT,
        message: "Tool execution timed out after 50ms: never-returns",
        data: { toolName: "never-returns" },
      },
      id: "test-timeout",
    });
    assert.strictEqual(bridge.pendingTimeoutCount, 0, "no timer should remain after a timeout");

    socket.destroy();
  });
});
