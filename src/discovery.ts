/**
 * SubagentToolDiscovery — script-facing capability discovery + runtime routing
 * over the ALREADY-CAPTURED subagent tool registry (design:
 * tasks/a-p04-p11-toolsets/design.md, P11).
 *
 * The public 0.83.0 ExtensionAPI exposes third-party tools as metadata only
 * (getAllTools() → ToolInfo without execute), so capability discovery CANNOT
 * read the host surface that way. This module queries the same registries the
 * SubagentToolsAssembler's named toolsets resolve from (host bundle, MCP
 * servers, captured extension sources, vendored chrome, damage control) — a
 * workflow script can search/describe/select tools by capability at runtime
 * and hand agents tools that did not exist when the script was authored
 * (e.g. a newly added MCP server, a newly installed research extension).
 *
 * Deliberately differentiated from the human-facing `/workflows-subagent-tools`
 * listing: that is operator inspection; this is script routing.
 *
 * Determinism: search/describe/select are pure functions of the materialized
 * defs + the run's resolved tool names. Materialization is lazy + cached per
 * instance (a supplier's defs are resolved once), so within one run the
 * surface is stable; across runs the registry may legitimately change (that is
 * the adaptation P11 exists for). No wall-clock or RNG anywhere.
 *
 * Internal module: imported by the assembler, workflow runtime, and tests;
 * NOT re-exported from src/index.ts (the entry contract stays untouched).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentToolsMode } from "./subagent/subagent-tools-assembler.js";

/** Where a discovered def comes from — the assembler's named-toolset surfaces. */
type SubagentToolSourceId = "host" | "mcp" | "extension" | "chrome" | "damage-control";

/** One source's defs; a function defers resolution until first use (lazy + cached). */
export interface SubagentToolRegistrySource {
  source: SubagentToolSourceId;
  tools: ToolDefinition[] | (() => ToolDefinition[] | Promise<ToolDefinition[]>);
}

/** One discoverable tool. `resolvable` = the current run's toolset can hand it to an agent. */
interface SubagentToolDescriptor {
  name: string;
  description: string;
  source: SubagentToolSourceId;
  /** Primary capability tag (see classifyToolCapability). */
  capability: string;
  /** Secondary tags the tool also answers to (e.g. research tools tag "research"). */
  tags: readonly string[];
  /** False when the tool exists in the registry but the run's resolved toolset excludes it. */
  resolvable: boolean;
}

/** Result of {@link SubagentToolDiscovery.select} — the route a script hands to agent({ toolNames }). */
interface SubagentToolSelection {
  capability: string;
  /**
   * Tool names the CURRENT run can actually resolve — safe to pass straight
   * into `agent(prompt, { toolNames })` (an allowlist never silently drops a
   * name that is not in the run's resolved toolset).
   */
  toolNames: readonly string[];
  /** Registry tools of this capability the run CANNOT resolve (would need another toolset/setting). */
  missing: readonly string[];
  /**
   * Named-toolset hint when the whole capability maps to ONE source
   * ("extension-tools" / "chrome-tools" / "mcp-tools" /
   * "damage-control-tools"); undefined when the capability spans sources.
   */
  toolset?: string;
}

/** Options for {@link SubagentToolDiscovery}. */
interface SubagentToolDiscoveryOptions {
  /** Extra tool names to deny (mirrors settings.excludeSubagentTools). */
  excludeTools?: string[];
  /**
   * Tool names the current run's resolved toolset can hand to agents. When
   * absent, every registry tool counts as resolvable. Derived from the run's
   * resolved defs (workflow.ts binds it at runtime).
   */
  resolvableNames?: Iterable<string>;
}

/** A def plus its resolved source label, in registry order. */
interface ResolvedEntry {
  def: ToolDefinition;
  source: SubagentToolSourceId;
}

/**
 * Deterministic capability classification for a tool def. Prefix/exact-name
 * rules first (the capture registry's known surface), then a description
 * keyword fallback so a future MCP server or extension tool still classifies.
 * Pure string logic — no randomness, no wall clock, stable across resume.
 */
export function classifyToolCapability(name: string, description: string): { capability: string; tags: string[] } {
  if (name.startsWith("mcp_")) return { capability: "mcp", tags: [] };
  if (name.startsWith("chrome_")) return { capability: "browser", tags: ["automation"] };
  if (name.startsWith("codegraph_")) return { capability: "codebase", tags: ["research"] };
  if (name === "describe_image") return { capability: "vision", tags: ["research"] };
  if (name === "workflow_damage_control") return { capability: "damage-control", tags: [] };
  if (name === "store_put" || name === "store_get") return { capability: "store", tags: [] };
  if (name === "structured_output") return { capability: "output", tags: [] };
  switch (name) {
    case "web_search":
    case "web_fetch":
    case "web_fetch_md":
    case "web_docs_search":
    case "web_docs_fetch":
      return { capability: "web", tags: ["research"] };
    case "read":
    case "grep":
    case "find":
    case "ls":
      return { capability: "files", tags: ["coding"] };
    case "bash":
      return { capability: "automation", tags: ["coding"] };
    case "edit":
    case "write":
      return { capability: "editing", tags: ["coding"] };
    default:
      break;
  }
  // Description keyword fallback (deterministic, case-insensitive substring).
  const text = description.toLowerCase();
  if (/\b(web|search|fetch|docs?)\b/.test(text)) return { capability: "web", tags: ["research"] };
  if (/\b(image|vision|screenshot|describe)\b/.test(text)) return { capability: "vision", tags: ["research"] };
  if (/code ?graph|callers|callees|impact|codebase/.test(text)) return { capability: "codebase", tags: ["research"] };
  if (/\b(browser|chrome|tab|page|snapshot)\b/.test(text)) return { capability: "browser", tags: ["automation"] };
  if (/\b(shell|terminal|command|execute)\b/.test(text)) return { capability: "automation", tags: ["coding"] };
  if (/\b(file|read|grep|search)\b/.test(text)) return { capability: "files", tags: ["coding"] };
  return { capability: "coding", tags: [] };
}

/** Match a query string against a descriptor: capability name, then name/description substring. */
function matchesQuery(entry: ResolvedEntry, query: string): boolean {
  const { capability, tags } = classifyToolCapability(entry.def.name, entry.def.description ?? "");
  const name = entry.def.name.toLowerCase();
  const description = (entry.def.description ?? "").toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (capability === needle || tags.includes(needle)) return true;
  return name.includes(needle) || description.includes(needle);
}

/**
 * Search/describe/select over a materializable tool registry. Lazy + cached:
 * async suppliers are resolved once per instance on first use, so repeated
 * calls inside one run see a stable surface and a script that never calls it
 * pays nothing. `withResolvable()` returns a NEW instance (same sources) with
 * the run's resolved names — construction never mutates.
 */
export class SubagentToolDiscovery {
  private readonly sources: readonly SubagentToolRegistrySource[];
  private readonly excludeTools: readonly string[];
  private readonly resolvableNames?: ReadonlySet<string>;
  private materialized: ResolvedEntry[] | null = null;

  constructor(sources: readonly SubagentToolRegistrySource[], options: SubagentToolDiscoveryOptions = {}) {
    this.sources = sources;
    this.excludeTools = options.excludeTools ?? [];
    this.resolvableNames = options.resolvableNames ? new Set(options.resolvableNames) : undefined;
  }

  /** A copy of this discovery whose resolvable set is the run's resolved tool names. */
  withResolvable(names: Iterable<string> | undefined): SubagentToolDiscovery {
    return new SubagentToolDiscovery(this.sources, {
      excludeTools: [...this.excludeTools],
      ...(names === undefined ? {} : { resolvableNames: names }),
    });
  }

  /** Resolve every supplier once; cached per instance. Never throws ([] on failure). */
  private async registry(): Promise<ResolvedEntry[]> {
    if (this.materialized) return this.materialized;
    const exclude = new Set(this.excludeTools);
    const entries: ResolvedEntry[] = [];
    const seen = new Set<string>();
    for (const source of this.sources) {
      let defs: ToolDefinition[];
      try {
        defs = typeof source.tools === "function" ? await source.tools() : source.tools;
      } catch {
        defs = [];
      }
      for (const def of defs) {
        if (!def || typeof def.name !== "string" || exclude.has(def.name) || seen.has(def.name)) continue;
        seen.add(def.name);
        entries.push({ def, source: source.source });
      }
    }
    this.materialized = entries;
    return entries;
  }

  private descriptor(entry: ResolvedEntry): SubagentToolDescriptor {
    const { capability, tags } = classifyToolCapability(entry.def.name, entry.def.description ?? "");
    return {
      name: entry.def.name,
      description: entry.def.description ?? "",
      source: entry.source,
      capability,
      tags,
      resolvable: this.resolvableNames === undefined || this.resolvableNames.has(entry.def.name),
    };
  }

  /**
   * Search the registry. No query → every tool. A string query matches the
   * capability vocabulary first ("web", "codebase", "vision", "browser",
   * "mcp", "damage-control", "coding", "files", "editing", "automation",
   * "store", "output", "research"), else a case-insensitive substring on
   * name + description. An object query filters by capability/source/name.
   */
  async search(
    query?: string | { capability?: string; source?: SubagentToolSourceId; name?: string },
  ): Promise<SubagentToolDescriptor[]> {
    const entries = await this.registry();
    if (typeof query === "string") {
      return entries.filter((entry) => matchesQuery(entry, query)).map((entry) => this.descriptor(entry));
    }
    const filters = query ?? {};
    return entries
      .filter((entry) => {
        if (filters.capability !== undefined) {
          const { capability, tags } = classifyToolCapability(entry.def.name, entry.def.description ?? "");
          if (capability !== filters.capability && !tags.includes(filters.capability)) return false;
        }
        if (filters.source !== undefined && entry.source !== filters.source) return false;
        if (filters.name !== undefined && !matchesQuery(entry, filters.name)) return false;
        return true;
      })
      .map((entry) => this.descriptor(entry));
  }

  /** Describe one tool by exact name, or null when it is not in the registry. */
  async describe(name: string): Promise<SubagentToolDescriptor | null> {
    const entries = await this.registry();
    const entry = entries.find((candidate) => candidate.def.name === name);
    return entry ? this.descriptor(entry) : null;
  }

  /**
   * Route a capability to the tool names a script can hand this run's agents:
   * `const { toolNames } = await subagentTools.select("web")` →
   * `agent(prompt, { toolNames })`. `missing` names need another toolset or
   * setting; `toolset` hints the named toolset when the whole capability maps
   * to one source.
   */
  async select(capability: string): Promise<SubagentToolSelection> {
    const entries = await this.registry();
    const selected = entries.filter((entry) => {
      const classified = classifyToolCapability(entry.def.name, entry.def.description ?? "");
      return classified.capability === capability || classified.tags.includes(capability);
    });
    const toolNames: string[] = [];
    const missing: string[] = [];
    const sources = new Set<SubagentToolSourceId>();
    for (const entry of selected) {
      sources.add(entry.source);
      if (this.resolvableNames === undefined || this.resolvableNames.has(entry.def.name))
        toolNames.push(entry.def.name);
      else missing.push(entry.def.name);
    }
    return {
      capability,
      toolNames,
      missing,
      ...(sources.size === 1 ? { toolset: namedToolsetForSource([...sources][0]) } : {}),
    };
  }

  /** The known capability vocabulary with per-capability counts + example names. */
  async capabilities(): Promise<Array<{ capability: string; count: number; tools: readonly string[] }>> {
    const entries = await this.registry();
    const byCapability = new Map<string, string[]>();
    for (const entry of entries) {
      const { capability } = classifyToolCapability(entry.def.name, entry.def.description ?? "");
      const bucket = byCapability.get(capability) ?? [];
      bucket.push(entry.def.name);
      byCapability.set(capability, bucket);
    }
    return [...byCapability.entries()]
      .map(([capability, tools]) => ({ capability, count: tools.length, tools }))
      .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0));
  }
}

/** Named-toolset tag for a source that has one (the assembler's named surfaces). */
function namedToolsetForSource(source: SubagentToolSourceId): string | undefined {
  switch (source) {
    case "mcp":
      return "mcp-tools";
    case "chrome":
      return "chrome-tools";
    case "extension":
      return "extension-tools";
    case "damage-control":
      return "damage-control-tools";
    default:
      return undefined;
  }
}

/** The MCP allowlist filter the assembler applies to its own defs. */
function filterByMode(defs: ToolDefinition[], mode: SubagentToolsMode): ToolDefinition[] {
  if (mode === "all") return defs;
  const allowlist = new Set(mode);
  return defs.filter((def) => allowlist.has(def.name));
}

/**
 * Build a discovery from defs (host/runtime bundles) or another discovery
 * (assembler path). The single entry point the workflow runtime uses:
 * `createSubagentToolDiscovery(options.subagentToolDiscovery ?? options.tools)`.
 */
export function createSubagentToolDiscovery(
  input: SubagentToolDiscovery | readonly ToolDefinition[],
  options: SubagentToolDiscoveryOptions = {},
): SubagentToolDiscovery {
  if (input instanceof SubagentToolDiscovery) return input;
  return new SubagentToolDiscovery([{ source: "host", tools: [...input] }], options);
}

/**
 * Build a discovery over the assembler's registries (P11 — the named-toolset
 * mechanism extended into one queryable surface). Mode/exclude filtering is
 * applied exactly like the named toolsets apply it, so what select() reports
 * as resolvable matches what the assembler can actually merge.
 */
export function createAssemblerSubagentToolDiscovery(options: {
  hostTools: () => Promise<ToolDefinition[]> | ToolDefinition[];
  mcpTools: () => Promise<ToolDefinition[]> | ToolDefinition[];
  mcpMode: SubagentToolsMode;
  extensionTools?: () => Promise<ToolDefinition[]> | ToolDefinition[];
  chromeTools?: () => Promise<ToolDefinition[]> | ToolDefinition[];
  damageControlTools?: () => Promise<ToolDefinition[]> | ToolDefinition[];
  excludeTools?: string[];
}): SubagentToolDiscovery {
  const sources: SubagentToolRegistrySource[] = [
    { source: "host", tools: options.hostTools },
    {
      source: "mcp",
      tools: async () => filterByMode(await options.mcpTools(), options.mcpMode),
    },
    ...(options.extensionTools ? [{ source: "extension" as const, tools: options.extensionTools }] : []),
    ...(options.chromeTools ? [{ source: "chrome" as const, tools: options.chromeTools }] : []),
    ...(options.damageControlTools ? [{ source: "damage-control" as const, tools: options.damageControlTools }] : []),
  ];
  return new SubagentToolDiscovery(sources, { excludeTools: options.excludeTools });
}
