/**
 * MCP server configuration loader for subagent tools (design:
 * tasks/subagent-tools-all/DESIGN.md).
 *
 * Reads the user's `~/.pi/agent/mcp.json` (the same file the pi host itself
 * consumes) via the public SDK `getAgentDir()` (honors PI_CODING_AGENT_DIR,
 * falling back to `homedir()/.pi/agent` when the SDK export is unavailable).
 * Only streamable-HTTP servers (`type: "http"`) are usable from this extension:
 * stdio servers are skipped with a one-time warning (documented capability gap
 * — spawning and supervising stdio MCP processes is out of scope on the public
 * ExtensionAPI).
 *
 * Never throws: a missing file, malformed JSON, or an invalid server entry
 * degrades to an empty server list (the manager surfaces the empty toolset to
 * subagents rather than failing a run at toolset-resolution time).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** A single validated HTTP MCP server entry (name = key under mcpServers). */
export interface McpServerConfig {
  /** Server id from the mcp.json key; used in `mcp_<server>_<tool>` names. */
  name: string;
  /** Transport marker; only "http" (or absent-with-url) servers are used. */
  type?: string;
  /** POST endpoint for JSON-RPC requests. Required for http servers. */
  url?: string;
  /**
   * Optional tool-name filter (`["*"]`/absent = all tools; explicit names =
   * allowlist). Normalized: "*" entries and invalid values are dropped; an
   * empty result means "all" (undefined).
   */
  tools?: string[];
  /** Extra request headers, passed through verbatim. Values are never logged. */
  headers?: Record<string, string>;
}

/** Result of a config load: validated servers plus the path they came from. */
export interface McpConfig {
  servers: McpServerConfig[];
  configPath: string;
}

/** Options for {@link loadMcpConfig}. */
export interface LoadMcpConfigOptions {
  /** Explicit config path; a relative path is resolved against `cwd`. */
  configPath?: string;
  /** Base for resolving a relative `configPath` (defaults to process.cwd()). */
  cwd?: string;
}

/** JSON file name under the agent dir that pi itself reads for MCP servers. */
const MCP_CONFIG_FILE = "mcp.json";
/** Agent-dir segments used only when the SDK getAgentDir export is missing. */
const FALLBACK_AGENT_DIR_SEGMENTS = [".pi", "agent"] as const;
/** Accepted transport type for in-process HTTP MCP clients. */
const HTTP_TRANSPORT = "http";

/** Dedupes one-time warnings so a broken server entry is logged once per process. */
const warnedServers = new Set<string>();

/**
 * Whether a server entry is a usable HTTP transport. Absent `type` is
 * tolerated when a `url` is present (the url is the http marker); an explicit
 * non-http type (e.g. "stdio") or a command-style entry without a url is
 * skipped with a one-time warning.
 */
function isHttpServer(server: Record<string, unknown>): boolean {
  const type = typeof server.type === "string" ? server.type : undefined;
  if (type !== undefined && type !== HTTP_TRANSPORT) return false;
  return typeof server.url === "string" && server.url.length > 0;
}

/**
 * Normalize the per-server `tools` filter. `["*"]`, invalid entries, and an
 * empty result all normalize to `undefined` ("all"); explicit names are kept.
 */
function normalizeToolsFilter(tools: unknown): string[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const names = tools.filter((entry): entry is string => typeof entry === "string").filter((name) => name !== "*");
  return names.length > 0 ? names : undefined;
}

/** Normalize the optional headers map; anything non-string/string is dropped. */
function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate one server entry into {@link McpServerConfig}, or null when unusable. */
function validateServer(name: string, raw: unknown): McpServerConfig | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const server = raw as Record<string, unknown>;
  if (!isHttpServer(server)) {
    if (!warnedServers.has(name)) {
      warnedServers.add(name);
      console.warn(
        `[workflows-mcp] Server "${name}" is not a streamable-HTTP MCP server (type != "http" or missing url) ` +
          "and is skipped. Only HTTP MCP servers are supported for subagent tools on the public ExtensionAPI " +
          "(stdio servers are a documented capability gap).",
      );
    }
    return null;
  }
  return {
    name,
    type: typeof server.type === "string" ? server.type : HTTP_TRANSPORT,
    url: typeof server.url === "string" ? server.url : undefined,
    tools: normalizeToolsFilter(server.tools),
    headers: normalizeHeaders(server.headers),
  };
}

/**
 * The agent config directory holding mcp.json: SDK `getAgentDir()` when
 * available (honors PI_CODING_AGENT_DIR), else `homedir()/.pi/agent`.
 */
function agentDir(): string {
  try {
    const dir = getAgentDir();
    if (dir && dir.length > 0) return dir;
  } catch {
    // Fall through to the manual derivation on hosts without the export.
  }
  return join(homedir(), ...FALLBACK_AGENT_DIR_SEGMENTS);
}

/**
 * Load and validate the user's MCP server configuration.
 *
 * Never throws: a missing or malformed file yields an empty server list.
 * Invalid entries (non-objects, stdio transports, entries without a url) are
 * skipped; usable HTTP servers are returned with their per-server tool filter
 * and headers normalized.
 */
export function loadMcpConfig(options: LoadMcpConfigOptions = {}): McpConfig {
  const configPath = resolveConfigPath(options);
  const servers: McpServerConfig[] = [];
  if (!existsSync(configPath)) {
    return { servers, configPath };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    const mcpServers =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).mcpServers
        : undefined;
    if (mcpServers === null || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
      return { servers, configPath };
    }
    for (const [name, entry] of Object.entries(mcpServers)) {
      const server = validateServer(name, entry);
      if (server) servers.push(server);
    }
  } catch {
    // Malformed JSON or an unreadable file: treat as no servers, never throw.
  }
  return { servers, configPath };
}

/** Resolve the mcp.json path: explicit configPath (relative → cwd) or agent dir. */
function resolveConfigPath(options: LoadMcpConfigOptions): string {
  if (options.configPath) {
    return isAbsolute(options.configPath)
      ? options.configPath
      : resolve(options.cwd ?? process.cwd(), options.configPath);
  }
  return join(agentDir(), MCP_CONFIG_FILE);
}
