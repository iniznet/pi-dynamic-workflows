/**
 * extension-tools-capture git-source tests (slice S2, design:
 * tasks/s2-capture-gateway/DESIGN.md): pi-vision-handoff's `describe_image`
 * capture end-to-end against a temp fixture tree that mirrors the
 * `~/.pi/agent/git/github.com/<owner>/<repo>` layout — never the real home
 * dir. Kept in a SEPARATE test file so it gets its own worker process (fresh
 * module registry → fresh per-source capture cache): the empty-roots capture
 * tests in extension-tools-capture.test.ts cache every source as
 * not-installed, and this file must capture the REAL pi-vision-handoff source
 * id against fixture roots.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentRoots,
  createExtensionToolsSupplier,
  defaultAgentRoots,
  EXTENSION_TOOL_SOURCES,
  getExtensionToolSourceResults,
  loadCapturedTools,
} from "../../src/subagent/extension-tools-capture.js";
import { McpToolsManager } from "../../src/subagent/mcp-tools.js";
import { SubagentToolsAssembler } from "../../src/subagent/subagent-tools-assembler.js";

/**
 * A self-contained entry in the S1 dev-checkout shape (default-export factory
 * calling pi.registerTool synchronously). No imports on purpose: the capture
 * test must not depend on the real host-bundle alias discovery or the real
 * pi-vision-handoff checkout — S3 syncs the installed clone with the real
 * entry, which imports ./src/* + @earendil-works/* (the existing alias
 * machinery covers those).
 */
const FIXTURE_ENTRY = `export default function (pi: any): void {
  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description: "Return a text description of an image file",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", description: "Path to an image file" } },
    },
    async execute(_toolCallId: string, params: { path: string }) {
      return { content: [{ type: "text", text: "described " + params.path }] };
    },
  });
}
`;

/** A temp home mirroring the agent's git-install layout (no real home access). */
function fixtureRoots(): AgentRoots {
  const home = mkdtempSync(join(tmpdir(), "ext-tools-vision-"));
  const entry = join(home, ".pi", "agent", "git", "github.com", "iniznet", "pi-vision-handoff", "vision-handoff.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, FIXTURE_ENTRY, "utf8");
  // USERPROFILE wins on Windows, HOME elsewhere — force both so the fixture
  // home is picked regardless of platform.
  return defaultAgentRoots({ USERPROFILE: home, HOME: home });
}

const VISION_SOURCE = EXTENSION_TOOL_SOURCES.find((source) => source.id === "pi-vision-handoff");
assert.ok(VISION_SOURCE, "pi-vision-handoff must be a registered source");

/** A minimal ToolDefinition whose execute echoes its params (assembler-shape parity). */
function fakeHostTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `Fake tool (${name})`,
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: JSON.stringify(params) }], details: undefined };
    },
  } as ToolDefinition;
}

describe("pi-vision-handoff git-source capture (fixture)", () => {
  test("loadCapturedTools captures describe_image from the fixture checkout", async () => {
    const result = await loadCapturedTools(VISION_SOURCE, fixtureRoots());
    assert.equal(result.status, "captured");
    assert.equal(result.label, "pi-vision-handoff");
    assert.deepEqual(
      result.defs.map((def) => def.name),
      ["describe_image"],
    );
  });

  test('"on" mode captures pi-vision-handoff alongside the npm sources', async () => {
    const results = await getExtensionToolSourceResults("on", fixtureRoots());
    assert.equal(results.length, 3);
    const vision = results.find((result) => result.sourceId === "pi-vision-handoff");
    assert.equal(vision?.status, "captured");
    assert.deepEqual(
      vision?.defs.map((def) => def.name),
      ["describe_image"],
    );
    // The fixture home has no npm-installed packages — the npm sources stay
    // truthful (not-installed), never fabricated.
    for (const result of results) {
      if (result.sourceId !== "pi-vision-handoff") assert.equal(result.status, "not-installed");
    }
  });

  test('the "pi-vision-handoff" allowlist captures only that source', async () => {
    const results = await getExtensionToolSourceResults(["pi-vision-handoff"], fixtureRoots());
    assert.equal(results[0].status, "not-enabled"); // supi-web
    assert.equal(results[1].status, "not-enabled"); // pi-codegraph
    const vision = results[2];
    assert.equal(vision.sourceId, "pi-vision-handoff");
    assert.equal(vision.status, "captured");
    assert.deepEqual(
      vision.defs.map((def) => def.name),
      ["describe_image"],
    );
  });
});

describe("SubagentToolsAssembler with the real capture supplier (fixture)", () => {
  function assemblerWith(mode: "on" | ["pi-vision-handoff"], roots: AgentRoots): SubagentToolsAssembler {
    return new SubagentToolsAssembler({
      mode: "all",
      hostTools: () => [fakeHostTool("read"), fakeHostTool("bash")],
      mcpTools: new McpToolsManager({ config: [] }),
      extensionTools: createExtensionToolsSupplier(mode, roots),
    });
  }

  test('describe_image lands in the default toolset when subagentExtensionTools is "on"', async () => {
    const tools = await assemblerWith("on", fixtureRoots()).assemble();
    const describeImage = tools.find((tool) => tool.name === "describe_image");
    assert.ok(describeImage, "describe_image must be assembled from the captured def");
    assert.equal(describeImage.description, "Return a text description of an image file");
  });

  test('describe_image lands when allowlisted with ["pi-vision-handoff"]', async () => {
    const tools = await assemblerWith(["pi-vision-handoff"], fixtureRoots()).assemble();
    assert.ok(tools.some((tool) => tool.name === "describe_image"));
  });

  test("extensionToolsOnly resolves the captured set without the host/MCP bundle", async () => {
    const tools = await assemblerWith("on", fixtureRoots()).extensionToolsOnly();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["describe_image"],
    );
  });
});
