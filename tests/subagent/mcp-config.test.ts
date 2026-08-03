/**
 * loadMcpConfig tests (design: tasks/subagent-tools-all/DESIGN.md §mcp-config).
 *
 * Never throws: a missing file, malformed JSON, or invalid server entries
 * degrade to an empty server list. Only streamable-HTTP servers are kept;
 * stdio servers are skipped with a one-time warning. The per-server `tools`
 * filter is normalized (`["*"]` → all) and headers pass through as-is.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadMcpConfig } from "../../src/subagent/mcp-config.js";
import { withFakeHome } from "../helpers/fake-home.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Replace console.warn for the duration of a callback; returns captured lines. */
async function captureConsoleWarn<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("loadMcpConfig", () => {
  test("a missing config file yields an empty server list without throwing", () => {
    const dir = makeTempDir("mcp-config-missing-");
    const configPath = join(dir, "does-not-exist", "mcp.json");
    const config = loadMcpConfig({ configPath });
    assert.deepEqual(config.servers, []);
    assert.equal(config.configPath, configPath);
  });

  test("malformed JSON yields an empty list without throwing", () => {
    const dir = makeTempDir("mcp-config-malformed-");
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, "{ this is not json", "utf-8");
    const config = loadMcpConfig({ configPath });
    assert.deepEqual(config.servers, []);
    assert.equal(config.configPath, configPath);
  });

  test("a non-object or mcpServers-less root yields an empty list", () => {
    const dir = makeTempDir("mcp-config-root-");
    for (const [fileName, contents] of [
      ["array.json", "[1, 2, 3]"],
      ["empty-object.json", "{}"],
      ["no-servers.json", '{"imports": ["cursor"]}'],
    ]) {
      const configPath = join(dir, fileName);
      writeFileSync(configPath, contents, "utf-8");
      assert.deepEqual(loadMcpConfig({ configPath }).servers, [], `${fileName} must yield no servers`);
    }
  });

  test("a valid http server is parsed with url, headers and normalized tools", () => {
    const dir = makeTempDir("mcp-config-valid-");
    const configPath = join(dir, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          svelte: {
            type: "http",
            url: "https://mcp.svelte.dev/mcp",
            tools: ["*"],
            headers: { Authorization: "Bearer secret" },
          },
        },
      }),
      "utf-8",
    );

    const config = loadMcpConfig({ configPath });
    assert.equal(config.servers.length, 1);
    const [server] = config.servers;
    assert.equal(server.name, "svelte");
    assert.equal(server.type, "http");
    assert.equal(server.url, "https://mcp.svelte.dev/mcp");
    assert.deepEqual(server.headers, { Authorization: "Bearer secret" });
    // `["*"]` normalizes to "all" (undefined).
    assert.equal(server.tools, undefined);
  });

  test("an explicit per-server tools filter is preserved and invalid entries dropped", () => {
    const dir = makeTempDir("mcp-config-filter-");
    const configPath = join(dir, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          filtered: { type: "http", url: "https://example.com/mcp", tools: ["read", "write", 42, "*"] },
          bare: { type: "http", url: "https://example.com/bare" },
        },
      }),
      "utf-8",
    );

    const config = loadMcpConfig({ configPath });
    const byName = new Map(config.servers.map((server) => [server.name, server]));
    assert.deepEqual(byName.get("filtered")?.tools, ["read", "write"], "only string names survive");
    assert.equal(byName.get("bare")?.tools, undefined, "absent filter means all tools");
  });

  test("stdio (non-http) servers are skipped with a one-time warning", async () => {
    const dir = makeTempDir("mcp-config-stdio-");
    const configPath = join(dir, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          git: { command: "mcp-server-git", args: ["--stdio"] },
          explicit: { type: "stdio", command: "mcp-server-other" },
          ok: { type: "http", url: "https://example.com/mcp" },
        },
      }),
      "utf-8",
    );

    const { value: config, warnings } = await captureConsoleWarn(() => {
      const result = loadMcpConfig({ configPath });
      return Promise.resolve(result);
    });
    assert.deepEqual(
      config.servers.map((server) => server.name),
      ["ok"],
      "only the http server survives",
    );
    assert.ok(
      warnings.some((line) => line.includes("git") && line.includes("not a streamable-HTTP")),
      "the skipped stdio server must be explained in a warning",
    );
    assert.ok(
      warnings.some((line) => line.includes("explicit")),
      "the explicit stdio type must also be warned about",
    );
  });

  test("default path resolves under the agent dir via the SDK getAgentDir", () => {
    const dir = makeTempDir("mcp-config-default-");
    // Isolate from any host-level PI_CODING_AGENT_DIR so the fake home wins.
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      withFakeHome(dir, () => {
        mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
        writeFileSync(
          join(dir, ".pi", "agent", "mcp.json"),
          JSON.stringify({ mcpServers: { svelte: { type: "http", url: "https://mcp.svelte.dev/mcp" } } }),
          "utf-8",
        );
        const config = loadMcpConfig();
        assert.equal(config.configPath, join(dir, ".pi", "agent", "mcp.json"));
        assert.deepEqual(
          config.servers.map((server) => server.name),
          ["svelte"],
        );
      });
    } finally {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  });

  test("a relative configPath resolves against cwd", () => {
    const dir = makeTempDir("mcp-config-relative-");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(
      join(dir, "nested", "mcp.json"),
      JSON.stringify({ mcpServers: { rel: { type: "http", url: "https://example.com/mcp" } } }),
      "utf-8",
    );
    const config = loadMcpConfig({ configPath: "nested/mcp.json", cwd: dir });
    assert.equal(config.configPath, join(dir, "nested", "mcp.json"));
    assert.equal(config.servers.length, 1);
  });
});
