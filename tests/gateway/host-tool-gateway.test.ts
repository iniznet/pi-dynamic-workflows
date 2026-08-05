/**
 * P2-1 WIRE tests: the lazy HostToolGateway lifecycle, the host-tools opt-in
 * toolset, and the /workflows-gateway command.
 *
 * Contract under test:
 * - Constructing HostToolGateway is side-effect free (no socket before start).
 * - start/stop are idempotent and start only on demand.
 * - createGatewayProxiedTools resolves without throwing when the gateway is
 *   stopped (the run must fail at tool-call time, not wedge at resolution),
 *   and round-trips calls through a real socket when it is running.
 * - The command registers start | stop | status handlers.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ProxyAbortError, proxiedParameters } from "../../src/agent/mcp-proxy-client.js";
import {
  createGatewayProxiedTools,
  GATEWAY_NOT_RUNNING_MESSAGE,
  HostToolGateway,
  hostToolsFromDefinitions,
  registerWorkflowGatewayCommand,
} from "../../src/gateway/host-tool-gateway.js";
import type { ProxiedToolDef, ToolCallResult, ToolExecutor } from "../../src/gateway/types.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "../helpers/mock-pi.js";

/** A minimal ToolDefinition whose execute echoes its params as text. */
function echoTool(name = "echo"): ToolDefinition {
  return {
    name,
    label: name,
    description: `Echoes its arguments (${name})`,
    parameters: Type.Object({}),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;
}

const gateways: HostToolGateway[] = [];

function trackedGateway(): HostToolGateway {
  const gateway = new HostToolGateway();
  gateways.push(gateway);
  return gateway;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
});

test("HostToolGateway construction is side-effect free (no bridge, no socket)", () => {
  const gateway = new HostToolGateway();
  assert.equal(gateway.isRunning(), false);
  assert.equal(gateway.getSocketPath(), undefined);
  assert.deepEqual(gateway.getProxiedToolDefinitions(), []);
});

test("HostToolGateway start/stop are idempotent and expose a socket path while running", async () => {
  const gateway = trackedGateway();
  const bundle = hostToolsFromDefinitions([echoTool()]);

  const first = await gateway.start(bundle);
  assert.equal(gateway.isRunning(), true);
  assert.ok(first, "socket path must be defined");
  assert.equal(gateway.getSocketPath(), first);

  // Idempotent start: same socket path, no second server.
  const second = await gateway.start(bundle);
  assert.equal(second, first, "restart must return the existing socket path");

  assert.deepEqual(
    gateway.getProxiedToolDefinitions().map((d) => d.name),
    ["echo"],
  );

  await gateway.stop();
  assert.equal(gateway.isRunning(), false);
  assert.equal(gateway.getSocketPath(), undefined);
  assert.deepEqual(gateway.getProxiedToolDefinitions(), []);

  // Idempotent stop on an already-stopped gateway.
  await gateway.stop();
});

test("hostToolsFromDefinitions adapts ToolDefinition.execute into bridge executors", async () => {
  const { tools, toolDefs } = hostToolsFromDefinitions([echoTool("greet")]);

  const executor = tools.get("greet");
  assert.ok(executor, "executor map must contain the tool");
  const result = await (executor as ToolExecutor)({ who: "world" });
  assert.deepEqual(result, { content: JSON.stringify({ who: "world" }), isError: false, details: undefined });

  assert.deepEqual(
    toolDefs.map((d) => ({ name: d.name, source: d.source })),
    [{ name: "greet", source: "host" }],
  );
});

test("hostToolsFromDefinitions surfaces host tool execution failures as isError results", async () => {
  const failing: ToolDefinition = {
    name: "boom",
    label: "boom",
    description: "always fails",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("host exploded");
    },
  } as ToolDefinition;

  const { tools } = hostToolsFromDefinitions([failing]);
  const executor = tools.get("boom");
  assert.ok(executor, "executor map must contain the failing tool");
  const result = await (executor as ToolExecutor)({});
  assert.equal(result.isError, true);
  assert.match(result.content, /host exploded/);
});

test("hostToolsFromDefinitions passes the injected session manager to the execution context (0.83.0 bash contract)", async () => {
  // Mirrors the 0.83.0 bash tool's ctx reads: PI_SESSION_ID / PI_SESSION_FILE
  // come from ctx.sessionManager. An undefined sessionManager crashes every
  // proxied bash call (TypeError on getSessionId), so the bridge must forward
  // the manager the extension captured at session_start.
  const readsSessionCtx: ToolDefinition = {
    name: "bash_like",
    label: "bash_like",
    description: "reads the session-manager surface like 0.83.0 bash",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const session = (
        ctx as unknown as { sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined } }
      ).sessionManager;
      if (!session) throw new Error("ctx.sessionManager is undefined");
      return {
        content: [
          {
            type: "text" as const,
            text: `${session.getSessionId()}|${session.getSessionFile() ?? "<none>"}`,
          },
        ],
        details: undefined,
      };
    },
  } as ToolDefinition;

  const injected = hostToolsFromDefinitions([readsSessionCtx], {
    getSessionId: () => "session-abc",
    getSessionFile: () => "/tmp/session-abc.jsonl",
  });
  const injectedResult = await (injected.tools.get("bash_like") as ToolExecutor)({});
  assert.deepEqual(injectedResult, {
    content: "session-abc|/tmp/session-abc.jsonl",
    isError: false,
    details: undefined,
  });
});

test("hostToolsFromDefinitions falls back to a stable session-manager shim when none is injected", async () => {
  const readsSessionCtx: ToolDefinition = {
    name: "bash_like",
    label: "bash_like",
    description: "reads the session-manager surface like 0.83.0 bash",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const session = (
        ctx as unknown as { sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined } }
      ).sessionManager;
      if (!session) throw new Error("ctx.sessionManager is undefined");
      return {
        content: [
          {
            type: "text" as const,
            text: `${session.getSessionId()}|${session.getSessionFile() ?? "<none>"}`,
          },
        ],
        details: undefined,
      };
    },
  } as ToolDefinition;

  // A bundle built before the first session_start (eager "on" mode) must not
  // crash bash — the shim is honest (gateway identity, no fake session file).
  const fallback = hostToolsFromDefinitions([readsSessionCtx]);
  const first = await (fallback.tools.get("bash_like") as ToolExecutor)({});
  const second = await (fallback.tools.get("bash_like") as ToolExecutor)({});
  assert.deepEqual(first, { content: "host-tool-gateway|<none>", isError: false, details: undefined });
  assert.deepEqual(second, first, "the fallback identity is stable across calls");
});

test("hostToolsFromDefinitions resolves a provider per call so a load-time bundle adopts the real session manager later", async () => {
  const readsSessionCtx: ToolDefinition = {
    name: "bash_like",
    label: "bash_like",
    description: "reads the session-manager surface like 0.83.0 bash",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const session = (
        ctx as unknown as { sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined } }
      ).sessionManager;
      if (!session) throw new Error("ctx.sessionManager is undefined");
      return {
        content: [
          {
            type: "text" as const,
            text: `${session.getSessionId()}|${session.getSessionFile() ?? "<none>"}`,
          },
        ],
        details: undefined,
      };
    },
  } as ToolDefinition;

  // Simulates eager "on" mode: the bundle is built at load, BEFORE the
  // session_start handler assigns the real manager to the provider.
  let real: { getSessionId(): string; getSessionFile(): string | undefined } | undefined;
  const bundle = hostToolsFromDefinitions([readsSessionCtx], () => real);
  const executor = bundle.tools.get("bash_like") as ToolExecutor;

  const before = await executor({});
  assert.deepEqual(before, { content: "host-tool-gateway|<none>", isError: false, details: undefined });

  // session_start fires; the provider now returns the real manager.
  real = { getSessionId: () => "session-live-9", getSessionFile: () => "/tmp/session-live-9.jsonl" };
  const after = await executor({});
  assert.deepEqual(after, { content: "session-live-9|/tmp/session-live-9.jsonl", isError: false, details: undefined });
  assert.notDeepEqual(after, before, "the same bundle must adopt the real manager without a rebuild");
});

test("createGatewayProxiedTools with a stopped gateway resolves to definitions that fail at call time", async () => {
  const gateway = trackedGateway();
  const defs = createGatewayProxiedTools(gateway);

  // Resolution must not throw — executeRun resolves toolsets before its
  // try/catch, so a throw would strand the run without a persisted failure.
  assert.ok(Array.isArray(defs), "toolset must resolve to a definition array even when stopped");
  assert.equal(defs.length, 0, "no proxied tools when the gateway never started");

  // With a started-then-stopped gateway, the earlier tool list is still known,
  // but calls must fail loudly with the actionable message.
  const bundle = hostToolsFromDefinitions([echoTool()]);
  await gateway.start(bundle);
  await gateway.stop();

  const stoppedDefs = createGatewayProxiedTools(gateway);
  assert.equal(stoppedDefs.length, 1, "stopped gateway still advertises the known tool list");
  await assert.rejects(
    () =>
      (stoppedDefs[0] as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("call-1", {}),
    (error: unknown) => (error as Error).message === GATEWAY_NOT_RUNNING_MESSAGE,
  );
});

test("createGatewayProxiedTools round-trips a call through the running gateway", async () => {
  const gateway = trackedGateway();
  const bundle = hostToolsFromDefinitions([echoTool()]);
  await gateway.start(bundle);

  const defs = createGatewayProxiedTools(gateway);
  const echo = defs.find((d) => d.name === "echo");
  assert.ok(echo, "echo must be exposed once the gateway is running");

  const result = (await (
    echo as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  ).execute("call-1", { hello: "world" })) as { content: Array<{ type: string; text: string }> };
  assert.strictEqual(result.content[0].text, JSON.stringify({ hello: "world" }));
});

test("createGatewayProxiedTools propagates an abort as ProxyAbortError, not an isError result (gateway-ipc:i1)", async () => {
  // The production gateway consumer must mirror executeToolCall's guard: an
  // aborted call rejects with ProxyAbortError instead of degrading into a
  // recoverable tool failure the agent could retry past.
  const tools = new Map<string, ToolExecutor>();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const hostCancelled = new Promise<ToolCallResult>((resolve) => {
    tools.set("blocking", async (_args, signal) => {
      markStarted();
      signal?.addEventListener("abort", () => resolve({ content: "cancelled-by-abort", isError: false }), {
        once: true,
      });
      return await new Promise<ToolCallResult>(() => {});
    });
  });

  const gateway = trackedGateway();
  await gateway.start({
    tools,
    toolDefs: [{ name: "blocking", description: "blocks until aborted", inputSchema: {}, source: "host" }],
  });

  const defs = createGatewayProxiedTools(gateway);
  const blocking = defs.find((d) => d.name === "blocking");
  assert.ok(blocking, "blocking must be proxied");

  const controller = new AbortController();
  const call = (
    blocking as unknown as {
      execute: (id: string, p: unknown, signal: AbortSignal) => Promise<unknown>;
    }
  ).execute("call-1", {}, controller.signal);

  await started; // the host tool is in flight on the bridge
  controller.abort();

  await assert.rejects(call, (error: unknown) => error instanceof ProxyAbortError);
  await hostCancelled;
});

test("a stale/dead socket surfaces an isError result with no unhandledRejection (gateway-ipc:f1)", async () => {
  // The background connect() fired by createGatewayProxiedTools must carry a
  // detached catch: when the bridge dies under it, the rejected connect
  // promise must never become an unhandledRejection (which with Node's
  // default --unhandled-rejections=throw would crash the host process).
  const unhandled: Error[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason : new Error(String(reason)));
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const gateway = trackedGateway();
    await gateway.start(hostToolsFromDefinitions([echoTool()]));

    const defs = createGatewayProxiedTools(gateway);
    // Tear the bridge down immediately — the client's connect() is still in
    // flight, so its promise rejects against the dying socket. The detached
    // .catch(() => {}) must absorb that rejection.
    await gateway.stop();
    await new Promise((r) => setTimeout(r, 30));

    const echo = defs.find((d) => d.name === "echo") as unknown as {
      execute: (
        id: string,
        p: unknown,
      ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
    };
    // Per-call `await connecting` still surfaces the failure as an isError
    // result instead of throwing out of the proxied execute.
    const result = await echo.execute("call-1", { hello: "world" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /error/i);

    // Drain any late rejection before asserting.
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, [], "the stale-socket connect rejection must be caught, never unhandled");
});

test("proxied tool definitions carry the host tool's real argument schema (gateway-ipc:f6/i2)", async () => {
  const withSchema: ToolDefinition = {
    name: "search",
    label: "search",
    description: "search tool",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;

  // Bridge metadata preserves the host tool's real schema, not Type.Object({}).
  const bundle = hostToolsFromDefinitions([withSchema]);
  assert.strictEqual(bundle.toolDefs[0].inputSchema, withSchema.parameters);

  // The subagent-facing definition exposes the actual argument shape.
  const gateway = trackedGateway();
  await gateway.start(bundle);
  const defs = createGatewayProxiedTools(gateway);
  const search = defs.find((d) => d.name === "search");
  assert.ok(search, "search must be proxied once the gateway is running");
  const parameters = (search as { parameters: { type?: string; properties?: Record<string, { type?: string }> } })
    .parameters;
  assert.equal(parameters.type, "object");
  assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), ["limit", "query"]);
  assert.equal(parameters.properties?.query.type, "string");
  assert.equal(parameters.properties?.limit.type, "number");
});

test("/workflows-gateway command: start → status → stop lifecycle", async () => {
  const gateway = trackedGateway();
  const { pi, commands, sent } = makeCommandRegistryPi();
  const { ctx } = makeNotifyCtx();

  registerWorkflowGatewayCommand(pi as ExtensionAPI, gateway, {
    buildHostTools: () => hostToolsFromDefinitions([echoTool()]),
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "workflows-gateway");
  const handler = commands[0].handler as (args: string, c: ExtensionCommandContext) => Promise<void>;

  // start
  await handler("start", ctx);
  assert.equal(gateway.isRunning(), true);
  const started = sent.at(-1)?.content ?? "";
  assert.match(started, /Host tool gateway started on/);
  assert.match(started, /1 host tool\(s\) proxied/);
  assert.match(started, /toolset "host-tools"/, "start must state the explicit opt-in surface");
  // The default "auto" mode is stated in the copy: untagged runs include host
  // tools automatically, so the message must no longer claim opt-in-only.
  assert.match(
    started,
    /include host tools automatically/,
    "start must state the automatic default (subagentHostTools=auto)",
  );

  // status (running)
  await handler("status", ctx);
  assert.match(sent.at(-1)?.content ?? "", /RUNNING on/);

  // stop
  await handler("stop", ctx);
  assert.equal(gateway.isRunning(), false);
  assert.match(sent.at(-1)?.content ?? "", /stopped/);

  // status (stopped) states the automatic default in "auto" mode
  await handler("status", ctx);
  assert.match(sent.at(-1)?.content ?? "", /STOPPED/);
  assert.match(
    sent.at(-1)?.content ?? "",
    /auto-start it when they need host tools/,
    "stopped status must state that untagged runs auto-start the gateway",
  );
});

test("/workflows-gateway command keeps the legacy opt-in-only copy when hostToolsAutomatic is false", async () => {
  // The "off" escape hatch restores the exact pre-change copy: opt-in via
  // toolset "host-tools" after a manual start, README default for STOPPED.
  const gateway = trackedGateway();
  const { pi, commands, sent } = makeCommandRegistryPi();
  const { ctx } = makeNotifyCtx();

  registerWorkflowGatewayCommand(pi as ExtensionAPI, gateway, {
    buildHostTools: () => hostToolsFromDefinitions([echoTool()]),
    hostToolsAutomatic: false,
  });
  const handler = commands[0].handler as (args: string, c: ExtensionCommandContext) => Promise<void>;

  await handler("start", ctx);
  const started = sent.at(-1)?.content ?? "";
  assert.match(
    started,
    /Subagents still get no host tools by default/,
    "off-mode start must keep the opt-in-only requirement",
  );

  await handler("stop", ctx);
  await handler("status", ctx);
  const stopped = sent.at(-1)?.content ?? "";
  assert.match(stopped, /STOPPED/);
  assert.match(
    stopped,
    /README default — subagents get no host tools/,
    "off-mode STOPPED must keep the legacy README-default copy",
  );
});

test("/workflows-gateway command registration is idempotent", async () => {
  const gateway = trackedGateway();
  const { pi, commands } = makeCommandRegistryPi(["workflows-gateway"]);
  const { ctx } = makeNotifyCtx();

  registerWorkflowGatewayCommand(pi as ExtensionAPI, gateway, {
    buildHostTools: () => hostToolsFromDefinitions([echoTool()]),
  });
  assert.equal(commands.length, 0, "an existing /workflows-gateway must not be re-registered");
  assert.equal(gateway.isRunning(), false, "registration alone must not start the gateway");
  void ctx;
});

test("host-tools toolset does not start the gateway on resolution", async () => {
  const gateway = trackedGateway();
  // Resolution alone (e.g. a run naming toolset "host-tools" while the gateway
  // is stopped) must not spawn a socket.
  createGatewayProxiedTools(gateway);
  assert.equal(gateway.isRunning(), false);
});

test("exported gateway types are usable (ProxiedToolDef round-trip)", () => {
  const def: ProxiedToolDef = { name: "x", description: "d", inputSchema: {}, source: "host" };
  assert.equal(def.source, "host");
});

test("connecting to a dead/stale socket must NOT produce an unhandledRejection (gateway-ipc:f1)", async () => {
  const gateway = trackedGateway();
  const bundle = hostToolsFromDefinitions([echoTool()]);
  await gateway.start(bundle);

  // Kill the bridge behind the gateway's back: the gateway still believes it
  // is running, but the socket file/pipe no longer accepts connections — the
  // exact "stale/dead socket" scenario where client.connect() rejects long
  // before any proxied tool executes.
  await (gateway as unknown as { bridge: { stop(): Promise<void> } }).bridge.stop();
  assert.equal(gateway.isRunning(), true, "gateway must still report running over a dead socket");

  // Install a process-level unhandledRejection probe BEFORE the background
  // connect fires so a regression is measured instead of crashing the runner.
  const unhandled: unknown[] = [];
  const probe = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", probe);
  try {
    const defs = createGatewayProxiedTools(gateway);
    assert.equal(defs.length, 1, "the dead-socket gateway must still advertise its known tool list");

    // Give the background connect() time to reject against the dead socket.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(unhandled, [], "background connect rejection must be detached, not unhandled");

    // The per-call await still surfaces the failure — as an isError result,
    // never as a thrown exception escaping the proxied execute.
    const result = (await (
      defs[0] as unknown as {
        execute: (
          id: string,
          p: unknown,
        ) => Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }>;
      }
    ).execute("call-1", {})) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    assert.equal(result.isError, true, "dead-socket call must surface as an isError result");
    assert.match(result.content[0].text, /Host tool gateway error/);
  } finally {
    process.removeListener("unhandledRejection", probe);
    await gateway.stop();
  }
});

test("proxied tool definitions carry the real input schema through to defineTool (gateway-ipc:f6/i2)", async () => {
  const gateway = trackedGateway();
  const schema = Type.Object({ who: Type.String(), count: Type.Integer() });
  const tool: ToolDefinition = {
    name: "greet",
    label: "greet",
    description: "Greets someone",
    parameters: schema,
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;

  const bundle = hostToolsFromDefinitions([tool]);
  await gateway.start(bundle);

  // The bridge-side metadata must not degrade the schema to Type.Object({}).
  const defs = gateway.getProxiedToolDefinitions();
  assert.equal(defs.length, 1);
  assert.deepEqual(defs[0].inputSchema, schema, "inputSchema must be the host tool's real parameter shape");

  // The proxied ToolDefinition (what subagent models see) must expose the same
  // shape via proxiedParameters inside defineTool.
  const proxied = createGatewayProxiedTools(gateway);
  assert.deepEqual((proxied[0] as unknown as { parameters: unknown }).parameters, schema);
});

test("proxiedParameters preserves a real JSON schema and falls back to an empty object (gateway-ipc:f6/i2)", () => {
  const schema = Type.Object({ who: Type.String() });
  assert.deepEqual(proxiedParameters(schema), schema, "real schemas must pass through unchanged");
  assert.deepEqual(proxiedParameters(null), Type.Object({}));
  assert.deepEqual(proxiedParameters("not-a-schema"), Type.Object({}));
  assert.deepEqual(proxiedParameters(undefined), Type.Object({}));
});
