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
 * - Graceful shutdown with process lifecycle hooks
 */

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import {
  INTERNAL_ERROR,
  INVALID_REQUEST,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MCPBridgeOptions,
  METHOD_NOT_FOUND,
  METHOD_PING,
  METHOD_SHUTDOWN,
  METHOD_TOOL_CALL,
  METHOD_TOOL_DESCRIBE,
  METHOD_TOOL_LIST,
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

/**
 * Raised when a tool call exceeds the configured per-call timeout.
 *
 * Propagates to the JSON-RPC response layer, which maps it to the TOOL_TIMEOUT
 * error code so clients can distinguish a timed-out call from a tool failure.
 */
export class ToolTimeoutError extends Error {
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
 * // ... subagents connect via MCPProxyClient
 * await bridge.stop();
 * ```
 */
export class MCPBridge {
  private readonly tools: Map<string, ToolExecutor>;
  private readonly toolDefs: ProxiedToolDef[];
  private readonly timeout: number;
  private readonly maxConnections: number;
  private readonly socketPath: string;
  private server: Server | null = null;
  private connections: Set<Socket> = new Set();
  private started = false;
  private cleanupHandlersInstalled = false;
  /** Outstanding per-call timeout timers; every settled call must leave this empty. */
  private readonly activeTimeoutHandles = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: MCPBridgeOptions) {
    this.tools = options.tools;
    this.toolDefs = options.toolDefs ?? [];
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.socketPath = options.socketPath ?? this.generateSocketPath();
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
        this.installCleanupHandlers();
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server and close all connections.
   */
  async stop(): Promise<void> {
    if (!this.started || !this.server) {
      return;
    }

    this.started = false;

    // Close all active connections
    for (const socket of this.connections) {
      try {
        socket.destroy();
      } catch {
        // Best-effort cleanup
      }
    }
    this.connections.clear();

    // Cancel outstanding per-call timers so a hung in-flight call cannot keep
    // the process alive past shutdown.
    for (const handle of this.activeTimeoutHandles) {
      clearTimeout(handle);
    }
    this.activeTimeoutHandles.clear();

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

    process.on("exit", cleanup);
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
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
    });

    socket.on("error", (error) => {
      console.error("[MCPBridge] Socket error:", error.message);
      this.connections.delete(socket);
    });
  }

  /**
   * Process buffered data, extracting complete messages.
   * Returns remaining buffer after processing.
   */
  private processBuffer(socket: Socket, buffer: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
    while (buffer.length >= LENGTH_PREFIX_SIZE) {
      const messageLength = buffer.readUInt32BE(0);

      if (buffer.length < LENGTH_PREFIX_SIZE + messageLength) {
        // Incomplete message, wait for more data
        return buffer;
      }

      // Extract complete message
      const messageBuffer = buffer.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + messageLength);
      buffer = buffer.subarray(LENGTH_PREFIX_SIZE + messageLength) as Buffer<ArrayBuffer>;

      // Process message asynchronously
      this.handleMessage(socket, messageBuffer.toString("utf-8"));
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

    // Route to appropriate handler
    try {
      let result: unknown;

      switch (request.method) {
        case METHOD_TOOL_CALL:
          result = await this.handleToolCall(request.params as { toolName: string; args: Record<string, unknown> });
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
          this.sendResponse(socket, {
            jsonrpc: "2.0",
            result: { shuttingDown: true },
            id: request.id,
          });
          await this.stop();
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
   * Handle a tool.call request.
   */
  private async handleToolCall(params: { toolName: string; args: Record<string, unknown> }): Promise<ToolCallResult> {
    const { toolName, args } = params;

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

    // Execute with timeout. The handle is registered so it can be cleared when
    // the call settles — otherwise every completed call leaks a live 30s timer.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new ToolTimeoutError(toolName, this.timeout));
      }, this.timeout);
      this.activeTimeoutHandles.add(timeoutHandle);
    });

    try {
      return await Promise.race([executor(args ?? {}), timeoutPromise]);
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        // Let the JSON-RPC layer map this to a TOOL_TIMEOUT error response.
        throw error;
      }
      return {
        content: `Tool execution error: ${error instanceof Error ? error.message : "Unknown error"}`,
        isError: true,
      };
    } finally {
      if (timeoutHandle !== undefined) {
        this.activeTimeoutHandles.delete(timeoutHandle);
        clearTimeout(timeoutHandle);
      }
    }
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
   * Send a JSON-RPC response to a client socket.
   */
  private sendResponse(socket: Socket, response: JsonRpcResponse): void {
    try {
      const json = JSON.stringify(response);
      const messageBuffer = Buffer.from(json, "utf-8");
      const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
      lengthPrefix.writeUInt32BE(messageBuffer.length, 0);
      const frame = Buffer.concat([lengthPrefix, messageBuffer]);
      socket.write(frame);
    } catch (error) {
      console.error("[MCPBridge] Failed to send response:", error);
    }
  }
}
