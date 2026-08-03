/**
 * `/workflows-subagent-tools` command: the effective subagent toolset, per
 * tool, with its source and allow status (design:
 * tasks/subagent-tools-all/DESIGN.md §listing command).
 *
 * The renderer is a pure function over a plain listing input — no pi imports,
 * no I/O — so the classification logic is fully unit-testable. The
 * registration glue gathers the live inputs (settings mode, the assembled
 * default toolset, the host's public getAllTools() metadata) and sends the
 * rendered markdown via pi.sendMessage.
 *
 * What the listing shows:
 *  - Tools actually in subagent sessions (assembled default toolset): source
 *    (builtin host / proxied host / web / MCP / extension) and status
 *    (allowed, or allowlisted when the subagentTools mode is an allowlist).
 *  - Host-registered tools NOT in the toolset: denied (always: workflow /
 *    workflow_control; settings: excludeSubagentTools) or unavailable — the
 *    chrome, UI, todo, vcc, and host mcp tools the public 0.83.0 ExtensionAPI
 *    only exposes as metadata (ToolInfo without execute). The SDK limitation
 *    stays visible instead of being hidden.
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EXCLUDED_SUBAGENT_TOOLS } from "./agent.js";
import type { HostToolsMode } from "./gateway/subagent-host-tools.js";
import type { WorkflowSettings } from "./workflow-settings.js";

/** "all" | exact mcp_* allowlist ([] = no MCP tools for subagents). */
export type SubagentToolsMode = "all" | string[];

/** Tool source classification shown in the listing. */
export type SubagentToolSource = "builtin" | "proxied-host" | "web" | "mcp" | "chrome" | "extension";

/** Tool allow status shown in the listing. */
export type SubagentToolStatus =
  | "allowed"
  | "allowlisted"
  | "denied-always"
  | "denied-settings"
  | "unavailable"
  | "available-if-enabled";

/** One rendered listing row. */
export interface SubagentToolRow {
  name: string;
  source: SubagentToolSource | undefined;
  status: SubagentToolStatus;
  note?: string;
}

/** Inputs the pure renderer consumes (gathered by the command handler). */
export interface SubagentToolsListingInput {
  /** Effective subagentTools mode ("all" default; [] = none). */
  mode: SubagentToolsMode;
  /** Effective subagentHostTools mode (for the header banner). */
  hostToolsMode: HostToolsMode;
  /** settings.excludeSubagentTools names (denied-settings rows). */
  excludeTools: string[];
  /** Names in the effective default subagent toolset. */
  assembledToolNames: string[];
  /** Live host tool metadata (pi.getAllTools(); may be empty pre-metadata). */
  hostToolInfos: ToolInfo[];
  /** Configured MCP server names (for the header's server list). */
  mcpServerNames: string[];
  /** Effective subagentChromeTools mode ("on" | "off"). */
  chromeToolsMode: "on" | "off";
  /** Whether the host currently holds the shared /chrome authorize grant. */
  chromeGranted: boolean;
}

/** The executable coding builtins (createCodingTools) — host-bundle sources. */
const BUILTIN_HOST_TOOLS = new Set(["read", "bash", "edit", "write"]);
/** The read-only builtins (createReadOnlyTools) — host-bundle sources. */
const BUILTIN_READONLY_TOOLS = new Set(["grep", "find", "ls"]);
/** Extension-defined web tools (createWebTools). */
const WEB_TOOLS = new Set(["web_search", "web_fetch"]);
/** Vendored chrome tools (createVendoredChromeTools) — pi-chrome's names. */
const CHROME_TOOLS = new Set([
  "chrome_launch",
  "chrome_tab",
  "chrome_snapshot",
  "chrome_find",
  "chrome_inspect",
  "chrome_navigate",
  "chrome_evaluate",
  "chrome_click",
  "chrome_type",
  "chrome_fill",
  "chrome_key",
  "chrome_wait_for",
  "chrome_list_console_messages",
  "chrome_list_network_requests",
  "chrome_get_network_request",
  "chrome_screenshot",
  "chrome_hover",
  "chrome_drag",
  "chrome_tap",
  "chrome_scroll",
  "chrome_upload_file",
]);
/** Names a builtin/sdk host tool can take (metadata source check). */
const HOST_SOURCE_NAMES = new Set([...BUILTIN_HOST_TOOLS, ...BUILTIN_READONLY_TOOLS, ...WEB_TOOLS]);

/** Classify an assembled tool's source by its name. */
export function classifyToolSource(name: string): SubagentToolSource {
  if (name.startsWith("mcp_")) return "mcp";
  if (CHROME_TOOLS.has(name)) return "chrome";
  if (WEB_TOOLS.has(name)) return "web";
  if (BUILTIN_HOST_TOOLS.has(name) || BUILTIN_READONLY_TOOLS.has(name)) return "builtin";
  return "extension";
}

/**
 * Build the listing rows: assembled tools first (source + allow status), then
 * host-registered tools that never reach subagent sessions (denied or
 * metadata-only-unavailable), sorted within each status group by name.
 */
export function buildSubagentToolRows(input: SubagentToolsListingInput): SubagentToolRow[] {
  const allowlist = input.mode === "all" ? undefined : new Set(input.mode);
  const assembled = new Set(input.assembledToolNames);

  const rows: SubagentToolRow[] = [];
  for (const name of input.assembledToolNames) {
    const isMcp = name.startsWith("mcp_");
    const isChrome = CHROME_TOOLS.has(name);
    rows.push({
      name,
      source: classifyToolSource(name),
      status: allowlist && isMcp ? "allowlisted" : "allowed",
      note:
        allowlist && isMcp
          ? "in the subagentTools allowlist"
          : isMcp
            ? "from mcp.json (subagentTools=all)"
            : isChrome
              ? "vendored chrome defs (subagentChromeTools=on)"
              : undefined,
    });
  }

  const seen = new Set(rows.map((row) => row.name));
  for (const info of input.hostToolInfos) {
    if (seen.has(info.name)) continue;
    if (DEFAULT_EXCLUDED_SUBAGENT_TOOLS.includes(info.name)) {
      rows.push({
        name: info.name,
        source: undefined,
        status: "denied-always",
        note: "never exposed to subagents (#107)",
      });
    } else if (input.excludeTools.includes(info.name)) {
      rows.push({
        name: info.name,
        source: undefined,
        status: "denied-settings",
        note: "settings.excludeSubagentTools",
      });
    } else if (HOST_SOURCE_NAMES.has(info.name) && !assembled.has(info.name)) {
      // A host builtin/web tool that is NOT in the assembled set: host tools
      // are off (subagentHostTools=off), so untagged runs cannot reach it.
      rows.push({
        name: info.name,
        source: classifyToolSource(info.name),
        status: "available-if-enabled",
        note: 'host tools off — reachable via /workflows-gateway start + toolset "host-tools"',
      });
    } else if (CHROME_TOOLS.has(info.name)) {
      // A pi-chrome host tool not in the assembled set: either the setting is
      // off or the shared grant is not held — both recoverable, no SDK gap.
      rows.push({
        name: info.name,
        source: "chrome",
        status: "available-if-enabled",
        note:
          input.chromeToolsMode === "off"
            ? "subagentChromeTools is off — set settings.subagentChromeTools=on to expose vendored chrome tools"
            : "no active /chrome authorize grant — chrome tools attach once the host session authorizes",
      });
    } else {
      rows.push({
        name: info.name,
        source: undefined,
        status: "unavailable",
        note: "metadata-only on the 0.83.0 ExtensionAPI (no getAllToolDefinitions) — not executable by this extension",
      });
    }
    seen.add(info.name);
  }

  const statusOrder: Record<SubagentToolStatus, number> = {
    allowed: 0,
    allowlisted: 1,
    "denied-always": 2,
    "denied-settings": 3,
    unavailable: 4,
    "available-if-enabled": 5,
  };
  return rows.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name));
}

/** Render the listing as markdown for pi.sendMessage. */
export function renderSubagentToolsListing(input: SubagentToolsListingInput): string {
  const modeLine =
    input.mode === "all"
      ? "**all** — every HTTP MCP server in mcp.json (`mcp_<server>_<tool>` tools)"
      : input.mode.length === 0
        ? "**none** — MCP tools disabled for subagents (empty allowlist)"
        : `**allowlist (${input.mode.length})** — \`${input.mode.join("`, `")}\``;
  const rows = buildSubagentToolRows(input);
  const inSession = rows.filter((row) => row.status === "allowed" || row.status === "allowlisted");
  const others = rows.filter((row) => row.status !== "allowed" && row.status !== "allowlisted");

  const lines: string[] = [];
  lines.push("### Effective subagent toolset (workflow subagents)");
  lines.push("");
  lines.push(`- MCP tools: ${modeLine}`);
  lines.push(
    `- Host tools: **${input.hostToolsMode}** (${input.hostToolsMode === "off" ? "legacy opt-in — untagged runs get coding tools only" : "merged coding + proxied host tools in untagged runs"})`,
  );
  lines.push(
    `- MCP servers configured: ${input.mcpServerNames.length > 0 ? input.mcpServerNames.join(", ") : "(none — add HTTP servers to ~/.pi/agent/mcp.json)"}`,
  );
  lines.push(
    `- Chrome tools: **${input.chromeToolsMode}** (${input.chromeToolsMode === "off" ? "vendored chrome defs hidden — set settings.subagentChromeTools=on to expose them" : input.chromeGranted ? "shared /chrome authorize grant active — chrome defs attach to runs" : "setting on but no /chrome authorize grant — chrome defs stay empty until the host authorizes"})`,
  );
  const alwaysDenied = DEFAULT_EXCLUDED_SUBAGENT_TOOLS.join(", ");
  const deniedSettings =
    input.excludeTools.length > 0 ? `; settings.excludeSubagentTools: ${input.excludeTools.join(", ")}` : "";
  lines.push(`- Always denied: ${alwaysDenied}${deniedSettings}`);
  lines.push("");
  lines.push(`#### In subagent sessions (${inSession.length})`);
  if (inSession.length === 0) {
    lines.push("");
    lines.push("_No tools. Untagged runs fall back to the agent's default coding tools._");
  } else {
    lines.push("");
    lines.push("| Tool | Source | Status |");
    lines.push("|---|---|---|");
    for (const row of inSession) {
      lines.push(`| \`${row.name}\` | ${row.source ?? "-"} | ${row.status}${row.note ? ` — ${row.note}` : ""} |`);
    }
  }
  if (others.length > 0) {
    lines.push("");
    lines.push(`#### Not in subagent sessions (${others.length})`);
    lines.push("");
    lines.push("| Tool | Status |");
    lines.push("|---|---|");
    for (const row of others) {
      lines.push(`| \`${row.name}\` | ${row.status}${row.note ? ` — ${row.note}` : ""} |`);
    }
  }
  return lines.join("\n");
}

export interface WorkflowSubagentToolsCommandOptions {
  /** Resolves the effective (env-overridden) settings — extension passes loadSettings. */
  loadSettings: () => WorkflowSettings;
  /** Live host tool metadata — extension passes () => pi.getAllTools(). */
  getHostToolInfos: () => ToolInfo[];
  /** The effective default subagent toolset — extension passes the assembler. */
  assembleDefaultTools: () => Promise<ToolDefinition[]>;
  /** Configured MCP server names — extension passes mcpToolsManager.serverNames(). */
  listMcpServers: () => string[];
  /** Shared-grant check — extension passes isChromeAuthorized. */
  getChromeGranted: () => boolean;
}

/**
 * Register `/workflows-subagent-tools`. Idempotent, like the other command
 * registrations: a host that already knows the name is left untouched.
 */
export function registerWorkflowSubagentToolsCommand(
  pi: ExtensionAPI,
  options: WorkflowSubagentToolsCommandOptions,
): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === COMMAND_NAME);
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const settings = options.loadSettings();
      const [assembled, infos] = await Promise.all([
        options.assembleDefaultTools().catch(() => [] as ToolDefinition[]),
        Promise.resolve(options.getHostToolInfos()),
      ]);
      const listing = renderSubagentToolsListing({
        mode: settings.subagentTools ?? "all",
        hostToolsMode: settings.subagentHostTools ?? "auto",
        excludeTools: settings.excludeSubagentTools ?? [],
        assembledToolNames: assembled.map((tool) => tool.name),
        hostToolInfos: infos,
        mcpServerNames: options.listMcpServers(),
        chromeToolsMode: settings.subagentChromeTools ?? "off",
        chromeGranted: options.getChromeGranted(),
      });
      // fallback: a host without sendMessage still surfaces the rows via the
      // notify channel; ctx.cwd keeps the listing project-scoped.
      if (typeof pi.sendMessage === "function") {
        pi.sendMessage({ customType: "workflows-subagent-tools", content: listing, display: true });
      } else {
        ctx.ui?.notify?.(listing, "info");
      }
    },
  });
}

const COMMAND_NAME = "workflows-subagent-tools";

const COMMAND_DESCRIPTION =
  "Show the effective workflow subagent toolset: per-tool source and allow status, MCP servers, and host tools that cannot reach subagents on the 0.83.0 ExtensionAPI";
