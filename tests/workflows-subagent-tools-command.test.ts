/**
 * `/workflows-subagent-tools` command tests: the pure listing renderer.
 *
 * Coverage: source classification (mcp_* / web / builtin / extension), allow status
 * per subagentTools mode (all → allowed; allowlist → allowlisted), the
 * always-denied workflow/workflow_control rows, settings-denied rows,
 * host-builtin rows that are reachable-if-enabled when host tools are off,
 * and the unavailable rows for host tools the 0.83.0 metadata-only
 * ExtensionAPI cannot execute (chrome/UI/todo/vcc) — the SDK limitation the
 * user asked to keep visible.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildSubagentToolRows,
  classifyToolSource,
  renderSubagentToolsListing,
  type SubagentToolsListingInput,
} from "../src/workflows-subagent-tools-command.js";

/** ToolInfo metadata for a host-registered tool (the getAllTools() shape). */
function fakeInfo(name: string, source: string = "extension"): ToolInfo {
  return {
    name,
    description: `Live ${name} description`,
    parameters: Type.Object({}),
    promptGuidelines: [`Guideline for ${name}`],
    sourceInfo: { path: `<${name}>`, source, scope: "temporary", origin: "top-level" },
  };
}

const HOST_INFOS: ToolInfo[] = [
  fakeInfo("read", "builtin"),
  fakeInfo("bash", "builtin"),
  fakeInfo("grep", "builtin"),
  fakeInfo("web_search", "sdk"),
  fakeInfo("workflow"),
  fakeInfo("workflow_control"),
  fakeInfo("chrome_snapshot"),
  fakeInfo("observe_ui"),
  fakeInfo("todo"),
  fakeInfo("vcc_recall"),
  fakeInfo("mcp"),
];

function listing(overrides: Partial<SubagentToolsListingInput> = {}): SubagentToolsListingInput {
  return {
    mode: "all",
    hostToolsMode: "auto",
    excludeTools: [],
    assembledToolNames: ["read", "bash", "edit", "write", "grep", "web_search", "mcp_svelte_get-docs"],
    hostToolInfos: HOST_INFOS,
    mcpServerNames: ["svelte"],
    ...overrides,
  };
}

function rowByName(rows: ReturnType<typeof buildSubagentToolRows>, name: string) {
  return rows.find((row) => row.name === name);
}

describe("classifyToolSource", () => {
  test("classifies by name namespace", () => {
    assert.equal(classifyToolSource("mcp_svelte_get-docs"), "mcp");
    assert.equal(classifyToolSource("web_search"), "web");
    assert.equal(classifyToolSource("read"), "builtin");
    assert.equal(classifyToolSource("grep"), "builtin");
    assert.equal(classifyToolSource("some_extension_tool"), "extension");
  });
});

describe("buildSubagentToolRows", () => {
  test("all mode marks every assembled tool allowed with its source", () => {
    const rows = buildSubagentToolRows(listing());
    const read = rowByName(rows, "read");
    assert.equal(read?.status, "allowed");
    assert.equal(read?.source, "builtin");
    const mcp = rowByName(rows, "mcp_svelte_get-docs");
    assert.equal(mcp?.status, "allowed");
    assert.equal(mcp?.source, "mcp");
    const web = rowByName(rows, "web_search");
    assert.equal(web?.source, "web");
  });

  test("allowlist mode marks listed mcp_* tools allowlisted", () => {
    const rows = buildSubagentToolRows(
      listing({ mode: ["mcp_svelte_get-docs"], assembledToolNames: ["read", "bash", "mcp_svelte_get-docs"] }),
    );
    assert.equal(rowByName(rows, "mcp_svelte_get-docs")?.status, "allowlisted");
    assert.equal(rowByName(rows, "read")?.status, "allowed");
  });

  test("workflow/workflow_control are always denied even when the host registers them", () => {
    const rows = buildSubagentToolRows(listing());
    assert.equal(rowByName(rows, "workflow")?.status, "denied-always");
    assert.equal(rowByName(rows, "workflow_control")?.status, "denied-always");
  });

  test("settings.excludeSubagentTools names are denied-settings", () => {
    const rows = buildSubagentToolRows(listing({ excludeTools: ["todo"] }));
    assert.equal(rowByName(rows, "todo")?.status, "denied-settings");
  });

  test("host chrome/UI/vcc/mcp tools are unavailable: metadata-only on the 0.83.0 API", () => {
    const rows = buildSubagentToolRows(listing());
    for (const name of ["chrome_snapshot", "observe_ui", "vcc_recall", "mcp"]) {
      const row = rowByName(rows, name);
      assert.equal(row?.status, "unavailable", `${name} must be listed as unavailable`);
      assert.match(row?.note ?? "", /metadata-only/);
    }
  });

  test("host builtins absent from the toolset are available-if-enabled when host tools are off", () => {
    const rows = buildSubagentToolRows(
      listing({
        assembledToolNames: ["read", "bash"],
        hostToolsMode: "off",
        hostToolInfos: [fakeInfo("grep", "builtin")],
      }),
    );
    const grep = rowByName(rows, "grep");
    assert.equal(grep?.status, "available-if-enabled");
    assert.match(grep?.note ?? "", /host tools off/);
  });
});

describe("renderSubagentToolsListing", () => {
  test("the header shows the mode, host mode, and configured MCP servers", () => {
    const md = renderSubagentToolsListing(listing());
    assert.match(md, /MCP tools: \*\*all\*\*/);
    assert.match(md, /Host tools: \*\*auto\*\*/);
    assert.match(md, /MCP servers configured: svelte/);
    assert.match(md, /Always denied: workflow, workflow_control/);
  });

  test("allowlist mode renders the names and marks rows allowlisted", () => {
    const md = renderSubagentToolsListing(
      listing({ mode: ["mcp_svelte_get-docs"], assembledToolNames: ["read", "mcp_svelte_get-docs"] }),
    );
    assert.match(md, /MCP tools: \*\*allowlist \(1\)\*\*/);
    assert.match(md, /mcp_svelte_get-docs/);
  });

  test("empty mode renders the none state with no in-session tools", () => {
    const md = renderSubagentToolsListing(listing({ mode: [], assembledToolNames: [] }));
    assert.match(md, /MCP tools: \*\*none\*\*/);
    assert.match(md, /No tools\. Untagged runs fall back/);
  });

  test("unavailable host tools stay visible in the not-in-session table", () => {
    const md = renderSubagentToolsListing(listing());
    assert.match(md, /#### Not in subagent sessions/);
    assert.match(md, /chrome_snapshot/);
    assert.match(md, /metadata-only/);
  });
});
