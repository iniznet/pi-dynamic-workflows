/**
 * MCPProxyClient - Client-side proxy for the Universal Host Tool Gateway.
 *
 * Runs in worktree subagent processes and connects to the host's MCPBridge
 * over IPC. Provides ToolDefinition[] that can be injected into subagent
 * sessions to access tools registered in the parent Pi session.
 *
 * Architecture:
 * - Uses node:net to connect to host IPC socket
 * - Platform detection: Unix domain socket on Linux/macOS, named pipe on Windows
 * - JSON-RPC 2.0 protocol with length-prefixed framing
 * - Auto-reconnect capability (configurable)
 * - Request/response correlation via id field
 */

import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type ConnectionState,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MCPProxyClientOptions,
  METHOD_TOOL_CALL,
  METHOD_TOOL_LIST,
  type PendingRequest,
  type ProxiedToolDef,
  type ToolCallResult,
} from "../gateway/types.js";

/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/** Default reconnect delay in milliseconds. */
const DEFAULT_RECONNECT_DELAY = 1000;

/** Maximum reconnect attempts. */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;

/** Length prefix size in bytes (4-byte big-endian uint32). */
const LENGTH_PREFIX_SIZE = 4;

/**
 * MCPProxyClient connects to a host MCPBridge and provides proxied tool definitions.
 *
 * @example
 * ```typescript
 * const client = new MCPProxyClient("/tmp/pi-workflow-1234.sock");
 * await client.connect();
 * const tools = client.getToolDefinitions();
 * // Inject tools into subagent session
 * await client.disconnect();
 * ```
 */
export class MCPProxyClient {
  private readonly socketPath: string;
  private readonly timeout: number;
  private readonly reconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;

  private socket: Socket | null = null;
  private state: ConnectionState = "disconnected";
  private buffer: Buffer = Buffer.alloc(0);
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private requestIdCounter = 0;
  private toolDefs: ProxiedToolDef[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socketPath: string, options?: MCPProxyClientOptions) {
    this.socketPath = socketPath;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.reconnect = options?.reconnect ?? false;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = options?.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
  }

  /**
   * Connect to the host MCPBridge.
   * @throws {Error} If connection fails.
   */
  async connect(): Promise<void> {
    if (this.state === "connected") {
      return;
    }

    this.state = "connecting";

    return new Promise<void>((resolve, reject) => {
      this.socket = new Socket();

      const onError = (error: Error) => {
        if (this.state === "connecting") {
          this.state = "disconnected";
          reject(error);
        } else {
          console.error("[MCPProxyClient] Socket error:", error.message);
          this.handleDisconnect();
        }
      };

      this.socket.on("error", onError);

      this.socket.on("connect", async () => {
        this.state = "connected";
        this.reconnectAttempts = 0;

        // Fetch tool list from bridge
        try {
          await this.fetchToolList();
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.socket.on("data", (chunk) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
        this.buffer = Buffer.concat([this.buffer, buf]);
        this.processBuffer();
      });

      this.socket.on("close", () => {
        this.handleDisconnect();
      });

      this.socket.on("end", () => {
        this.handleDisconnect();
      });

      // Initiate connection
      this.socket.connect(this.socketPath);
    });
  }

  /**
   * Disconnect from the host MCPBridge.
   */
  async disconnect(): Promise<void> {
    this.state = "closing";

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    // Close socket
    if (this.socket) {
      return new Promise<void>((resolve) => {
        this.socket?.end(() => {
          this.socket = null;
          this.state = "disconnected";
          resolve();
        });
      });
    }

    this.state = "disconnected";
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get proxied tool definitions for injection into a subagent session.
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefs.map((def) => this.createToolDefinition(def));
  }

  /**
   * Fetch tool list from the bridge.
   */
  private async fetchToolList(): Promise<void> {
    const result = await this.sendRequest(METHOD_TOOL_LIST, {});
    this.toolDefs = result as ProxiedToolDef[];
  }

  /**
   * Create a ToolDefinition for a proxied tool.
   */
  private createToolDefinition(def: ProxiedToolDef): ToolDefinition {
    const client = this;
    return defineTool({
      name: def.name,
      label: def.name,
      description: `[Proxied] ${def.description}`,
      parameters: Type.Object({}),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: ExtensionContext,
      ) {
        const result = await client.executeToolCall(def.name, params);
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: result.details,
        };
      },
    });
  }

  /**
   * Send a JSON-RPC request and await the response.
   */
  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.state !== "connected" || !this.socket) {
      throw new Error("Not connected to bridge");
    }

    const id = this.generateRequestId();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    return new Promise<unknown>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${this.timeout}ms: ${method}`));
      }, this.timeout);

      // Track pending request
      this.pendingRequests.set(id, {
        id,
        resolve,
        reject,
        timeout,
        startedAt: Date.now(),
      });

      // Send request
      try {
        const json = JSON.stringify(request);
        const messageBuffer = Buffer.from(json, "utf-8");
        const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
        lengthPrefix.writeUInt32BE(messageBuffer.length, 0);
        this.socket?.write(Buffer.concat([lengthPrefix, messageBuffer]));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Generate a unique request ID.
   */
  private generateRequestId(): string {
    this.requestIdCounter++;
    return `${process.pid}-${this.requestIdCounter}-${randomUUID().slice(0, 4)}`;
  }

  /**
   * Process buffered data, extracting complete messages.
   */
  private processBuffer(): void {
    while (this.buffer.length >= LENGTH_PREFIX_SIZE) {
      const messageLength = this.buffer.readUInt32BE(0);

      if (this.buffer.length < LENGTH_PREFIX_SIZE + messageLength) {
        // Incomplete message, wait for more data
        return;
      }

      // Extract complete message
      const messageBuffer = this.buffer.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + messageLength);
      this.buffer = this.buffer.subarray(LENGTH_PREFIX_SIZE + messageLength);

      // Process message
      this.handleMessage(messageBuffer.toString("utf-8"));
    }
  }

  /**
   * Handle a complete IPC message (response from bridge).
   */
  private handleMessage(raw: string): void {
    let response: JsonRpcResponse;

    try {
      response = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      console.error("[MCPProxyClient] Invalid JSON response");
      return;
    }

    // Find and resolve pending request
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn("[MCPProxyClient] Received response for unknown request:", response.id);
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle disconnection.
   */
  private handleDisconnect(): void {
    if (this.state === "closing") {
      return;
    }

    this.state = "disconnected";
    this.socket = null;

    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection lost"));
    }
    this.pendingRequests.clear();

    // Attempt reconnect if enabled
    if (this.reconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.warn(
        `[MCPProxyClient] Connection lost. Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
      );

      this.reconnectTimer = setTimeout(async () => {
        try {
          await this.connect();
          console.warn("[MCPProxyClient] Reconnected successfully");
        } catch (error) {
          console.error("[MCPProxyClient] Reconnect failed:", error);
        }
      }, this.reconnectDelay);
    }
  }

  /**
   * Execute a tool call through the proxy.
   * This is the main method used by proxied tool definitions.
   */
  async executeToolCall(toolName: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      const result = await this.sendRequest(METHOD_TOOL_CALL, { toolName, args });
      return result as ToolCallResult;
    } catch (error) {
      return {
        content: `Proxy error: ${error instanceof Error ? error.message : "Unknown error"}`,
        isError: true,
      };
    }
  }

  /**
   * Get tool definitions as a raw array (for manual injection).
   */
  getProxiedToolDefs(): ProxiedToolDef[] {
    return this.toolDefs;
  }
}

/**
 * Create proxied tool definitions that call through the MCPProxyClient.
 *
 * This factory creates tool definitions that forward calls to the host bridge.
 *
 * @param client - Connected MCPProxyClient instance
 * @param toolDefs - Tool definitions from the bridge
 * @returns Array of ToolDefinition objects
 */
export function createProxiedTools(client: MCPProxyClient, toolDefs: ProxiedToolDef[]): ToolDefinition[] {
  return toolDefs.map((def) =>
    defineTool({
      name: def.name,
      label: def.name,
      description: `[Proxied] ${def.description}`,
      parameters: Type.Object({}),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: ExtensionContext,
      ) {
        const result = await client.executeToolCall(def.name, params);
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: result.details,
        };
      },
    }),
  );
}
