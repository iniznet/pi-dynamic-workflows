/**
 * Real web tools for research workflows. These execute in the extension host
 * process (which has network access), not in a subagent sandbox, so they perform
 * genuine HTTP requests via Node's fetch.
 *
 * - web_search: best-effort Bing HTML scrape -> Bing RSS fallback -> {url, title}
 * - web_fetch:  fetch a URL and return readable text (HTML stripped, truncated)
 *
 * Memory is bounded: response bodies are streamed with a byte cap (never
 * buffered in full), and the fetch deadline is enforced by a central safe-timer
 * utility that always aborts the underlying request on timeout.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withTimeout } from "./timing.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Default per-request deadline. */
const DEFAULT_TIMEOUT_MS = 15000;
/** Byte cap on a web_search response body (Bing HTML/RSS pages are small). */
const SEARCH_BODY_CAP_BYTES = 1024 * 1024;
/** Base byte cap on a web_fetch response body; scaled up for very large maxChars. */
const FETCH_BODY_CAP_BYTES = 512 * 1024;
/** Search result count clamp bounds. */
const MIN_COUNT = 1;
const MAX_COUNT = 10;
const DEFAULT_COUNT = 6;

/** Options shared by both web tools. */
export interface WebToolOptions {
  /** Per-request deadline; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable fetch implementation (test seam); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch a URL and return its status plus a streamed, byte-capped body.
 * `capBytes` bounds how much of the response is ever held in memory — the
 * reader is cancelled as soon as the cap is reached so the socket is released
 * and the remaining body is never buffered. `withTimeout` aborts the request
 * when the deadline hits.
 */
async function fetchText(
  url: string,
  capBytes: number,
  options: WebToolOptions = {},
): Promise<{ status: number; body: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const request = (async () => {
    const res = await fetchImpl(url, {
      headers: { "user-agent": UA },
      signal: controller.signal,
      redirect: "follow",
    });
    const body = await readBodyCapped(res, capBytes);
    return { status: res.status, body };
  })();
  return withTimeout(request, timeoutMs, `fetch ${url}`, () => controller.abort());
}

/**
 * Stream `res.body` into a string, keeping at most `capBytes` bytes in memory.
 * Chunks are decoded incrementally (so multi-byte UTF-8 sequences split across
 * chunk boundaries survive) and the reader is cancelled at the cap so the
 * connection releases immediately.
 */
async function readBodyCapped(res: Response, capBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = capBytes - total;
      if (remaining <= 0) break;
      if (value.byteLength > remaining) {
        chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
        total += remaining;
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
      total += value.byteLength;
    }
  } finally {
    // Flush any trailing multi-byte sequence held in the decoder.
    chunks.push(decoder.decode());
    await reader.cancel().catch(() => {});
  }
  return chunks.join("");
}

/** Decode the XML entity escapes Bing's RSS feed emits in titles/links. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseBingResults(html: string, limit: number): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = m[1];
    if (/\.bing\.com|go\.microsoft\.com/.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: m[2].replace(/<[^>]+>/g, "").trim() });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Parse Bing's RSS search feed (`/search?format=rss`) into {url, title} pairs.
 * This is the markup-independent fallback for web_search: the RSS schema is
 * stable XML, so results survive Bing HTML redesigns, consent walls, and
 * JS-only markup that would defeat the HTML-scrape parser.
 */
export function parseRssResults(xml: string, limit: number): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const link = item.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? "";
    const url = decodeXmlEntities(link).trim();
    if (!url || /\.bing\.com|go\.microsoft\.com/.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: decodeXmlEntities(title)
        .replace(/<[^>]+>/g, "")
        .trim(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Clamp the requested result count into [MIN_COUNT, MAX_COUNT]; default when absent. */
function clampCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.floor(count)));
}

/** A tool that searches the web (best-effort) and returns result URLs + titles. */
export function createWebSearchTool(options: WebToolOptions = {}): ToolDefinition {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web and return a list of result URLs and titles. Use before web_fetch to find sources.",
    promptSnippet: "Search the web for sources",
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      count: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_COUNT}).` })),
    }),
    async execute(_id, params: { query: string; count?: number }) {
      const limit = clampCount(params.count);
      try {
        const encoded = encodeURIComponent(params.query);
        const primary = await fetchText(`https://www.bing.com/search?q=${encoded}`, SEARCH_BODY_CAP_BYTES, options);
        let results = parseBingResults(primary.body, limit);
        if (!results.length) {
          // Markup-independent fallback: the RSS feed does not depend on the
          // HTML-scrape parser's markup assumptions.
          const rss = await fetchText(
            `https://www.bing.com/search?format=rss&q=${encoded}`,
            SEARCH_BODY_CAP_BYTES,
            options,
          ).catch(() => null);
          if (rss) results = parseRssResults(rss.body, limit);
        }
        const text = results.length
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")
          : `No results parsed (HTTP ${primary.status}). Try a different query or fetch a known URL directly.`;
        return { content: [{ type: "text", text }], details: { results } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `web_search failed: ${error instanceof Error ? error.message : error}` }],
          details: { results: [] as Array<{ url: string; title: string }> },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** A tool that fetches a URL and returns readable text. */
export function createWebFetchTool(maxChars = 6000, options: WebToolOptions = {}): ToolDefinition {
  // The body cap must comfortably cover what maxChars can consume even when
  // HTML-to-text shrinks the output (tags stripped, whitespace collapsed).
  const capBytes = Math.max(FETCH_BODY_CAP_BYTES, maxChars * 16);
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return its readable text content (HTML stripped, truncated).",
    promptSnippet: "Fetch a URL's text",
    parameters: Type.Object({
      url: Type.String({ description: "The absolute URL to fetch." }),
    }),
    async execute(_id, params: { url: string }) {
      try {
        const { status, body } = await fetchText(params.url, capBytes, options);
        if (status >= 400) {
          return {
            content: [{ type: "text", text: `web_fetch failed for ${params.url}: HTTP ${status}` }],
            details: { status, url: params.url },
          };
        }
        const text = htmlToText(body).slice(0, maxChars);
        return {
          content: [{ type: "text", text: `HTTP ${status} ${params.url}\n\n${text}` }],
          details: { status, url: params.url },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `web_fetch failed for ${params.url}: ${error instanceof Error ? error.message : error}`,
            },
          ],
          details: { status: 0, url: params.url },
        };
      }
    },
  }) as unknown as ToolDefinition;
}

/** Both web tools, for injecting into a research workflow's agents. */
export function createWebTools(): ToolDefinition[] {
  return [createWebSearchTool(), createWebFetchTool()];
}
