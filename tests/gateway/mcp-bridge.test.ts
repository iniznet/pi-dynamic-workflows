/**
 * Unit tests for MCPBridge.
 *
 * The bridge now requires a socket auth handshake (auth.handshake with the
 * bridge token) before any method is accepted, so every request-bearing test
 * first authenticates via connectToBridge. Raw unauthenticated sockets are
 * used deliberately by the auth-negative tests (AUTH_REQUIRED / AUTH_FAILED).
 */

import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MCPProxyClient, ProxyAbortError, proxiedParameters } from "../../src/agent/mcp-proxy-client.js";
import { MCPBridge } from "../../src/gateway/mcp-bridge.js";
import type { ToolCallResult, ToolExecutor } from "../../src/gateway/types.js";
import { AUTH_REQUIRED, FRAME_TOO_LARGE, TOOL_TIMEOUT } from "../../src/gateway/types.js";

// Each test instantiates a fresh bridge, and every bridge registers process
// lifecycle listeners; lift the default cap so the accumulated instances in
// this single test process don't trip MaxListenersExceededWarning.
process.setMaxListeners(64);

const LENGTH_PREFIX_SIZE = 4;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until a condition holds or the deadline passes (for async teardown). */
async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await sleep(5);
  }
  assert.ok(cond(), `condition not met within ${timeoutMs}ms: ${label}`);
}

/** Length-prefix a JSON value into one IPC frame. */
function framed(obj: unknown): Buffer {
  const messageBuffer = Buffer.from(JSON.stringify(obj), "utf-8");
  const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
  lengthPrefix.writeUInt32BE(messageBuffer.length, 0);
  return Buffer.concat([lengthPrefix, messageBuffer]);
}

/** Send a JSON-RPC request and receive the response. */
function sendRequest(socket: Socket, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.write(framed(request));

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

/** Connect a raw socket and complete the auth handshake with the bridge token. */
async function connectToBridge(bridge: MCPBridge): Promise<Socket> {
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    socket.on("error", onError);
    socket.connect(bridge.getSocketPath(), () => {
      socket.removeListener("error", onError);
      resolve();
    });
  });
  const handshake = (await sendRequest(socket, {
    jsonrpc: "2.0",
    method: "auth.handshake",
    params: { token: bridge.getAuthToken() },
    id: "auth-handshake",
  })) as { result?: { ok?: boolean }; error?: { code?: number } };
  assert.ok(
    handshake.error === undefined && handshake.result?.ok === true,
    `handshake must succeed (got: ${JSON.stringify(handshake)})`,
  );
  return socket;
}

/** A unique IPC path for throwaway servers (named pipe on Windows, socket file elsewhere). */
function tempIpcPath(label: string): string {
  const id = `${label}-${process.pid}-${randomUUID().slice(0, 6)}`;
  return platform() === "win32" ? join("\\\\.\\pipe", id) : join(tmpdir(), `${id}.sock`);
}

describe("MCPBridge", () => {
  let bridge: MCPBridge;
  let tools: Map<string, ToolExecutor>;

  beforeEach(() => {
    tools = new Map([
      [
        "echo",
        async (args: Record<string, unknown>): Promise<ToolCallResult> => ({
          content: JSON.stringify(args),
          isError: false,
        }),
      ],
      [
        "error-tool",
        async (): Promise<ToolCallResult> => ({
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

    const socket = await connectToBridge(bridge);

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

    const socket = await connectToBridge(bridge);

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

    const socket = await connectToBridge(bridge);

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

    const socket = await connectToBridge(bridge);

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

    const socket = await connectToBridge(bridge);

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "ping",
      params: {},
      id: "test-5",
    });

    const result = (response as { result?: { pong?: boolean; timestamp?: number } }).result;
    assert.ok(result?.pong === true, "Should respond with pong");
    assert.ok(typeof result?.timestamp === "number", "Should include timestamp");

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
        const handshake = (await sendRequest(socket, {
          jsonrpc: "2.0",
          method: "auth.handshake",
          params: { token: bridge.getAuthToken() },
          id: "auth-concurrent",
        })) as { result?: { ok?: boolean } };
        assert.strictEqual(handshake.result?.ok, true);
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

    const socket = await connectToBridge(bridge);

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

    const socket = await connectToBridge(bridge);

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
    const bridgeHandle = bridge as unknown as {
      handleToolCall: (p: unknown, c: unknown) => Promise<unknown>;
    };
    const pending = bridgeHandle.handleToolCall(
      { toolName: "slow", args: {} },
      { requestId: "direct-1", socket: {} as Socket },
    );
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
    const failed = (await bridgeHandle.handleToolCall(
      { toolName: "thrower", args: {} },
      { requestId: "direct-2", socket: {} as Socket },
    )) as ToolCallResult;
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

    const socket = await connectToBridge(bridge);

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

  // ─── B2 — per-tool timeouts + timeout propagation via AbortSignal ────────

  it("a slow tool with a declared per-tool timeout surfaces a timeout, not a hang (B2)", async () => {
    // A signal-oblivious executor that never settles: only the bridge's own
    // deadline can end the call — if the per-tool timeout were ignored, the
    // call would wait the flat default and this test would blow its guard.
    let signalAborted = false;
    tools.set("glacial", async (_args, signal) => {
      signal?.addEventListener("abort", () => {
        signalAborted = true;
      });
      await new Promise<void>(() => {});
      return { content: "unreachable", isError: false };
    });

    bridge = new MCPBridge({ tools, toolTimeouts: { glacial: 60 } });
    await bridge.start();

    const socket = await connectToBridge(bridge);
    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "glacial", args: {} },
      id: "b2-per-tool-timeout",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      error: {
        code: TOOL_TIMEOUT,
        message: "Tool execution timed out after 60ms: glacial",
        data: { toolName: "glacial" },
      },
      id: "b2-per-tool-timeout",
    });
    // Requirement 3: the timeout must propagate via AbortSignal so the host
    // executor can stop cleanly instead of running forever with nobody
    // listening.
    assert.strictEqual(signalAborted, true, "the executor's AbortSignal must be aborted on timeout");
    assert.strictEqual(bridge.pendingTimeoutCount, 0, "no timer should remain after a per-tool timeout");

    socket.destroy();
  });

  it("a tool without a per-tool entry keeps the default timeout (B2)", async () => {
    // The per-tool table must not leak: only 'glacial' gets the 60ms override;
    // 'other' falls back to the bridge-wide 90ms default.
    let signalAborted = false;
    tools.set("other", async (_args, signal) => {
      signal?.addEventListener("abort", () => {
        signalAborted = true;
      });
      await new Promise<void>(() => {});
      return { content: "unreachable", isError: false };
    });

    bridge = new MCPBridge({ tools, timeout: 90, toolTimeouts: { glacial: 60 } });
    await bridge.start();

    const socket = await connectToBridge(bridge);
    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "other", args: {} },
      id: "b2-default-timeout",
    });

    assert.deepStrictEqual((response as { error?: { code: number; message: string } }).error, {
      code: TOOL_TIMEOUT,
      message: "Tool execution timed out after 90ms: other",
      data: { toolName: "other" },
    });
    assert.strictEqual(signalAborted, true);

    socket.destroy();
  });

  it("accepts the per-tool timeout table as a plain object shape (feature-detect, B2)", async () => {
    tools.set("hangs", async () => {
      await new Promise<void>(() => {});
      return { content: "unreachable", isError: false };
    });
    // Record shape (not a Map): normalizeToolTimeouts must feature-detect it.
    bridge = new MCPBridge({ tools, toolTimeouts: { hangs: 40 } });
    await bridge.start();

    const socket = await connectToBridge(bridge);
    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "hangs", args: {} },
      id: "b2-record-shape",
    });

    assert.strictEqual((response as { error?: { code: number } }).error?.code, TOOL_TIMEOUT);
    assert.match((response as { error?: { message: string } }).error?.message ?? "", /after 40ms: hangs/);

    socket.destroy();
  });

  it("drops non-positive/NaN per-tool timeout entries (a malformed table cannot arm a 0ms deadline, B2)", async () => {
    tools.set("ok", async () => ({ content: "fine", isError: false }));
    // 0 and NaN entries are dropped by normalizeToolTimeouts; the tool then
    // uses the bridge default (500ms here) and completes normally.
    bridge = new MCPBridge({ tools, timeout: 500, toolTimeouts: { ok: 0, nope: Number.NaN } });
    await bridge.start();

    const socket = await connectToBridge(bridge);
    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "ok", args: {} },
      id: "b2-malformed-table",
    });

    assert.deepStrictEqual((response as { result?: ToolCallResult }).result, { content: "fine", isError: false });
    socket.destroy();
  });

  // ─── gateway-ipc:i4 — socket auth handshake ───────────────────────────────

  it("rejects tool.list before auth.handshake with AUTH_REQUIRED (gateway-ipc:i4)", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    // Deliberately NO handshake: the connection is unauthenticated.
    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(bridge.getSocketPath(), resolve));

    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.list",
      params: {},
      id: "unauth-1",
    });

    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      error: {
        code: AUTH_REQUIRED,
        message: "Socket not authenticated: send auth.handshake with the bridge token first",
      },
      id: "unauth-1",
    });

    // A tool call is equally refused.
    const call = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "echo", args: { sneaky: true } },
      id: "unauth-2",
    });
    assert.deepStrictEqual((call as { error?: { code: number } }).error?.code, AUTH_REQUIRED);

    socket.destroy();
  });

  it("closes the connection on an invalid handshake token; a good token still works (gateway-ipc:i4)", async () => {
    bridge = new MCPBridge({ tools, authToken: "secret-token" });
    await bridge.start();

    // Wrong token: the bridge must terminate the connection so the attacker
    // cannot retry with a different token on the same socket.
    const bad = new Socket();
    // A data listener keeps the pipe in flowing mode: on Windows named pipes a
    // paused socket never observes the peer's close, and we want both the
    // AUTH_FAILED frame and the termination itself.
    const frames: Buffer[] = [];
    bad.on("error", () => {});
    bad.on("data", (chunk: Buffer) => frames.push(chunk));
    const closed = new Promise<void>((resolve) => bad.once("close", () => resolve()));
    await new Promise<void>((resolve) => bad.connect(bridge.getSocketPath(), resolve));
    bad.write(
      framed({
        jsonrpc: "2.0",
        method: "auth.handshake",
        params: { token: "wrong-token" },
        id: "bad-token",
      }),
    );
    await Promise.race([
      closed,
      sleep(1000).then(() => {
        throw new Error("bridge kept a connection alive after a wrong token");
      }),
    ]);
    const payload = Buffer.concat(frames).toString("utf-8");
    assert.match(payload, /Invalid auth token/, "a wrong token must be refused with an AUTH_FAILED error frame");
    // The AUTH_FAILED frame must echo the request's id so the client's
    // PendingRequest (keyed by its own generated id) correlates the failure
    // instead of only learning of it later as 'Connection closed'.
    assert.ok(payload.includes(`"id":"bad-token"`), "AUTH_FAILED must carry the original request id for correlation");

    // The gate is selective: a correct token authenticates normally.
    const good = await connectToBridge(bridge);
    const response = await sendRequest(good, {
      jsonrpc: "2.0",
      method: "tool.list",
      params: {},
      id: "good-1",
    });
    assert.ok(Array.isArray((response as { result?: unknown }).result));
    good.destroy();
  });

  // ─── gateway-ipc:i3 — idempotency keys ────────────────────────────────────

  it("dedupes replayed tool executions by idempotency key (gateway-ipc:i3)", async () => {
    let executions = 0;
    tools.set("side-effect", async () => {
      executions++;
      await sleep(20);
      return { content: `execution-${executions}`, isError: false };
    });
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const s1 = await connectToBridge(bridge);
    const s2 = await connectToBridge(bridge);

    // Two callers race the same idempotency key (client timeout + retry shape).
    const [r1, r2] = await Promise.all([
      sendRequest(s1, {
        jsonrpc: "2.0",
        method: "tool.call",
        params: { toolName: "side-effect", args: {}, idempotencyKey: "key-1" },
        id: "replay-a",
      }),
      sendRequest(s2, {
        jsonrpc: "2.0",
        method: "tool.call",
        params: { toolName: "side-effect", args: {}, idempotencyKey: "key-1" },
        id: "replay-b",
      }),
    ]);

    assert.strictEqual(executions, 1, "a replayed call with the same key must join the original execution");
    assert.deepStrictEqual((r1 as { result?: ToolCallResult }).result, { content: "execution-1", isError: false });
    assert.deepStrictEqual((r2 as { result?: ToolCallResult }).result, { content: "execution-1", isError: false });

    // A different key starts a fresh execution.
    const r3 = await sendRequest(s1, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "side-effect", args: {}, idempotencyKey: "key-2" },
      id: "fresh-c",
    });
    assert.strictEqual(executions, 2);
    assert.deepStrictEqual((r3 as { result?: ToolCallResult }).result, { content: "execution-2", isError: false });

    s1.destroy();
    s2.destroy();
  });

  it("a sequential replay with the same idempotency key returns the first result without re-executing (B2)", async () => {
    // The B2 shape: a call timed out client-side but ACTUALLY completed on the
    // host; the retry with the same key must return the cached result instead
    // of re-running the side-effectful tool (no duplicated write/edit).
    let executions = 0;
    tools.set("side-effect", async () => {
      executions++;
      return { content: `execution-${executions}`, isError: false };
    });
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = await connectToBridge(bridge);

    const first = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "side-effect", args: {}, idempotencyKey: "b2-key" },
      id: "first",
    });
    assert.strictEqual(executions, 1);
    assert.deepStrictEqual((first as { result?: ToolCallResult }).result, { content: "execution-1", isError: false });

    // Replay AFTER the first execution already settled: the cached result must
    // be returned without touching the tool again.
    const replay = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "side-effect", args: {}, idempotencyKey: "b2-key" },
      id: "replay",
    });
    assert.strictEqual(executions, 1, "a replayed call after completion must not re-execute the tool");
    assert.deepStrictEqual((replay as { result?: ToolCallResult }).result, { content: "execution-1", isError: false });

    socket.destroy();
  });

  it("the proxy client honors a tool's declared per-tool timeout end-to-end (B2)", async () => {
    // A signal-oblivious host tool that never settles. Both sides carry the
    // same per-tool table (as the gateway threads it), so the call must end
    // with a timeout (not a hang) once the declared 80ms deadline passes —
    // either the client's own wait deadline or the bridge's TOOL_TIMEOUT
    // response settles it, never the flat 30s default.
    let hostSignalAborted = false;
    tools.set("glacial", async (_args, signal) => {
      signal?.addEventListener("abort", () => {
        hostSignalAborted = true;
      });
      await new Promise<void>(() => {});
      return { content: "unreachable", isError: false };
    });

    const table = { glacial: 80 };
    bridge = new MCPBridge({ tools, toolTimeouts: table });
    await bridge.start();

    const client = new MCPProxyClient(bridge.getSocketPath(), {
      authToken: bridge.getAuthToken(),
      toolTimeouts: table,
    });
    await client.connect();
    try {
      const startedAt = Date.now();
      const result = await client.executeToolCall("glacial", {});
      const elapsed = Date.now() - startedAt;

      assert.equal(result.isError, true, "a timed-out call must surface as an error result, not a hang");
      assert.match(result.content, /timed out/i);
      assert.ok(elapsed < 5000, `call must end at the declared deadline, not hang (took ${elapsed}ms)`);
      // The bridge aborts the host executor's signal on timeout (requirement 3).
      // The client's own wait deadline can win the race by a tick, so poll
      // briefly for the bridge-side abort to land.
      await waitFor(() => hostSignalAborted, 1000, "host executor signal aborted after the declared timeout");
      assert.strictEqual(hostSignalAborted, true, "the host executor's AbortSignal must be aborted on timeout");
    } finally {
      await client.disconnect();
    }
  });

  // ─── gateway-ipc:f8 — hard frame-size cap ─────────────────────────────────

  it("rejects an oversized frame with FRAME_TOO_LARGE and drops only that connection (gateway-ipc:f8)", async () => {
    bridge = new MCPBridge({ tools, maxFrameSize: 1024 });
    await bridge.start();

    const lying = new Socket();
    await new Promise<void>((resolve) => lying.connect(bridge.getSocketPath(), resolve));
    const closed = new Promise<void>((resolve) => lying.once("close", () => resolve()));

    // The length prefix alone lies about the frame size; the bridge must not
    // buffer 9999 bytes (OOM defense) — it responds once and drops the socket.
    const lie = Buffer.alloc(LENGTH_PREFIX_SIZE);
    lie.writeUInt32BE(9999, 0);
    lying.write(lie);

    const response = await new Promise<unknown>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        lying.removeListener("data", onData);
        reject(new Error("no response to oversized frame"));
      }, 1000);
      function onData(chunk: Buffer) {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= LENGTH_PREFIX_SIZE) {
          const messageLength = buffer.readUInt32BE(0);
          if (buffer.length >= LENGTH_PREFIX_SIZE + messageLength) {
            clearTimeout(timer);
            lying.removeListener("data", onData);
            resolve(
              JSON.parse(buffer.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + messageLength).toString("utf-8")),
            );
          }
        }
      }
      lying.on("data", onData);
    });
    assert.deepStrictEqual(response, {
      jsonrpc: "2.0",
      error: { code: FRAME_TOO_LARGE, message: "Frame of 9999 bytes exceeds the 1024-byte cap" },
      id: 0,
    });
    await Promise.race([
      closed,
      sleep(1000).then(() => {
        throw new Error("socket not closed after an oversized frame");
      }),
    ]);

    // The bridge itself survives: an authenticated client still works.
    const good = await connectToBridge(bridge);
    const call = await sendRequest(good, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "echo", args: { ok: 1 } },
      id: "after-cap",
    });
    assert.deepStrictEqual((call as { result?: ToolCallResult }).result, {
      content: JSON.stringify({ ok: 1 }),
      isError: false,
    });
    good.destroy();
  });

  // ─── gateway-ipc:i1 — abort/cancellation over IPC ─────────────────────────

  it("tool.abort cancels an in-flight host tool execution (bridge side, gateway-ipc:i1)", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveDone!: (r: ToolCallResult) => void;
    const done = new Promise<ToolCallResult>((resolve) => {
      resolveDone = resolve;
    });
    tools.set("blocking", async (_args, signal) => {
      markStarted();
      signal?.addEventListener("abort", () => resolveDone({ content: "cancelled-by-abort", isError: false }), {
        once: true,
      });
      return await done;
    });
    bridge = new MCPBridge({ tools, timeout: 10_000 });
    await bridge.start();

    const socket = await connectToBridge(bridge);

    // Fire the call without awaiting it — the bridge suppresses the response
    // for a cancelled request, so only the executor's outcome proves the abort.
    socket.write(
      framed({
        jsonrpc: "2.0",
        method: "tool.call",
        params: { toolName: "blocking", args: {} },
        id: "abort-target",
      }),
    );
    await started;

    socket.write(
      framed({
        jsonrpc: "2.0",
        method: "tool.abort",
        params: { requestId: "abort-target" },
        id: "abort-ack",
      }),
    );

    const result = await done;
    assert.deepStrictEqual(result, { content: "cancelled-by-abort", isError: false });
    socket.destroy();
  });

  // ─── gateway-ipc:f8/i5 — flush-based shutdown ─────────────────────────────

  it("delivers the shutdown ack before the bridge stops (flush-based shutdown)", async () => {
    bridge = new MCPBridge({ tools });
    await bridge.start();

    const socket = await connectToBridge(bridge);
    const response = await sendRequest(socket, {
      jsonrpc: "2.0",
      method: "shutdown",
      params: {},
      id: "shutdown-1",
    });

    // The ack round-trips even though the very next step tears the socket
    // down — sendResponse flushes before stop() destroys the connection.
    assert.deepStrictEqual(response, { jsonrpc: "2.0", result: { shuttingDown: true }, id: "shutdown-1" });
    // The ack can reach the client a tick before the bridge finishes stop(),
    // so wait for the server teardown to complete before asserting it.
    const deadline = Date.now() + 1000;
    while ((bridge as unknown as { started: boolean }).started && Date.now() < deadline) {
      await sleep(5);
    }
    assert.strictEqual((bridge as unknown as { started: boolean }).started, false);
    assert.strictEqual((bridge as unknown as { server: unknown }).server, null);
    // afterEach's stop() is a safe no-op for an already-stopped bridge.
  });

  // ─── gateway-ipc:f2 — bounded connect ─────────────────────────────────────

  it("bounded connect(): a silent bridge surfaces an error instead of wedging (gateway-ipc:f2)", async () => {
    const path = tempIpcPath("gateway-silent");
    // Accepts the socket but never answers the auth handshake — the exact
    // "peer accepted but is dead" shape that used to hang connect() forever.
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    try {
      const client = new MCPProxyClient(path, { authToken: "any", connectTimeout: 80 });
      await assert.rejects(client.connect(), /Connect timed out after 80ms/);
      assert.strictEqual(client.getState(), "disconnected");
    } finally {
      silent.close();
      if (platform() !== "win32") {
        try {
          unlinkSync(path);
        } catch {
          // never created a file
        }
      }
    }
  });

  it("client rejects an oversized frame from the bridge (gateway-ipc:f8)", async () => {
    const path = tempIpcPath("gateway-lie");
    const server = createServer((socket) => {
      // Answer the client's auth handshake with a lying length prefix.
      socket.once("data", () => {
        const lie = Buffer.alloc(LENGTH_PREFIX_SIZE);
        lie.writeUInt32BE(9999, 0);
        socket.write(Buffer.concat([lie, Buffer.from("garbage")]));
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const client = new MCPProxyClient(path, { authToken: "any", maxFrameSize: 64, connectTimeout: 1000 });
      await assert.rejects(client.connect(), /Frame of 9999 bytes exceeds the 64-byte cap/);
    } finally {
      server.close();
      if (platform() !== "win32") {
        try {
          unlinkSync(path);
        } catch {
          // never created a file
        }
      }
    }
  });

  // ─── gateway-ipc:f6/i2 — real JSON schemas through the proxy ──────────────

  it("proxiedParameters carries the real JSON schema into subagent definitions (gateway-ipc:f6/i2)", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(proxiedParameters(schema))), schema);
    // Non-schema input degrades to the previous empty-object schema.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(proxiedParameters(null))), { type: "object", properties: {} });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(proxiedParameters(undefined))), {
      type: "object",
      properties: {},
    });
  });

  it("propagates an external abort to the bridge and rejects the local call (client side, gateway-ipc:i1)", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveDone!: (r: ToolCallResult) => void;
    const hostCancelled = new Promise<ToolCallResult>((resolve) => {
      resolveDone = resolve;
    });
    tools.set("blocking", async (_args, signal) => {
      markStarted();
      signal?.addEventListener("abort", () => resolveDone({ content: "cancelled-by-abort", isError: false }), {
        once: true,
      });
      return await hostCancelled;
    });
    bridge = new MCPBridge({ tools, timeout: 5000 });
    await bridge.start();

    const client = new MCPProxyClient(bridge.getSocketPath(), { authToken: bridge.getAuthToken() });
    await client.connect();
    try {
      const controller = new AbortController();
      const call = client.executeToolCall("blocking", {}, { signal: controller.signal });
      await started; // the host tool is now in flight on the bridge

      controller.abort();

      // The local request must fail as an abort (not an isError tool result),
      // and the bridge-side host tool must have observed the cancellation.
      await assert.rejects(call, ProxyAbortError);
      const hostOutcome = await hostCancelled;
      assert.deepStrictEqual(hostOutcome, { content: "cancelled-by-abort", isError: false });
    } finally {
      await client.disconnect();
    }
  });

  it("round-trips a tool call through a real MCPProxyClient socket (E2E proxied path)", async () => {
    bridge = new MCPBridge({
      tools,
      toolDefs: [
        {
          name: "echo",
          description: "Echo tool",
          inputSchema: { type: "object", properties: { hello: { type: "string" } } },
          source: "host",
        },
        { name: "error-tool", description: "Error tool", inputSchema: {}, source: "host" },
      ],
    });
    await bridge.start();

    // Client side of the proxied path: a real MCPProxyClient connects to the
    // bridge socket exactly like a subagent session would — and must present
    // the auth token to get past the handshake gate.
    const client = new MCPProxyClient(bridge.getSocketPath(), { authToken: bridge.getAuthToken() });
    await client.connect();
    try {
      const proxiedDefs = client.getProxiedToolDefs();
      assert.deepStrictEqual(
        proxiedDefs.map((d) => d.name),
        ["echo", "error-tool"],
        "tool.list must reach the client through the socket",
      );

      // Invoke a tool through the bridge and assert the response round-trips.
      const result = await client.executeToolCall("echo", { hello: "world" });
      assert.deepStrictEqual(result, {
        content: JSON.stringify({ hello: "world" }),
        isError: false,
      });

      // The proxied ToolDefinition path (what a subagent session actually
      // executes) forwards through the same client and carries the host
      // tool's REAL argument schema (gateway-ipc:f6/i2), not Type.Object({}).
      const echoDef = client.getToolDefinitions().find((d) => d.name === "echo");
      assert.ok(echoDef, "echo tool definition must be exposed to the subagent");
      const paramsJson = JSON.parse(JSON.stringify((echoDef as unknown as { parameters: unknown }).parameters));
      assert.deepStrictEqual(paramsJson, {
        type: "object",
        properties: { hello: { type: "string" } },
      });
      const defResult = (await (
        echoDef as unknown as {
          execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
        }
      ).execute("call-1", { nested: [1, 2] })) as { content: Array<{ type: string; text: string }> };
      assert.strictEqual(defResult.content[0].text, JSON.stringify({ nested: [1, 2] }));
    } finally {
      await client.disconnect();
    }
  });

  it("drops the connection slot when a client socket closes — the cap self-heals (mcp-proxy-client-socket-leak)", async () => {
    // Steady-state leak check: every tracked connection must be removed when
    // its client socket closes/destroys. If entries lingered, enough dead
    // clients would wedge the connection cap and block every later run/resume
    // (the leak that made the gateway stop accepting after repeated toolset
    // resolutions).
    bridge = new MCPBridge({ tools, maxConnections: 2 });
    await bridge.start();

    const conns = (bridge as unknown as { connections: Set<Socket> }).connections;

    const s1 = new Socket();
    await new Promise<void>((resolve) => s1.connect(bridge.getSocketPath(), resolve));
    const s2 = new Socket();
    await new Promise<void>((resolve) => s2.connect(bridge.getSocketPath(), resolve));
    await waitFor(() => conns.size === 2, 1000, "both connections tracked");

    // A third connection at the cap must be refused outright.
    const rejected = new Socket();
    rejected.on("error", () => {});
    const rejectedClosed = new Promise<void>((resolve) => rejected.once("close", () => resolve()));
    await new Promise<void>((resolve) => rejected.connect(bridge.getSocketPath(), resolve));
    await Promise.race([
      rejectedClosed,
      sleep(1000).then(() => {
        throw new Error("bridge must refuse a connection beyond the cap");
      }),
    ]);
    assert.equal(conns.size, 2, "the refused connection must not be tracked");

    // Close one tracked client: the bridge must drop its connection slot.
    s1.destroy();
    await waitFor(() => conns.size === 1, 1000, "closed client slot released");

    // A NEW client now fits under the cap and can authenticate + call tools.
    const s3 = await connectToBridge(bridge);
    const response = await sendRequest(s3, {
      jsonrpc: "2.0",
      method: "tool.call",
      params: { toolName: "echo", args: { healed: true } },
      id: "after-close",
    });
    assert.deepStrictEqual((response as { result?: ToolCallResult }).result, {
      content: JSON.stringify({ healed: true }),
      isError: false,
    });
    assert.equal(conns.size, 2, "the reconnected client occupies the freed slot");

    s2.destroy();
    s3.destroy();
    await waitFor(() => conns.size === 0, 1000, "all client slots released");
  });
});
