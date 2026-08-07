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
 * - Bounded connect (socket + handshake) timeout so a dead socket surfaces an
 *   error instead of wedging forever
 * - Socket auth handshake: presents the bridge token before any tool call
 * - Idempotency keys so a timed-out call can be retried without re-executing
 *   the side-effectful host tool
 * - Abort propagation: an external AbortSignal cancels the in-flight call on
 *   the bridge and fails the local request promptly
 * - Hard frame-size cap defending against corrupt/malformed frames (OOM)
 * - Auto-reconnect capability (configurable)
 * - Request/response correlation via id field
 */

import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
  type ConnectionState,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MAX_IPC_FRAME_SIZE,
  type MCPProxyClientOptions,
  METHOD_AUTH_HANDSHAKE,
  METHOD_TOOL_ABORT,
  METHOD_TOOL_CALL,
  METHOD_TOOL_LIST,
  normalizeToolTimeouts,
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

/** Default bound on connect() (socket + handshake) in milliseconds. */
const DEFAULT_CONNECT_TIMEOUT = 5_000;

/** Length prefix size in bytes (4-byte big-endian uint32). */
const LENGTH_PREFIX_SIZE = 4;

/**
 * Raised when a proxied tool call is cancelled via its AbortSignal.
 *
 * Deliberately not converted into an isError result: the subagent runtime
 * aborted this call, so the rejection must surface as an abort, not as a
 * normal tool failure the agent could recover from.
 */
export class ProxyAbortError extends Error {
  constructor() {
    super("Tool call aborted by caller signal");
    this.name = "ProxyAbortError";
  }
}

/**
 * Derive a stable idempotency key for a proxied tool call from the logical
 * call identity (tool name + toolCallId).
 *
 * The subagent runtime executes each tool_use block once under a stable
 * toolCallId (verified: pi-agent-core agent-loop passes `toolCall.id` straight
 * through), so every attempt of the same logical call maps to the same key
 * while distinct calls never collide. The bridge dedupes replays with the same
 * key (joins the original execution / returns its cached result), so a call
 * that timed out client-side but actually completed on the host is NOT
 * re-executed — no duplicated write/edit side effects. Keying on args alone
 * would wrongly dedupe two legitimate identical calls, so the call identity is
 * the key basis.
 */
export function proxiedIdempotencyKey(toolName: string, toolCallId: string): string {
  return `host:${toolName}:${toolCallId}`;
}

/**
 * Convert a serialized JSON Schema into a TypeBox schema for defineTool.
 *
 * The bridge ships the host tool's real argument shape; passing it through
 * (instead of the previous empty `Type.Object({})`) lets subagent models see
 * and call the actual parameters.
 */
export function proxiedParameters(inputSchema: unknown): TSchema {
  if (inputSchema !== null && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    return Type.Unsafe(inputSchema as TSchema);
  }
  return Type.Object({});
}

/**
 * MCPProxyClient connects to a host MCPBridge and provides proxied tool definitions.
 *
 * @example
 * ```typescript
 * const client = new MCPProxyClient("/tmp/pi-workflow-1234.sock", { authToken });
 * await client.connect();
 * const tools = client.getToolDefinitions();
 * // Inject tools into subagent session
 * await client.disconnect();
 * ```
 */
export class MCPProxyClient {
  private readonly socketPath: string;
  private readonly timeout: number;
  /** Per-tool timeout overrides; a tool without an entry uses {@link timeout}. */
  private readonly perToolTimeouts: ReadonlyMap<string, number>;
  private readonly reconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly connectTimeout: number;
  private readonly maxFrameSize: number;
  private readonly authToken: string | undefined;

  private socket: Socket | null = null;
  private state: ConnectionState = "disconnected";
  private buffer: Buffer = Buffer.alloc(0);
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private abortCleanups: Map<string | number, () => void> = new Map();
  private requestIdCounter = 0;
  private toolDefs: ProxiedToolDef[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight connect attempt; concurrent callers await the same promise. */
  private connectPromise: Promise<void> | null = null;

  constructor(socketPath: string, options?: MCPProxyClientOptions) {
    this.socketPath = socketPath;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.perToolTimeouts = normalizeToolTimeouts(options?.toolTimeouts);
    this.reconnect = options?.reconnect ?? false;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = options?.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    this.connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.maxFrameSize = options?.maxFrameSize ?? MAX_IPC_FRAME_SIZE;
    this.authToken = options?.authToken;
  }

  /**
   * The wait deadline for one tool's calls: the tool's declared per-tool
   * timeout when configured, otherwise the client-wide default. Mirrors the
   * bridge's `timeoutFor` (the gateway threads the same config to both) so a
   * slow tool gets its declared timeout on the waiting side too — the client
   * must not give up at 30s on a tool the bridge allows 120s.
   */
  private timeoutFor(toolName: string): number {
    return this.perToolTimeouts.get(toolName) ?? this.timeout;
  }

  /**
   * Connect to the host MCPBridge (bounded by connectTimeout), present the
   * auth token, and fetch the tool list.
   * @throws {Error} If connection, handshake, or tool-list fetch fails.
   */
  async connect(): Promise<void> {
    if (this.state === "connected") {
      return;
    }
    if (this.connectPromise) {
      // A previous connect() is still in flight; share it rather than stacking
      // a second socket.
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.state = "connecting";

    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const connectPromise = new Promise<void>((resolve, reject) => {
      this.socket = new Socket();

      const onError = (error: Error) => {
        if (this.state === "connecting") {
          this.state = "disconnected";
          this.socket = null;
          reject(error);
        } else {
          console.error("[MCPProxyClient] Socket error:", error.message);
          this.handleDisconnect();
        }
      };

      this.socket.on("error", onError);

      this.socket.on("connect", async () => {
        this.state = "connected";
        try {
          await this.performHandshake();
          this.reconnectAttempts = 0;
          await this.fetchToolList();
          resolve();
        } catch (error) {
          this.state = "disconnected";
          this.socket?.destroy();
          this.socket = null;
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

    try {
      return await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(() => {
            this.socket?.destroy();
            this.socket = null;
            this.state = "disconnected";
            reject(new Error(`Connect timed out after ${this.connectTimeout}ms: ${this.socketPath}`));
          }, this.connectTimeout);
        }),
      ]);
    } finally {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
      }
    }
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

    // Release abort listeners and reject all pending requests
    for (const cleanup of this.abortCleanups.values()) {
      cleanup();
    }
    this.abortCleanups.clear();

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
   * Present the bridge auth token. Fails loudly (and the bridge closes the
   * connection) when the token is missing or wrong.
   */
  private async performHandshake(): Promise<void> {
    await this.sendRequest(METHOD_AUTH_HANDSHAKE, { token: this.authToken });
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
      parameters: proxiedParameters(def.inputSchema),
      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: ExtensionContext,
      ) {
        const result = await client.executeToolCall(def.name, params, {
          signal,
          // Per-(call,attempt) idempotency key generated at the proxy (see
          // proxiedIdempotencyKey) so a replayed call dedupes on the bridge.
          idempotencyKey: proxiedIdempotencyKey(def.name, toolCallId),
        });
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
  private async sendRequest(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown> {
    if (this.state !== "connected" || !this.socket) {
      throw new Error("Not connected to bridge");
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      throw new ProxyAbortError();
    }

    const id = this.generateRequestId();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    return new Promise<unknown>((resolve, reject) => {
      // Set up timeout: a per-call timeout (e.g. the tool's declared per-tool
      // timeout) overrides the client-wide default for this one request.
      const timeoutMs = options?.timeout ?? this.timeout;
      const timeout = setTimeout(() => {
        this.abortCleanups.get(id)?.();
        this.abortCleanups.delete(id);
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      // Track pending request
      this.pendingRequests.set(id, {
        id,
        resolve,
        reject,
        timeout,
        startedAt: Date.now(),
      });

      // Propagate an external abort: tell the bridge to cancel the in-flight
      // host tool, then fail this request promptly instead of awaiting a
      // response that will never be observed.
      if (signal) {
        const onAbort = () => {
          this.writeFrame({
            jsonrpc: "2.0",
            method: METHOD_TOOL_ABORT,
            params: { requestId: id },
            id: this.generateRequestId(),
          });
          const pending = this.pendingRequests.get(id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(id);
            pending.reject(new ProxyAbortError());
          }
          this.abortCleanups.delete(id);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.abortCleanups.set(id, () => signal.removeEventListener("abort", onAbort));
      }

      // Send request
      try {
        this.writeFrame(request);
      } catch (error) {
        clearTimeout(timeout);
        this.abortCleanups.get(id)?.();
        this.abortCleanups.delete(id);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Serialize and write one frame; throws when the socket rejects the write.
   */
  private writeFrame(request: JsonRpcRequest): void {
    if (!this.socket) {
      throw new Error("Not connected to bridge");
    }
    const json = JSON.stringify(request);
    const messageBuffer = Buffer.from(json, "utf-8");
    const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
    lengthPrefix.writeUInt32BE(messageBuffer.length, 0);
    this.socket.write(Buffer.concat([lengthPrefix, messageBuffer]));
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

      if (messageLength > this.maxFrameSize) {
        // A corrupt or malicious length prefix. The channel cannot be trusted
        // past this point, so drop it and fail every in-flight request.
        const error = new Error(`Frame of ${messageLength} bytes exceeds the ${this.maxFrameSize}-byte cap`);
        this.socket?.destroy();
        this.state = "disconnected";
        this.socket = null;
        for (const [_id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        this.pendingRequests.clear();
        for (const cleanup of this.abortCleanups.values()) {
          cleanup();
        }
        this.abortCleanups.clear();
        this.buffer = Buffer.alloc(0);
        return;
      }

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
    this.abortCleanups.get(response.id)?.();
    this.abortCleanups.delete(response.id);
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
    for (const cleanup of this.abortCleanups.values()) {
      cleanup();
    }
    this.abortCleanups.clear();

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
  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    options?: { idempotencyKey?: string; signal?: AbortSignal; timeout?: number },
  ): Promise<ToolCallResult> {
    try {
      // The wait deadline honors the tool's declared per-tool timeout when one
      // is configured; an explicit per-call timeout wins over both.
      const timeout = options?.timeout ?? this.timeoutFor(toolName);
      const result = await this.sendRequest(
        METHOD_TOOL_CALL,
        { toolName, args, idempotencyKey: options?.idempotencyKey },
        { signal: options?.signal, timeout },
      );
      return result as ToolCallResult;
    } catch (error) {
      if (error instanceof ProxyAbortError) {
        throw error;
      }
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
      parameters: proxiedParameters(def.inputSchema),
      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: ExtensionContext,
      ) {
        // Per-(call,attempt) idempotency key generated at the proxy from the
        // stable call identity, so a replayed call joins the original bridge
        // execution instead of re-running a side-effectful host tool.
        const result = await client.executeToolCall(def.name, params, {
          signal,
          idempotencyKey: proxiedIdempotencyKey(def.name, toolCallId),
        });
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: result.details,
        };
      },
    }),
  );
}
