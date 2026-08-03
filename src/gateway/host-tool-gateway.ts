/**
 * HostToolGateway — lazy host-side IPC gateway for the Universal Host Tool Gateway.
 *
 * P2-1 WIRE decision: the gateway stays (additive) and is wired into the
 * extension, but only as an explicit opt-in. Constructing a HostToolGateway has
 * zero side effects — no socket, no timers, no process listeners. A bridge is
 * only started when a user runs `/workflows-gateway start` (or a host calls
 * `gateway.start(...)` directly). This preserves the README-documented default:
 * subagents get NO host tools unless a run explicitly opts into the `host-tools`
 * toolset AND the gateway is running.
 *
 * The bridge proxies the ToolDefinitions the extension can actually execute
 * (e.g. createCodingTools + createWebTools) via the same JSON-RPC framing the
 * MCPProxyClient speaks, so a subagent session that opts in receives proxied
 * definitions that forward each call back to the host.
 */

import { randomUUID } from "node:crypto";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MCPProxyClient, ProxyAbortError, proxiedParameters } from "../agent/mcp-proxy-client.js";
import { MCPBridge } from "./mcp-bridge.js";
import type { ProxiedToolDef, ToolExecutor } from "./types.js";

/** Host tool bundle: executor map + serializable metadata for proxy registration. */
export interface HostToolsBundle {
  tools: Map<string, ToolExecutor>;
  toolDefs: ProxiedToolDef[];
}

/**
 * Build a HostToolsBundle from ToolDefinitions the host can execute.
 *
 * Each ToolDefinition.execute returns pi agent-core's AgentToolResult (content
 * array); the adapter flattens text parts into the bridge's ToolCallResult
 * content string. Coding/web tools read at most `ctx?.model` (verified in
 * @earendil-works/pi-coding-agent/dist/core/tools/*), so a minimal context is a
 * truthful stand-in for host-side execution.
 */
export function hostToolsFromDefinitions(definitions: ToolDefinition[]): HostToolsBundle {
  const tools = new Map<string, ToolExecutor>();
  const toolDefs: ProxiedToolDef[] = [];
  const minimalCtx = { model: undefined } as unknown as ExtensionContext;

  for (const def of definitions) {
    if (tools.has(def.name)) continue;
    tools.set(def.name, async (args, signal) => {
      try {
        const result = await def.execute(randomUUID(), (args ?? {}) as never, signal, undefined, minimalCtx);
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => (part as { type: "text"; text: string }).text)
          .join("\n");
        return { content: text, isError: false, details: result.details };
      } catch (error) {
        return {
          content: `Host tool error: ${error instanceof Error ? error.message : "Unknown error"}`,
          isError: true,
        };
      }
    });
    toolDefs.push({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters,
      source: "host",
    });
  }

  return { tools, toolDefs };
}

/**
 * Lazily-started MCPBridge holder. Construction is side-effect free; start/stop
 * are idempotent and safe to call repeatedly.
 */
export class HostToolGateway {
  private bridge: MCPBridge | null = null;
  /** Last-known proxied tool list, retained across stop so an opt-in run that
   * resolves the toolset while the gateway is stopped still fails loudly at
   * call time instead of silently running without the tools it asked for. */
  private knownToolDefs: ProxiedToolDef[] = [];

  isRunning(): boolean {
    return this.bridge !== null;
  }

  getSocketPath(): string | undefined {
    return this.bridge?.getSocketPath();
  }

  /**
   * The auth token proxied clients must present on connect. The host passes it
   * to subagent processes (e.g. via env) so they can authenticate; it is the
   * capability that stops other local processes from invoking host tools.
   */
  getAuthToken(): string | undefined {
    return this.bridge?.getAuthToken();
  }

  /** The proxied tool metadata for the running bridge (empty when stopped). */
  getProxiedToolDefinitions(): ProxiedToolDef[] {
    return this.bridge ? this.knownToolDefs : [];
  }

  /** Last-known tool list, kept after stop for the actionable error path. */
  getKnownToolDefinitions(): ProxiedToolDef[] {
    return this.knownToolDefs;
  }

  async start(bundle: HostToolsBundle): Promise<string> {
    if (this.bridge) return this.bridge.getSocketPath();
    const bridge = new MCPBridge({ tools: bundle.tools, toolDefs: bundle.toolDefs });
    await bridge.start();
    this.bridge = bridge;
    this.knownToolDefs = bundle.toolDefs;
    return bridge.getSocketPath();
  }

  async stop(): Promise<void> {
    if (!this.bridge) return;
    const bridge = this.bridge;
    this.bridge = null;
    await bridge.stop();
  }
}

/** Message surfaced when a run opts into host-tools while the gateway is stopped. */
export const GATEWAY_NOT_RUNNING_MESSAGE =
  'Host tool gateway is not running — start it with /workflows-gateway start before a run uses toolset "host-tools".';

/**
 * Resolve the `host-tools` toolset for a workflow run.
 *
 * Returns proxied ToolDefinitions that forward every call to the running
 * gateway. When the gateway is stopped, the definitions still resolve (a
 * toolset factory must not throw at resolution time — executeRun resolves
 * toolsets before its try/catch, so a throw would strand the run in "running"
 * without a persisted failure) but each call fails loudly with an actionable
 * message. The README default is preserved: no toolset tag, no host tools.
 */
export function createGatewayProxiedTools(gateway: HostToolGateway): ToolDefinition[] {
  const socketPath = gateway.getSocketPath();
  if (!gateway.isRunning() || !socketPath) {
    // A gateway that never started has no tool list — nothing to proxy. One
    // that was stopped still knows its last tool set; each advertised def
    // fails loudly so an explicit opt-in is never silently dropped.
    return gateway.getKnownToolDefinitions().map((def) =>
      defineTool({
        name: def.name,
        label: def.name,
        description: `[Proxied host tool — unavailable] ${def.description}`,
        parameters: proxiedParameters(def.inputSchema),
        async execute() {
          throw new Error(GATEWAY_NOT_RUNNING_MESSAGE);
        },
      }),
    );
  }

  const client = new MCPProxyClient(socketPath, { authToken: gateway.getAuthToken() });
  // Fire the connection in the background; each proxied execute awaits it, so
  // the first call made by a subagent never races the socket handshake. The
  // catch detaches the rejection when the socket is stale/dead: with Node's
  // default --unhandled-rejections=throw an unattached rejection would crash
  // the host; the per-call `await connecting` still surfaces the error.
  const connecting = client.connect();
  connecting.catch(() => {});

  return gateway.getProxiedToolDefinitions().map((def) =>
    defineTool({
      name: def.name,
      label: def.name,
      description: `[Proxied host tool] ${def.description}`,
      parameters: proxiedParameters(def.inputSchema),
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        try {
          await connecting;
          const result = await client.executeToolCall(def.name, (params ?? {}) as Record<string, unknown>, {
            signal,
          });
          return {
            content: [{ type: "text", text: result.content }],
            details: result.details,
            isError: result.isError,
          };
        } catch (error) {
          // The subagent runtime aborted this call — surface the rejection as
          // an abort, NOT as a recoverable tool failure (mirrors the guard in
          // MCPProxyClient.executeToolCall itself).
          if (error instanceof ProxyAbortError) throw error;
          return {
            content: [
              {
                type: "text",
                text: `Host tool gateway error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            details: error,
            isError: true,
          };
        }
      },
    }),
  );
}

export interface WorkflowGatewayCommandOptions {
  /** Build the host tool bundle lazily at `start` time (not at load). */
  buildHostTools: () => HostToolsBundle;
  /**
   * When true (the extension's default "auto"/"on" modes), the start/status
   * copy states that untagged runs include host tools automatically; false
   * (the "off" escape hatch) keeps the legacy opt-in-only phrasing. Defaults
   * to true — the extension's default mode is "auto".
   */
  hostToolsAutomatic?: boolean;
}

/**
 * Register the `/workflows-gateway` command: start | stop | status.
 *
 * The bridge is NOT started on extension load — only this command (or a direct
 * gateway.start call) starts it. Idempotent registration (skips if a
 * `/workflows-gateway` command is already registered).
 */
export function registerWorkflowGatewayCommand(
  pi: ExtensionAPI,
  gateway: HostToolGateway,
  options: WorkflowGatewayCommandOptions,
): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflows-gateway");
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  pi.registerCommand("workflows-gateway", {
    description:
      'Host tool IPC gateway (MCPBridge) — start | stop | status. Starts the bridge lazily; in the default "auto" mode untagged runs include host tools automatically, and the explicit toolset "host-tools" also works.',
    async handler(args: string, ctx: ExtensionCommandContext) {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "status";
      const say = (content: string) => pi.sendMessage({ customType: "workflows-gateway", content, display: true });
      const automatic = options.hostToolsAutomatic !== false;

      if (sub === "start") {
        if (gateway.isRunning()) {
          await say(`Host tool gateway already running on ${gateway.getSocketPath()}.`);
          return;
        }
        try {
          const socketPath = await gateway.start(options.buildHostTools());
          const count = gateway.getProxiedToolDefinitions().length;
          const defaultNote = automatic
            ? 'Untagged runs include host tools automatically (setting subagentHostTools=auto); the explicit toolset "host-tools" also works.'
            : 'Subagents still get no host tools by default; a workflow must opt in via toolset "host-tools".';
          await say(`Host tool gateway started on ${socketPath} — ${count} host tool(s) proxied. ${defaultNote}`);
        } catch (error) {
          ctx.ui.notify(
            `Failed to start host tool gateway: ${error instanceof Error ? error.message : "Unknown error"}`,
            "error",
          );
        }
        return;
      }

      if (sub === "stop") {
        if (!gateway.isRunning()) {
          await say("Host tool gateway is not running.");
          return;
        }
        await gateway.stop();
        // In auto/on modes an untagged run re-starts the gateway, so "stopped"
        // is a temporary state — only the off escape hatch makes it permanent.
        await say(
          automatic
            ? "Host tool gateway stopped — untagged runs will auto-start it again when they need host tools (subagentHostTools=off makes this permanent)."
            : "Host tool gateway stopped — runs can no longer proxy host tools.",
        );
        return;
      }

      if (gateway.isRunning()) {
        await say(
          `Host tool gateway RUNNING on ${gateway.getSocketPath()} — ${gateway.getProxiedToolDefinitions().length} tool(s) proxied. ` +
            `Usage: /workflows-gateway stop`,
        );
      } else {
        const stoppedNote = automatic
          ? "Host tool gateway STOPPED (untagged runs auto-start it when they need host tools)."
          : "Host tool gateway STOPPED (README default — subagents get no host tools).";
        await say(`${stoppedNote} Usage: /workflows-gateway start | stop | status`);
      }
    },
  });
}
