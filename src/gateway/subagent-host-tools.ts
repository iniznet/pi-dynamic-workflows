/**
 * SubagentHostToolsPolicy — the auto-start + default-toolset policy that makes
 * host coding/web tools reach subagents by default.
 *
 * Controlled by the `subagentHostTools` settings key ("auto" | "on" | "off",
 * default "auto"; design: tasks/subagent-tools-auto/design.md §3.2):
 *  - "auto" (default): the gateway starts lazily on the first run that needs
 *    host tools; untagged runs get merged coding + proxied host tools.
 *  - "on": same merged default; the extension eagerly starts the gateway at
 *    the first session_start (opt-in only — the default path stays side-effect
 *    free; deferred past load because pi's runtime only binds action methods
 *    after extension loading finishes).
 *  - "off": exact legacy behavior — nothing auto-starts; untagged runs get
 *    coding tools only; toolset "host-tools" is the only proxy path and needs
 *    a manual `/workflows-gateway start`.
 *
 * Safety invariants (P2-1 + #109): construction is side-effect free; start is
 * idempotent (guarded against concurrent runs sharing one in-flight start);
 * a start failure never throws out of the factories — run toolset resolution
 * happens before executeRun's try/catch, so a throw would strand the run — it
 * logs once and the affected run degrades to coding-only tools, self-healing
 * on the next run/resume.
 *
 * Internal module: imported only by extensions/workflow.ts. NOT re-exported
 * from src/index.ts, so the public entry contract is untouched.
 */

import {
  createCodingTools,
  createReadOnlyTools,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_EXCLUDED_SUBAGENT_TOOLS } from "../agent.js";
import { createWebTools } from "../web-tools.js";
import {
  createGatewayProxiedTools,
  type HostToolGateway,
  type HostToolsBundle,
  hostToolsFromDefinitions,
  type SessionManagerLike,
  type SessionManagerProvider,
} from "./host-tool-gateway.js";

/** Subagent host-tool access mode: "auto" (default) | "on" (eager) | "off" (legacy). */
export type HostToolsMode = "auto" | "on" | "off";

/**
 * Options for {@link buildMergedHostTools}.
 */
export interface MergedHostToolsOptions {
  /** Workspace the coding tools operate on. */
  cwd: string;
  /**
   * The host session manager captured at session_start (see
   * {@link SessionManagerLike}). Passed into the bridge execution context so
   * host-side bash calls (0.83.0 reads ctx.sessionManager.getSessionId()) work;
   * a provider form is resolved per tool call, so a bundle built before the
   * first session_start (eager "on" mode) adopts the real manager once it
   * exists — until then a stable fallback shim keeps bash working.
   */
  sessionManager?: SessionManagerLike | SessionManagerProvider;
  /**
   * Extra tool names to deny (wired from `settings.excludeSubagentTools`), on
   * top of the always-on `workflow`/`workflow_control` denial.
   */
  excludeSubagentTools?: string[];
}

/**
 * The newer host SDK surface that exposes every registered tool definition.
 * Intersection-cast only — never referenced statically, because it does NOT
 * exist in SDK 0.83.0's public types (verified against the published dist);
 * `tsc` against the pinned SDK must still compile. On a future SDK that has
 * it, this returns the union of core built-ins and every extension-registered
 * tool (MCP servers, third-party extensions); on 0.83.0 the optional method is
 * simply absent and the primary path below (public getAllTools metadata + SDK
 * tool factories) is what actually runs.
 */
type HostToolDefinitionApi = ExtensionAPI & { getAllToolDefinitions?: () => ToolDefinition[] };

/**
 * Extension-only builtin suite: the executable coding tools (read/bash/edit/
 * write) merged with the read-only builtins (grep/find/ls) via the PUBLIC SDK
 * factories. These execute in-process in the gateway with a minimal context,
 * exactly like createCodingTools already did — no SDK modification involved.
 * hostToolsFromDefinitions dedupes by name, so `read` keeps its coding def.
 */
function createExecutableBuiltins(cwd: string): ToolDefinition[] {
  return [...createCodingTools(cwd), ...createReadOnlyTools(cwd)];
}

/**
 * Whether a host tool name may be proxied to subagents. Always denies the
 * recursive-orchestration tools the extension itself registers (`workflow`,
 * `workflow_control` — {@link DEFAULT_EXCLUDED_SUBAGENT_TOOLS}, #107), plus any
 * names the user blocked via `settings.excludeSubagentTools`. Audit: this
 * extension registers no other host-only tools (task panel / UI / commands are
 * not tools), so the always-on deny set is exactly the subagent defaults.
 */
export function isExcludedHostTool(name: string, extraExcluded: string[] = []): boolean {
  return DEFAULT_EXCLUDED_SUBAGENT_TOOLS.includes(name) || extraExcluded.includes(name);
}

/**
 * Build the host bundle subagents can reach through the gateway, entirely from
 * the PUBLIC ExtensionAPI surface (extension-only — pi source is off-limits):
 *
 * 1. Executable builtin suite from public SDK factories (coding + read-only
 *    builtins), metadata-synced against the running host via the public
 *    `pi.getAllTools()` API (present on every SDK the extension compiles
 *    against): descriptions/promptGuidelines follow the live host, and a
 *    builtin is only advertised if the host actually registers it.
 * 2. Web tools (extension-defined, unchanged).
 * 3. Future path: full extension/MCP tool definitions via the feature-detected
 *    `getAllToolDefinitions()` — absent on 0.83.0, so it contributes nothing
 *    today; on a future SDK it merges extension-registered tools automatically.
 *
 * Extension-registered tools that are ONLY visible as metadata (sourceInfo
 * source ≠ builtin/sdk) cannot be executed by the gateway without their full
 * definitions, so they are never advertised — the gap is logged once per build
 * (documented capability limit of the public API, see AGENTS.md).
 */
export function buildMergedHostTools(pi: ExtensionAPI, options: MergedHostToolsOptions): HostToolsBundle {
  // Live host tool metadata (name/description/parameters/promptGuidelines/sourceInfo).
  // Feature-detected: an SDK without the public getAllTools() degrades to the
  // full executable builtin suite with no metadata sync.
  const live = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
  const liveByName = new Map(live.map((info) => [info.name, info]));

  const builtins = createExecutableBuiltins(options.cwd)
    .filter((def) => !isExcludedHostTool(def.name, options.excludeSubagentTools))
    // Advertise a builtin only when the host registers it (empty live list =
    // no metadata API — keep the whole suite rather than hiding everything).
    .filter((def) => liveByName.size === 0 || liveByName.has(def.name))
    .map((def) => {
      const info = liveByName.get(def.name);
      // Description sync only: hostToolsFromDefinitions advertises exactly
      // name/description/parameters, so promptGuidelines would be stripped
      // downstream anyway. Execution stays on our own SDK-factory def.
      return info ? { ...def, description: info.description } : def;
    });

  const registered = (pi as HostToolDefinitionApi).getAllToolDefinitions?.() ?? [];
  const extensionTools = registered.filter(
    (def) => typeof def.execute === "function" && !isExcludedHostTool(def.name, options.excludeSubagentTools),
  );

  const unproxyable = live.filter(
    (info) =>
      info.sourceInfo.source !== "builtin" &&
      info.sourceInfo.source !== "sdk" &&
      !isExcludedHostTool(info.name, options.excludeSubagentTools) &&
      !extensionTools.some((def) => def.name === info.name),
  );
  if (unproxyable.length > 0) {
    console.error(
      `[workflows] ${unproxyable.length} extension/MCP host tool(s) are not proxied to subagents ` +
        `(${unproxyable.map((info) => info.name).join(", ")}): the public ExtensionAPI exposes them as metadata ` +
        "only. Full-definition proxying needs the SDK's getAllToolDefinitions, which pi 0.83.0 does not provide.",
    );
  }

  return hostToolsFromDefinitions([...builtins, ...createWebTools(), ...extensionTools], options.sessionManager);
}

export interface SubagentHostToolsPolicyOptions {
  gateway: HostToolGateway;
  /** Resolved from settings at generation start; defaults to "auto". */
  mode: HostToolsMode;
  /**
   * Lazy host bundle (coding + web tools), built at start time, not at load —
   * mirrors the /workflows-gateway command's buildHostTools (design §3.2).
   */
  buildHostTools: () => HostToolsBundle;
  /** Subagent-facing coding tools, merged ahead of the proxied defs (design §3.2 defaultTools). */
  buildCodingTools: () => ToolDefinition[];
}

export class SubagentHostToolsPolicy {
  private readonly gateway: HostToolGateway;
  readonly mode: HostToolsMode;
  private readonly buildHostTools: () => HostToolsBundle;
  private readonly buildCodingTools: () => ToolDefinition[];
  /** Set after a failed auto-start; cleared when a later start succeeds. */
  private startFailed = false;
  /** The auto-start failure is logged only once per generation. */
  private startFailureLogged = false;
  /** In-flight start so concurrent runs share one socket bind instead of racing. */
  private starting?: Promise<void>;

  constructor(options: SubagentHostToolsPolicyOptions) {
    this.gateway = options.gateway;
    this.mode = options.mode;
    this.buildHostTools = options.buildHostTools;
    this.buildCodingTools = options.buildCodingTools;
  }

  /** Host tools reach subagents unless the user explicitly opted out ("off"). */
  isEnabled(): boolean {
    return this.mode !== "off";
  }

  /** Whether the last auto-start attempt failed (design §3.2 startFailed marker). */
  hasStartFailed(): boolean {
    return this.startFailed;
  }

  /**
   * Idempotent lazy start. Never throws: a failure is logged once and marked;
   * the affected run degrades to coding-only tools (see defaultTools). Because
   * resolution re-runs per start AND per resume, a transient failure (e.g.
   * EADDRINUSE, socket-path collision) self-heals on the next run.
   */
  async ensureStarted(): Promise<void> {
    if (this.mode === "off" || this.gateway.isRunning()) return;
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
  }

  private async doStart(): Promise<void> {
    try {
      await this.gateway.start(this.buildHostTools());
      this.startFailed = false;
      this.startFailureLogged = false;
    } catch (error) {
      this.startFailed = true;
      if (!this.startFailureLogged) {
        this.startFailureLogged = true;
        console.error(
          `[workflows] Host tool gateway auto-start failed: ${error instanceof Error ? error.message : String(error)}. ` +
            "This run's subagents get coding tools only; the next run will retry. " +
            "Set subagentHostTools=off (or PI_WORKFLOW_SUBAGENT_HOST_TOOLS=off) to restore opt-in-only behavior.",
        );
      }
    }
  }

  /**
   * Default toolset for untagged runs: coding tools merged with the proxied
   * host tools. After a failed start the gateway has no proxied defs yet, so
   * the merged list degrades to coding-only — loud at start time (logged),
   * never a silent empty list for a run that expected host tools.
   */
  async defaultTools(): Promise<ToolDefinition[]> {
    await this.ensureStarted();
    return [...this.buildCodingTools(), ...createGatewayProxiedTools(this.gateway)];
  }

  /**
   * Wrapper for the explicit "host-tools" toolset. Auto-starts first, fixing
   * the silent-empty opt-in a never-started gateway used to produce; in "off"
   * mode ensureStarted is a no-op, so a manual /workflows-gateway start remains
   * the only path (exact legacy behavior).
   */
  async hostToolsToolset(): Promise<ToolDefinition[]> {
    await this.ensureStarted();
    return createGatewayProxiedTools(this.gateway);
  }

  /**
   * Deterministic teardown hook for reload/shutdown (B5). A stop racing an
   * in-flight auto-start must await the shared start FIRST — otherwise the
   * start completes after the stop returns and leaves an orphaned bridge
   * bound to a live socket. Mirrors the gateway's own single-flight start:
   * await the policy's in-flight start, then stop whatever it produced.
   * Idempotent: no in-flight start and a stopped gateway → no-op.
   */
  async stop(): Promise<void> {
    if (this.starting) await this.starting;
    if (this.gateway.isRunning()) await this.gateway.stop();
  }
}
