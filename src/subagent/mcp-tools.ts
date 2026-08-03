/**
 * McpToolsManager — turns the user's HTTP MCP servers into subagent
 * ToolDefinitions (design: tasks/subagent-tools-all/DESIGN.md).
 *
 * Tool names are `mcp_<server>_<tool>` (server/tool names sanitized with
 * `[^A-Za-z0-9_-]` → `_`); each MCP inputSchema is passed through to the tool
 * definition's parameters, and execution forwards to the server via
 * {@link McpHttpClient}.
 *
 * Lifecycle: construction is side-effect free; nothing touches the network
 * until the first {@link listSubagentTools}. Per-server tool lists are cached
 * with a TTL (default 5 min); an unreachable server warns once and contributes
 * no tools (graceful offline), never throwing out of the factory — subagent
 * toolset resolution happens before a run's error handling, so a throw here
 * would strand the run.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { type McpCallResult, McpHttpClient, type McpToolInfo } from "./mcp-client.js";
import { loadMcpConfig, type McpServerConfig } from "./mcp-config.js";

/** Options for {@link McpToolsManager}. */
export interface McpToolsManagerOptions {
  /** Explicit mcp.json path (passed through to loadMcpConfig). */
  configPath?: string;
  /** Base for resolving a relative configPath (passed through). */
  cwd?: string;
  /** Inline server list overriding any config file (test seam). */
  config?: McpServerConfig[];
  /** Injectable fetch implementation (test seam). */
  fetchImpl?: typeof fetch;
  /** Per-server tool-list cache TTL in milliseconds. */
  listTtlMs?: number;
}

/** Default per-server tool-list cache TTL. */
const DEFAULT_LIST_TTL_MS = 5 * 60_000;
/** Per tool-call deadline: 120s (long-running servers like autofixers). */
const TOOL_CALL_TIMEOUT_MS = 120_000;
/** Prefix of every MCP-backed subagent tool name. */
const MCP_TOOL_PREFIX = "mcp_";
/** Characters preserved in sanitized server/tool names. */
const NAME_ALLOWED = /[^A-Za-z0-9_-]/g;
/** Tool name shown when a server advertises a nameless tool. */
const UNKNOWN_TOOL_NAME = "unknown";

/** Dedupes one-time warnings per server name across manager instances. */
const warnedServers = new Set<string>();

/** Sanitize a server/tool name into the `mcp_<server>_<tool>` namespace. */
function sanitizeName(name: string): string {
  const sanitized = name.replace(NAME_ALLOWED, "_");
  return sanitized.length > 0 ? sanitized : UNKNOWN_TOOL_NAME;
}

/**
 * Convert a serialized MCP inputSchema (JSON Schema draft-07) into a TypeBox
 * schema for defineTool. Mirrors proxiedParameters in the host-tool gateway:
 * the raw schema passes through (Type.Unsafe), so subagent models see the
 * server's real argument shape.
 */
function mcpParameters(inputSchema: Record<string, unknown>): TSchema {
  if (inputSchema !== null && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    return Type.Unsafe(inputSchema as TSchema);
  }
  return Type.Object({});
}

/** One server's cached tool definitions plus their fetch time. */
interface ServerListCache {
  defs: ToolDefinition[];
  fetchedAt: number;
}

export class McpToolsManager {
  private readonly options: McpToolsManagerOptions;
  private readonly listTtlMs: number;
  private readonly clients = new Map<string, McpHttpClient>();
  private readonly listCache = new Map<string, ServerListCache>();
  private resolvedConfig: McpServerConfig[] | undefined;

  constructor(options: McpToolsManagerOptions = {}) {
    this.options = options;
    this.listTtlMs = options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
  }

  /**
   * Resolve the configured server names (config file read, no network).
   */
  serverNames(): string[] {
    return this.resolveServers().map((server) => server.name);
  }

  /**
   * Fetch every server's tools as subagent ToolDefinitions. Unreachable or
   * misconfigured servers contribute nothing (warned once, skipped); the
   * result is the union across all reachable servers.
   */
  async listSubagentTools(): Promise<ToolDefinition[]> {
    const servers = this.resolveServers();
    const all: ToolDefinition[] = [];
    for (const server of servers) {
      try {
        all.push(...(await this.listServerTools(server)));
      } catch (error) {
        this.warnOnce(
          server.name,
          `MCP server "${server.name}" unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            "its tools are skipped for subagents. Offline servers recover automatically on the next list.",
        );
      }
    }
    return all;
  }

  /** Forget cached tool lists and session state (extension dispose). */
  disconnectAll(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.listCache.clear();
    this.resolvedConfig = undefined;
  }

  /** Resolve the effective server list (inline config wins over the file). */
  private resolveServers(): McpServerConfig[] {
    if (this.resolvedConfig) return this.resolvedConfig;
    const servers = this.options.config ?? loadMcpConfig(this.options).servers;
    this.resolvedConfig = servers;
    return servers;
  }

  /** List one server's tools, TTL-cached per server name. */
  private async listServerTools(server: McpServerConfig): Promise<ToolDefinition[]> {
    const now = Date.now();
    const cached = this.listCache.get(server.name);
    if (cached && now - cached.fetchedAt < this.listTtlMs) return cached.defs;

    const client = this.getClient(server);
    await client.initialize();
    const rawTools = await client.listTools();
    const filter = server.tools;
    const defs = rawTools
      .filter((tool) => filter === undefined || filter.includes(tool.name))
      .map((tool) => this.toToolDefinition(server, tool));

    this.listCache.set(server.name, { defs, fetchedAt: now });
    return defs;
  }

  /** The shared client for a server (created lazily, cached by name). */
  private getClient(server: McpServerConfig): McpHttpClient {
    let client = this.clients.get(server.name);
    if (!client) {
      client = new McpHttpClient(server, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: TOOL_CALL_TIMEOUT_MS,
      });
      this.clients.set(server.name, client);
    }
    return client;
  }

  /** Build the ToolDefinition that forwards calls to the MCP server. */
  private toToolDefinition(server: McpServerConfig, tool: McpToolInfo): ToolDefinition {
    const client = this.getClient(server);
    const toolName = `${MCP_TOOL_PREFIX}${sanitizeName(server.name)}_${sanitizeName(tool.name)}`;
    return defineTool({
      name: toolName,
      label: tool.name,
      description: tool.description ?? `MCP tool "${tool.name}" from server "${server.name}"`,
      parameters: mcpParameters(tool.inputSchema ?? { type: "object", properties: {} }),
      async execute(_toolCallId, params, signal) {
        return callMcpTool(client, server, tool.name, (params ?? {}) as Record<string, unknown>, signal);
      },
    });
  }

  /** Log a per-server warning exactly once across the process lifetime. */
  private warnOnce(serverName: string, message: string): void {
    if (warnedServers.has(serverName)) return;
    warnedServers.add(serverName);
    console.warn(`[workflows-mcp] ${message}`);
  }
}

/**
 * Execute one MCP tool call, mapping the result into the pi tool-result shape:
 * text content for the model, structured content in `details` (AgentToolResult
 * has no structuredContent field — `details` is its structured channel), and
 * the server's error flag preserved.
 */
async function callMcpTool(
  client: McpHttpClient,
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError: boolean }> {
  try {
    const result: McpCallResult = await client.callTool(toolName, args, signal);
    const text = result.content.map((part) => part.text).join("\n");
    return {
      content: [{ type: "text", text }],
      details: result.structuredContent,
      isError: result.isError ?? false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `MCP tool "${server.name}/${toolName}" failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      details: undefined,
      isError: true,
    };
  }
}
