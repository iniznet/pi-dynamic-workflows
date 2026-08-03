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
import type { CapturedSourceResult } from "../src/subagent/extension-tools-capture.js";
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
  // Host-registered extension tools (supi-web + pi-codegraph): the listing
  // reports their capture state truthfully instead of the metadata-only row.
  fakeInfo("web_fetch_md"),
  fakeInfo("web_docs_search"),
  fakeInfo("codegraph_search"),
  fakeInfo("codegraph_files"),
];

function listing(overrides: Partial<SubagentToolsListingInput> = {}): SubagentToolsListingInput {
  return {
    mode: "all",
    hostToolsMode: "auto",
    excludeTools: [],
    assembledToolNames: ["read", "bash", "edit", "write", "grep", "web_search", "mcp_svelte_get-docs"],
    hostToolInfos: HOST_INFOS,
    mcpServerNames: ["svelte"],
    chromeToolsMode: "off",
    chromeGranted: false,
    extensionToolsMode: "off",
    extensionToolSources: [],
    ...overrides,
  };
}

function rowByName(rows: ReturnType<typeof buildSubagentToolRows>, name: string) {
  return rows.find((row) => row.name === name);
}

describe("classifyToolSource", () => {
  test("classifies by name namespace", () => {
    assert.equal(classifyToolSource("mcp_svelte_get-docs"), "mcp");
    assert.equal(classifyToolSource("chrome_snapshot"), "chrome");
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

  test("host UI/vcc/mcp tools are unavailable: metadata-only on the 0.83.0 API", () => {
    const rows = buildSubagentToolRows(listing());
    for (const name of ["observe_ui", "vcc_recall", "mcp"]) {
      const row = rowByName(rows, name);
      assert.equal(row?.status, "unavailable", `${name} must be listed as unavailable`);
      assert.match(row?.note ?? "", /metadata-only/);
    }
  });

  test("chrome tools are available-if-enabled when the setting is off", () => {
    const rows = buildSubagentToolRows(listing({ chromeToolsMode: "off" }));
    const chrome = rowByName(rows, "chrome_snapshot");
    assert.equal(chrome?.status, "available-if-enabled");
    assert.equal(chrome?.source, "chrome");
    assert.match(chrome?.note ?? "", /subagentChromeTools is off/);
  });

  test("chrome tools are available-if-enabled when the grant is missing, setting on", () => {
    const rows = buildSubagentToolRows(listing({ chromeToolsMode: "on", chromeGranted: false }));
    const chrome = rowByName(rows, "chrome_snapshot");
    assert.equal(chrome?.status, "available-if-enabled");
    assert.match(chrome?.note ?? "", /no active \/chrome authorize grant/);
  });

  test("assembled chrome tools are allowed with a chrome source note", () => {
    const rows = buildSubagentToolRows(
      listing({ chromeToolsMode: "on", chromeGranted: true, assembledToolNames: ["chrome_snapshot"] }),
    );
    const chrome = rowByName(rows, "chrome_snapshot");
    assert.equal(chrome?.status, "allowed");
    assert.equal(chrome?.source, "chrome");
    assert.match(chrome?.note ?? "", /subagentChromeTools=on/);
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

  test("extension tools hidden when the setting is off get an actionable note", () => {
    const rows = buildSubagentToolRows(listing());
    for (const name of ["web_fetch_md", "web_docs_search", "codegraph_search", "codegraph_files"]) {
      const row = rowByName(rows, name);
      assert.equal(row?.status, "available-if-enabled", `${name} must be available-if-enabled`);
      assert.equal(row?.source, "extension");
      assert.match(row?.note ?? "", /subagentExtensionTools is off/);
    }
  });

  test("extension tools of a source allowlisted out report the missing source", () => {
    const rows = buildSubagentToolRows(
      listing({
        extensionToolsMode: ["pi-codegraph"],
        extensionToolSources: [
          {
            sourceId: "supi-web",
            label: "supi-web",
            defs: [],
            status: "not-enabled",
          } as CapturedSourceResult,
          {
            sourceId: "pi-codegraph",
            label: "pi-codegraph",
            defs: [],
            status: "captured",
          } as CapturedSourceResult,
        ],
      }),
    );
    const web = rowByName(rows, "web_fetch_md");
    assert.equal(web?.status, "available-if-enabled");
    assert.match(web?.note ?? "", /supi-web is not in the subagentExtensionTools allowlist/);
    const cg = rowByName(rows, "codegraph_search");
    assert.equal(cg?.status, "available-if-enabled");
    assert.match(cg?.note ?? "", /captured by pi-codegraph but filtered/);
  });

  test("a captured source whose tools are assembled is allowed with an extension source", () => {
    const rows = buildSubagentToolRows(
      listing({
        extensionToolsMode: "on",
        extensionToolSources: [
          {
            sourceId: "supi-web",
            label: "supi-web",
            defs: [],
            status: "captured",
          } as CapturedSourceResult,
        ],
        assembledToolNames: ["read", "bash", "web_fetch_md"],
      }),
    );
    const web = rowByName(rows, "web_fetch_md");
    assert.equal(web?.status, "allowed");
    assert.equal(web?.source, "extension");
  });

  test("a failing source reports unavailable with its one-line error", () => {
    const rows = buildSubagentToolRows(
      listing({
        extensionToolsMode: "on",
        extensionToolSources: [
          {
            sourceId: "pi-codegraph",
            label: "pi-codegraph",
            defs: [],
            status: "capture-failed",
            error: "capturing pi-codegraph threw: boom",
          } as CapturedSourceResult,
        ],
      }),
    );
    const cg = rowByName(rows, "codegraph_search");
    assert.equal(cg?.status, "unavailable");
    assert.match(cg?.note ?? "", /capture-failed/);
    assert.match(cg?.note ?? "", /boom/);
  });
});

describe("renderSubagentToolsListing", () => {
  test("the header shows the mode, host mode, chrome mode, and configured MCP servers", () => {
    const md = renderSubagentToolsListing(listing());
    assert.match(md, /MCP tools: \*\*all\*\*/);
    assert.match(md, /Host tools: \*\*auto\*\*/);
    assert.match(md, /Chrome tools: \*\*off\*\*/);
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

  test("chrome host tools stay visible in the not-in-session table (not metadata-only)", () => {
    const md = renderSubagentToolsListing(listing());
    assert.match(md, /#### Not in subagent sessions/);
    assert.match(md, /chrome_snapshot/);
    assert.match(md, /subagentChromeTools is off/);
  });

  test("the header renders the extension-tools mode with an actionable hint when off", () => {
    const md = renderSubagentToolsListing(listing());
    assert.match(md, /Extension tools: \*\*off\*\*/);
    assert.match(md, /set settings\.subagentExtensionTools=on/);
  });

  test("the header shows the allowlist and per-source status when enabled", () => {
    const md = renderSubagentToolsListing(
      listing({
        extensionToolsMode: "on",
        extensionToolSources: [
          {
            sourceId: "supi-web",
            label: "supi-web",
            defs: [],
            status: "captured",
          } as CapturedSourceResult,
          {
            sourceId: "pi-codegraph",
            label: "pi-codegraph",
            defs: [],
            status: "not-installed",
          } as CapturedSourceResult,
        ],
      }),
    );
    assert.match(md, /Extension tools: \*\*on\*\*/);
    assert.match(md, /captured in-process from installed sources/);
  });
});
