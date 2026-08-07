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
  resolveChromeBridgePort,
} from "../../src/subagent/chrome-bridge-client.js";

type WireRequest = { url: string; init: { method?: string; body?: string; headers?: Record<string, string> } };

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
    const { requests } = fakeFetch([
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

  test("sends the envelope with an application/json content-type header", async () => {
    const { fetchImpl, requests } = fakeFetch([okResult({ ok: true })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    await client.send("tab.list", {}, 1000);
    assert.deepEqual(requests[0].init.headers, { "content-type": "application/json" });
  });

  test("a malformed (non-JSON) response body falls back to a generic bridge error", async () => {
    const { fetchImpl } = fakeFetch([new Response("<html>proxy error</html>", { status: 200 })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    await assert.rejects(client.send("tab.list", {}, 1000), /Chrome bridge owner HTTP 200/);
  });

  test("HTTP 500 with a JSON error body surfaces the bridge's own error text", async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(500, { error: "extension busy" })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    await assert.rejects(client.send("tab.list", {}, 1000), /extension busy/);
  });

  test("the internal deadline (timeoutMs + 2s) times out when the bridge never answers", async () => {
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
    // timeoutMs 0 → the internal timer fires at ~2s; the external signal stays clean so
    // the client must report the owner deadline, not a user abort.
    await assert.rejects(
      client.send("page.snapshot", {}, 0),
      /Timed out waiting for the Chrome bridge owner after 0ms/,
    );
  });

  test("{ok:true} with no result resolves undefined", async () => {
    const { fetchImpl } = fakeFetch([jsonResponse(200, { ok: true })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    assert.equal(await client.send("tab.list", {}, 1000), undefined);
  });
});

describe("ChromeBridgeClient.heartbeat", () => {
  test("POSTs {sessionKey} to <url>/heartbeat and returns true on 2xx", async () => {
    const { fetchImpl, requests } = fakeFetch([jsonResponse(200, { ok: true })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    const result = await client.heartbeat("session:abc");
    assert.equal(result, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:17318/heartbeat");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].init.body ?? "{}"), { sessionKey: "session:abc" });
    assert.deepEqual(requests[0].init.headers, { "content-type": "application/json" });
  });

  test("swallows network failures by default and returns false", async () => {
    const client = new ChromeBridgeClient({
      url: "http://127.0.0.1:17318",
      fetchImpl: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch,
    });
    assert.equal(await client.heartbeat("session:abc"), false);
  });

  test("swallows non-ok HTTP responses by default and returns false", async () => {
    const { fetchImpl } = fakeFetch([new Response("boom", { status: 500 })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    assert.equal(await client.heartbeat("session:abc"), false);
  });

  test("throwOnError rethrows network failures unchanged", async () => {
    const client = new ChromeBridgeClient({
      url: "http://127.0.0.1:17318",
      fetchImpl: (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch,
    });
    await assert.rejects(client.heartbeat("session:abc", { throwOnError: true }), /fetch failed/);
  });

  test("throwOnError rethrows non-ok HTTP responses with the status", async () => {
    const { fetchImpl } = fakeFetch([new Response("boom", { status: 500 })]);
    const client = new ChromeBridgeClient({ url: "http://127.0.0.1:17318", fetchImpl });
    await assert.rejects(client.heartbeat("session:abc", { throwOnError: true }), /heartbeat HTTP 500/);
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

describe("resolveChromeBridgePort (PI_CHROME_BRIDGE_PORT parsing)", () => {
  test("accepts a valid in-range port", () => {
    assert.equal(resolveChromeBridgePort("17318"), 17318);
    assert.equal(resolveChromeBridgePort("1"), 1);
    assert.equal(resolveChromeBridgePort("65535"), 65535);
    assert.equal(resolveChromeBridgePort(" 8080 "), 8080); // Number() trims whitespace
  });

  test("rejects out-of-range and fractional ports with the default", () => {
    assert.equal(resolveChromeBridgePort("0"), 17318);
    assert.equal(resolveChromeBridgePort("-1"), 17318);
    assert.equal(resolveChromeBridgePort("65536"), 17318);
    assert.equal(resolveChromeBridgePort("17318.5"), 17318);
  });

  test("rejects garbage and missing values with the default", () => {
    assert.equal(resolveChromeBridgePort("NaN"), 17318);
    assert.equal(resolveChromeBridgePort("abc"), 17318);
    assert.equal(resolveChromeBridgePort(""), 17318);
    assert.equal(resolveChromeBridgePort(undefined), 17318);
  });

  test("the module default port is derived from the validated parse", () => {
    // No PI_CHROME_BRIDGE_PORT in the test env ⇒ the default URL stays sane.
    assert.equal(new ChromeBridgeClient().url, "http://127.0.0.1:17318");
  });
});
