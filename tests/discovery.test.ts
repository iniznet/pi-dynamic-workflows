/**
 * SubagentToolDiscovery tests (P11 — design: tasks/a-p04-p11-toolsets/design.md):
 * search/describe/select/capabilities over a fixture capture registry (host +
 * MCP + extension + chrome + damage-control), the deterministic capability
 * classifier, resolvable-vs-missing routing (an agent({ toolNames }) allowlist
 * must never silently drop a tool), named-toolset hints, lazy per-instance
 * materialization, and the excludeTools gate.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  classifyToolCapability,
  createAssemblerSubagentToolDiscovery,
  createSubagentToolDiscovery,
  SubagentToolDiscovery,
  type SubagentToolRegistrySource,
} from "../src/discovery.js";

/** A minimal ToolDefinition whose execute echoes its params as text. */
function fakeTool(name: string, description = `Fake tool (${name})`): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;
}

/** The P04 capture surface + host/MCP/chrome/damage-control fixtures. */
const FIXTURE_SOURCES: SubagentToolRegistrySource[] = [
  { source: "host", tools: [fakeTool("read"), fakeTool("grep"), fakeTool("find"), fakeTool("bash"), fakeTool("edit")] },
  {
    source: "mcp",
    tools: [fakeTool("mcp_docs_get-docs", "Fetch documentation for a library"), fakeTool("mcp_db_query")],
  },
  {
    source: "extension",
    tools: [
      fakeTool("codegraph_search", "Search the code graph for a symbol"),
      fakeTool("web_fetch_md", "Fetch a URL as Markdown"),
      fakeTool("web_docs_search", "Search documentation"),
      fakeTool("describe_image", "Describe an image with a vision model"),
    ],
  },
  { source: "chrome", tools: [fakeTool("chrome_snapshot", "Capture a browser snapshot")] },
  { source: "damage-control", tools: [fakeTool("workflow_damage_control")] },
];

describe("classifyToolCapability", () => {
  test("prefix rules classify the captured registry deterministically", () => {
    assert.deepEqual(classifyToolCapability("mcp_docs_get-docs", ""), { capability: "mcp", tags: [] });
    assert.deepEqual(classifyToolCapability("chrome_snapshot", ""), { capability: "browser", tags: ["automation"] });
    assert.deepEqual(classifyToolCapability("codegraph_search", ""), { capability: "codebase", tags: ["research"] });
    assert.deepEqual(classifyToolCapability("describe_image", ""), { capability: "vision", tags: ["research"] });
    assert.deepEqual(classifyToolCapability("workflow_damage_control", ""), {
      capability: "damage-control",
      tags: [],
    });
    assert.deepEqual(classifyToolCapability("store_put", ""), { capability: "store", tags: [] });
  });

  test("exact host-tool names classify the coding surface", () => {
    assert.deepEqual(classifyToolCapability("web_fetch_md", ""), { capability: "web", tags: ["research"] });
    assert.deepEqual(classifyToolCapability("web_docs_search", ""), { capability: "web", tags: ["research"] });
    assert.deepEqual(classifyToolCapability("read", ""), { capability: "files", tags: ["coding"] });
    assert.deepEqual(classifyToolCapability("bash", ""), { capability: "automation", tags: ["coding"] });
    assert.deepEqual(classifyToolCapability("edit", ""), { capability: "editing", tags: ["coding"] });
  });

  test("description keyword fallback classifies unknown tools deterministically", () => {
    assert.deepEqual(classifyToolCapability("new_mcp_thing", "Fetches web content and searches"), {
      capability: "web",
      tags: ["research"],
    });
    assert.deepEqual(classifyToolCapability("visual_check", "Analyzes an image screenshot"), {
      capability: "vision",
      tags: ["research"],
    });
    assert.equal(classifyToolCapability("mystery", "No keywords here").capability, "coding");
  });
});

describe("SubagentToolDiscovery.search", () => {
  test("no query returns every tool with source/capability/resolvable facts", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const all = await discovery.search();
    assert.equal(all.length, 13);
    const codegraph = all.find((tool) => tool.name === "codegraph_search");
    assert.deepEqual(codegraph?.source, "extension");
    assert.equal(codegraph?.capability, "codebase");
    assert.equal(codegraph?.resolvable, true, "without a resolvable set everything counts as resolvable");
  });

  test("a capability query matches primary capability and tags", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const web = await discovery.search("web");
    assert.deepEqual(web.map((tool) => tool.name).sort(), ["web_docs_search", "web_fetch_md"]);
    const research = await discovery.search("research");
    assert.deepEqual(
      research.map((tool) => tool.name).sort(),
      ["codegraph_search", "describe_image", "web_docs_search", "web_fetch_md"],
      "the research tag groups the captured research surface",
    );
  });

  test("a substring query matches name or description case-insensitively", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const docs = await discovery.search("docs");
    assert.ok(
      docs.some((tool) => tool.name === "web_docs_search"),
      "name substring",
    );
    assert.ok(
      docs.some((tool) => tool.name === "mcp_docs_get-docs"),
      "description substring",
    );
  });

  test("an object query filters by capability/source/name", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const mcp = await discovery.search({ source: "mcp" });
    assert.deepEqual(mcp.map((tool) => tool.name).sort(), ["mcp_db_query", "mcp_docs_get-docs"]);
    const codebase = await discovery.search({ capability: "codebase" });
    assert.deepEqual(
      codebase.map((tool) => tool.name),
      ["codegraph_search"],
    );
    const named = await discovery.search({ name: "describe" });
    assert.deepEqual(
      named.map((tool) => tool.name),
      ["describe_image"],
    );
  });
});

describe("SubagentToolDiscovery.describe", () => {
  test("returns the exact-name descriptor with source/capability", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const tool = await discovery.describe("codegraph_search");
    assert.ok(tool);
    assert.equal(tool.source, "extension");
    assert.equal(tool.capability, "codebase");
    assert.equal(tool.description, "Search the code graph for a symbol");
  });

  test("returns null for an unknown name", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    assert.equal(await discovery.describe("nope"), null);
  });
});

describe("SubagentToolDiscovery.select", () => {
  test("routes a capability to resolvable tool names + reports missing registry tools", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES, {
      resolvableNames: ["read", "grep", "find", "bash", "edit", "codegraph_search", "web_fetch_md"],
    });
    const web = await discovery.select("web");
    assert.equal(web.capability, "web");
    assert.deepEqual(web.toolNames, ["web_fetch_md"], "only names the run can resolve are routable");
    assert.deepEqual(web.missing, ["web_docs_search"], "registry tools outside the run's toolset are reported");
    assert.equal(web.toolset, "extension-tools", "a single-source capability hints its named toolset");
  });

  test("a single-source capability hints its named toolset (research → extension-tools)", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES, {
      resolvableNames: ["web_fetch_md", "codegraph_search"],
    });
    const research = await discovery.select("research");
    assert.deepEqual(research.toolNames, ["codegraph_search", "web_fetch_md"], "registry order preserved");
    assert.equal(research.toolset, "extension-tools", "the captured research surface all lives in one source");
  });

  test("a multi-source capability yields no toolset hint", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const coding = await discovery.select("coding");
    assert.equal(coding.toolset, undefined, "coding spans host tools only but mixes files/automation/editing tags");
  });

  test("browser routes through the chrome named toolset", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const browser = await discovery.select("browser");
    assert.deepEqual(browser.toolNames, ["chrome_snapshot"]);
    assert.equal(browser.toolset, "chrome-tools");
  });

  test("mcp routes through the mcp named toolset", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const mcp = await discovery.select("mcp");
    assert.deepEqual(mcp.toolNames, ["mcp_docs_get-docs", "mcp_db_query"], "registry order is preserved");
    assert.equal(mcp.toolset, "mcp-tools");
  });

  test("an empty selection routes nothing (no error)", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const none = await discovery.select("photography");
    assert.deepEqual(none.toolNames, []);
    assert.deepEqual(none.missing, []);
  });
});

describe("SubagentToolDiscovery.capabilities", () => {
  test("inventories the vocabulary with stable counts and example names", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const capabilities = await discovery.capabilities();
    const web = capabilities.find((entry) => entry.capability === "web");
    assert.equal(web?.count, 2);
    assert.deepEqual(web?.tools, ["web_fetch_md", "web_docs_search"]);
    const codebase = capabilities.find((entry) => entry.capability === "codebase");
    assert.equal(codebase?.count, 1);
    // Deterministic order.
    assert.deepEqual(
      capabilities.map((entry) => entry.capability),
      [...capabilities].sort((a, b) => (a.capability < b.capability ? -1 : 1)).map((entry) => entry.capability),
    );
  });
});

describe("SubagentToolDiscovery lazy materialization", () => {
  test("async suppliers resolve once per instance and the result is cached", async () => {
    let calls = 0;
    const sources: SubagentToolRegistrySource[] = [
      {
        source: "extension",
        tools: async () => {
          calls++;
          return [fakeTool("codegraph_search")];
        },
      },
    ];
    const discovery = new SubagentToolDiscovery(sources);
    await discovery.search();
    await discovery.describe("codegraph_search");
    await discovery.select("codebase");
    assert.equal(calls, 1, "the supplier must be called exactly once per instance");
  });

  test("a throwing supplier degrades to [] (never throws out of a discovery method)", async () => {
    const sources: SubagentToolRegistrySource[] = [
      { source: "extension", tools: () => Promise.reject(new Error("boom")) },
    ];
    const discovery = new SubagentToolDiscovery(sources);
    assert.deepEqual(await discovery.search(), []);
    assert.deepEqual(await discovery.select("web"), { capability: "web", toolNames: [], missing: [] });
  });

  test("excludeTools names never appear in any surface", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES, { excludeTools: ["workflow_damage_control"] });
    const all = await discovery.search();
    assert.ok(!all.some((tool) => tool.name === "workflow_damage_control"));
    assert.equal(await discovery.describe("workflow_damage_control"), null);
    assert.deepEqual(await discovery.select("damage-control"), {
      capability: "damage-control",
      toolNames: [],
      missing: [],
    });
  });

  test("withResolvable returns a NEW instance; the original is unchanged", async () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    const scoped = discovery.withResolvable(["read", "grep", "find", "bash", "edit"]);
    assert.notEqual(scoped, discovery);
    const scopedWeb = await scoped.select("web");
    assert.deepEqual(scopedWeb.toolNames, [], "the scoped run cannot resolve the captured web defs");
    const originalWeb = await discovery.select("web");
    assert.deepEqual(originalWeb.toolNames, ["web_fetch_md", "web_docs_search"], "the original is untouched");
  });
});

describe("createSubagentToolDiscovery", () => {
  test("builds a host-sourced discovery from raw defs", async () => {
    const discovery = createSubagentToolDiscovery([fakeTool("read"), fakeTool("codegraph_search")]);
    const all = await discovery.search();
    assert.equal(all.length, 2);
    assert.equal(all[1]?.source, "host");
  });

  test("passes an existing discovery through unchanged", () => {
    const discovery = new SubagentToolDiscovery(FIXTURE_SOURCES);
    assert.equal(createSubagentToolDiscovery(discovery), discovery);
  });
});

describe("createAssemblerSubagentToolDiscovery", () => {
  test("composes the assembler's named-toolset surfaces with MCP mode filtering", async () => {
    const discovery = createAssemblerSubagentToolDiscovery({
      hostTools: () => [fakeTool("read"), fakeTool("bash")],
      mcpTools: () => [fakeTool("mcp_a_x"), fakeTool("mcp_b_y")],
      mcpMode: ["mcp_a_x"],
      extensionTools: () => [fakeTool("codegraph_search")],
      chromeTools: () => [fakeTool("chrome_launch")],
      damageControlTools: () => [fakeTool("workflow_damage_control")],
      excludeTools: ["bash"],
    });
    const all = await discovery.search();
    assert.deepEqual(
      all.map((tool) => tool.name),
      ["read", "mcp_a_x", "codegraph_search", "chrome_launch", "workflow_damage_control"],
      "mcp allowlist + excludeTools apply; sources compose in assembler order",
    );
    // The mode-filtered mcp defs route through the mcp-tools hint.
    const mcp = await discovery.select("mcp");
    assert.deepEqual(mcp.toolNames, ["mcp_a_x"]);
    assert.equal(mcp.toolset, "mcp-tools");
  });

  test("an off supplier contributes no defs to the discovery", async () => {
    const discovery = createAssemblerSubagentToolDiscovery({
      hostTools: () => [fakeTool("read")],
      mcpTools: () => [],
      mcpMode: "all",
    });
    const all = await discovery.search();
    assert.deepEqual(
      all.map((tool) => tool.name),
      ["read"],
    );
  });
});
