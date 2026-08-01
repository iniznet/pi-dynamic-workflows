/**
 * Shared type definitions for the Universal Host Tool IPC Gateway.
 *
 * These types are used by both MCPBridge (host-side) and MCPProxyClient (client-side)
 * to enable worktree subagents to call tools registered in the parent Pi session.
 */

// ─── JSON-RPC 2.0 Protocol ──────────────────────────────────────────────────

/** JSON-RPC 2.0 request message. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Method name (e.g., "tool.call", "tool.list", "tool.describe"). */
  method: string;
  /** Method parameters. */
  params?: unknown;
  /** Request identifier for correlation with responses. */
  id: string | number;
}

/** JSON-RPC 2.0 response message. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  /** Result value (present on success). */
  result?: unknown;
  /** Error object (present on failure). */
  error?: JsonRpcError;
  /** Request identifier for correlation. */
  id: string | number;
}

/** JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  /** Error code (standard or custom). */
  code: number;
  /** Human-readable error message. */
  message: string;
  /** Additional error data. */
  data?: unknown;
}

// ─── IPC Message Framing ─────────────────────────────────────────────────────

/**
 * Length-prefixed IPC message format.
 * Each message is: [4 bytes big-endian uint32 length][JSON payload]
 */
export interface IpcFramedMessage {
  /** Message length in bytes (excluding the 4-byte prefix). */
  length: number;
  /** JSON payload (JsonRpcRequest or JsonRpcResponse). */
  payload: JsonRpcRequest | JsonRpcResponse;
}

// ─── Tool Proxy Types ────────────────────────────────────────────────────────

/** Serialized tool definition for proxy registration. */
export interface ProxiedToolDef {
  /** Tool name (unique identifier). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for input parameters. */
  inputSchema: unknown;
  /** Tool source type. */
  source: "host" | "mcp" | "extension";
}

/** Parameters for a tool call request. */
export interface ToolCallParams {
  /** Tool name to invoke. */
  toolName: string;
  /** Tool arguments. */
  args: Record<string, unknown>;
}

/** Result from a tool call execution. */
export interface ToolCallResult {
  /** Result content (string or structured). */
  content: string;
  /** Whether the tool call resulted in an error. */
  isError: boolean;
  /** Optional structured details. */
  details?: unknown;
}

// ─── Bridge Configuration ────────────────────────────────────────────────────

/** Tool executor function signature. */
export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolCallResult>;

/** Configuration for MCPBridge (host-side). */
export interface MCPBridgeOptions {
  /** Map of tool name to executor function. */
  tools: Map<string, ToolExecutor>;
  /** Tool metadata for proxy registration. */
  toolDefs?: ProxiedToolDef[];
  /** Custom IPC socket path (auto-generated if omitted). */
  socketPath?: string;
  /** Per-tool-call timeout in milliseconds (default: 30000). */
  timeout?: number;
  /** Maximum concurrent connections (default: 10). */
  maxConnections?: number;
}

/** Configuration for MCPProxyClient (client-side). */
export interface MCPProxyClientOptions {
  /** Per-request timeout in milliseconds (default: 30000). */
  timeout?: number;
  /** Auto-reconnect on disconnect (default: false). */
  reconnect?: boolean;
  /** Maximum reconnect attempts (default: 3). */
  maxReconnectAttempts?: number;
  /** Reconnect delay in milliseconds (default: 1000). */
  reconnectDelay?: number;
}

// ─── JSON-RPC Error Codes ────────────────────────────────────────────────────

/** Standard JSON-RPC 2.0 error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** Custom error codes for tool execution. */
export const TOOL_NOT_FOUND = -32001;
export const TOOL_TIMEOUT = -32002;
export const TOOL_EXECUTION_ERROR = -32003;
export const CONNECTION_CLOSED = -32004;
export const BRIDGE_NOT_STARTED = -32005;

// ─── Protocol Methods ────────────────────────────────────────────────────────

/** JSON-RPC method names for the IPC protocol. */
export const METHOD_TOOL_CALL = "tool.call";
export const METHOD_TOOL_LIST = "tool.list";
export const METHOD_TOOL_DESCRIBE = "tool.describe";
export const METHOD_PING = "ping";
export const METHOD_SHUTDOWN = "shutdown";

// ─── Utility Types ───────────────────────────────────────────────────────────

/** Connection state for tracking client lifecycle. */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "closing";

/** Pending request tracking for response correlation. */
export interface PendingRequest {
  /** Original request ID. */
  id: string | number;
  /** Promise resolve function. */
  resolve: (result: unknown) => void;
  /** Promise reject function. */
  reject: (error: Error) => void;
  /** Timeout handle. */
  timeout: ReturnType<typeof setTimeout>;
  /** Request timestamp for diagnostics. */
  startedAt: number;
}