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
 * The session-manager surface host-side coding tools read from the execution
 * context. The host aliases @earendil-works/pi-coding-agent to its own runtime
 * dist (0.83.0), whose bash tool reads `ctx.sessionManager.getSessionId()` and
 * `getSessionFile()` to set PI_SESSION_ID/PI_SESSION_FILE env — an undefined
 * sessionManager crashes every proxied bash call. ReadonlySessionManager in
 * the SDK structurally satisfies this shape, so the extension can pass the
 * real session manager captured at session_start.
 */
export interface SessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

/**
 * A session-manager provider, evaluated per tool call. A bundle built before
 * the first session_start (eager "on" mode starts the gateway at load) picks
 * up the real manager the moment session_start delivers it, instead of
 * freezing the fallback identity for the gateway's whole lifetime.
 */
export type SessionManagerProvider = () => SessionManagerLike | undefined;

/**
 * Honest stand-in until a real session manager exists: subagent bash calls
 * still work, but clearly belong to the gateway rather than a real session.
 */
const FALLBACK_SESSION_MANAGER: SessionManagerLike = {
  getSessionId: () => "host-tool-gateway",
  getSessionFile: () => undefined,
};

/**
 * Build a HostToolsBundle from ToolDefinitions the host can execute.
 *
 * Each ToolDefinition.execute returns pi agent-core's AgentToolResult (content
 * array); the adapter flattens text parts into the bridge's ToolCallResult
 * content string. Most coding tools read at most `ctx?.model` (verified in
 * @earendil-works/pi-coding-agent/dist/core/tools/*), but 0.83.0's bash also
 * reads `ctx.sessionManager`, so the bridge context carries the session
 * manager the extension captured at session_start (or a provider that resolves
 * it per call, falling back to {@link FALLBACK_SESSION_MANAGER} until the real
 * one exists).
 */
export function hostToolsFromDefinitions(
  definitions: ToolDefinition[],
  sessionManager?: SessionManagerLike | SessionManagerProvider,
): HostToolsBundle {
  const tools = new Map<string, ToolExecutor>();
  const toolDefs: ProxiedToolDef[] = [];
  // Resolved per call: a provider form lets a load-time-built bundle (eager
  // "on" mode) adopt the real session manager once session_start has fired;
  // an object form is stable for the bundle's lifetime.
  const resolveSessionManager = (): SessionManagerLike => {
    const candidate = typeof sessionManager === "function" ? sessionManager() : sessionManager;
    return candidate ?? FALLBACK_SESSION_MANAGER;
  };

  for (const def of definitions) {
    if (tools.has(def.name)) continue;
    tools.set(def.name, async (args, signal) => {
      const minimalCtx = {
        model: undefined,
        sessionManager: resolveSessionManager(),
      } as unknown as ExtensionContext;
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
  /**
   * The single shared MCPProxyClient for the running bridge
   * (mcp-proxy-client-socket-leak fix): created lazily on first toolset
   * resolution, reused across every createGatewayProxiedTools() call — a run
   * start and a resume must not each open a fresh bridge connection — and
   * disconnected deterministically by stop(). Nulled by stop() so a later
   * start reconnects through a fresh client bound to the new bridge's socket
   * path + auth token.
   */
  private proxiedClient: MCPProxyClient | null = null;
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

  /**
   * The shared proxied client for the running bridge, created lazily on first
   * use. One client per start→stop lifetime: the socket-leak audit found a
   * fresh MCPProxyClient per createGatewayProxiedTools() call (i.e. per run
   * start AND per resume), each holding a live bridge connection that was
   * never disconnected — with the bridge's 10-connection cap, enough
   * resolves/resumes wedged the gateway. Every caller (concurrent runs,
   * resumes) now shares this single connection; stop() disconnects it
   * deterministically.
   *
   * The connection is fired in the background; each proxied execute awaits
   * client.connect() (idempotent: returns the shared in-flight promise, or
   * immediately when already connected), so the first call made by a subagent
   * never races the socket handshake and a failed initial connect is retried
   * per call instead of wedging the shared client. The detached catch keeps a
   * stale/dead-socket rejection from becoming an unhandledRejection (Node's
   * default --unhandled-rejections=throw would crash the host); the per-call
   * `await client.connect()` still surfaces the error.
   */
  getProxyClient(): MCPProxyClient | undefined {
    if (!this.bridge) return undefined;
    if (!this.proxiedClient) {
      const client = new MCPProxyClient(this.bridge.getSocketPath(), { authToken: this.bridge.getAuthToken() });
      const connecting = client.connect();
      connecting.catch(() => {});
      this.proxiedClient = client;
    }
    return this.proxiedClient;
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
    const bridge = this.bridge;
    this.bridge = null;
    const client = this.proxiedClient;
    this.proxiedClient = null;
    // Release the shared proxied socket deterministically — a stopped gateway
    // must not leave a client connected to a dead/stopped bridge (the leak the
    // shared-client design closes). Idempotent: both null → no-op. Every stop
    // path funnels here: /workflows-gateway stop, extension reload/shutdown
    // (dispose fanout → stopHostToolGateway), and discard of an abandoned
    // generation.
    if (client) await client.disconnect();
    if (bridge) await bridge.stop();
  }
}

/** Message surfaced when a run opts into host-tools while the gateway is stopped. */
export const GATEWAY_NOT_RUNNING_MESSAGE =
  'Host tool gateway is not running — start it with /workflows-gateway start before a run uses toolset "host-tools".';

/**
 * Proxied defs that fail loudly at call time — used when the gateway is
 * stopped (or a running gateway lacks a shared client, defensively). The defs
 * still resolve so an explicit opt-in is never silently dropped; each call
 * throws the actionable message.
 */
function unavailableToolDefinitions(gateway: HostToolGateway): ToolDefinition[] {
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

/**
 * Resolve the `host-tools` toolset for a workflow run.
 *
 * Returns proxied ToolDefinitions that forward every call to the running
 * gateway. When the gateway is stopped, the definitions still resolve (a
 * toolset factory must not throw at resolution time — executeRun resolves
 * toolsets before its try/catch, so a throw would strand the run in "running"
 * without a persisted failure) but each call fails loudly with an actionable
 * message. The README default is preserved: no toolset tag, no host tools.
 *
 * The proxied defs are backed by ONE shared MCPProxyClient held on the
 * gateway (mcp-proxy-client-socket-leak fix): every run start AND every resume
 * used to create a fresh client whose live bridge connection was never
 * disconnected, eventually wedging the bridge's connection cap. See
 * {@link HostToolGateway#getProxyClient}.
 */
export function createGatewayProxiedTools(gateway: HostToolGateway): ToolDefinition[] {
  if (!gateway.isRunning() || !gateway.getSocketPath()) {
    // A gateway that never started has no tool list — nothing to proxy. One
    // that was stopped still knows its last tool set; each advertised def
    // fails loudly so an explicit opt-in is never silently dropped.
    return unavailableToolDefinitions(gateway);
  }

  // One shared client per gateway lifetime — never a fresh MCPProxyClient per
  // resolution. A per-call client was the mcp-proxy-client-socket-leak finding:
  // every run start AND every resume opened a new bridge connection that was
  // never disconnected (disconnect() only ever ran in tests), eventually
  // wedging the bridge's connection cap. getProxyClient() fires the background
  // connect and each proxied execute awaits client.connect(), so the first
  // call made by a subagent never races the socket handshake.
  const client = gateway.getProxyClient();
  if (!client) {
    // Defensive: getProxyClient creates a client whenever the bridge exists,
    // so a running gateway without one means the bridge is mid-transition.
    return unavailableToolDefinitions(gateway);
  }

  return gateway.getProxiedToolDefinitions().map((def) =>
    defineTool({
      name: def.name,
      label: def.name,
      description: `[Proxied host tool] ${def.description}`,
      parameters: proxiedParameters(def.inputSchema),
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        try {
          await client.connect();
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
