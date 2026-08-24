/**
 * McpHttpClient — minimal stateless HTTP JSON-RPC client for MCP servers
 * (streamable-HTTP transport as served by e.g. mcp.svelte.dev).
 *
 * Design: tasks/subagent-tools-all/DESIGN.md §MCP client lifecycle. One client
 * per configured server; the transport is plain POST requests with no
 * persistent sockets, so "disconnect" is just dropping cached session state.
 *
 * Wire behavior (verified against the svelte server probe):
 * - initialize POST (captures the Mcp-Session-Id response header, negotiates
 *   protocol 2025-03-26 with a one-shot fallback to 2024-11-05) → tools/list →
 *   tools/call, echoing Mcp-Session-Id on every subsequent request.
 * - Responses may be `text/event-stream` (SSE `event: message` / `data:`
 *   framing) or plain JSON; both are parsed.
 * - A 404 / session-expired call triggers one re-initialize + retry.
 * - User-supplied header VALUES are redacted from every error string
 *   (`[redacted]`) so credentials from the user's own mcp.json never appear in
 *   logs or exception messages.
 */

import type { McpServerConfig } from "./mcp-config.js";

/** One tool as advertised by `tools/list` (schema kept as plain JSON). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Normalized result of a `tools/call`: text content plus structured content. */
export interface McpCallResult {
  /** Text content blocks, flattened from the server's content array. */
  content: Array<{ type: string; text: string }>;
  /** Structured result payload (preferred over the text when both exist). */
  structuredContent?: unknown;
  /** Whether the server marked the call as failed (result.isError). */
  isError?: boolean;
}

/** Options for {@link McpHttpClient}. */
interface McpHttpClientOptions {
  /**
   * Per-request deadline for listTools/callTool (ms) — the long bound for
   * actual tool work. Default {@link DEFAULT_TIMEOUT_MS} (30s).
   */
  timeoutMs?: number;
  /**
   * Per-request deadline for the initialize handshake (ms). The handshake is
   * the SHORTER bound (B4): a dead server must fail the list in seconds, not
   * consume the full tool-call timeout. Default {@link HANDSHAKE_TIMEOUT_MS}.
   */
  handshakeTimeoutMs?: number;
  /** Injectable fetch implementation (test seam); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** JSON-RPC error raised for protocol-level failures. */
export class McpRpcError extends Error {
  /** JSON-RPC error code from the server (or a client-side stand-in < 0). */
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "McpRpcError";
    this.code = code;
  }
}

/** Raised when the caller's AbortSignal cancels an in-flight request. */
export class McpAbortError extends Error {
  constructor(server: string) {
    super(`MCP request to server "${server}" aborted by caller signal`);
    this.name = "McpAbortError";
  }
}

/** Raised when a request misses its deadline (client timeout, not the caller). */
export class McpTimeoutError extends Error {
  constructor(server: string, timeoutMs: number) {
    super(`MCP request to server "${server}" timed out after ${timeoutMs}ms`);
    this.name = "McpTimeoutError";
  }
}

/** Internal marker for a dead/expired session (HTTP 404 or session error). */
class McpSessionExpiredError extends Error {
  constructor(server: string, detail: string) {
    super(`MCP session for server "${server}" expired or rejected: ${detail}`);
    this.name = "McpSessionExpiredError";
  }
}

/** Default per-request deadline in milliseconds (listTools/callTool). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Default initialize-handshake deadline in milliseconds (shorter than the call bound). */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** Primary MCP protocol version; servers rejecting it trigger the fallback. */
const PROTOCOL_VERSION_PRIMARY = "2025-03-26";
/** Fallback protocol version for servers that do not support the primary. */
const PROTOCOL_VERSION_FALLBACK = "2024-11-05";
/** JSON-RPC version string. */
const JSONRPC = "2.0";
/** initialize handshake method. */
const METHOD_INITIALIZE = "initialize";
/** tools/list method. */
const METHOD_LIST_TOOLS = "tools/list";
/** tools/call method. */
const METHOD_CALL_TOOL = "tools/call";
/** Session id response/request header issued and echoed by MCP servers. */
const HEADER_SESSION_ID = "mcp-session-id";
/** JSON-RPC error code for "method not found" (protocol negotiation probe). */
const RPC_METHOD_NOT_FOUND = -32601;
/** Client-side stand-in code for network/transport failures. */
const RPC_TRANSPORT_ERROR = -32603;
/** HTTP status meaning the server no longer recognizes the session. */
const HTTP_SESSION_EXPIRED = 404;
/** Client identity reported in the initialize handshake. */
const CLIENT_NAME = "pi-dynamic-workflows";
const CLIENT_VERSION = "1.0";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** A parsed body already matched against the request id. */
interface ParsedBody {
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class McpHttpClient {
  private readonly cfg: McpServerConfig;
  private readonly timeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Cached session id issued by the server; echoed on every request. */
  private sessionId: string | undefined;
  private initialized = false;
  /** Whether the protocol-version fallback was already attempted. */
  private negotiationRetried = false;
  private requestIdCounter = 0;

  constructor(cfg: McpServerConfig, options: McpHttpClientOptions = {}) {
    this.cfg = cfg;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Whether the server is initialized (session id captured, version set). */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Perform the MCP initialize handshake. Negotiates 2025-03-26 first; a
   * JSON-RPC error (e.g. -32601 "method not found" from a server that only
   * speaks the older protocol) triggers a one-shot retry with 2024-11-05.
   * No-op when already initialized.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.doInitialize(PROTOCOL_VERSION_PRIMARY, signal).catch(async (error) => {
      if (this.negotiationRetried) throw error;
      this.negotiationRetried = true;
      await this.doInitialize(PROTOCOL_VERSION_FALLBACK, signal);
    });
    this.initialized = true;
  }

  /**
   * List the server's tools. Initializes first when needed.
   */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    await this.ensureInitialized(signal);
    const response = await this.rpcRequest(METHOD_LIST_TOOLS, {}, signal);
    const result =
      response.result !== null && typeof response.result === "object" && !Array.isArray(response.result)
        ? (response.result as Record<string, unknown>)
        : {};
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((tool) => normalizeToolInfo(tool));
  }

  /**
   * Invoke a tool and map the MCP result into {@link McpCallResult}. A dead
   * session (HTTP 404 or a session error) triggers one re-initialize + retry.
   */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    await this.ensureInitialized(signal);
    try {
      return await this.doCallTool(name, args, signal);
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error;
      // Session died between initialize and the call (server restart, TTL):
      // drop cached state and re-run the handshake exactly once.
      this.initialized = false;
      this.sessionId = undefined;
      await this.initialize(signal);
      return this.doCallTool(name, args, signal);
    }
  }

  /** Forget cached session state. There are no sockets to close. */
  close(): void {
    this.initialized = false;
    this.sessionId = undefined;
    this.negotiationRetried = false;
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) await this.initialize(signal);
  }

  private async doInitialize(protocolVersion: string, signal?: AbortSignal): Promise<void> {
    // A stale session id must not ride along on a fresh handshake.
    this.sessionId = undefined;
    const response = await this.rpcRequest(
      METHOD_INITIALIZE,
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      signal,
      // The handshake is the SHORTER bound (B4): the initialize exchange must
      // never consume the long tool-call deadline on a dead server.
      this.handshakeTimeoutMs,
    );
    void response;
  }

  private async doCallTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const response = await this.rpcRequest(METHOD_CALL_TOOL, { name, arguments: args }, signal);
    const result =
      response.result !== null && typeof response.result === "object" && !Array.isArray(response.result)
        ? (response.result as Record<string, unknown>)
        : {};
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter(
        (block): block is { type: string; text: string } =>
          block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text",
      )
      .map((block) => String(block.text ?? ""))
      .join("\n");
    const structuredContent = result.structuredContent;
    return {
      content: [
        { type: "text", text: text || (structuredContent !== undefined ? JSON.stringify(structuredContent) : "") },
      ],
      structuredContent,
      isError: result.isError === true,
    };
  }

  /**
   * Send one JSON-RPC request and return the parsed result. Applies the
   * per-request deadline (the handshake bound for initialize, the call bound
   * otherwise) plus the caller's signal; session id, content type and the
   * user's configured headers ride on every request.
   */
  private async rpcRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    deadlineMs: number = this.timeoutMs,
  ): Promise<ParsedBody> {
    const url = this.cfg.url;
    if (!url) throw new McpRpcError(RPC_TRANSPORT_ERROR, `MCP server "${this.cfg.name}" has no url configured`);

    const id = this.requestIdCounter++;
    const headers: Record<string, string> = {
      ...(this.cfg.headers ?? {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers[HEADER_SESSION_ID] = this.sessionId;

    const timeoutSignal = AbortSignal.timeout(deadlineMs);
    const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: JSONRPC, id, method, params }),
        signal: requestSignal,
      });
    } catch (error) {
      throw this.mapRequestError(error, signal, timeoutSignal, deadlineMs);
    }

    const sessionId = response.headers.get(HEADER_SESSION_ID);
    if (sessionId) this.sessionId = sessionId;

    const bodyText = await readResponseBody(response);
    if (response.status === HTTP_SESSION_EXPIRED) {
      throw new McpSessionExpiredError(this.cfg.name, `HTTP ${HTTP_SESSION_EXPIRED}`);
    }
    if (response.status >= 400) {
      const error = parseJsonRpcError(bodyText, response.headers.get("content-type"));
      throw new McpRpcError(
        error?.code ?? response.status,
        this.redact(error?.message ?? `HTTP ${response.status} from MCP server "${this.cfg.name}"`),
      );
    }

    const parsed = parseResponseBody(bodyText, response.headers.get("content-type"), id);
    if (parsed.error) {
      const message = this.redact(parsed.error.message ?? "Unknown MCP error");
      if (parsed.error.code === RPC_METHOD_NOT_FOUND) {
        throw new McpRpcError(parsed.error.code, message);
      }
      if (/session/i.test(message)) {
        throw new McpSessionExpiredError(this.cfg.name, message);
      }
      throw new McpRpcError(parsed.error.code ?? RPC_TRANSPORT_ERROR, message);
    }
    return { result: parsed.result };
  }

  /**
   * Convert a fetch failure into a typed error, honoring the caller signal and
   * the client deadline, and redacting any user header values that leaked in.
   */
  private mapRequestError(
    error: unknown,
    signal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
    deadlineMs: number,
  ): Error {
    if (signal?.aborted) return new McpAbortError(this.cfg.name);
    if (timeoutSignal.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
      return new McpTimeoutError(this.cfg.name, deadlineMs);
    }
    return new McpRpcError(
      RPC_TRANSPORT_ERROR,
      this.redact(error instanceof Error ? error.message : `MCP transport error for "${this.cfg.name}"`),
    );
  }

  /** Replace user header values inside an error string with a redaction marker. */
  private redact(message: string): string {
    let out = message;
    for (const value of Object.values(this.cfg.headers ?? {})) {
      if (typeof value === "string" && value.length > 0 && out.includes(value)) {
        out = out.split(value).join("[redacted]");
      }
    }
    return out;
  }
}

/** Read a response body defensively (missing body support in test doubles). */
async function readResponseBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Parse a response body that may be `text/event-stream` (SSE `event: message`
 * / `data:` framing, as mcp.svelte.dev serves) or plain JSON. Returns the
 * JSON-RPC payload matching the request id; mismatched messages are ignored.
 */
function parseResponseBody(body: string, contentType: string | null, id: number): ParsedBody {
  if (body.length === 0) throw new McpRpcError(RPC_TRANSPORT_ERROR, "Empty response from MCP server");
  const candidates = looksLikeSse(body, contentType) ? parseSseMessages(body) : [body];
  for (const candidate of candidates) {
    const parsed = tryParseJsonRpc(candidate, id);
    if (parsed) return parsed;
  }
  throw new McpRpcError(RPC_TRANSPORT_ERROR, "Unparseable response from MCP server");
}

/**
 * Split an SSE payload into its `data:` lines. Multi-line data blocks are
 * joined; `event: message` lines are the signal that a data block follows.
 */
function parseSseMessages(body: string): string[] {
  const messages: string[] = [];
  let currentEvent = "";
  let dataLines: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      const data = line.slice("data:".length).trim();
      if (data.length > 0) dataLines.push(data);
    } else if (line.length === 0 && dataLines.length > 0) {
      // Blank line terminates an SSE event: emit any accumulated message.
      if (currentEvent === "message" || currentEvent === "") {
        messages.push(dataLines.join("\n"));
      }
      dataLines = [];
      currentEvent = "";
    }
  }
  if (dataLines.length > 0) messages.push(dataLines.join("\n"));
  return messages;
}

/** Try to parse one candidate as a JSON-RPC response for the given id. */
function tryParseJsonRpc(text: string, id: number | undefined): ParsedBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as JsonRpcResponse;
  if (id !== undefined && candidate.id !== undefined && candidate.id !== id) return null;
  return {
    result: candidate.result,
    error: candidate.error ? { code: candidate.error.code, message: candidate.error.message } : undefined,
  };
}

/** Extract the JSON-RPC error from an error-status body, if one is present. */
function parseJsonRpcError(body: string, contentType: string | null): { code?: number; message?: string } | undefined {
  for (const candidate of looksLikeSse(body, contentType) ? parseSseMessages(body) : [body]) {
    const parsed = tryParseJsonRpc(candidate, undefined);
    if (parsed?.error) return parsed.error;
  }
  return undefined;
}

/** Whether a body looks like SSE framing (event:/data: lines). */
function looksLikeSse(body: string, contentType: string | null): boolean {
  if (contentType?.toLowerCase().includes("text/event-stream")) return true;
  return body.startsWith("event:") || body.startsWith("data:") || body.includes("\nevent:") || body.includes("\ndata:");
}

/** Shape-guard a tools/list entry into {@link McpToolInfo}. */
function normalizeToolInfo(tool: unknown): McpToolInfo {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    return { name: "unknown", description: undefined, inputSchema: { type: "object", properties: {} } };
  }
  const entry = tool as Record<string, unknown>;
  const inputSchema =
    entry.inputSchema !== null && typeof entry.inputSchema === "object" && !Array.isArray(entry.inputSchema)
      ? (entry.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
  return {
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "unknown",
    description: typeof entry.description === "string" ? entry.description : undefined,
    inputSchema,
  };
}
