/**
 * SubagentHostToolsPolicy + extension wiring tests (design C: automatic host
 * tools for subagents, default "auto").
 *
 * Policy unit tests (design §9 item 1/3): "auto" is enabled and lazy; a start
 * is idempotent and shared between concurrent runs; defaultTools merges coding
 * + proxied tools after a successful start and degrades to coding-only when
 * the start fails (logged once, self-healing on the next run); "off" disables
 * host tools entirely and never starts the gateway; the explicit "host-tools"
 * toolset wrapper auto-starts the gateway (fixing the old silent-empty opt-in).
 *
 * Extension-level tests (design §9 item 5, mock-pi): the default "auto" mode
 * leaves the gateway STOPPED at load with the automatic-default copy; "off"
 * (settings file) keeps the legacy opt-in-only copy; "on" (settings file)
 * eagerly starts the gateway at the first session_start — NOT at load, because
 * pi's runtime binds action methods only after extension loading finishes.
 * Untagged-run tool delivery itself is covered by the manager defaultTools
 * tests (resolution order) plus the policy merge tests — spinning a real
 * subagent session is out of scope for unit tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discardWorkflowRuntime, takeWorkflowRuntime } from "../src/extension-reload.js";
import { HostToolGateway, type HostToolsBundle, hostToolsFromDefinitions } from "../src/gateway/host-tool-gateway.js";
import { SubagentHostToolsPolicy } from "../src/gateway/subagent-host-tools.js";
import { getWorkflowSettingsPath } from "../src/workflow-settings.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import type { RegisteredCommand } from "./helpers/mock-pi.js";
import { makeNotifyCtx } from "./helpers/mock-pi.js";

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

/** A real gateway whose start() counts invocations (idempotence/self-heal probes). */
function spiedGateway(): { gateway: HostToolGateway; countStarts: () => number } {
  const gateway = new HostToolGateway();
  let starts = 0;
  const realStart = gateway.start.bind(gateway);
  (gateway as unknown as { start: (bundle: HostToolsBundle) => Promise<string> }).start = (bundle) => {
    starts++;
    return realStart(bundle);
  };
  return { gateway, countStarts: () => starts };
}

const gateways: HostToolGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
});

function track(gateway: HostToolGateway): HostToolGateway {
  gateways.push(gateway);
  return gateway;
}

/** Replace console.error for the duration of a callback; returns the captured lines. */
async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), errors };
  } finally {
    console.error = original;
  }
}

function makePolicy(
  gateway: HostToolGateway,
  mode: "auto" | "on" | "off" = "auto",
  buildHostTools: () => HostToolsBundle = () => hostToolsFromDefinitions([echoTool()]),
  buildCodingTools: () => ToolDefinition[] = () => [echoTool("code")],
): SubagentHostToolsPolicy {
  return new SubagentHostToolsPolicy({ gateway, mode, buildHostTools, buildCodingTools });
}

describe("SubagentHostToolsPolicy", () => {
  test("construction is side-effect free and 'auto' is enabled", () => {
    const gateway = track(new HostToolGateway());
    const policy = makePolicy(gateway);
    assert.equal(policy.isEnabled(), true, "'auto' must be enabled");
    assert.equal(policy.hasStartFailed(), false);
    assert.equal(gateway.isRunning(), false, "construction must not start the gateway");
    assert.equal(gateway.getSocketPath(), undefined, "no socket at construction");
  });

  test("ensureStarted starts the gateway on first need and is idempotent", async () => {
    const { gateway, countStarts } = spiedGateway();
    track(gateway);
    const policy = makePolicy(gateway);

    await policy.ensureStarted();
    assert.equal(gateway.isRunning(), true, "the first ensureStarted must start the gateway");
    assert.equal(countStarts(), 1);

    await policy.ensureStarted();
    assert.equal(countStarts(), 1, "a second ensureStarted while running must be a no-op");

    // defaultTools must not restart a running gateway either.
    const defs = await policy.defaultTools();
    assert.equal(countStarts(), 1, "defaultTools must not restart an already-running gateway");
    assert.equal(defs.length, 2, "coding + proxied defs merged");
  });

  test("concurrent runs share one in-flight start", async () => {
    const { gateway, countStarts } = spiedGateway();
    track(gateway);
    const policy = makePolicy(gateway);

    const [a, b] = await Promise.all([policy.defaultTools(), policy.defaultTools()]);
    assert.equal(countStarts(), 1, "two concurrent runs must share a single socket bind");
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
  });

  test("defaultTools merges coding + proxied tools after a successful start", async () => {
    const { gateway, countStarts } = spiedGateway();
    track(gateway);
    const policy = makePolicy(
      gateway,
      "auto",
      () => hostToolsFromDefinitions([echoTool("hosted")]),
      () => [echoTool("code")],
    );

    const defs = await policy.defaultTools();
    assert.equal(countStarts(), 1, "the untagged default must auto-start the gateway");
    assert.deepEqual(
      defs.map((d) => d.name),
      ["code", "hosted"],
      "untagged runs get coding tools merged with the proxied host tools",
    );
  });

  test("a failed auto-start degrades to coding-only tools and logs once", async () => {
    const gateway = track(new HostToolGateway());
    let starts = 0;
    const startImpl: () => Promise<string> = async () => {
      throw new Error("EADDRINUSE: socket path in use");
    };
    (gateway as unknown as { start: () => Promise<string> }).start = () => {
      starts++;
      return startImpl();
    };

    const policy = makePolicy(
      gateway,
      "auto",
      () => hostToolsFromDefinitions([echoTool("hosted")]),
      () => [echoTool("code")],
    );

    const { value: first, errors } = await captureConsoleError(() => policy.defaultTools());
    assert.deepEqual(
      first.map((d) => d.name),
      ["code"],
      "a failed start must degrade to coding-only tools, never an empty list",
    );
    assert.equal(policy.hasStartFailed(), true);
    assert.equal(starts, 1);
    assert.equal(errors.length, 1, "the auto-start failure must be logged");
    assert.match(errors[0], /auto-start failed/);
    assert.match(errors[0], /subagentHostTools=off/, "the log must name the escape hatch");

    // The same failure is logged only once per generation.
    const second = await policy.defaultTools();
    assert.equal(errors.length, 1, "a repeated failure must not re-log");
    assert.deepEqual(
      second.map((d) => d.name),
      ["code"],
    );
    assert.equal(policy.hasStartFailed(), true);
  });

  test("a later successful start clears the failure marker and restores the merge", async () => {
    const gateway = track(new HostToolGateway());
    let startImpl: () => Promise<string> = async () => {
      throw new Error("EADDRINUSE: socket path in use");
    };
    const originalStart = gateway.start.bind(gateway);
    const bundle = hostToolsFromDefinitions([echoTool("hosted")]);
    (gateway as unknown as { start: () => Promise<string> }).start = () => startImpl();

    const policy = makePolicy(
      gateway,
      "auto",
      () => bundle,
      () => [echoTool("code")],
    );

    await policy.defaultTools();
    assert.equal(policy.hasStartFailed(), true);
    // Heal the start; the next run/resume must self-heal (per-start resolution).
    startImpl = async () => originalStart(bundle);
    const healed = await policy.defaultTools();
    assert.equal(policy.hasStartFailed(), false, "a successful start clears the failure marker");
    assert.deepEqual(
      healed.map((d) => d.name),
      ["code", "hosted"],
      "the merge (and proxied tools) must be restored after the start succeeds",
    );
  });

  test("'off' mode disables host tools and never starts the gateway", async () => {
    const { gateway, countStarts } = spiedGateway();
    track(gateway);
    const policy = makePolicy(gateway, "off");

    assert.equal(policy.isEnabled(), false, "'off' must disable host tools");
    await policy.ensureStarted();
    assert.equal(countStarts(), 0, "'off' must never auto-start the gateway");
    assert.equal(gateway.isRunning(), false);

    // Legacy behavior: the explicit host-tools toolset yields nothing on a
    // stopped gateway (a manual /workflows-gateway start is the only path).
    const defs = await policy.hostToolsToolset();
    assert.deepEqual(defs, [], "off-mode host-tools toolset must stay empty on a stopped gateway");
    assert.equal(countStarts(), 0);
  });

  test("the explicit host-tools toolset wrapper auto-starts the gateway", async () => {
    const { gateway, countStarts } = spiedGateway();
    track(gateway);
    const policy = makePolicy(
      gateway,
      "auto",
      () => hostToolsFromDefinitions([echoTool("hosted")]),
      () => [echoTool("code")],
    );

    const defs = await policy.hostToolsToolset();
    assert.equal(countStarts(), 1, "an explicit host-tools opt-in must auto-start the gateway");
    assert.deepEqual(
      defs.map((d) => d.name),
      ["hosted"],
      "the host-tools toolset stays proxied-only (no coding merge)",
    );
  });
});

describe("extension wiring (mock-pi)", () => {
  interface ExtensionPi {
    pi: ExtensionAPI;
    commands: RegisteredCommand[];
    handlers: Record<string, Array<(...args: any[]) => any>>;
    sent: Array<{ content?: string }>;
  }

  /** A Pi mock matching workflow-tools-available.test.ts plus command/message capture. */
  function makeExtensionPi(): ExtensionPi {
    const registeredTools: string[] = [];
    const handlers: Record<string, Array<(...args: any[]) => any>> = {};
    const activeTools: string[] = ["bash", "read"];
    const commands: RegisteredCommand[] = [];
    const sent: Array<{ content?: string }> = [];
    const pi = {
      registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
      registerCommand: (name: string, spec: Omit<RegisteredCommand, "name">) => {
        commands.push({ name, ...spec });
      },
      getCommands: () => commands.map((c) => ({ name: c.name })),
      on: (event: string, handler: (...args: any[]) => any) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (tools: string[]) => {
        activeTools.splice(0, activeTools.length, ...tools);
      },
      sendMessage: (msg: { content?: string }) => {
        sent.push(msg);
      },
    } as unknown as ExtensionAPI;
    return { pi, commands, handlers, sent };
  }

  /** Clean a staged runtime the way a non-reload shutdown does. */
  function cleanupExtension(handlers: Record<string, Array<(...args: any[]) => any>>): void {
    handlers.session_shutdown?.[0]?.();
    discardWorkflowRuntime(process.cwd());
    // Drain anything the discard path might still have staged.
    const stale = takeWorkflowRuntime(process.cwd());
    if (stale) discardWorkflowRuntime(process.cwd(), stale);
  }

  function gatewayCommand(commands: RegisteredCommand[]) {
    const command = commands.find((c) => c.name === "workflows-gateway");
    assert.ok(command, "the extension must register /workflows-gateway");
    return command;
  }

  function lastSent(extension: ExtensionPi): string {
    return extension.sent.at(-1)?.content ?? "";
  }

  test("default 'auto' mode stays STOPPED at load with the automatic-default copy", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-hosttools-auto-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const extension = makeExtensionPi();
        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(extension.pi);

        // P2-1: extension load must not start the bridge.
        const command = gatewayCommand(extension.commands);
        const { ctx } = makeNotifyCtx();
        await (command.handler as (args: string, c: ExtensionCommandContext) => Promise<void>)("status", ctx);

        const status = lastSent(extension);
        assert.match(status, /STOPPED/);
        assert.match(
          status,
          /auto-start it when they need host tools/,
          "auto-mode status must say untagged runs auto-start the gateway",
        );
        assert.match(status, /Usage: \/workflows-gateway start \| stop \| status/);

        cleanupExtension(extension.handlers);
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("'off' (settings file) keeps the legacy opt-in-only copy and manual-start-only path", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-hosttools-off-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const settingsPath = getWorkflowSettingsPath();
        mkdirSync(join(settingsPath, ".."), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ subagentHostTools: "off" }), "utf-8");

        const extension = makeExtensionPi();
        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(extension.pi);

        const command = gatewayCommand(extension.commands);
        const { ctx } = makeNotifyCtx();
        const handler = command.handler as (args: string, c: ExtensionCommandContext) => Promise<void>;

        // The stopped status keeps the legacy README-default copy.
        await handler("status", ctx);
        assert.match(lastSent(extension), /STOPPED/);
        assert.match(lastSent(extension), /README default — subagents get no host tools/);

        // A manual start still works and keeps the legacy opt-in-only copy.
        await handler("start", ctx);
        assert.match(lastSent(extension), /Host tool gateway started on/);
        assert.match(lastSent(extension), /Subagents still get no host tools by default/);
        assert.match(lastSent(extension), /toolset "host-tools"/);

        await handler("status", ctx);
        assert.match(
          lastSent(extension),
          /RUNNING on/,
          "manual /workflows-gateway start remains available in off mode",
        );

        cleanupExtension(extension.handlers);
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("'on' (settings file) eagerly starts the gateway at the first session_start", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-hosttools-on-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const settingsPath = getWorkflowSettingsPath();
        mkdirSync(join(settingsPath, ".."), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ subagentHostTools: "on" }), "utf-8");

        const extension = makeExtensionPi();
        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(extension.pi);

        const command = gatewayCommand(extension.commands);
        const { ctx } = makeNotifyCtx();
        const handler = command.handler as (args: string, c: ExtensionCommandContext) => Promise<void>;

        // No start at load: pi's runtime binds action methods only after
        // extension loading finishes, so a load-time start would throw
        // ("Extension runtime not initialized"). Status must be STOPPED.
        await handler("status", ctx);
        assert.match(lastSent(extension), /STOPPED/, "'on' must NOT start the gateway at extension load");

        // Fire the session_start handlers the extension registered (post-bind
        // in real pi): the eager ensureStarted is fire-and-forget, so poll the
        // status until the bridge reports RUNNING.
        for (const fire of extension.handlers.session_start ?? []) {
          fire(
            {},
            {
              model: undefined,
              modelRegistry: {},
              sessionManager: { getSessionId: () => "session-1" },
              ui: { setWidget: () => {} },
            },
          );
        }

        let running = "";
        for (let i = 0; i < 100; i++) {
          await handler("status", ctx);
          running = lastSent(extension);
          if (/RUNNING on/.test(running)) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.match(running, /RUNNING on/, "'on' mode must start the gateway at the first session_start");

        cleanupExtension(extension.handlers);
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
