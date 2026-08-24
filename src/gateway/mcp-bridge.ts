/**
 * MCPBridge - Host-side IPC server for the Universal Host Tool Gateway.
 *
 * Runs in the main Pi process and exposes all registered tools (MCP, extensions,
 * built-in) over a local IPC socket/pipe. Worktree subagents connect via
 * MCPProxyClient to execute tools without re-instantiating heavy extensions.
 *
 * Architecture:
 * - Uses node:net for IPC (Unix domain socket on Linux/macOS, named pipe on Windows)
 * - JSON-RPC 2.0 protocol with length-prefixed framing
 * - Handles multiple concurrent subagent connections
 * - Per-call timeout handling (configurable, default 30s)
 * - Socket auth handshake: every connection must present the bridge token via
 *   `auth.handshake` before any method (including ping) is accepted
 * - Idempotency keys dedupe replayed tool executions (client timeout + retry)
 * - Abort support: `tool.abort` cancels an in-flight call's AbortSignal
 * - Hard frame-size cap defending against corrupt/malformed frames (OOM)
 * - Graceful shutdown with process lifecycle hooks
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import {
  AUTH_FAILED,
  AUTH_REQUIRED,
  FRAME_TOO_LARGE,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MAX_IPC_FRAME_SIZE,
  type MCPBridgeOptions,
  METHOD_AUTH_HANDSHAKE,
  METHOD_NOT_FOUND,
  METHOD_PING,
  METHOD_SHUTDOWN,
  METHOD_TOOL_ABORT,
  METHOD_TOOL_CALL,
  METHOD_TOOL_DESCRIBE,
  METHOD_TOOL_LIST,
  normalizeToolTimeouts,
  PARSE_ERROR,
  type ProxiedToolDef,
  TOOL_TIMEOUT,
  type ToolCallResult,
  type ToolExecutor,
} from "./types.js";

/** Default per-tool-call timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/** Maximum concurrent connections. */
const DEFAULT_MAX_CONNECTIONS = 10;

/** Length prefix size in bytes (4-byte big-endian uint32). */
const LENGTH_PREFIX_SIZE = 4;

/** Bound on the idempotency-result cache (FIFO eviction past this). */
const IDEMPOTENCY_CACHE_LIMIT = 256;

/** Sentinel returned by handleToolCall when the call was aborted mid-flight. */
const ABORTED_RESULT = Symbol("aborted-tool-call");

/** Tracks an in-flight tool call so `tool.abort` can cancel it. */
interface ActiveCall {
  controller: AbortController;
  socket: Socket;
  aborted: boolean;
}

/**
 * Raised when a tool call exceeds the configured per-call timeout.
 *
 * Propagates to the JSON-RPC response layer, which maps it to the TOOL_TIMEOUT
 * error code so clients can distinguish a timed-out call from a tool failure.
 */
class ToolTimeoutError extends Error {
  /** JSON-RPC error code for tool timeouts. */
  readonly code: number = TOOL_TIMEOUT;
  /** Name of the tool that missed its deadline. */
  readonly toolName: string;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool execution timed out after ${timeoutMs}ms: ${toolName}`);
    this.name = "ToolTimeoutError";
    this.toolName = toolName;
  }
}

/**
 * MCPBridge exposes registered tools over a local IPC socket.
 *
 * @example
 * ```typescript
 * const bridge = new MCPBridge({
 *   tools: new Map([
 *     ["my-tool", async (args) => ({ content: "result", isError: false })]
 *   ]),
 * });
 * await bridge.start();
 * console.log(`Bridge listening on ${bridge.getSocketPath()}`);
 * // ... subagents connect via MCPProxyClient with the bridge's auth token
 * await bridge.stop();
 * ```
 */
export class MCPBridge {
  private readonly tools: Map<string, ToolExecutor>;
  private readonly toolDefs: ProxiedToolDef[];
  private readonly timeout: number;
  /** Per-tool timeout overrides; a tool without an entry uses {@link timeout}. */
  private readonly perToolTimeouts: ReadonlyMap<string, number>;
  private readonly maxConnections: number;
  private readonly maxFrameSize: number;
  private readonly authToken: string;
  private readonly socketPath: string;
  private server: Server | null = null;
  private connections: Set<Socket> = new Set();
  /** Sockets that completed the `auth.handshake` and may issue requests. */
  private readonly authenticated = new Set<Socket>();
  /** In-flight tool calls keyed by request id, for `tool.abort`. */
  private readonly activeCalls = new Map<string | number, ActiveCall>();
  /** Dedupe cache: idempotency key -> the execution it maps to. */
  private readonly idempotentExecutions = new Map<string, Promise<ToolCallResult>>();
  private started = false;
  private cleanupHandlersInstalled = false;
  /**
   * This bridge's installed process lifecycle handlers ([event, fn] pairs), so
   * stop() can removeListener exactly the ones it installed — each extension
   * generation that started a bridge used to leave three process.on listeners
   * behind forever (process-listeners-reload).
   */
  private readonly processCleanupHandlers: Array<[string, (...args: unknown[]) => void]> = [];
  /** Outstanding per-call timeout timers; every settled call must leave this empty. */
  private readonly activeTimeoutHandles = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: MCPBridgeOptions) {
    this.tools = options.tools;
    this.toolDefs = options.toolDefs ?? [];
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.perToolTimeouts = normalizeToolTimeouts(options.toolTimeouts);
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxFrameSize = options.maxFrameSize ?? MAX_IPC_FRAME_SIZE;
    this.authToken = options.authToken ?? randomUUID();
    this.socketPath = options.socketPath ?? this.generateSocketPath();
  }

  /**
   * The deadline for one tool call: the tool's declared per-tool timeout when
   * configured, otherwise the bridge-wide default. A slow tool therefore gets
   * its declared timeout instead of the flat 30s cap.
   */
  private timeoutFor(toolName: string): number {
    return this.perToolTimeouts.get(toolName) ?? this.timeout;
  }

  /**
   * Generate a platform-appropriate IPC socket path.
   * Unix: /tmp/pi-workflow-<pid>-<uuid>.sock
   * Windows: \\.\pipe\pi-workflow-<pid>-<uuid>
   */
  private generateSocketPath(): string {
    const id = randomUUID().slice(0, 8);
    const pid = process.pid;

    if (platform() === "win32") {
      return join("\\\\.\\pipe", `pi-workflow-${pid}-${id}`);
    }

    return join("/tmp", `pi-workflow-${pid}-${id}.sock`);
  }

  /**
   * Start the IPC server and begin accepting connections.
   * @throws {Error} If the server fails to start.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    // Remove stale socket file if it exists (Unix only)
    if (platform() !== "win32") {
      try {
        await unlink(this.socketPath);
      } catch {
        // File doesn't exist - that's fine
      }
    }

    return new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));

      this.server.on("error", (error) => {
        if (!this.started) {
          reject(error);
        } else {
          console.error("[MCPBridge] Server error:", error.message);
        }
      });

      this.server.listen(this.socketPath, () => {
        this.started = true;
        // Restrict the socket to the owner where the platform allows: the
        // socket is the capability that lets other local processes invoke
        // host tools, so it must not be world-readable/writable.
        if (platform() !== "win32") {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch (e) {
            // Best-effort: some platforms may not expose chmod on sockets.
            // Surface it once so a permissions regression on the socket
            // capability stays observable rather than failing silently.
            console.warn("[MCPBridge] socket chmod 0o600 failed:", (e as Error).message);
          }
        }
        this.installCleanupHandlers();
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server and close all connections.
   */
  async stop(): Promise<void> {
    // Remove this bridge's own process lifecycle handlers first — a stopped
    // bridge must not leave process.on listeners behind (process-listeners-
    // reload: every extension generation used to accumulate three). Safe on
    // every stop path: the array is empty until installCleanupHandlers() ran.
    for (const [event, handler] of this.processCleanupHandlers) {
      process.removeListener(event, handler);
    }
    this.processCleanupHandlers.length = 0;

    if (!this.started || !this.server) {
      return;
    }

    this.started = false;

    // Cancel outstanding per-call timers so a hung in-flight call cannot keep
    // the process alive past shutdown.
    for (const handle of this.activeTimeoutHandles) {
      clearTimeout(handle);
    }
    this.activeTimeoutHandles.clear();

    // Abort in-flight calls so signal-aware executors can stop promptly.
    for (const call of this.activeCalls.values()) {
      call.controller.abort();
    }
    this.activeCalls.clear();

    // Close all active connections
    for (const socket of this.connections) {
      try {
        socket.destroy();
      } catch {
        // Best-effort cleanup
      }
    }
    this.connections.clear();
    this.authenticated.clear();

    // Close the server
    const server = this.server;
    return new Promise<void>((resolve) => {
      server.close(() => {
        // Remove socket file on Unix
        if (platform() !== "win32") {
          unlink(this.socketPath).catch(() => {});
        }
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Get the IPC socket path for client connections.
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * The handshake token clients must present before any method is accepted.
   *
   * The host is responsible for handing this to subagent processes (e.g. via
   * env) so their MCPProxyClient can authenticate; it is the capability that
   * stops other local processes from invoking host tools.
   */
  getAuthToken(): string {
    return this.authToken;
  }

  /**
   * Number of per-call timeout timers currently armed.
   * Returns to zero after every completed call; exposed for leak assertions.
   */
  get pendingTimeoutCount(): number {
    return this.activeTimeoutHandles.size;
  }

  /**
   * Get serialized tool definitions for proxy registration.
   */
  getProxiedToolDefinitions(): ProxiedToolDef[] {
    // If explicit toolDefs were provided, use them
    if (this.toolDefs.length > 0) {
      return this.toolDefs;
    }

    // Otherwise, generate minimal defs from the tools map
    return Array.from(this.tools.keys()).map((name) => ({
      name,
      description: `Proxied tool: ${name}`,
      inputSchema: { type: "object", properties: {} },
      source: "host" as const,
    }));
  }

  /**
   * Install process lifecycle handlers for cleanup.
   */
  private installCleanupHandlers(): void {
    if (this.cleanupHandlersInstalled) {
      return;
    }
    this.cleanupHandlersInstalled = true;

    const cleanup = () => {
      if (this.started) {
        // Synchronous cleanup for process exit
        for (const socket of this.connections) {
          try {
            socket.destroy();
          } catch {
            // Best-effort
          }
        }
        if (this.server) {
          this.server.close();
        }
        // Remove socket file on Unix
        if (platform() !== "win32") {
          try {
            unlinkSync(this.socketPath);
          } catch {
            // Best-effort
          }
        }
      }
    };

    const onSigterm = () => {
      cleanup();
      process.exit(0);
    };
    const onSigint = () => {
      cleanup();
      process.exit(0);
    };
    this.processCleanupHandlers.push(["exit", cleanup], ["SIGTERM", onSigterm], ["SIGINT", onSigint]);
    process.on("exit", cleanup);
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
  }

  /**
   * Handle a new client connection.
   */
  private handleConnection(socket: Socket): void {
    if (this.connections.size >= this.maxConnections) {
      socket.destroy();
      return;
    }

    this.connections.add(socket);
    let buffer: Buffer<ArrayBuffer> = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      buffer = Buffer.concat([buffer, buf]) as Buffer<ArrayBuffer>;
      buffer = this.processBuffer(socket, buffer);
    });

    socket.on("close", () => {
      this.connections.delete(socket);
      this.authenticated.delete(socket);
      // A dying connection must not keep in-flight calls running forever;
      // signal-aware executors stop, signal-oblivious ones settle on their own.
      for (const [requestId, call] of this.activeCalls) {
        if (call.socket === socket) {
          call.controller.abort();
          this.activeCalls.delete(requestId);
        }
      }
    });

    socket.on("error", (error) => {
      console.error("[MCPBridge] Socket error:", error.message);
      this.connections.delete(socket);
      this.authenticated.delete(socket);
    });
  }

  /**
   * Process buffered data, extracting complete messages.
   * Returns remaining buffer after processing.
   */
  private processBuffer(socket: Socket, buffer: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
    while (buffer.length >= LENGTH_PREFIX_SIZE) {
      const messageLength = buffer.readUInt32BE(0);

      if (messageLength > this.maxFrameSize) {
        // The length prefix lies beyond the accepted cap: either a corrupt
        // frame or an OOM attempt. The framing is untrustworthy past this
        // point, so respond once and drop the connection.
        this.sendResponse(socket, {
          jsonrpc: "2.0",
          error: {
            code: FRAME_TOO_LARGE,
            message: `Frame of ${messageLength} bytes exceeds the ${this.maxFrameSize}-byte cap`,
          },
          id: 0,
        });
        socket.destroy();
        return Buffer.alloc(0) as Buffer<ArrayBuffer>;
      }

      if (buffer.length < LENGTH_PREFIX_SIZE + messageLength) {
        // Incomplete message, wait for more data
        return buffer;
      }

      // Extract complete message
      const messageBuffer = buffer.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + messageLength);
      buffer = buffer.subarray(LENGTH_PREFIX_SIZE + messageLength) as Buffer<ArrayBuffer>;

      // Process message asynchronously
      void this.handleMessage(socket, messageBuffer.toString("utf-8"));
    }

    return buffer;
  }

  /**
   * Handle a complete IPC message.
   */
  private async handleMessage(socket: Socket, raw: string): Promise<void> {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      this.sendResponse(socket, {
        jsonrpc: "2.0",
        error: { code: PARSE_ERROR, message: "Invalid JSON" },
        id: 0,
      });
      return;
    }

    // Validate JSON-RPC structure
    if (request.jsonrpc !== "2.0" || !request.method) {
      this.sendResponse(socket, {
        jsonrpc: "2.0",
        error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC request" },
        id: request.id ?? 0,
      });
      return;
    }

    // Socket auth gate: nothing except the handshake itself is accepted until
    // the connection has proven it holds the bridge token.
    if (request.method !== METHOD_AUTH_HANDSHAKE && !this.authenticated.has(socket)) {
      this.sendResponse(socket, {
        jsonrpc: "2.0",
        error: {
          code: AUTH_REQUIRED,
          message: "Socket not authenticated: send auth.handshake with the bridge token first",
        },
        id: request.id,
      });
      return;
    }

    // Route to appropriate handler
    try {
      let result: unknown;

      switch (request.method) {
        case METHOD_AUTH_HANDSHAKE: {
          // On auth failure handleAuthHandshake replies directly (with the
          // request's id so the client correlates it) and destroys the
          // socket, so no outer result is emitted in that case.
          const authResult = await this.handleAuthHandshake(socket, request.params as { token?: unknown }, request.id);
          if (!authResult.ok) {
            // handleAuthHandshake already emitted AUTH_FAILED and destroyed
            // the socket; suppress the outer result to avoid a double reply.
            return;
          }
          result = authResult;
          break;
        }

        case METHOD_TOOL_CALL:
          result = await this.handleToolCall(
            request.params as { toolName: string; args: Record<string, unknown>; idempotencyKey?: string },
            { requestId: request.id, socket },
          );
          if (result === ABORTED_RESULT) {
            // The caller already got its tool.abort ack; suppress the late
            // result so a cancelled request never resolves post-abort.
            return;
          }
          break;

        case METHOD_TOOL_LIST:
          result = this.getProxiedToolDefinitions();
          break;

        case METHOD_TOOL_DESCRIBE:
          result = this.handleToolDescribe((request.params as { toolName: string })?.toolName);
          break;

        case METHOD_PING:
          result = { pong: true, timestamp: Date.now() };
          break;

        case METHOD_SHUTDOWN:
          // Flush the ack before the server stops so the caller reliably
          // observes it instead of racing socket teardown.
          await this.sendResponse(socket, {
            jsonrpc: "2.0",
            result: { shuttingDown: true },
            id: request.id,
          });
          await this.stop();
          return;

        case METHOD_TOOL_ABORT:
          this.handleToolAbort(request.params as { requestId?: string | number });
          return;

        default:
          this.sendResponse(socket, {
            jsonrpc: "2.0",
            error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
            id: request.id,
          });
          return;
      }

      this.sendResponse(socket, {
        jsonrpc: "2.0",
        result,
        id: request.id,
      });
    } catch (error) {
      const rpcError: JsonRpcError =
        error instanceof ToolTimeoutError
          ? {
              code: TOOL_TIMEOUT,
              message: error.message,
              data: { toolName: error.toolName },
            }
          : {
              code: INTERNAL_ERROR,
              message: error instanceof Error ? error.message : "Unknown error",
            };
      this.sendResponse(socket, {
        jsonrpc: "2.0",
        error: rpcError,
        id: request.id,
      });
    }
  }

  /**
   * Authenticate a connection against the bridge token (constant-time compare).
   * On failure the connection is destroyed so a wrong token cannot retry.
   */
  private async handleAuthHandshake(
    socket: Socket,
    params: { token?: unknown },
    requestId: string | number,
  ): Promise<{ ok: boolean }> {
    const presented = typeof params?.token === "string" ? params.token : "";
    const presentedBuffer = Buffer.from(presented, "utf-8");
    const expectedBuffer = Buffer.from(this.authToken, "utf-8");

    const matches =
      presentedBuffer.length === expectedBuffer.length && timingSafeEqual(presentedBuffer, expectedBuffer);

    if (matches) {
      this.authenticated.add(socket);
      return { ok: true };
    }

    // Flush the refusal before destroying the connection so the client always
    // observes AUTH_FAILED instead of racing socket teardown. Echo the
    // request's id so the client's PendingRequest (keyed by its own id)
    // correlates the failure and can surface the auth error to the user.
    await this.sendResponse(socket, {
      jsonrpc: "2.0",
      error: { code: AUTH_FAILED, message: "Invalid auth token" },
      id: requestId,
    });
    socket.destroy();
    return { ok: false };
  }

  /**
   * Abort an in-flight tool call. Fire-and-forget: the original requester's
   * response is suppressed (handleToolCall returns ABORTED_RESULT), so there
   * is no response to correlate on the abort channel itself. Unknown request
   * ids are silently ignored: the call may have already settled.
   */
  private handleToolAbort(params: { requestId?: string | number }): void {
    const requestId = params?.requestId;
    if (requestId === undefined) {
      return;
    }
    const call = this.activeCalls.get(requestId);
    if (call) {
      call.aborted = true;
      call.controller.abort();
    }
  }

  /**
   * Handle a tool.call request.
   */
  private async handleToolCall(
    params: { toolName: string; args: Record<string, unknown>; idempotencyKey?: string },
    callInfo: { requestId: string | number; socket: Socket },
  ): Promise<ToolCallResult | typeof ABORTED_RESULT> {
    const { toolName, args, idempotencyKey } = params;

    if (!toolName || typeof toolName !== "string") {
      return {
        content: "Missing or invalid toolName parameter",
        isError: true,
      };
    }

    const executor = this.tools.get(toolName);
    if (!executor) {
      return {
        content: `Tool not found: ${toolName}`,
        isError: true,
      };
    }

    const controller = new AbortController();
    const call: ActiveCall = { controller, socket: callInfo.socket, aborted: false };
    this.activeCalls.set(callInfo.requestId, call);

    // A replayed call (client timeout + retry) joins the original execution
    // instead of running the side-effectful tool a second time. The replay's
    // own controller only governs its response, never the shared execution.
    let execution: Promise<ToolCallResult>;
    if (idempotencyKey !== undefined && this.idempotentExecutions.has(idempotencyKey)) {
      execution = this.idempotentExecutions.get(idempotencyKey) as Promise<ToolCallResult>;
    } else {
      execution = this.executeWithTimeout(toolName, executor, args ?? {}, controller, this.timeoutFor(toolName));
      if (idempotencyKey !== undefined) {
        this.idempotentExecutions.set(idempotencyKey, execution);
        if (this.idempotentExecutions.size > IDEMPOTENCY_CACHE_LIMIT) {
          const oldest = this.idempotentExecutions.keys().next().value;
          if (oldest !== undefined) {
            this.idempotentExecutions.delete(oldest);
          }
        }
      }
    }

    try {
      const result = await execution;
      // Suppress the response when the caller aborted this specific request;
      // the tool.abort ack already told the client it is cancelled.
      return call.aborted ? ABORTED_RESULT : result;
    } catch (error) {
      if (call.aborted) {
        return ABORTED_RESULT;
      }
      if (error instanceof ToolTimeoutError) {
        // Let the JSON-RPC layer map this to a TOOL_TIMEOUT error response.
        throw error;
      }
      return {
        content: `Tool execution error: ${error instanceof Error ? error.message : "Unknown error"}`,
        isError: true,
      };
    } finally {
      this.activeCalls.delete(callInfo.requestId);
    }
  }

  /**
   * Run one executor under its per-tool deadline. The signal (owned by the
   * active-call record) is aborted both on timeout and on `tool.abort`, so
   * signal-aware executors can stop promptly instead of running to completion
   * with nobody listening.
   */
  private executeWithTimeout(
    toolName: string,
    executor: ToolExecutor,
    args: Record<string, unknown>,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<ToolCallResult> {
    // The handle is registered so it can be cleared when the call settles —
    // otherwise every completed call leaks a live timer.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new ToolTimeoutError(toolName, timeoutMs));
      }, timeoutMs);
      this.activeTimeoutHandles.add(timeoutHandle);
    });

    return Promise.race([executor(args, controller.signal), timeoutPromise]).finally(() => {
      if (timeoutHandle !== undefined) {
        this.activeTimeoutHandles.delete(timeoutHandle);
        clearTimeout(timeoutHandle);
      }
    });
  }

  /**
   * Handle a tool.describe request.
   */
  private handleToolDescribe(toolName: string): ProxiedToolDef | null {
    const def = this.toolDefs.find((d) => d.name === toolName);
    if (def) {
      return def;
    }

    // Generate minimal def from tools map
    if (this.tools.has(toolName)) {
      return {
        name: toolName,
        description: `Proxied tool: ${toolName}`,
        inputSchema: { type: "object", properties: {} },
        source: "host",
      };
    }

    return null;
  }

  /**
   * Send a JSON-RPC response to a client socket. Resolves once the frame has
   * been flushed to the kernel (write callback), so shutdown acks are reliably
   * delivered before the socket is destroyed.
   */
  private sendResponse(socket: Socket, response: JsonRpcResponse): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const json = JSON.stringify(response);
        const messageBuffer = Buffer.from(json, "utf-8");
        const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
        lengthPrefix.writeUInt32BE(messageBuffer.length, 0);
        const frame = Buffer.concat([lengthPrefix, messageBuffer]);
        socket.write(frame, () => resolve());
      } catch (error) {
        console.error("[MCPBridge] Failed to send response:", error);
        resolve();
      }
    });
  }
}
