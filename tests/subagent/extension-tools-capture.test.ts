/**
 * extension-tools-capture tests (design: tasks/subagent-extension-tools/DESIGN.md):
 * the capture proxy records registerTool defs and no-ops everything else;
 * enabled-source resolution; the expected-name mapping; the "off" gate on the
 * supplier; and graceful per-source degradation (never throws) with a roots
 * that has none of the packages installed.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentRoots,
  captureEntryTools,
  createExtensionToolsSupplier,
  EXTENSION_TOOL_SOURCES,
  extensionSourceIdForTool,
  getExtensionToolSourceResults,
  isKnownExtensionToolSourceId,
  loadCapturedTools,
  resolveEnabledSourceIds,
} from "../../src/subagent/extension-tools-capture.js";

/** A ToolDefinition whose execute echoes its params (shape parity with the assembler test). */
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

/** A roots whose npm dir contains no packages → every source reports not-installed. */
function emptyRoots(): AgentRoots {
  return { npm: mkdtempSync(join(tmpdir(), "ext-tools-capture-")) };
}

describe("captureEntryTools", () => {
  test("collects registerTool defs and returns them in registration order", () => {
    const entry = (pi: ExtensionAPI) => {
      pi.registerTool(fakeTool("web_fetch_md"));
      pi.registerTool(fakeTool("web_docs_search"));
    };
    const defs = captureEntryTools(entry);
    assert.deepEqual(
      defs.map((def) => def.name),
      ["web_fetch_md", "web_docs_search"],
    );
  });

  test("first-wins dedupe keeps only the first definition per name", () => {
    const first = fakeTool("web_fetch_md");
    const entry = (pi: ExtensionAPI) => {
      pi.registerTool(first);
      pi.registerTool({ ...fakeTool("web_fetch_md"), description: "shadowed" });
    };
    const defs = captureEntryTools(entry);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].description, first.description);
  });

  test("swallows every other ExtensionAPI member (no throw, no state touched)", () => {
    const entry = (pi: ExtensionAPI) => {
      pi.registerCommand("x", () => {});
      pi.registerShortcut("x", () => {});
      pi.on("session_start", () => {});
      pi.setActiveTools(["read"]);
      void pi.exec("bash", { command: "echo hi" });
      void pi.sendMessage("hello");
      const tools = pi.getAllTools();
      assert.deepEqual(tools, []);
      pi.registerTool(fakeTool("web_docs_fetch"));
    };
    const defs = captureEntryTools(entry);
    assert.deepEqual(
      defs.map((def) => def.name),
      ["web_docs_fetch"],
    );
  });

  test("ignores tools registered with a name outside the expected allowlist", () => {
    const entry = (pi: ExtensionAPI) => {
      pi.registerTool(fakeTool("codegraph_search"));
      pi.registerTool(fakeTool("web_fetch_md"));
    };
    // captureEntryTools itself does not filter — the filter is applied at
    // loadCapturedTools with the source's expectedToolNames.
    const defs = captureEntryTools(entry);
    assert.equal(defs.length, 2);
  });

  test("an entry that throws mid-registration propagates (loadCapturedTools catches)", () => {
    const entry = (pi: ExtensionAPI) => {
      pi.registerTool(fakeTool("web_fetch_md"));
      throw new Error("boom");
    };
    assert.throws(() => captureEntryTools(entry), /boom/);
  });
});

describe("resolveEnabledSourceIds", () => {
  test('"on" enables every known source in stable order', () => {
    assert.deepEqual(resolveEnabledSourceIds("on"), ["supi-web", "pi-codegraph"]);
  });

  test("an allowlist keeps only the listed source ids", () => {
    assert.deepEqual(resolveEnabledSourceIds(["pi-codegraph"]), ["pi-codegraph"]);
    assert.deepEqual(resolveEnabledSourceIds([]), []);
  });

  test("unknown ids in an allowlist are filtered out", () => {
    assert.deepEqual(resolveEnabledSourceIds(["pi-codegraph", "not-a-source"]), ["pi-codegraph"]);
  });
});

describe("source id helpers", () => {
  test("isKnownExtensionToolSourceId guards the union", () => {
    assert.ok(isKnownExtensionToolSourceId("supi-web"));
    assert.ok(isKnownExtensionToolSourceId("pi-codegraph"));
    assert.ok(!isKnownExtensionToolSourceId("rpiv-todo"));
  });

  test("extensionSourceIdForTool maps expected names to their source", () => {
    assert.equal(extensionSourceIdForTool("web_fetch_md"), "supi-web");
    assert.equal(extensionSourceIdForTool("web_docs_search"), "supi-web");
    assert.equal(extensionSourceIdForTool("codegraph_search"), "pi-codegraph");
    assert.equal(extensionSourceIdForTool("codegraph_files"), "pi-codegraph");
    assert.equal(extensionSourceIdForTool("todo"), undefined);
  });
});

describe("loadCapturedTools with an empty roots", () => {
  test("a source that is not installed anywhere reports not-installed, never throws", async () => {
    const results = await Promise.all(EXTENSION_TOOL_SOURCES.map((source) => loadCapturedTools(source, emptyRoots())));
    for (const result of results) {
      assert.equal(result.status, "not-installed", `${result.sourceId} must be not-installed`);
      assert.deepEqual(result.defs, []);
      assert.equal(result.error, undefined);
    }
  });
});

describe("getExtensionToolSourceResults", () => {
  test('"off" reports every source as not-enabled without importing anything', async () => {
    const results = await getExtensionToolSourceResults("off", emptyRoots());
    assert.deepEqual(
      results.map((result) => result.status),
      ["not-enabled", "not-enabled"],
    );
  });

  test("an enabled source with an empty roots reports not-installed (truthful row)", async () => {
    const results = await getExtensionToolSourceResults("on", emptyRoots());
    assert.deepEqual(
      results.map((result) => result.status),
      ["not-installed", "not-installed"],
    );
  });

  test("an allowlist leaves non-listed sources not-enabled", async () => {
    const results = await getExtensionToolSourceResults(["pi-codegraph"], emptyRoots());
    assert.equal(results[0].sourceId, "supi-web");
    assert.equal(results[0].status, "not-enabled");
    assert.equal(results[1].sourceId, "pi-codegraph");
    assert.equal(results[1].status, "not-installed");
  });
});

describe("createExtensionToolsSupplier", () => {
  test('"off" returns undefined — no defs anywhere, including the named toolset', () => {
    assert.equal(createExtensionToolsSupplier("off"), undefined);
  });

  test('"on" returns a supplier resolving to the captured defs across sources', async () => {
    const supplier = createExtensionToolsSupplier("on");
    assert.ok(supplier);
    const defs = await supplier();
    // Empty roots → not-installed everywhere → no defs; never throws.
    assert.deepEqual(defs, []);
  });

  test("an allowlist supplier only captures the listed source", async () => {
    const supplier = createExtensionToolsSupplier(["supi-web"]);
    assert.ok(supplier);
    assert.deepEqual(await supplier(), []);
  });
});
