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
import {
  createGatewayProxiedTools,
  GATEWAY_NOT_RUNNING_MESSAGE,
  HostToolGateway,
  hostToolsFromDefinitions,
  registerWorkflowGatewayCommand,
} from "../../src/gateway/host-tool-gateway.js";
import type { ProxiedToolDef, ToolExecutor } from "../../src/gateway/types.js";
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
    () => (stoppedDefs[0] as { execute: () => Promise<unknown> }).execute("call-1", {}),
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
    echo as { execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
  ).execute("call-1", { hello: "world" })) as { content: Array<{ type: string; text: string }> };
  assert.strictEqual(result.content[0].text, JSON.stringify({ hello: "world" }));
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
  assert.match(started, /toolset "host-tools"/, "start must state the explicit opt-in requirement");

  // status (running)
  await handler("status", ctx);
  assert.match(sent.at(-1)?.content ?? "", /RUNNING on/);

  // stop
  await handler("stop", ctx);
  assert.equal(gateway.isRunning(), false);
  assert.match(sent.at(-1)?.content ?? "", /stopped/);

  // status (stopped) states the README default
  await handler("status", ctx);
  assert.match(sent.at(-1)?.content ?? "", /STOPPED/);
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
