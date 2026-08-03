/**
 * buildMergedHostTools + isExcludedHostTool unit tests (host-tool gateway
 * upgrade: proxy every extension-registered tool with feature-detect fallback).
 *
 * Coverage:
 *  - Fallback path: an SDK surface without getAllToolDefinitions (e.g. the
 *    installed 0.80.10) yields exactly the six core host tools — nothing more.
 *  - Feature-detected path: extension-registered tools (MCP, third-party) are
 *    merged into the proxied bundle.
 *  - Exclusions: workflow/workflow_control are NEVER proxied even when the
 *    definitions list contains them; settings.excludeSubagentTools names are
 *    filtered too.
 *  - Dedupe: a same-named extension def loses to the core coding/web def
 *    (hostToolsFromDefinitions keeps the first occurrence).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildMergedHostTools, isExcludedHostTool } from "../src/gateway/subagent-host-tools.js";

/** The six core host tools (createCodingTools + createWebTools), verified live. */
const CORE_TOOL_NAMES = ["read", "bash", "edit", "write", "web_search", "web_fetch"];

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

/** An ExtensionAPI mock exposing getAllToolDefinitions, or a bare API without it. */
function makePi(registeredTools?: ToolDefinition[]): ExtensionAPI {
  if (registeredTools === undefined) return {} as ExtensionAPI;
  return { getAllToolDefinitions: () => registeredTools } as unknown as ExtensionAPI;
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
  test("fallback path: no getAllToolDefinitions on the API surface → exactly the six core tools", () => {
    const bundle = buildMergedHostTools(makePi(), { cwd: process.cwd() });
    assert.deepEqual(
      toolNames(bundle),
      CORE_TOOL_NAMES,
      "an SDK without getAllToolDefinitions must preserve exactly today's bundle",
    );
  });

  test("feature-detected path: extension-registered tools are merged in", () => {
    const bundle = buildMergedHostTools(makePi([fakeTool("mcp_github"), fakeTool("mcp_fs")]), {
      cwd: process.cwd(),
    });
    assert.deepEqual(toolNames(bundle), [...CORE_TOOL_NAMES, "mcp_github", "mcp_fs"]);
  });

  test("workflow/workflow_control are never proxied even when present in the definitions list", () => {
    const bundle = buildMergedHostTools(
      makePi([fakeTool("workflow"), fakeTool("workflow_control"), fakeTool("mcp_github")]),
      { cwd: process.cwd() },
    );
    const names = toolNames(bundle);
    assert.ok(!names.includes("workflow"), "workflow must never be proxied");
    assert.ok(!names.includes("workflow_control"), "workflow_control must never be proxied");
    assert.ok(names.includes("mcp_github"), "non-excluded extension tools must still be proxied");
  });

  test("settings.excludeSubagentTools names are filtered from the proxied bundle", () => {
    const bundle = buildMergedHostTools(makePi([fakeTool("mcp_github"), fakeTool("recursive_bridge")]), {
      cwd: process.cwd(),
      excludeSubagentTools: ["recursive_bridge"],
    });
    const names = toolNames(bundle);
    assert.ok(!names.includes("recursive_bridge"), "user-excluded tool names must be dropped");
    assert.ok(names.includes("mcp_github"), "other extension tools stay");
    assert.ok(names.includes("bash"), "core tools are unaffected by the extra exclusions");
  });

  test("dedupe: a same-named extension def loses to the core tool (first occurrence wins)", () => {
    const bundle = buildMergedHostTools(makePi([fakeTool("read"), fakeTool("web_search"), fakeTool("mcp_x")]), {
      cwd: process.cwd(),
    });
    const names = toolNames(bundle);
    const reads = names.filter((name) => name === "read");
    const webSearches = names.filter((name) => name === "web_search");
    assert.equal(reads.length, 1, "a duplicate 'read' must be deduped away");
    assert.equal(webSearches.length, 1, "a duplicate 'web_search' must be deduped away");
    assert.equal(names.length, CORE_TOOL_NAMES.length + 1, "only mcp_x is additive");
    assert.ok(names.includes("mcp_x"));
  });
});
