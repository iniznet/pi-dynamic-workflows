/**
 * Context-cost: shared codebase oracle (T2-B1).
 *
 * A deterministic, ZERO-LLM symbol/type/declaration scan of the workspace
 * (functions / classes / consts / types / interfaces / enums / UPPER_SNAKE
 * tokens with `file:line`), injected ONCE per run so parallel subagents reuse
 * a bounded repo map instead of each re-discovering structure via
 * ls/grep/find/codegraph round trips.
 *
 * Contract:
 *  - DETERMINISTIC: the scan is a pure function of the tree on disk — sorted
 *    walk order, per-line regex extraction, no wall clock, no RNG. Two scans
 *    of the same tree produce byte-identical maps.
 *  - ZERO-LLM / FAIL-CLOSED: recall never guesses. An absent symbol returns
 *    `{ status: "search-required" }` — the caller must search, never assume.
 *    The built-in filesystem live-search fallback (liveSearchFiles /
 *    resolveSymbol) finds REAL disk matches (file:line:text) and only real
 *    matches; a query with no disk match still resolves to search-required.
 *  - CHEAP + BOUNDED: hard caps on file count, per-file bytes, and symbol
 *    count (see DEFAULT_ORACLE_*_MAX_* in config.ts). Huge generated files
 *    and dependency trees never dominate the scan.
 *  - CACHEABLE: scanCodebaseOracle is the raw scan (always re-reads disk);
 *    loadCodebaseOracle is the cached wrapper (module-level, bounded LRU keyed
 *    by cwd + bounds) plus a per-run memo in the WorkflowAgent. A workflow's
 *    N subagents therefore pay ONE scan, not N.
 *
 * Headless-safe: imports only node builtins + config.ts (a pi-tui-free leaf).
 */

import { closeSync, type Dirent, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DEFAULT_ORACLE_ENABLED,
  DEFAULT_ORACLE_MAX_BYTES_PER_FILE,
  DEFAULT_ORACLE_MAX_FILES,
  DEFAULT_ORACLE_MAX_SYMBOLS,
  DEFAULT_ORACLE_RENDER_MAX_TOKENS,
} from "./config.js";

/** Kinds of symbols the zero-LLM scan extracts. */
export type OracleSymbolKind = "function" | "class" | "const" | "type" | "interface" | "enum" | "token";

/** One indexed declaration: name + kind + file:line. */
export interface OracleSymbol {
  name: string;
  kind: OracleSymbolKind;
  /** Path relative to the scan cwd, forward-slash separated (deterministic). */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
}

/**
 * The immutable scan result. `symbols` maps the lowercased symbol name to its
 * declarations (a name may be declared in several files); `files` is the
 * sorted relative file list (reused by the live-search fallback to avoid a
 * second walk).
 */
export interface CodebaseOracle {
  cwd: string;
  symbols: ReadonlyMap<string, readonly OracleSymbol[]>;
  files: readonly string[];
  symbolCount: number;
  fileCount: number;
  /** True when the scan hit a bound (maxFiles/maxSymbols) — the map is partial. */
  truncated: boolean;
}

/** Bounds for scanCodebaseOracle; every field optional (config defaults). */
export interface OracleScanOptions {
  cwd: string;
  /** Hard cap on scanned files (default DEFAULT_ORACLE_MAX_FILES). */
  maxFiles?: number;
  /** Hard cap on retained symbols (default DEFAULT_ORACLE_MAX_SYMBOLS). */
  maxSymbols?: number;
  /** Per-file read cap in bytes (default DEFAULT_ORACLE_MAX_BYTES_PER_FILE). */
  maxBytesPerFile?: number;
  /** File extensions scanned (default: the TS/JS/Svelte source set). */
  includeExtensions?: readonly string[];
  /** Directory names (basename) excluded at any depth. */
  excludeDirs?: ReadonlySet<string>;
  /** True to skip scanning (returns an empty oracle). */
  disabled?: boolean;
}

/** Default source extensions the oracle indexes. */
const DEFAULT_INCLUDE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".svelte",
];

/** Directories never walked (vcs, build output, tool state, vendored deps). */
const DEFAULT_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "coverage",
  ".codegraph",
  ".pi",
  ".svelte-kit",
  ".next",
  "out",
  "tmp",
]);

/** Max directory depth — pathological nesting cannot blow the walk. */
const MAX_SCAN_DEPTH = 16;

/**
 * Per-line declaration pattern. One alternation with named groups so a single
 * regex pass extracts kind + name per line (cheap, deterministic, no parser).
 * Deliberately conservative: destructuring (`const { a } =`), call sites, and
 * non-declaration lines do not match. Comment lines are skipped beforehand.
 */
const DECLARATION_PATTERN =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(?<function>[A-Za-z_$][\w$]*)\s*\(|class\s+(?<class>[A-Za-z_$][\w$]*)|interface\s+(?<interface>[A-Za-z_$][\w$]*)|enum\s+(?<enum>[A-Za-z_$][\w$]*)|type\s+(?<type>[A-Za-z_$][\w$]*)\s*=|const\s+(?<const>[A-Za-z_$][\w$]*)\s*=)/;

/** UPPER_SNAKE / ALL_CAPS consts are indexed as tokens (brief: "tokens"). */
const TOKEN_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** A line that is clearly a comment (never a declaration). */
function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("<!--")
  );
}

/** Bounded read of the first `maxBytes` bytes of a file (huge files never load fully). */
function readBoundedFile(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const size = Math.min(Math.max(0, statSync(filePath).size), maxBytes);
    const buffer = Buffer.alloc(size);
    if (size > 0) readSync(fd, buffer, 0, size, 0);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Bounds the deterministic walk needs (a subset of OracleScanOptions). */
type WalkBounds = {
  cwd: string;
  maxFiles: number;
  maxBytesPerFile: number;
  includeExtensions: readonly string[];
  excludeDirs: ReadonlySet<string>;
};

/** Deterministic bounded walk: sorted entries, excluded dirs skipped, depth-capped. */
function collectCandidateFiles(options: WalkBounds): {
  files: string[];
  truncated: boolean;
} {
  const out: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || out.length >= options.maxFiles) {
      if (out.length >= options.maxFiles) truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, missing) — skipped, never fatal
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= options.maxFiles) {
        truncated = true;
        break;
      }
      if (entry.isDirectory()) {
        if (options.excludeDirs.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      if (!options.includeExtensions.includes(ext)) continue;
      if (out.length < options.maxFiles) {
        out.push(join(dir, entry.name));
      } else {
        truncated = true;
      }
    }
  };
  walk(options.cwd, 0);
  return { files: out, truncated };
}

function toRelPath(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel.split(sep).join("/");
}

/**
 * RAW scan: reads the tree on disk and builds a fresh CodebaseOracle. Always
 * re-scans — use loadCodebaseOracle for the cached wrapper.
 */
export function scanCodebaseOracle(options: OracleScanOptions): CodebaseOracle {
  if (options.disabled === true) {
    return { cwd: options.cwd, symbols: new Map(), files: [], symbolCount: 0, fileCount: 0, truncated: false };
  }
  const bounds = {
    cwd: options.cwd,
    maxFiles: options.maxFiles ?? DEFAULT_ORACLE_MAX_FILES,
    maxSymbols: options.maxSymbols ?? DEFAULT_ORACLE_MAX_SYMBOLS,
    maxBytesPerFile: options.maxBytesPerFile ?? DEFAULT_ORACLE_MAX_BYTES_PER_FILE,
    includeExtensions: options.includeExtensions ?? DEFAULT_INCLUDE_EXTENSIONS,
    excludeDirs: options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS,
  };
  const { files, truncated: filesTruncated } = collectCandidateFiles(bounds);
  const symbolsByLower: Map<string, OracleSymbol[]> = new Map();
  let symbolCount = 0;
  let symbolsTruncated = false;

  outer: for (const filePath of files) {
    if (symbolCount >= bounds.maxSymbols) {
      symbolsTruncated = true;
      break;
    }
    const rel = toRelPath(bounds.cwd, filePath);
    const content = readBoundedFile(filePath, bounds.maxBytesPerFile);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (symbolCount >= bounds.maxSymbols) {
        symbolsTruncated = true;
        break outer;
      }
      const trimmed = lines[i].trim();
      if (!trimmed || isCommentLine(trimmed)) continue;
      const match = DECLARATION_PATTERN.exec(trimmed);
      if (!match?.groups) continue;
      const groups = match.groups as Record<string, string | undefined>;
      const kindEntry = (
        [
          ["function", groups.function],
          ["class", groups.class],
          ["interface", groups.interface],
          ["enum", groups.enum],
          ["type", groups.type],
          ["const", groups.const],
        ] as Array<[OracleSymbolKind, string | undefined]>
      ).find(([, name]) => name !== undefined);
      if (!kindEntry) continue;
      const [baseKind, rawName] = kindEntry;
      const name = rawName as string;
      // UPPER_SNAKE consts are tokens (the brief's "tokens" class).
      const kind: OracleSymbolKind = baseKind === "const" && TOKEN_NAME_PATTERN.test(name) ? "token" : baseKind;
      const symbol: OracleSymbol = { name, kind, file: rel, line: i + 1 };
      const key = name.toLowerCase();
      const bucket = symbolsByLower.get(key);
      if (bucket) bucket.push(symbol);
      else symbolsByLower.set(key, [symbol]);
      symbolCount++;
    }
  }

  return {
    cwd: bounds.cwd,
    symbols: symbolsByLower,
    files,
    symbolCount,
    fileCount: files.length,
    truncated: filesTruncated || symbolsTruncated,
  };
}

// ── module-level cache (bounded LRU keyed by cwd + bounds) ──────────────────

interface OracleCacheEntry {
  oracle: CodebaseOracle;
  order: number;
}

const oracleCache = new Map<string, OracleCacheEntry>();
const ORACLE_CACHE_MAX_ENTRIES = 8;
let cacheOrderCounter = 0;

/** Cache key: cwd + every bound that changes the scan output. */
function oracleCacheKey(options: OracleScanOptions): string {
  return [
    options.cwd,
    options.disabled ?? false,
    options.maxFiles ?? DEFAULT_ORACLE_MAX_FILES,
    options.maxSymbols ?? DEFAULT_ORACLE_MAX_SYMBOLS,
    options.maxBytesPerFile ?? DEFAULT_ORACLE_MAX_BYTES_PER_FILE,
    (options.includeExtensions ?? DEFAULT_INCLUDE_EXTENSIONS).join(","),
  ].join("|");
}

/** Cached oracle for the same cwd+bounds (module-wide, bounded LRU). Returns undefined on cache miss. */
export function getCachedOracle(options: OracleScanOptions): CodebaseOracle | undefined {
  const entry = oracleCache.get(oracleCacheKey(options));
  if (!entry) return undefined;
  entry.order = ++cacheOrderCounter;
  return entry.oracle;
}

/** Clear the module-level oracle cache (tests only — never part of a resume identity). */
export function clearOracleCache(): void {
  oracleCache.clear();
}

/**
 * CACHED scan: scanCodebaseOracle + memoization. A run's N subagents pay one
 * scan. Cache entries are bounded (LRU eviction) so a long-lived process
 * cannot leak.
 */
export function loadCodebaseOracle(options: OracleScanOptions): CodebaseOracle {
  const key = oracleCacheKey(options);
  const cached = oracleCache.get(key);
  if (cached) {
    cached.order = ++cacheOrderCounter;
    return cached.oracle;
  }
  const oracle = scanCodebaseOracle(options);
  oracleCache.set(key, { oracle, order: ++cacheOrderCounter });
  if (oracleCache.size > ORACLE_CACHE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestOrder = Number.POSITIVE_INFINITY;
    for (const [k, entry] of oracleCache) {
      if (entry.order < oldestOrder) {
        oldestOrder = entry.order;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) oracleCache.delete(oldestKey);
  }
  return oracle;
}

// ── fail-closed recall ───────────────────────────────────────────────────────

/** Outcome of recallSymbol: a real index hit, or search-required (never a guess). */
export type OracleRecall =
  | { status: "hit"; source: "index"; query: string; symbols: readonly OracleSymbol[] }
  | { status: "search-required"; query: string; note: string };

/** Normalize a recall query: trim, strip leading/trailing sigils and quotes, lowercase. */
export function normalizeOracleQuery(query: string): string {
  return query
    .trim()
    .replace(/^[$#@`~'"“”]+/, "")
    .replace(/[`~'"“”]+$/, "")
    .toLowerCase();
}

/**
 * FAIL-CLOSED recall: exact-name match first, then case-insensitive substring
 * over indexed names. Absence ⇒ `search-required` — the caller must search,
 * never assume a symbol exists or guess its shape. Deterministic and sync.
 */
export function recallSymbol(oracle: CodebaseOracle, query: string, limit = 20): OracleRecall {
  const normalized = normalizeOracleQuery(query);
  if (!normalized) {
    return { status: "search-required", query, note: "empty query" };
  }
  // Exact-name hits first (deterministic priority over substring).
  const exact = oracle.symbols.get(normalized);
  if (exact && exact.length > 0) {
    return { status: "hit", source: "index", query, symbols: exact.slice(0, limit) };
  }
  // Substring: collect over indexed names in sorted order (deterministic).
  const hits: OracleSymbol[] = [];
  const names = [...oracle.symbols.keys()].sort();
  for (const name of names) {
    if (!name.includes(normalized)) continue;
    const bucket = oracle.symbols.get(name);
    if (bucket) {
      for (const symbol of bucket) {
        hits.push(symbol);
        if (hits.length >= limit) break;
      }
    }
    if (hits.length >= limit) break;
  }
  if (hits.length > 0) {
    return { status: "hit", source: "index", query, symbols: hits };
  }
  return {
    status: "search-required",
    query,
    note: `"${query}" is not in the codebase map — run a targeted search (grep/find) or liveSearchFiles before assuming it does not exist.`,
  };
}

// ── filesystem live-search fallback ──────────────────────────────────────────

/** One live disk match: file:line + the matched line's text (real, never guessed). */
export interface OracleSearchHit {
  file: string;
  line: number;
  text: string;
}

export interface OracleLiveSearchOptions {
  cwd: string;
  /** Reuse an oracle's bounded file list (skips a second walk). */
  files?: readonly string[];
  maxFiles?: number;
  maxBytesPerFile?: number;
  includeExtensions?: readonly string[];
  excludeDirs?: ReadonlySet<string>;
  /** Per-file match cap (default 5). */
  limitPerFile?: number;
  /** Total match cap (default 20). */
  maxHits?: number;
  caseSensitive?: boolean;
}

/**
 * Filesystem live-search fallback: substring search over the bounded source
 * file set (the oracle's own list when provided). Returns REAL disk matches
 * with file:line:text — never a fabrication. Bounded per file and in total;
 * deterministic order (sorted file list, line order).
 */
export function liveSearchFiles(query: string, options: OracleLiveSearchOptions): OracleSearchHit[] {
  const maxHits = options.maxHits ?? 20;
  const limitPerFile = options.limitPerFile ?? 5;
  const needle = options.caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];
  const bounds = {
    cwd: options.cwd,
    maxFiles: options.maxFiles ?? DEFAULT_ORACLE_MAX_FILES,
    maxBytesPerFile: options.maxBytesPerFile ?? DEFAULT_ORACLE_MAX_BYTES_PER_FILE,
    includeExtensions: options.includeExtensions ?? DEFAULT_INCLUDE_EXTENSIONS,
    excludeDirs: options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS,
  };
  const files = options.files ?? collectCandidateFiles(bounds).files;
  const hits: OracleSearchHit[] = [];
  outer: for (const filePath of files) {
    if (hits.length >= maxHits) break;
    const rel = toRelPath(bounds.cwd, filePath);
    let content: string;
    try {
      content = readBoundedFile(filePath, bounds.maxBytesPerFile);
    } catch {
      continue; // unreadable file — skipped
    }
    const lines = content.split(/\r?\n/);
    let perFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const haystack = options.caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) continue;
      hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160) });
      perFile++;
      if (perFile >= limitPerFile || hits.length >= maxHits) break outer;
    }
  }
  return hits;
}

/**
 * Combined resolution outcome: a real hit (from the index OR the live-search
 * fallback) or search-required (neither found a real match — never fabricated).
 */
export type OracleResolution =
  | { status: "hit"; source: "index" | "live-search"; query: string; symbols: readonly OracleSymbol[] }
  | { status: "search-required"; query: string; note: string };

/**
 * Combined resolution: fail-closed index recall first; when it reports
 * search-required, fall back to the filesystem live search (real matches
 * only). Truly absent queries still resolve to search-required.
 */
export function resolveSymbol(
  oracle: CodebaseOracle,
  query: string,
  options?: OracleLiveSearchOptions,
): OracleResolution {
  const recalled = recallSymbol(oracle, query);
  if (recalled.status === "hit") return recalled;
  const liveHits = liveSearchFiles(query, options ?? { cwd: oracle.cwd, files: oracle.files });
  if (liveHits.length === 0) return recalled;
  return {
    status: "hit",
    source: "live-search",
    query,
    symbols: liveHits.map((h) => ({ name: query, kind: "const" as const, file: h.file, line: h.line })),
  };
}

// ── bounded render ───────────────────────────────────────────────────────────

/** chars/4 token heuristic (matches the runtime estimate convention). */
export function estimateOracleTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface OracleRenderOptions {
  /** Token cap on the render (default DEFAULT_ORACLE_RENDER_MAX_TOKENS). */
  maxTokens?: number;
  /** Symbol cap on the render (default DEFAULT_ORACLE_MAX_SYMBOLS). */
  maxSymbols?: number;
}

/**
 * Compact, token-bounded render for prompt injection. Deterministic (sorted by
 * name, then file:line). Includes recall guidance (fail-closed) so a subagent
 * never treats an absent symbol as proof it does not exist. The WHOLE render
 * (header + symbol lines + footer) fits inside the token budget.
 */
export function renderOracle(oracle: CodebaseOracle, options: OracleRenderOptions = {}): string {
  const maxTokens = options.maxTokens ?? DEFAULT_ORACLE_RENDER_MAX_TOKENS;
  const maxSymbols = options.maxSymbols ?? DEFAULT_ORACLE_MAX_SYMBOLS;
  const all = [...oracle.symbols.values()].flat().slice(0, maxSymbols);
  all.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line,
  );

  const header = `Codebase map (${oracle.symbolCount} symbols across ${oracle.fileCount} files${
    oracle.truncated ? ", truncated — partial" : ""
  }):`;
  const footer =
    "Codebase map rules: exact symbols above are authoritative (file:line). A symbol NOT in the map is NOT proof it does not exist — run a targeted search (grep/find) first. Never invent file paths or line numbers from memory.";
  // Reserve the header + footer up front so the total render stays ≤ budget.
  const budget = Math.max(256, maxTokens * 4);
  const lines: string[] = [header];
  let chars = header.length + 4 + footer.length;
  for (const symbol of all) {
    const line = `- ${symbol.name} (${symbol.kind}) ${symbol.file}:${symbol.line}`;
    if (chars + line.length + 2 > budget) {
      lines.push(`- … (${oracle.symbolCount} indexed; bounded map — run a targeted search for the rest)`);
      break;
    }
    lines.push(line);
    chars += line.length + 2;
  }
  lines.push(footer);
  return lines.join("\n");
}

/** The compact follow-up note for agents after the once-per-run full render. */
export function renderOracleFollowup(oracle: CodebaseOracle): string {
  return `Codebase map already provided earlier in this run (${oracle.symbolCount} symbols, ${
    oracle.fileCount
  } files) — reuse it; do not re-discover the repo. For a specific symbol run a targeted search (grep/find) — a symbol absent from the map is not proof it does not exist.`;
}

/**
 * Default-on helper: the oracle is enabled unless a caller explicitly disabled
 * it (context-cost default). Feature-detect-friendly: a `disabled` scan option
 * yields an empty oracle rather than an error, so a hostile environment never
 * breaks an agent.
 */
export function isOracleEnabled(option: boolean | { enabled?: boolean } | undefined): boolean {
  if (option === undefined) return DEFAULT_ORACLE_ENABLED;
  if (typeof option === "boolean") return option;
  return option.enabled ?? DEFAULT_ORACLE_ENABLED;
}
