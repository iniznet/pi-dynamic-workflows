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
 *    subagents, design: tasks/subagent-chrome-tools/DESIGN.md) are NOT part
 *    of the default merge (T1-09): they attach per-task ONLY via the explicit
 *    "chrome-tools" named toolset ({@link chromeToolsOnly}), so untagged runs
 *    never pay the ~5.5 ktok/turn chrome defs. The supplier still respects the
 *    host's shared `/chrome authorize` grant (it decides at call time).
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
import { createAssemblerSubagentToolDiscovery, type SubagentToolDiscovery } from "../discovery.js";
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
   * chromeToolsOnly() so the supplier can re-check the shared chrome auth
   * grant. Consumed ONLY by the "chrome-tools" named toolset — T1-09 keeps
   * chrome defs out of the default assemble() merge (per-task opt-in).
   */
  chromeTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  /**
   * Host-captured extension tool defs (subagent-extension-tools). Resolved
   * lazily per assemble(); the supplier is undefined when the setting is off
   * (no defs anywhere, mirroring the chrome gate).
   */
  extensionTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  /**
   * Damage-control tool defs (damage-control-recovery DESIGN.md §6): the
   * `workflow_damage_control` def, closed over the live WorkflowManager.
   * Resolved lazily per assemble(); the supplier is undefined when the
   * setting is off (no defs anywhere, mirroring the chrome/extension gates).
   * A dedicated slot instead of the extension-tools capture pipeline because
   * capture binds static entry defs — damage control must act on the CURRENT
   * ACTIVE run, so its def needs the live manager.
   */
  damageControlTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
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

/** Captured extension defs minus the always-denied/excluded names. */
function filterExtensionTools(defs: ToolDefinition[], excludeTools: string[]): ToolDefinition[] {
  return defs.filter((def) => !isExcludedHostTool(def.name, excludeTools));
}

/**
 * Damage-control defs minus the always-denied/excluded names. The supplier is
 * the setting gate (off → undefined → no defs); this only strips user-denied
 * tool names, so `excludeSubagentTools` can always veto workflow_damage_control.
 */
function filterDamageControlTools(defs: ToolDefinition[], excludeTools: string[]): ToolDefinition[] {
  return defs.filter((def) => !isExcludedHostTool(def.name, excludeTools));
}

export class SubagentToolsAssembler {
  private readonly mode: SubagentToolsMode;
  private readonly hostTools: () => Promise<ToolDefinition[]> | ToolDefinition[];
  private readonly mcpTools: McpToolsManager;
  private readonly chromeTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  private readonly extensionTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  private readonly damageControlTools?: () => ToolDefinition[] | Promise<ToolDefinition[]>;
  private readonly excludeTools: string[];

  constructor(options: SubagentToolsAssemblerOptions) {
    this.mode = options.mode;
    this.hostTools = options.hostTools;
    this.mcpTools = options.mcpTools;
    this.chromeTools = options.chromeTools;
    this.extensionTools = options.extensionTools;
    this.damageControlTools = options.damageControlTools;
    this.excludeTools = options.excludeTools ?? [];
  }

  /**
   * The merged default toolset for untagged runs: host bundle + MCP tools
   * (mode-filtered) + captured extension tools (setting-gated by the supplier)
   * + damage-control tools (setting-gated by the supplier). Chrome defs are
   * deliberately ABSENT (T1-09): they attach per-task via chromeToolsOnly()
   * (the "chrome-tools" toolset), so a task that never drives the browser
   * does not pay the ~5.5 ktok/turn chrome defs. Never throws — MCP failures
   * degrade to host-only tools, and suppliers are expected to swallow their
   * own failures (the damage-control supplier yields [] on a missing module).
   */
  async assemble(): Promise<ToolDefinition[]> {
    const [host, mcp, extension, damageControl] = await Promise.all([
      this.hostTools(),
      this.mcpTools.listSubagentTools(),
      this.extensionTools?.() ?? [],
      this.damageControlTools?.() ?? [],
    ]);
    const merged = [
      ...host,
      ...filterMcpTools(mcp, this.mode, this.excludeTools),
      ...filterExtensionTools(extension, this.excludeTools),
      ...filterDamageControlTools(damageControl, this.excludeTools),
    ];
    // First-wins dedupe by name across every source (defensive: no collision
    // among current sources, but a future supplier could overlap).
    const seen = new Set<string>();
    const unique: ToolDefinition[] = [];
    for (const def of merged) {
      if (!seen.has(def.name)) {
        seen.add(def.name);
        unique.push(def);
      }
    }
    return unique;
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
   * Vendored chrome tools only (the "chrome-tools" named toolset — the ONLY
   * channel chrome defs attach through since T1-09). Resolved per call so it
   * reflects the CURRENT grant — a revoked grant yields an empty list (mirrors
   * pi-chrome only registering chrome tools when authorized).
   */
  async chromeToolsOnly(): Promise<ToolDefinition[]> {
    const chrome = (await this.chromeTools?.()) ?? [];
    return filterChromeTools(chrome, this.excludeTools);
  }

  /**
   * Captured extension tools only (the "extension-tools" named toolset).
   * Resolved per call so it reflects the CURRENT setting gate — with the
   * supplier undefined (setting off) this resolves to [] (script intent
   * recorded, no tools).
   */
  async extensionToolsOnly(): Promise<ToolDefinition[]> {
    const extension = (await this.extensionTools?.()) ?? [];
    return filterExtensionTools(extension, this.excludeTools);
  }

  /**
   * Damage-control tools only (the "damage-control-tools" named toolset).
   * Resolved per call so it reflects the CURRENT setting gate — with the
   * supplier undefined (setting off) this resolves to [] (script intent
   * recorded, no tools).
   */
  async damageControlToolsOnly(): Promise<ToolDefinition[]> {
    const damageControl = (await this.damageControlTools?.()) ?? [];
    return filterDamageControlTools(damageControl, this.excludeTools);
  }

  /**
   * P11: capability discovery + runtime routing over the assembler's registries.
   * EXTENDS the named-toolset mechanism — the same suppliers the
   * mcpToolsOnly()/chromeToolsOnly()/extensionToolsOnly()/damageControlToolsOnly()
   * surfaces resolve become ONE queryable registry: scripts search/describe/
   * select tools by capability at runtime (e.g. a newly added MCP server, a
   * newly installed research extension) and hand agents tools not known at
   * author time via `agent({ toolNames })`. Lazy: nothing resolves until a
   * discovery method is called; MCP mode/exclude filtering matches the named
   * toolsets exactly, so what select() reports as resolvable is what the
   * assembler can actually merge. Never throws (per-source degradation yields
   * [] like the other suppliers).
   */
  createDiscovery(): SubagentToolDiscovery {
    return createAssemblerSubagentToolDiscovery({
      hostTools: () => this.hostTools(),
      mcpTools: () => this.mcpTools.listSubagentTools(),
      mcpMode: this.mode,
      ...(this.extensionTools ? { extensionTools: () => this.extensionTools?.() ?? [] } : {}),
      ...(this.chromeTools ? { chromeTools: () => this.chromeTools?.() ?? [] } : {}),
      ...(this.damageControlTools ? { damageControlTools: () => this.damageControlTools?.() ?? [] } : {}),
      excludeTools: this.excludeTools,
    });
  }
}
