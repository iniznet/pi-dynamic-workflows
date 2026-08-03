/**
 * ChromeBridgeClient tests (design: tasks/subagent-chrome-tools/DESIGN.md):
 * the client-only bridge POST (URL/body/error mapping/AbortSignal) and the
 * shared auth-grant helpers. The client is a thin HTTP wrapper, so the fetch
 * is injected per test — no real network, no bridge server.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  CHROME_CONTROL_LOCKED_MESSAGE,
  ChromeBridgeClient,
  isChromeAuthorized,
  PI_CHROME_AUTH_GLOBAL_KEY,
  readChromeAuthGrant,
  requireChromeAuthorized,
} from "../../src/subagent/chrome-bridge-client.js";

type WireRequest = { url: string; init: { method?: string; body?: string } };

/** Records every fetch call; responds per the queued responder list. */
function fakeFetch(responders: Array<Response | Error>): { fetchImpl: typeof fetch; requests: WireRequest[] } {
  const requests: WireRequest[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const req = { url: String(url), init: (init ?? {}) as WireRequest["init"] };
    requests.push(req);
    const next = responders.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(null, { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A normal bridge success for a single action. */
function okResult(result: unknown): Response {
  return jsonResponse(200, { ok: true, result });
}

afterEach(() => {
  // Restore globalThis in case a test wrote the shared grant.
  delete (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY];
});

describe("ChromeBridgeClient.send", () => {
  test("POSTs {action, params, timeoutMs} to <url>/command and returns result", async () => {
    const { fetchImpl, requests } = fakeFetch([okResult({ ok: true, tabs: [] })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    const result = await client.send("tab.list", { sessionKey: "session:abc" }, 30_000);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:17318/command");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].init.body ?? "{}"), {
      action: "tab.list",
      params: { sessionKey: "session:abc" },
      timeoutMs: 30_000,
    });
    assert.deepEqual(result, { ok: true, tabs: [] });
  });

  test("defaults to the env-overridable bridge URL", () => {
    assert.equal(new ChromeBridgeClient().url, "http://127.0.0.1:17318");
  });

  test("!ok payloads surface the bridge's own error text", async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(200, { ok: false, error: "no active tab" })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    await assert.rejects(client.send("page.snapshot", {}, 1000), /no active tab/);
  });

  test("HTTP 404 (bridge owner too old for multi-session) maps to an actionable message", async () => {
    const { fetchImpl } = fakeFetch([new Response("not found", { status: 404 })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    await assert.rejects(client.send("tab.list", {}, 1000), /older pi-chrome/);
  });

  test("connection refused maps to a clear pi-chrome-not-reachable message", async () => {
    // Simulate undici's fetch-failed wrapping of ECONNREFUSED.
    const failing = new ChromeBridgeClient({
      url: "http://127.0.0.1:17318",
      fetchImpl: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      failing.send("tab.list", {}, 1000),
      /Chrome bridge at http:\/\/127\.0\.0\.1:17318 is not reachable/,
    );
  });

  test("a pre-aborted signal rejects with the abort message", async () => {
    const { fetchImpl } = fakeFetch([okResult(null)]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.send("page.evaluate", {}, 1000, controller.signal), /aborted/);
  });

  test("aborting mid-flight propagates to the fetch request", async () => {
    const { fetchImpl, requests } = fakeFetch([
      new Response("unused", { status: 500 }), // reached only if abort fails
    ]);
    const client = new ChromeBridgeClient({
      url: "http://127.0.0.1:17318",
      fetchImpl: (async (_url: unknown, init: unknown) => {
        await new Promise((_resolve, reject) => {
          (init as { signal: AbortSignal }).signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.send("page.snapshot", {}, 10_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /aborted/);
    assert.equal(requests.length, 0); // the stubbed fetch never returned a response
  });
});

describe("shared chrome auth grant", () => {
  test("reads pi-chrome's globalThis grant when valid", () => {
    const until = Date.now() + 60_000;
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until };
    assert.deepEqual(readChromeAuthGrant(), { until });
    assert.equal(isChromeAuthorized(), true);
  });

  test("indefinite grants never expire", () => {
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    assert.equal(isChromeAuthorized(), true);
  });

  test("absent or expired grants are not authorized and get dropped", () => {
    assert.equal(isChromeAuthorized(), false);
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: Date.now() - 1 };
    assert.equal(isChromeAuthorized(), false);
    assert.equal(
      (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY],
      undefined,
      "expired grant is cleaned up",
    );
  });

  test("requireChromeAuthorized throws the standard lock message", () => {
    assert.throws(
      () => requireChromeAuthorized(),
      (error: Error) => {
        assert.equal(error.message, CHROME_CONTROL_LOCKED_MESSAGE);
        return true;
      },
    );
    (globalThis as Record<string, unknown>)[PI_CHROME_AUTH_GLOBAL_KEY] = { until: "indefinite" };
    requireChromeAuthorized(); // does not throw
  });
});
