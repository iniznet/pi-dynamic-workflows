/**
 * Vendored chrome tools tests (design: tasks/subagent-chrome-tools/DESIGN.md):
 * the def set mirrors pi-chrome's contract (names + required params), execute
 * gates on the shared auth grant and forwards to the bridge with host-session
 * tagging (sessionKey, groupTitle/joinSessionGroup), and background→foreground
 * conversion matches pi-chrome's wire protocol. The bridge client's fetch is
 * injected per test — no real Chrome is involved.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ChromeBridgeClient, PI_CHROME_AUTH_GLOBAL_KEY } from "../../src/subagent/chrome-bridge-client.js";
import { createVendoredChromeTools } from "../../src/subagent/vendored-chrome-tools.js";

/** The pi-chrome v0.15.46 tool names this vendored set must mirror. */
const EXPECTED_NAMES = [
  "chrome_launch",
  "chrome_tab",
  "chrome_snapshot",
  "chrome_find",
  "chrome_inspect",
  "chrome_navigate",
  "chrome_evaluate",
  "chrome_click",
  "chrome_type",
  "chrome_fill",
  "chrome_key",
  "chrome_wait_for",
  "chrome_list_console_messages",
  "chrome_list_network_requests",
  "chrome_get_network_request",
  "chrome_screenshot",
  "chrome_hover",
  "chrome_drag",
  "chrome_tap",
  "chrome_scroll",
  "chrome_upload_file",
];

type CapturedSend = { action: string; params: Record<string, unknown>; timeoutMs: number };

/** A test client that records wire calls and returns canned results. */
function recordingClient(responses: unknown[]): { client: ChromeBridgeClient; sends: CapturedSend[] } {
  const sends: CapturedSend[] = [];
  const client = new ChromeBridgeClient({
    url: "http://127.0.0.1:17318",
    fetchImpl: (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as {
        action: string;
        params: Record<string, unknown>;
        timeoutMs: number;
      };
      sends.push(body);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify({ ok: true, result: next }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { client, sends };
}

function toolByName(defs: ToolDefinition[], name: string): ToolDefinition {
  const tool = defs.find((def) => def.name === name);
  assert.ok(tool, `tool ${name} must exist in the vendored set`);
  return tool;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY];
});

describe("createVendoredChromeTools contract", () => {
  test("exposes the full pi-chrome v0.15.46 chrome_* set", () => {
    const defs = createVendoredChromeTools();
    assert.deepEqual(
      defs.map((def) => def.name),
      EXPECTED_NAMES,
    );
  });

  test("every def carries a description and parameters schema", () => {
    for (const def of createVendoredChromeTools()) {
      assert.ok(def.description.length > 0, `${def.name} description`);
      assert.ok(def.parameters, `${def.name} parameters`);
    }
  });

  test("each build is a fresh set (no shared mutation across calls)", () => {
    const first = createVendoredChromeTools();
    const second = createVendoredChromeTools();
    assert.notEqual(first, second);
    assert.equal(first.length, second.length);
  });
});

describe("vendored chrome execute", () => {
  test("without an auth grant every page.* execute throws the standard lock message", async () => {
    const { client } = recordingClient([]);
    const defs = createVendoredChromeTools({ client });
    for (const name of ["chrome_snapshot", "chrome_click", "chrome_evaluate"]) {
      await assert.rejects(
        toolByName(defs, name).execute("id", {}, undefined, undefined, {} as never),
        /Chrome control locked/,
      );
    }
  });

  test("snapshot forwards with background→foreground conversion and host session tagging", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client, sends } = recordingClient([{ mode: "auto", title: "T", url: "https://x" }]);
    const defs = createVendoredChromeTools({
      client,
      sessionKey: () => "session:host-1",
      sessionGroupTitle: () => "Pi Session: host",
    });
    const result = await toolByName(defs, "chrome_snapshot").execute(
      "id",
      { mode: "auto" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].action, "page.snapshot");
    assert.equal(sends[0].params.foreground, false, "default background=true maps to foreground=false");
    assert.equal(sends[0].params.sessionKey, "session:host-1");
    assert.equal(sends[0].params.sessionGroupTitle, "Pi Session: host");
    assert.equal(sends[0].params.joinSessionGroup, true);
    assert.ok((result as { content: Array<{ text: string }> }).content[0].text.includes("T"));
  });

  test("explicit background=false maps to foreground=true", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client, sends } = recordingClient([{ title: "T" }]);
    const defs = createVendoredChromeTools({ client, sessionGroupTitle: () => "Pi Session: host" });
    await toolByName(defs, "chrome_snapshot").execute("id", { background: false }, undefined, undefined, {} as never);
    assert.equal(sends[0].params.foreground, true);
  });

  test("tab.new forces the session group title (never a per-subagent group)", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client, sends } = recordingClient([{ id: 7 }]);
    const defs = createVendoredChromeTools({
      client,
      sessionGroupTitle: () => "Pi Session: host",
    });
    await toolByName(defs, "chrome_tab").execute(
      "id",
      { action: "new", url: "https://x" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(sends[0].action, "tab.new");
    assert.equal(sends[0].params.groupTitle, "Pi Session: host");
    assert.equal(sends[0].params.joinSessionGroup, undefined, "tab.* actions never join a group");
  });

  test("chrome_evaluate renders values like the host tool (string passthrough, JSON otherwise)", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client } = recordingClient(["plain string"]);
    const defs = createVendoredChromeTools({ client });
    const result = await toolByName(defs, "chrome_evaluate").execute(
      "id",
      { expression: "1+1" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((result as { content: Array<{ text: string }> }).content[0].text, "plain string");
  });

  test("chrome_wait_for passes params without background conversion (no background param)", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client, sends } = recordingClient([null]);
    const defs = createVendoredChromeTools({ client });
    await toolByName(defs, "chrome_wait_for").execute(
      "id",
      { kind: "selector", value: "#x" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(sends[0].action, "page.waitFor");
    assert.equal(sends[0].params.foreground, undefined);
    assert.equal(sends[0].params.kind, "selector");
  });

  test("bridge failures propagate as thrown errors", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client } = recordingClient([new Error("boom")]);
    const defs = createVendoredChromeTools({ client });
    await assert.rejects(
      toolByName(defs, "chrome_click").execute("id", { uid: "u1" }, undefined, undefined, {} as never),
      /boom/,
    );
  });
});
