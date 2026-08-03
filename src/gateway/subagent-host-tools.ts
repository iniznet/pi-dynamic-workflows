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

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGatewayProxiedTools, type HostToolGateway, type HostToolsBundle } from "./host-tool-gateway.js";

/** Subagent host-tool access mode: "auto" (default) | "on" (eager) | "off" (legacy). */
export type HostToolsMode = "auto" | "on" | "off";

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
