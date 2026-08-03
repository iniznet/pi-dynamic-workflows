/**
 * SubagentHostToolsPolicy — the auto-start + default-toolset policy that makes
 * host coding/web tools reach subagents by default.
 *
 * Controlled by the `subagentHostTools` settings key ("auto" | "on" | "off",
 * default "auto"; design: tasks/subagent-tools-auto/design.md §3.2):
 *  - "auto" (default): the gateway starts lazily on the first run that needs
 *    host tools; untagged runs get merged coding + proxied host tools.
 *  - "on": same merged default; the extension eagerly starts the gateway at
 *    load (opt-in only — the default path stays side-effect free).
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

import { createCodingTools, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EXCLUDED_SUBAGENT_TOOLS } from "../agent.js";
import { createWebTools } from "../web-tools.js";
import {
  createGatewayProxiedTools,
  type HostToolGateway,
  type HostToolsBundle,
  hostToolsFromDefinitions,
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
   * Extra tool names to deny (wired from `settings.excludeSubagentTools`), on
   * top of the always-on `workflow`/`workflow_control` denial.
   */
  excludeSubagentTools?: string[];
}

/**
 * The newer host SDK surface that exposes every registered tool definition.
 * Intersection-cast only — never referenced statically, because it does NOT
 * exist in SDK 0.80.10's types (verified against its .d.ts); `tsc` against
 * 0.80.10 must still compile. On an SDK that has it, this returns the union of
 * core built-ins and every extension-registered tool (MCP servers, third-party
 * extensions); on older SDKs the optional method is simply absent.
 */
type HostToolDefinitionApi = ExtensionAPI & { getAllToolDefinitions?: () => ToolDefinition[] };

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
 * Build the host bundle subagents can reach through the gateway: the host
 * coding + web tools (unchanged baseline) merged with EVERY tool the host SDK
 * exposes via `getAllToolDefinitions()` (feature-detected), minus the
 * subagent-hostile exclusions. On an SDK without that method this degrades to
 * exactly the pre-upgrade bundle (the six core host tools), because
 * `hostToolsFromDefinitions` also dedupes by name — coding/web defs win on any
 * collision with same-named extension defs.
 */
export function buildMergedHostTools(pi: ExtensionAPI, options: MergedHostToolsOptions): HostToolsBundle {
  const registered = (pi as HostToolDefinitionApi).getAllToolDefinitions?.() ?? [];
  const extensionTools = registered.filter((def) => !isExcludedHostTool(def.name, options.excludeSubagentTools));
  return hostToolsFromDefinitions([...createCodingTools(options.cwd), ...createWebTools(), ...extensionTools]);
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
}
