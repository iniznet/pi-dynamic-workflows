/**
 * buildMergedHostTools + isExcludedHostTool unit tests (extension-only host-tool
 * upgrade: no pi source modification — proxied bundle is built entirely from the
 * public ExtensionAPI surface and public SDK tool factories).
 *
 * Coverage:
 *  - Baseline: the executable builtin suite (read/bash/edit/write + grep/find/ls
 *    via public createCodingTools/createReadOnlyTools factories) + web tools,
 *    even when the host exposes no metadata API at all.
 *  - Live metadata path: pi.getAllTools() (public) syncs descriptions /
 *    promptGuidelines and narrows the suite to builtins the host registers.
 *  - Extension/MCP tools visible ONLY as metadata (no full definitions) are
 *    never advertised — the public API cannot execute them (documented gap).
 *  - Future path: the feature-detected getAllToolDefinitions() still merges
 *    full extension defs when a future SDK provides it.
 *  - Exclusions: workflow/workflow_control are NEVER proxied even when present;
 *    settings.excludeSubagentTools names are filtered too.
 *  - Dedupe: a same-named def loses to the earlier core def (first wins).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildMergedHostTools, isExcludedHostTool } from "../src/gateway/subagent-host-tools.js";

/**
 * The executable host bundle baseline: createCodingTools (read/bash/edit/write)
 * + createReadOnlyTools (read/grep/find/ls) + createWebTools, deduped by name.
 */
const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const CORE_TOOL_NAMES = [...BUILTIN_TOOL_NAMES, "web_search", "web_fetch"];

/** A minimal ToolDefinition whose execute echoes its params as text. */
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `Fake tool (${name})`,
    parameters: Type.Object({}),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;
}

/** ToolInfo metadata for a host-registered tool (the getAllTools() shape). */
function fakeInfo(name: string, source: string = "builtin"): ToolInfo {
  return {
    name,
    description: `Live ${name} description`,
    parameters: Type.Object({}),
    promptGuidelines: [`Guideline for ${name}`],
    sourceInfo: { path: `<builtin:${name}>`, source, scope: "temporary", origin: "top-level" },
  };
}

interface MockPiOptions {
  /** Values for the public getAllTools() (live host metadata). */
  toolInfos?: ToolInfo[];
  /** Full definitions for the feature-detected getAllToolDefinitions() path. */
  registeredTools?: ToolDefinition[];
  /** Whether to omit getAllTools entirely (ancient-SDK fallback). */
  noMetadataApi?: boolean;
}

/** An ExtensionAPI mock whose surface mirrors 0.83.0's public API. */
function makePi({ toolInfos, registeredTools, noMetadataApi }: MockPiOptions = {}): ExtensionAPI {
  const api: Record<string, unknown> = {};
  if (!noMetadataApi) api.getAllTools = () => toolInfos ?? [];
  if (registeredTools !== undefined) api.getAllToolDefinitions = () => registeredTools;
  return api as ExtensionAPI;
}

function toolNames(bundle: ReturnType<typeof buildMergedHostTools>): string[] {
  return bundle.toolDefs.map((def) => def.name);
}

describe("isExcludedHostTool", () => {
  test("always denies the extension's own recursive-orchestration tools", () => {
    assert.equal(isExcludedHostTool("workflow"), true, "workflow must always be denied");
    assert.equal(isExcludedHostTool("workflow_control"), true, "workflow_control must always be denied");
    assert.equal(isExcludedHostTool("read"), false, "core host tools are not denied by default");
    assert.equal(isExcludedHostTool("mcp_github"), false, "MCP tools are not denied by default");
  });

  test("extra excluded names (settings.excludeSubagentTools) extend the deny set", () => {
    assert.equal(isExcludedHostTool("task", ["task"]), true);
    assert.equal(isExcludedHostTool("workflow", ["task"]), true, "defaults stay denied alongside extras");
    assert.equal(isExcludedHostTool("bash", ["task"]), false);
  });
});

describe("buildMergedHostTools", () => {
  test("no metadata API at all → full executable builtin suite + web tools (extension-only baseline)", () => {
    const bundle = buildMergedHostTools(makePi({ noMetadataApi: true }), { cwd: process.cwd() });
    assert.deepEqual(
      toolNames(bundle),
      CORE_TOOL_NAMES,
      "the extension-only baseline is the executable builtin suite plus the web tools",
    );
  });

  test("getAllTools() present: builtins the host does not register are dropped from the suite", () => {
    // The live host registers only the 4 coding tools — grep/find/ls are absent.
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: ["read", "bash", "edit", "write"].map((name) => fakeInfo(name)),
      }),
      { cwd: process.cwd() },
    );
    assert.deepEqual(toolNames(bundle), ["read", "bash", "edit", "write", "web_search", "web_fetch"]);
  });

  test("getAllTools() present: descriptions sync from live host metadata", () => {
    const live = BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name));
    const bundle = buildMergedHostTools(makePi({ toolInfos: live }), { cwd: process.cwd() });
    const read = bundle.toolDefs.find((def) => def.name === "read");
    assert.equal(read?.description, "Live read description", "description follows the running host");
  });

  test("extension/MCP tools visible only as metadata are never advertised (public API cannot execute them)", () => {
    const live = [
      ...BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
      fakeInfo("mcp_github", "extension"),
      fakeInfo("mcp_fs", "extension"),
    ];
    const bundle = buildMergedHostTools(makePi({ toolInfos: live }), { cwd: process.cwd() });
    const names = toolNames(bundle);
    assert.ok(!names.includes("mcp_github"), "metadata-only MCP tools must not be proxied");
    assert.ok(!names.includes("mcp_fs"), "metadata-only MCP tools must not be proxied");
    assert.ok(names.includes("read"), "executable builtins are unaffected");
  });

  test("future path: full extension defs from getAllToolDefinitions() are merged in", () => {
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
        registeredTools: [fakeTool("mcp_github"), fakeTool("mcp_fs")],
      }),
      { cwd: process.cwd() },
    );
    assert.deepEqual(toolNames(bundle), [...CORE_TOOL_NAMES, "mcp_github", "mcp_fs"]);
  });

  test("workflow/workflow_control are never proxied even when present in the definitions list", () => {
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
        registeredTools: [fakeTool("workflow"), fakeTool("workflow_control"), fakeTool("mcp_github")],
      }),
      { cwd: process.cwd() },
    );
    const names = toolNames(bundle);
    assert.ok(!names.includes("workflow"), "workflow must never be proxied");
    assert.ok(!names.includes("workflow_control"), "workflow_control must never be proxied");
    assert.ok(names.includes("mcp_github"), "non-excluded extension tools must still be proxied");
  });

  test("shape guard: definitions without an executable execute are never proxied", () => {
    const metadataOnly = {
      name: "mcp_broken",
      description: "no execute",
      parameters: Type.Object({}),
    } as ToolDefinition;
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
        registeredTools: [metadataOnly, fakeTool("mcp_ok")],
      }),
      { cwd: process.cwd() },
    );
    const names = toolNames(bundle);
    assert.ok(!names.includes("mcp_broken"), "execute-less defs must be filtered out (signature-drift guard)");
    assert.ok(names.includes("mcp_ok"), "executable defs still merge in");
  });

  test("settings.excludeSubagentTools names are filtered from the proxied bundle", () => {
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
        registeredTools: [fakeTool("mcp_github"), fakeTool("recursive_bridge")],
      }),
      { cwd: process.cwd(), excludeSubagentTools: ["recursive_bridge"] },
    );
    const names = toolNames(bundle);
    assert.ok(!names.includes("recursive_bridge"), "user-excluded tool names must be dropped");
    assert.ok(names.includes("mcp_github"), "other extension tools stay");
    assert.ok(names.includes("bash"), "core tools are unaffected by the extra exclusions");
  });

  test("sessionManager option is threaded into the bridge execution context", async () => {
    // A registered def that reads ctx.sessionManager like 0.83.0's bash tool;
    // the option must reach hostToolsFromDefinitions so subagent bash calls
    // carry the real session identity instead of crashing on undefined.
    const sessionReader: ToolDefinition = {
      name: "session_reader",
      label: "session_reader",
      description: "reads the session-manager surface",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const session = (
          ctx as unknown as { sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined } }
        ).sessionManager;
        if (!session) throw new Error("ctx.sessionManager is undefined");
        return {
          content: [
            { type: "text" as const, text: `${session.getSessionId()}|${session.getSessionFile() ?? "<none>"}` },
          ],
          details: undefined,
        };
      },
    } as ToolDefinition;
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
        registeredTools: [sessionReader],
      }),
      {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "session-xyz", getSessionFile: () => "/tmp/session-xyz.jsonl" },
      },
    );
    const executor = bundle.tools.get("session_reader");
    assert.ok(executor, "session_reader must be proxied");
    assert.deepEqual(await executor({}), {
      content: "session-xyz|/tmp/session-xyz.jsonl",
      isError: false,
      details: undefined,
    });
  });

  test("without a sessionManager option the fallback shim keeps ctx-reading defs working", async () => {
    const sessionReader: ToolDefinition = {
      name: "session_reader",
      label: "session_reader",
      description: "reads the session-manager surface",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const session = (
          ctx as unknown as { sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined } }
        ).sessionManager;
        if (!session) throw new Error("ctx.sessionManager is undefined");
        return {
          content: [
            { type: "text" as const, text: `${session.getSessionId()}|${session.getSessionFile() ?? "<none>"}` },
          ],
          details: undefined,
        };
      },
    } as ToolDefinition;
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
        registeredTools: [sessionReader],
      }),
      { cwd: process.cwd() },
    );
    const executor = bundle.tools.get("session_reader");
    assert.ok(executor, "session_reader must be proxied");
    assert.deepEqual(await executor({}), { content: "host-tool-gateway|<none>", isError: false, details: undefined });
  });

  test("dedupe: a same-named def loses to the earlier core def (first occurrence wins)", () => {
    const bundle = buildMergedHostTools(
      makePi({
        toolInfos: BUILTIN_TOOL_NAMES.map((name) => fakeInfo(name)),
        registeredTools: [fakeTool("read"), fakeTool("web_search"), fakeTool("mcp_x")],
      }),
      { cwd: process.cwd() },
    );
    const names = toolNames(bundle);
    const reads = names.filter((name) => name === "read");
    const webSearches = names.filter((name) => name === "web_search");
    assert.equal(reads.length, 1, "a duplicate 'read' must be deduped away");
    assert.equal(webSearches.length, 1, "a duplicate 'web_search' must be deduped away");
    assert.equal(names.length, CORE_TOOL_NAMES.length + 1, "only mcp_x is additive");
    assert.ok(names.includes("mcp_x"));
  });
});
