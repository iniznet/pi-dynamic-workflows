/**
 * SubagentToolsAssembler — merges the host tool bundle with MCP-backed tools
 * per the `subagentTools` settings key ("all" | allowlist; design:
 * tasks/subagent-tools-all/DESIGN.md).
 *
 * Ownership split:
 *  - The host bundle (coding + proxied host + web tools) is owned by
 *    {@link SubagentHostToolsPolicy} — its `defaultTools()` output is the
 *    unchanged baseline for untagged runs.
 *  - MCP tools (the user's HTTP mcp.json servers, surfaced as `mcp_<server>_<tool>`
 *    defs by {@link McpToolsManager}) are the new addition, controlled here:
 *    "all" appends every reachable server's tools; a string[] appends only the
 *    exact `mcp_*` names listed; [] appends nothing.
 *  - Vendored chrome tools (pi-chrome's `chrome_*` set re-created for
 *    subagents, design: tasks/subagent-chrome-tools/DESIGN.md) are appended
 *    after MCP tools when a supplier is provided; they respect the host's
 *    shared `/chrome authorize` grant (the supplier decides at call time).
 *
 * Safety invariants (mirror the host policy): construction is side-effect free;
 * nothing touches the network until the first assemble()/mcpToolsOnly(); MCP
 * server failures degrade gracefully inside McpToolsManager (warned once,
 * skipped) and never throw out of the factories — subagent toolset resolution
 * happens before executeRun's error handling, so a throw would strand the run.
 *
 * Internal module: imported only by extensions/workflow.ts (and tests). NOT
 * re-exported from src/index.ts, so the public entry contract is untouched.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isExcludedHostTool } from "../gateway/subagent-host-tools.js";
import type { McpToolsManager } from "./mcp-tools.js";

/** Effective subagentTools mode: "all" | exact mcp_* allowlist ([] = none). */
export type SubagentToolsMode = "all" | string[];

/** Options for {@link SubagentToolsAssembler}. */
export interface SubagentToolsAssemblerOptions {
  /** The effective subagentTools mode, resolved from settings ("all" default). */
  mode: SubagentToolsMode;
  /**
   * The merged host bundle factory (hostToolsPolicy.defaultTools()): coding
   * tools + proxied host tools + web tools. Resolved lazily per assemble().
   */
  hostTools: () => Promise<ToolDefinition[]> | ToolDefinition[];
  /** The extension-owned MCP tools manager (shared, so its TTL cache is reused). */
  mcpTools: McpToolsManager;
  /**
   * Vendored chrome tool defs (subagent-chrome-tools). Resolved lazily per
   * assemble() so the supplier can re-check the shared chrome auth grant.
   */
  chromeTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  /** Extra tool names to deny (wired from settings.excludeSubagentTools). */
  excludeTools?: string[];
}

/**
 * Filter MCP-backed definitions down to the always-allowed set: never the
 * recursive-orchestration defaults (workflow/workflow_control — defensive,
 * mcp_* names cannot collide with them today) and never a user-denied name.
 */
function filterMcpTools(defs: ToolDefinition[], mode: SubagentToolsMode, excludeTools: string[]): ToolDefinition[] {
  const allowlist = mode === "all" ? undefined : new Set(mode);
  return defs.filter(
    (def) => (allowlist === undefined || allowlist.has(def.name)) && !isExcludedHostTool(def.name, excludeTools),
  );
}

/**
 * Vendored chrome defs minus the always-denied/excluded names. The auth gate
 * is the supplier's job; this only strips user-denied tool names.
 */
function filterChromeTools(defs: ToolDefinition[], excludeTools: string[]): ToolDefinition[] {
  return defs.filter((def) => !isExcludedHostTool(def.name, excludeTools));
}

export class SubagentToolsAssembler {
  private readonly mode: SubagentToolsMode;
  private readonly hostTools: () => Promise<ToolDefinition[]> | ToolDefinition[];
  private readonly mcpTools: McpToolsManager;
  private readonly chromeTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  private readonly excludeTools: string[];

  constructor(options: SubagentToolsAssemblerOptions) {
    this.mode = options.mode;
    this.hostTools = options.hostTools;
    this.mcpTools = options.mcpTools;
    this.chromeTools = options.chromeTools;
    this.excludeTools = options.excludeTools ?? [];
  }

  /**
   * The merged default toolset for untagged runs: host bundle + MCP tools
   * (mode-filtered) + vendored chrome tools (auth-gated by the supplier).
   * Never throws — MCP failures degrade to host-only tools.
   */
  async assemble(): Promise<ToolDefinition[]> {
    const [host, mcp, chrome] = await Promise.all([
      this.hostTools(),
      this.mcpTools.listSubagentTools(),
      this.chromeTools?.() ?? [],
    ]);
    return [
      ...host,
      ...filterMcpTools(mcp, this.mode, this.excludeTools),
      ...filterChromeTools(chrome, this.excludeTools),
    ];
  }

  /**
   * MCP tools only (the "mcp-tools" named toolset): every mode-eligible MCP
   * def without the host bundle. Gives scripts an explicit opt-in path even
   * when host tools are "off" (defaultTools is then undefined).
   */
  async mcpToolsOnly(): Promise<ToolDefinition[]> {
    const mcp = await this.mcpTools.listSubagentTools();
    return filterMcpTools(mcp, this.mode, this.excludeTools);
  }

  /**
   * Vendored chrome tools only (the "chrome-tools" named toolset). Resolved
   * per call so it reflects the CURRENT grant — a revoked grant yields an
   * empty list (mirrors pi-chrome only registering chrome tools when
   * authorized).
   */
  async chromeToolsOnly(): Promise<ToolDefinition[]> {
    const chrome = (await this.chromeTools?.()) ?? [];
    return filterChromeTools(chrome, this.excludeTools);
  }
}
