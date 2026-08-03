/**
 * Host-captured extension tools for workflow subagents (design:
 * tasks/subagent-extension-tools/DESIGN.md).
 *
 * The public 0.83.0 ExtensionAPI exposes third-party extension tools as
 * metadata only (`getAllTools()` → ToolInfo without `execute`), so the
 * host-tool gateway cannot proxy them. But every pi extension entry is just
 * `(pi: ExtensionAPI) => void` calling `pi.registerTool(...)`: this module
 * runs an installed package's entry against a CAPTURE proxy that records the
 * real ToolDefinitions and no-ops everything else, then hands those defs to
 * the existing `hostToolsFromDefinitions` → gateway path. Subagents receive
 * thin proxied defs; the host process executes the real `execute` closures.
 *
 * Entries ship as TypeScript source (verified for both supported sources), so
 * capture transpiles them with jiti — the same mechanism pi's own extension
 * loader uses (jiti is a real dependency of this package). The target
 * packages' runtime imports resolve from their own install locations (the
 * agent npm root), which is why capture only works when the package is
 * actually installed there; a missing package degrades to `not-installed`.
 *
 * Scoped to opt-in, allowlisted sources only: supi-web (`web_fetch_md`,
 * `web_docs_search`, `web_docs_fetch`) and pi-codegraph (8 × `codegraph_*`).
 * Extensions whose executors are host-coupled to session state (rpiv-todo's
 * main-session todo store, pi-vcc's session-file search) are intentionally
 * NOT captured — their value is main-session state sharing, which the
 * gateway's per-call context cannot faithfully provide, and native subagent
 * loading is useless (subagents run with in-memory session managers).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti/static";

/** Opt-in sources this extension captures. Add a source here + wiring to extend. */
export type ExtensionToolSourceId = "supi-web" | "pi-codegraph";

/** How the `subagentExtensionTools` setting is shaped ("on" | allowlist). */
export type ExtensionToolsMode = "on" | ExtensionToolSourceId[];

/** A source's capture outcome (used by the listing command for truthful rows). */
export type CapturedSourceStatus = "captured" | "not-enabled" | "not-installed" | "unimportable" | "capture-failed";

/** Per-source capture result: defs (when captured) + a status + one-line error. */
export interface CapturedSourceResult {
  sourceId: ExtensionToolSourceId;
  label: string;
  defs: ToolDefinition[];
  status: CapturedSourceStatus;
  /** One-line, structural, non-sensitive diagnostic (never a stack trace). */
  error?: string;
}

/** Where the agent installs npm extensions (and where git checkouts live). */
export interface AgentRoots {
  /** `~/.pi/agent/npm/node_modules` — pi's npm extension install root. */
  npm: string;
}

/** One capturable extension package. */
export interface ExtensionToolSource {
  readonly id: ExtensionToolSourceId;
  readonly label: string;
  /** Exact tool names this source may contribute (defensive allowlist). */
  readonly expectedToolNames: readonly string[];
  /** Resolve the entry module to an importable specifier, or undefined when not installed. */
  resolveEntry(roots: AgentRoots): string | undefined;
  /** Import the entry module and return its default-export extension function. */
  loadEntry(specifier: string): Promise<(pi: ExtensionAPI) => void>;
}

/** Default agent install roots, derived from the home directory. Injectable for tests. */
export function defaultAgentRoots(env: Record<string, string | undefined> = process.env): AgentRoots {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return { npm: join(home, ".pi", "agent", "npm", "node_modules") };
}

const requireFromThisModule = createRequire(import.meta.url);

/**
 * Resolve a package's TS entry: first via this module's own resolution (a
 * checkout that sits in the same tree as the packages), then via the agent
 * npm root probe (the actual install location for pi npm extensions). Returns
 * a file URL or undefined when the package is not installed anywhere we can
 * reach — never throws.
 */
function resolvePackageEntry(
  roots: AgentRoots,
  packageName: string,
  entryRelative: string,
  subpath: string,
): string | undefined {
  try {
    const resolved = requireFromThisModule.resolve(subpath);
    return pathToFileURL(resolved).href;
  } catch {
    // Not in this module's tree — fall through to the agent-root probe.
  }
  const entryPath = join(roots.npm, packageName, entryRelative);
  if (!existsSync(entryPath)) return undefined;
  return pathToFileURL(entryPath).href;
}

// Lazily-created jiti instance (transpiles the TS entries at capture time).
let jitiTranspiler: ReturnType<typeof createJiti> | null = null;
function jiti(): ReturnType<typeof createJiti> {
  if (!jitiTranspiler) jitiTranspiler = createJiti(import.meta.url);
  return jitiTranspiler;
}

/** Transpile + import an entry module and return its default export. */
async function jitiImportDefault(specifier: string): Promise<unknown> {
  return jiti().import(specifier, { default: true });
}

/** The supported sources, in stable order (listing and allowlist share it). */
export const EXTENSION_TOOL_SOURCES: readonly ExtensionToolSource[] = [
  {
    id: "supi-web",
    label: "supi-web",
    expectedToolNames: ["web_fetch_md", "web_docs_search", "web_docs_fetch"],
    resolveEntry: (roots) =>
      resolvePackageEntry(roots, "@mrclrchtr/supi-web", "src/extension.ts", "@mrclrchtr/supi-web/extension"),
    loadEntry: async (specifier) => (await jitiImportDefault(specifier)) as (pi: ExtensionAPI) => void,
  },
  {
    id: "pi-codegraph",
    label: "pi-codegraph",
    expectedToolNames: [
      "codegraph_search",
      "codegraph_callers",
      "codegraph_callees",
      "codegraph_impact",
      "codegraph_explore",
      "codegraph_node",
      "codegraph_status",
      "codegraph_files",
    ],
    resolveEntry: (roots) =>
      resolvePackageEntry(roots, "@vndv/pi-codegraph", "extensions/codegraph.ts", "@vndv/pi-codegraph"),
    loadEntry: async (specifier) => (await jitiImportDefault(specifier)) as (pi: ExtensionAPI) => void,
  },
];

/** Type guard over the known source ids (env/file allowlist normalization). */
export function isKnownExtensionToolSourceId(id: string): id is ExtensionToolSourceId {
  return EXTENSION_TOOL_SOURCES.some((source) => source.id === id);
}

/** Every tool name any supported source may contribute (listing rows). */
export const EXPECTED_EXTENSION_TOOL_NAMES: ReadonlySet<string> = new Set(
  EXTENSION_TOOL_SOURCES.flatMap((source) => source.expectedToolNames),
);

/** Source id for a captured/expected tool name, or undefined. */
export function extensionSourceIdForTool(name: string): ExtensionToolSourceId | undefined {
  return EXTENSION_TOOL_SOURCES.find((source) => source.expectedToolNames.includes(name))?.id;
}

/**
 * Run an extension entry against a capture proxy. Only `registerTool` has an
 * effect (collecting, first-wins by name); every other ExtensionAPI member —
 * commands, shortcuts, hooks, UI, exec, state — is swallowed so capture never
 * touches host state. Unknown members return a benign no-op so a future SDK
 * surface cannot crash capture mid-entry.
 */
export function captureEntryTools(entry: (pi: ExtensionAPI) => void): ToolDefinition[] {
  const captured: ToolDefinition[] = [];
  const seen = new Set<string>();
  const noop = () => undefined;
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, prop) {
      switch (prop) {
        case "registerTool":
          return (tool: ToolDefinition) => {
            if (!tool || typeof tool.name !== "string" || seen.has(tool.name)) return;
            seen.add(tool.name);
            captured.push(tool);
          };
        case "getAllTools":
          return () => [];
        case "getActiveTools":
        case "getCommands":
        case "getFlag":
        case "getSessionName":
        case "getThinkingLevel":
          return () => undefined;
        case "setModel":
          return async () => false;
        case "setThinkingLevel":
        case "setActiveTools":
        case "setSessionName":
        case "setLabel":
        case "registerCommand":
        case "registerShortcut":
        case "registerFlag":
        case "registerMessageRenderer":
        case "registerEntryRenderer":
        case "appendEntry":
        case "exec":
        case "sendMessage":
        case "sendUserMessage":
          return noop;
        case "on":
          // Every event handler the entries register (session lifecycle,
          // before_agent_start guidance, tool rendering) is irrelevant to a
          // captured tool def — swallowing keeps capture side-effect free.
          return noop;
        default:
          return noop;
      }
    },
  });
  entry(api);
  return captured;
}

// Per-process capture cache: an enabled source is imported + captured once per
// extension lifetime; subsequent loads reuse the result (defs are stateless
// w.r.t. runs, so reusing them across workflows is safe).
const captureCache = new Map<ExtensionToolSourceId, Promise<CapturedSourceResult>>();

/** Capture one source (cached). Never throws — failures become a result. */
export function loadCapturedTools(
  source: ExtensionToolSource,
  roots: AgentRoots = defaultAgentRoots(),
): Promise<CapturedSourceResult> {
  let pending = captureCache.get(source.id);
  if (pending) return pending;
  pending = (async (): Promise<CapturedSourceResult> => {
    const specifier = source.resolveEntry(roots);
    if (!specifier) {
      return { sourceId: source.id, label: source.label, defs: [], status: "not-installed" };
    }
    let entry: (pi: ExtensionAPI) => void;
    try {
      entry = await source.loadEntry(specifier);
    } catch (error) {
      return {
        sourceId: source.id,
        label: source.label,
        defs: [],
        status: "unimportable",
        error: `could not load ${source.id} entry: ${oneLineError(error)}`,
      };
    }
    let defs: ToolDefinition[];
    try {
      defs = captureEntryTools(entry).filter((def) => source.expectedToolNames.includes(def.name));
    } catch (error) {
      return {
        sourceId: source.id,
        label: source.label,
        defs: [],
        status: "capture-failed",
        error: `capturing ${source.id} threw: ${oneLineError(error)}`,
      };
    }
    if (defs.length === 0) {
      return {
        sourceId: source.id,
        label: source.label,
        defs: [],
        status: "capture-failed",
        error: `${source.id} registered no tools matching ${source.expectedToolNames.join(", ")}`,
      };
    }
    return { sourceId: source.id, label: source.label, defs, status: "captured" };
  })();
  captureCache.set(source.id, pending);
  return pending;
}

/** Source ids enabled by a mode ("on" → every known source; else the allowlist). */
export function resolveEnabledSourceIds(mode: ExtensionToolsMode): ExtensionToolSourceId[] {
  return EXTENSION_TOOL_SOURCES.map((source) => source.id).filter((id) => mode === "on" || mode.includes(id));
}

/**
 * Per-source results for the listing command: every known source gets a row —
 * disabled sources report `not-enabled` (no import), enabled ones run the
 * cached capture. Never throws.
 */
export function getExtensionToolSourceResults(
  mode: ExtensionToolsMode | "off",
  roots: AgentRoots = defaultAgentRoots(),
): Promise<CapturedSourceResult[]> {
  const enabled = new Set(mode === "off" ? [] : resolveEnabledSourceIds(mode));
  return Promise.all(
    EXTENSION_TOOL_SOURCES.map((source) =>
      enabled.has(source.id)
        ? loadCapturedTools(source, roots)
        : Promise.resolve({
            sourceId: source.id,
            label: source.label,
            defs: [],
            status: "not-enabled",
          } as CapturedSourceResult),
    ),
  );
}

/**
 * The assembler's tool supplier: captured defs for the enabled sources, or
 * undefined when the setting is off (no defs anywhere — including the named
 * "extension-tools" toolset; mirrors the chrome supplier's gate).
 */
export function createExtensionToolsSupplier(
  mode: ExtensionToolsMode | "off",
): (() => Promise<ToolDefinition[]>) | undefined {
  if (mode === "off") return undefined;
  return async () => {
    const results = await getExtensionToolSourceResults(mode);
    return results.flatMap((result) => result.defs);
  };
}

/** Collapse an unknown failure to a single structural line (no stacks/secrets). */
function oneLineError(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? "unknown error";
  return String(error).split("\n")[0] ?? "unknown error";
}
