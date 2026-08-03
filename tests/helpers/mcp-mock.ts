/**
 * Shared test double: a mock MCP streamable-HTTP server for the subagent MCP
 * client/tools tests. Speaks the same wire protocol the svelte server does:
 * initialize (Mcp-Session-Id header) → tools/list → tools/call, with SSE
 * `event: message` / `data:` framing by default and plain-JSON opt-out.
 */

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One recorded inbound request. */
export interface MockRequest {
  index: number;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  parsed: Record<string, unknown>;
}

/** A responder's full HTTP reply. */
export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

/** Custom responder: receives the parsed request, returns the reply. */
export type MockResponder = (req: MockRequest) => MockReply | Promise<MockReply>;

/** Options for {@link createMockMcpServer}. */
export interface MockMcpServerOptions {
  /** Session id issued on every response (like the svelte server). */
  sessionId?: string;
  /** Tools advertised by tools/list. */
  tools?: Array<Record<string, unknown>>;
  /** Result payload for tools/call (content + structuredContent). */
  callResult?: Record<string, unknown>;
  /** Full override of the request → reply logic. */
  respond?: MockResponder;
}

export interface MockMcpServer {
  /** Base URL (http://127.0.0.1:<port>/mcp) for the client config. */
  url: string;
  /** Every request received, in order. */
  requests: MockRequest[];
  /** Destroy lingering sockets + close the listener; resolves on close. */
  close(): Promise<void>;
}

/** Wrap a payload in the SSE framing the svelte server uses. */
export function sseWrap(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A JSON-RPC success body for the given id. */
export function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

/** A JSON-RPC error body for the given id. */
export function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Default responder: initialize → tools/list → tools/call, SSE-wrapped. */
export function standardResponder(options: MockMcpServerOptions = {}): MockResponder {
  const sessionId = options.sessionId ?? "mock-session-123";
  const tools = options.tools ?? [
    {
      name: "get-documentation",
      description: "Get the Svelte docs for a section",
      inputSchema: { type: "object", properties: { section: { type: "string" } } },
    },
  ];
  const callResult = options.callResult ?? {
    content: [{ type: "text", text: '{"ok":true}' }],
    structuredContent: { ok: true },
  };

  return (req) => {
    const method = req.parsed.method as string;
    const id = req.parsed.id;
    const headers = { "Mcp-Session-Id": sessionId, "Content-Type": "text/event-stream" };
    if (method === "initialize") {
      return {
        headers,
        body: sseWrap(jsonRpcResult(id, { protocolVersion: "2025-03-26", serverInfo: { name: "mock-mcp" } })),
      };
    }
    if (method === "tools/list") {
      return { headers, body: sseWrap(jsonRpcResult(id, { tools })) };
    }
    if (method === "tools/call") {
      return { headers, body: sseWrap(jsonRpcResult(id, callResult)) };
    }
    return { status: 400, headers, body: sseWrap(jsonRpcError(id, -32601, `Unknown method: ${method}`)) };
  };
}

/**
 * Start a mock MCP server on an ephemeral port. `respond` (or the standard
 * responder) drives each request; every request is recorded for assertions.
 */
export async function createMockMcpServer(options: MockMcpServerOptions = {}): Promise<MockMcpServer> {
  const respond = options.respond ?? standardResponder(options);
  const requests: MockRequest[] = [];
  let index = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // Non-JSON body (unexpected): leave parsed empty.
    }
    const request: MockRequest = {
      index: index++,
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
      parsed,
    };
    requests.push(request);

    try {
      const reply = await respond(request);
      res.statusCode = reply.status ?? 200;
      for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
      res.end(reply.body);
    } catch (error) {
      res.statusCode = 500;
      res.end(`mock server error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
      await once(server, "close");
    },
  };
}

/** Read a request body, bounded to 1 MB so a malformed client cannot OOM. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > 1024 * 1024) {
      req.destroy();
      break;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
