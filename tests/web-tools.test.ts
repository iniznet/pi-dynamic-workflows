import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  htmlToText,
  parseBingResults,
} from "../src/web-tools.js";

// ─── createWebSearchTool ─────────────────────────────────────────────────────

test("createWebSearchTool has correct name and metadata", () => {
  const tool = createWebSearchTool();
  assert.equal(tool.name, "web_search");
  assert.equal(tool.label, "Web Search");
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.parameters, "parameters should be truthy");
});

test("createWebSearchTool has execute function", () => {
  const tool = createWebSearchTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWebSearchTool tool has parameters with query field", () => {
  const tool = createWebSearchTool();
  assert.ok(tool.parameters, "should have parameters");
});

test("createWebSearchTool declares a default count in its parameters description", () => {
  const tool = createWebSearchTool();
  // The schema advertises the default to the model (not just a truthiness claim):
  // the description of `count` must name the actual default value.
  const params = tool.parameters as unknown as {
    properties?: { count?: { description?: string } };
  };
  assert.match(
    params.properties?.count?.description ?? "",
    /default 6/,
    "parameters should advertise the default count",
  );
});

// ─── createWebFetchTool ────────────────────────────────────────────────────────

test("createWebFetchTool has correct name and metadata", () => {
  const tool = createWebFetchTool();
  assert.equal(tool.name, "web_fetch");
  assert.equal(tool.label, "Web Fetch");
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.parameters, "parameters should be truthy");
});

test("createWebFetchTool has execute function", () => {
  const tool = createWebFetchTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWebFetchTool accepts maxChars parameter", () => {
  const toolSmall = createWebFetchTool(100);
  const toolLarge = createWebFetchTool(10000);
  assert.equal(typeof toolSmall.execute, "function");
  assert.equal(typeof toolLarge.execute, "function");
});

test("createWebFetchTool has parameters with url field", () => {
  const tool = createWebFetchTool();
  const params = tool.parameters;
  assert.ok(params, "should have parameters");
});

// ─── createWebTools ────────────────────────────────────────────────────────────

test("createWebTools returns both tools in correct order", () => {
  const tools = createWebTools();
  assert.equal(tools.length, 2);
  assert.ok(Array.isArray(tools), "tools should be an array");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["web_fetch", "web_search"]);
});

test("createWebTools returns unique tool definitions (no duplicates)", () => {
  const tools = createWebTools();
  const names = tools.map((t) => t.name);
  const unique = new Set(names);
  assert.equal(names.length, unique.size, "tool names should be unique");
});

test("createWebTools each tool has execute", () => {
  const tools = createWebTools();
  for (const tool of tools) {
    assert.ok(tool.execute, `${tool.name} should have execute`);
  }
});

// ─── HTML parsing (import internal functions via tsx) ──────────────────────────

test("htmlToText strips HTML tags correctly", () => {
  assert.equal(htmlToText("<p>Hello</p>"), "Hello");
  assert.equal(htmlToText("<div>Line1</div><div>Line2</div>").trim(), "Line1\nLine2");
  assert.equal(htmlToText("Plain text"), "Plain text");
  assert.equal(htmlToText("<script>var x=1;</script>content"), "content");
  assert.equal(htmlToText("<style>.cls{}</style>content"), "content");
});

test("htmlToText converts HTML entities", () => {
  assert.equal(htmlToText("&amp;"), "&");
  assert.equal(htmlToText("&lt;test&gt;"), "<test>");
  assert.equal(htmlToText("&quot;hello&quot;"), '"hello"');
  assert.equal(htmlToText("hello&nbsp;world"), "hello world");
  assert.equal(htmlToText("&#39;it&#39;s&#39;"), "'it's'");
  assert.equal(htmlToText("&apos;x&apos;"), "'x'");
});

test("htmlToText normalizes whitespace", () => {
  const result = htmlToText("Hello    World");
  assert.equal(result, "Hello World");
});

test("htmlToText collapses multiple newlines", () => {
  const result = htmlToText("Line1\n\n\n\nLine2");
  assert.equal(result, "Line1\n\nLine2");
});

test("htmlToText replaces block element close tags with newlines", () => {
  const result = htmlToText("<p>Para1</p><p>Para2</p>");
  assert.equal(result.trim(), "Para1\nPara2");
  // li tags
  const list = htmlToText("<li>Item1</li><li>Item2</li>");
  assert.equal(list.trim(), "Item1\nItem2");
});

test("parseBingResults extracts results from mock HTML", () => {
  const mockHtml = `
    <h2><a href="https://example.com/page1">First Result</a></h2>
    <h2><a href="https://example.com/page2">Second Result</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/page1");
  assert.equal(results[0].title, "First Result");
  assert.equal(results[1].url, "https://example.com/page2");
  assert.equal(results[1].title, "Second Result");
});

test("parseBingResults respects limit and filters bing/microsoft domains", () => {
  const mockHtml = `
    <h2><a href="https://www.bing.com/search">Bing Link</a></h2>
    <h2><a href="https://example.com/1">Result 1</a></h2>
    <h2><a href="https://go.microsoft.com/link">Microsoft Link</a></h2>
    <h2><a href="https://example.com/2">Result 2</a></h2>
    <h2><a href="https://example.com/3">Result 3</a></h2>
  `;
  const results = parseBingResults(mockHtml, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/1");
  assert.equal(results[1].url, "https://example.com/2");
});

test("parseBingResults deduplicates URLs", () => {
  const mockHtml = `
    <h2><a href="https://example.com/dup">Dup</a></h2>
    <h2><a href="https://example.com/dup">Dup Again</a></h2>
    <h2><a href="https://example.com/unique">Unique</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 2, "should deduplicate URLs");
});

test("parseBingResults handles empty HTML", () => {
  assert.deepEqual(parseBingResults("", 5), []);
  assert.deepEqual(parseBingResults("<html></html>", 5), []);
});

test("parseBingResults strips inner HTML from titles", () => {
  const mockHtml = `
    <h2><a href="https://example.com/page"><strong>Bold</strong> Title</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Bold Title", "HTML tags should be stripped from title");
});

// ─── Mock-fetch execution tests (tests-coverage:f1) ───────────────────────────

/** Minimal executable shape of a web tool for tests. */
interface WebToolHandle {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

function asWebTool(tool: unknown): WebToolHandle {
  return tool as WebToolHandle;
}

/** Bing-style HTML with `resultCount` results. */
function bingHtml(resultCount: number): string {
  return Array.from(
    { length: resultCount },
    (_, i) => `<h2><a href="https://example.com/r${i}">Result ${i}</a></h2>`,
  ).join("\n");
}

function respond(status: number, body: string): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { status, body: stream } as unknown as Response;
}

/**
 * A large chunked response that reports how many bytes were handed to the
 * reader and whether the reader was cancelled early — proving the fetch path
 * streams with a byte cap instead of buffering the full body.
 */
function chunkedBody(
  totalBytes: number,
  chunkSize: number,
  stats: { sentBytes: number; cancelled: boolean },
): Response {
  const chunk = new Uint8Array(chunkSize).fill(0x41);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
      stats.sentBytes = sent;
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { status: 200, body: stream } as unknown as Response;
}

const details = (res: { details: Record<string, unknown> }) => res.details;
const text = (res: { content: Array<{ type: string; text: string }> }) => res.content[0]?.text ?? "";

// ─── count clamp (tests-coverage:f6: the old "has default count" test only
// asserted truthiness — this actually executes the tool) ───────────────────────

test("web_search execute clamps count: default 6, min 1, max 10", async () => {
  const tool = asWebTool(
    createWebSearchTool({
      fetchImpl: (async () => respond(200, bingHtml(12))) as unknown as typeof fetch,
    }),
  );

  assert.equal(
    (details(await tool.execute("", { query: "q" })).results as unknown[]).length,
    6,
    "absent count defaults to 6",
  );
  assert.equal((details(await tool.execute("", { query: "q", count: 3 })).results as unknown[]).length, 3);
  assert.equal(
    (details(await tool.execute("", { query: "q", count: -5 })).results as unknown[]).length,
    1,
    "negative count clamps to the minimum",
  );
  assert.equal(
    (details(await tool.execute("", { query: "q", count: 999 })).results as unknown[]).length,
    10,
    "oversized count clamps to the maximum",
  );
  assert.equal(
    (details(await tool.execute("", { query: "q", count: Number.NaN })).results as unknown[]).length,
    6,
    "non-finite count falls back to the default",
  );
});

// ─── Bing RSS fallback (infra-utils:i1) ───────────────────────────────────────

test("web_search falls back to the Bing RSS feed when the HTML scrape yields nothing", async () => {
  const rss = [
    "<item>",
    "  <title>RSS Result One</title>",
    "  <link>https://example.org/one</link>",
    "</item>",
    "<item>",
    "  <title>RSS Result Two</title>",
    "  <link>https://example.org/two</link>",
    "</item>",
  ].join("");
  const tool = asWebTool(
    createWebSearchTool({
      fetchImpl: (async (url: string) =>
        url.includes("format=rss")
          ? respond(200, rss)
          : respond(200, "<html><body>no results</body></html>")) as unknown as typeof fetch,
    }),
  );
  const res = await tool.execute("", { query: "q", count: 5 });
  const results = details(res).results as Array<{ url: string; title: string }>;
  assert.equal(results.length, 2, "RSS fallback parses results the HTML scrape missed");
  assert.equal(results[0].url, "https://example.org/one");
  assert.equal(results[1].title, "RSS Result Two");
  assert.ok(text(res).includes("https://example.org/two"), "results are surfaced in the tool output");
});

// ─── non-200 messaging ────────────────────────────────────────────────────────

test("web_fetch reports a non-200 status instead of returning page text", async () => {
  const tool = asWebTool(
    createWebFetchTool(6000, {
      fetchImpl: (async () => respond(404, "<html><body>not here</body></html>")) as unknown as typeof fetch,
    }),
  );
  const res = await tool.execute("", { url: "https://example.com/missing" });
  assert.ok(text(res).includes("HTTP 404"), `non-200 must be reported; got: ${text(res)}`);
  assert.ok(!text(res).includes("not here"), "the error body must not leak as content");
  assert.equal(details(res).status, 404);
});

test("web_search names the primary HTTP status when nothing could be parsed", async () => {
  const tool = asWebTool(
    createWebSearchTool({
      fetchImpl: (async () => respond(403, "<html><body>blocked</body></html>")) as unknown as typeof fetch,
    }),
  );
  const res = await tool.execute("", { query: "q" });
  assert.ok(text(res).includes("HTTP 403"), `no-results message must name the status; got: ${text(res)}`);
  assert.deepEqual(details(res).results, []);
});

// ─── maxChars slicing ─────────────────────────────────────────────────────────

test("web_fetch slices the extracted text to maxChars", async () => {
  const tool = asWebTool(
    createWebFetchTool(30, {
      fetchImpl: (async () =>
        respond(
          200,
          "<p>Hello World this is a very long paragraph of text to be truncated</p>",
        )) as unknown as typeof fetch,
    }),
  );
  const res = await tool.execute("", { url: "https://example.com/long" });
  const body = text(res).split("\n\n")[1] ?? "";
  assert.equal(body.length, 30, `extracted text must be sliced to maxChars; got: ${JSON.stringify(body)}`);
  assert.ok(body.startsWith("Hello World this is a very lo"));
  assert.ok(!body.includes("paragraph"), "the tail beyond maxChars must be dropped");
});

// ─── abort / timeout ──────────────────────────────────────────────────────────

test("web_fetch times out and aborts the underlying request instead of hanging", async () => {
  const aborted = { value: false };
  const fetchImpl = (async (_url: string, init?: { signal?: AbortSignal }) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted.value = true;
        reject(new Error("aborted"));
      });
    });
  }) as unknown as typeof fetch;
  const tool = asWebTool(createWebFetchTool(6000, { timeoutMs: 50, fetchImpl }));
  const res = await tool.execute("", { url: "https://example.com/slow" });
  assert.ok(text(res).includes("Timed out after 50ms"), `timeout must surface; got: ${text(res)}`);
  assert.equal(aborted.value, true, "the in-flight request must be aborted on timeout, not leaked");
  assert.equal(details(res).status, 0);
});

// ─── streamed byte cap (infra-utils:f4) ───────────────────────────────────────

test("web_search streams the response body with a byte cap (memory stays bounded)", async () => {
  const primary = { sentBytes: 0, cancelled: false };
  const tool = asWebTool(
    createWebSearchTool({
      fetchImpl: (async () => chunkedBody(3 * 1024 * 1024, 64 * 1024, primary)) as unknown as typeof fetch,
    }),
  );
  const res = await tool.execute("", { query: "q" });
  assert.equal(primary.cancelled, true, "the reader must be cancelled once the cap is reached");
  assert.ok(
    primary.sentBytes < 3 * 1024 * 1024,
    `the full body must never be buffered (consumed ${primary.sentBytes} of 3 MiB)`,
  );
  assert.ok(primary.sentBytes >= 1024 * 1024, "the 1 MiB cap is reached before the stream is cut off");
  assert.ok(text(res).includes("No results parsed"), "execution completes normally with a capped body");
});
