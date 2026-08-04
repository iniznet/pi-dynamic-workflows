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
import {
  createVendoredChromeTools,
  diffDigests,
  type SnapshotDigest,
  tabActionValues,
} from "../../src/subagent/vendored-chrome-tools.js";

/** The pi-chrome v0.15.46 tool names this vendored set must mirror (22 incl. chrome_diff). */
const EXPECTED_NAMES = [
  "chrome_launch",
  "chrome_tab",
  "chrome_snapshot",
  "chrome_diff",
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

  test("chrome_launch runs the auth gate ONLY on the params.url (tab.new) branch, never on the instruction path", async () => {
    // No grant + no url: the instruction path must NOT throw the lock message.
    const { client, sends } = recordingClient([]);
    const defs = createVendoredChromeTools({ client });
    const result = await toolByName(defs, "chrome_launch").execute("id", {}, undefined, undefined, {} as never);
    assert.ok((result as { content: Array<{ text: string }> }).content[0].text.includes("managed by the host"));
    assert.equal(sends.length, 0, "instruction path never calls the bridge");

    // No grant + url: the real tab.new must be gated.
    await assert.rejects(
      toolByName(defs, "chrome_launch").execute("id", { url: "https://x" }, undefined, undefined, {} as never),
      /Chrome control locked/,
    );

    // Grant + url: tab.new is sent with host-session tagging, and the gate does not run twice.
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const granted = recordingClient([{ id: 7 }]);
    const defs2 = createVendoredChromeTools({
      client: granted.client,
      sessionKey: () => "session:host-1",
      sessionGroupTitle: () => "Pi Session: host",
    });
    await toolByName(defs2, "chrome_launch").execute("id", { url: "https://x" }, undefined, undefined, {} as never);
    assert.equal(granted.sends.length, 1);
    assert.equal(granted.sends[0].action, "tab.new");
    assert.equal(granted.sends[0].params.sessionKey, "session:host-1");
    assert.equal(granted.sends[0].params.groupTitle, "Pi Session: host");
  });
});

describe("chrome_tab save/list (contract S2.2 named-handle registry)", () => {
  test("tabActionValues includes save and list for the named-handle registry", () => {
    assert.deepEqual(tabActionValues, ["list", "new", "activate", "close", "group", "ungroup", "version", "save"]);
  });

  test("chrome_tab save forwards action, name, subagentId and the auto-injected sessionKey", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client, sends } = recordingClient([{ ok: true, handle: { name: "login", tabId: 7 } }]);
    const defs = createVendoredChromeTools({ client, sessionKey: () => "session:host-1" });
    const result = await toolByName(defs, "chrome_tab").execute(
      "id",
      { action: "save", name: "login", subagentId: "sub-1", targetId: "123" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].action, "tab.save");
    assert.equal(sends[0].params.name, "login");
    assert.equal(sends[0].params.subagentId, "sub-1");
    assert.equal(sends[0].params.targetId, "123");
    assert.equal(sends[0].params.sessionKey, "session:host-1");
    assert.equal(sends[0].params.joinSessionGroup, undefined, "tab.* actions never join a group");
    assert.ok(
      (result as { content: Array<{ text: string }> }).content[0].text.includes('Saved handle "login" -> tab 7'),
    );
  });

  test("chrome_tab list forwards the action and formats the handle registry result", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client, sends } = recordingClient([
      { handles: [{ name: "login", tabId: 7, title: "Login", url: "https://x" }] },
    ]);
    const defs = createVendoredChromeTools({ client });
    const result = await toolByName(defs, "chrome_tab").execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(sends[0].action, "tab.list");
    assert.equal(sends[0].params.sessionKey, undefined, "no sessionKey provider, no injection");
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(text.includes("login\t7\tLogin\thttps://x"));
  });

  test("chrome_tab list still formats legacy array results from pre-registry service workers", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client, sends } = recordingClient([[{ id: 1, title: "T", url: "https://x", active: true, windowId: 1 }]]);
    const defs = createVendoredChromeTools({ client });
    const result = await toolByName(defs, "chrome_tab").execute(
      "id",
      { action: "list" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(sends[0].action, "tab.list");
    assert.ok((result as { content: Array<{ text: string }> }).content[0].text.includes("1\t*\tT\thttps://x"));
  });
});

describe("diffDigests + chrome_diff (contract S3.1)", () => {
  const digest = (overrides: Partial<SnapshotDigest> = {}): SnapshotDigest => ({
    url: "https://example.test/page",
    title: "Page",
    textHash: "hash-1",
    focusedUid: null,
    modalUid: null,
    labels: [],
    ...overrides,
  });

  test("identical digests produce an empty diff and the no-change line", async () => {
    const before = digest();
    const after = digest();
    const diff = diffDigests(before, after);
    assert.equal(diff.textHashChanged, false);
    assert.equal(diff.url, undefined);
    assert.equal(diff.title, undefined);
    assert.equal(diff.focusedUid, undefined);
    assert.equal(diff.modalUid, undefined);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.updated.length, 0);
    const defs = createVendoredChromeTools();
    const result = await toolByName(defs, "chrome_diff").execute(
      "id",
      { before, after },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(
      (result as { content: Array<{ text: string }> }).content[0].text,
      "No changes detected between the two snapshots.",
    );
  });

  test("reports url/title/text/focus/modal changes and label add/remove/update", () => {
    const before = digest({
      url: "https://example.test/a",
      title: "A",
      textHash: "h1",
      focusedUid: "e1",
      labels: [
        { uid: "e1", role: "button", label: "Submit" },
        { uid: "e2", role: "textbox", label: "Name", value: "old" },
      ],
    });
    const after = digest({
      url: "https://example.test/b",
      title: "B",
      textHash: "h2",
      focusedUid: "e2",
      modalUid: "m1",
      labels: [
        { uid: "e1", role: "button", label: "Submit", disabled: true },
        { uid: "e3", role: "link", label: "New" },
      ],
    });
    const diff = diffDigests(before, after);
    assert.deepEqual(diff.url, { before: "https://example.test/a", after: "https://example.test/b" });
    assert.deepEqual(diff.title, { before: "A", after: "B" });
    assert.equal(diff.textHashChanged, true);
    assert.deepEqual(diff.focusedUid, { before: "e1", after: "e2" });
    assert.deepEqual(diff.modalUid, { before: null, after: "m1" });
    assert.deepEqual(diff.added, [{ uid: "e3", role: "link", label: "New" }]);
    assert.deepEqual(diff.removed, [{ uid: "e2", role: "textbox", label: "Name" }]);
    assert.equal(diff.updated.length, 1);
    assert.equal(diff.updated[0].uid, "e1");
    assert.equal(diff.updated[0].before.label, "Submit");
    assert.equal(diff.updated[0].after.disabled, true);
  });

  test("chrome_diff renders the contract line vocabulary and passes the structured diff in details", async () => {
    const before = digest();
    const after = digest({
      url: "https://example.test/b",
      textHash: "h2",
      labels: [{ uid: "e1", role: "button", label: "Go" }],
    });
    const defs = createVendoredChromeTools();
    const result = (await toolByName(defs, "chrome_diff").execute(
      "id",
      { before, after },
      undefined,
      undefined,
      {} as never,
    )) as {
      content: Array<{ text: string }>;
      details: { diff: { url?: { before: string; after: string }; added: Array<{ uid: string }>; updated: unknown[] } };
    };
    const text = result.content[0].text;
    assert.ok(text.includes("URL changed: https://example.test/page -> https://example.test/b"));
    assert.ok(text.includes("Text content changed"));
    assert.ok(text.includes('+ button "Go" (e1)'));
    assert.equal(result.details.diff.url?.after, "https://example.test/b");
    assert.equal(result.details.diff.added.length, 1);
  });
});

describe("formatter golden output (shadow DOM + iframe snapshots)", () => {
  // Golden fixture: a snapshot as pi-chrome's shadow-DOM/iframe producers will emit it —
  // elements collected from inside an open shadow root (context = shadow host) and from a
  // child iframe (context = frame label), plus a diff block. The golden string pins that
  // these elements render with uid + role/tag + context + rect, that the iframe itself is
  // not dropped, and that diff sections still format. Change it only deliberately.
  const shadowIframeSnapshot = {
    mode: "auto",
    title: "Shadow + iframe",
    url: "https://example.test/dashboard",
    viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 12 },
    summary: { focused: { uid: "e2", role: "button", label: "Shadow submit" } },
    diff: {
      firstSnapshot: false,
      changes: [{ kind: "textChanged" }, { kind: "title", before: "Old", after: "New" }],
      added: [{ uid: "e2", role: "button", label: "Shadow submit" }],
      updated: [{ uid: "e1", before: { label: "Shadow name old" }, after: { label: "Shadow name" } }],
    },
    elements: [
      {
        uid: "e1",
        tag: "input",
        role: "textbox",
        label: "Shadow name",
        selector: "#shadow-host input",
        rect: { x: 10, y: 20, width: 200, height: 32 },
        context: { uid: "c1", label: "shadow host" },
      },
      {
        uid: "e2",
        tag: "button",
        role: "button",
        label: "Shadow submit",
        selector: "#shadow-host button",
        rect: { x: 10, y: 60, width: 120, height: 36 },
        context: { uid: "c1", label: "shadow host" },
      },
      {
        uid: "e3",
        tag: "iframe",
        role: "iframe",
        label: "Embedded app",
        selector: "iframe[data-app]",
        rect: { x: 0, y: 100, width: 640, height: 480 },
      },
      {
        uid: "e4",
        tag: "a",
        role: "link",
        label: "Inside iframe",
        selector: "a[href='/inside']",
        rect: { x: 20, y: 120, width: 90, height: 20 },
        context: { uid: "c2", label: "frame: embedded-app" },
      },
    ],
  };

  const GOLDEN = `# Chrome snapshot (auto)
Shadow + iframe
https://example.test/dashboard
viewport=1440x900 scroll=0,12
focused: e2 button Shadow submit

## Changed since last snapshot
- text changed
- title: Old → New
- added e2 button Shadow submit
- updated e1 Shadow name

## Visible actions
- e1 textbox Shadow name in c1 shadow host @ 10,20 200x32
- e2 button Shadow submit in c1 shadow host @ 10,60 120x36
- e3 iframe Embedded app @ 0,100 640x480
- e4 link Inside iframe in c2 frame: embedded-app @ 20,120 90x20

Tip: use chrome_snapshot({query:'...', mode:'interactive|forms|pageMap|text|changes|full'}) or nearUid to zoom in.`;

  test("shadow-root elements and iframe elements render with context, uid, role and rect", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client } = recordingClient([shadowIframeSnapshot]);
    const defs = createVendoredChromeTools({ client });
    const result = await toolByName(defs, "chrome_snapshot").execute(
      "id",
      { mode: "auto" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((result as { content: Array<{ text: string }> }).content[0].text, GOLDEN);
  });

  test("the golden output survives a full-mode passthrough (no shadow/iframe loss)", async () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    const { client } = recordingClient([{ ...shadowIframeSnapshot, mode: "full" }]);
    const defs = createVendoredChromeTools({ client });
    const result = await toolByName(defs, "chrome_snapshot").execute(
      "id",
      { mode: "full" },
      undefined,
      undefined,
      {} as never,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(text.includes('"tag": "iframe"'), "full mode keeps the iframe element");
    assert.ok(text.includes('"label": "Shadow submit"'), "full mode keeps the shadow element");
  });
});
