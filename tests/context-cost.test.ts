/**
 * Context-cost slice tests (T2-B1):
 *  1. SCOPED PER-AGENT CONTEXT — the shared resource loader strips the ~3.1
 *     ktok skill-stub block by default (passive slices); "all" stays opt-in;
 *     per-mode memoization; mode-aware system-prefix estimate.
 *  2. SHARED CODEBASE ORACLE — deterministic zero-LLM scan (functions/classes/
 *     consts/tokens with file:line), fail-closed recall (absence ⇒
 *     search-required, never a guess), filesystem live-search fallback, and
 *     bounded/cacheable scan.
 *  3. WIRING — oracle injected into subagent prompts (scan once, bounded
 *     render); estimate-forecast reflects the scoped-context savings.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowAgent } from "../src/agent.js";
import {
  type CodebaseOracle,
  clearOracleCache,
  estimateOracleTokens,
  isOracleEnabled,
  liveSearchFiles,
  loadCodebaseOracle,
  recallSymbol,
  renderOracle,
  resolveSymbol,
  scanCodebaseOracle,
} from "../src/codebase-oracle.js";
import {
  DEFAULT_ORACLE_MAX_FILES,
  DEFAULT_ORACLE_MAX_SYMBOLS,
  DEFAULT_ORACLE_RENDER_MAX_TOKENS,
  DEFAULT_SUBAGENT_SKILLS,
  SUBAGENT_SKILL_STUB_BLOCK_TOKENS,
} from "../src/config.js";
import { estimateWorkflowForecast } from "../src/estimate-forecast.js";
import { rmForce } from "./helpers/rm-force.js";

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeTree(root: string, files: Array<[rel: string, content: string]>): void {
  for (const [rel, content] of files) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }
}

const FIXTURE_FILES: Array<[string, string]> = [
  [
    "src/agent.ts",
    [
      "import { x } from './x.js';",
      "export async function runAgent(prompt) {",
      "  return prompt;",
      "}",
      "export class AgentRunner {",
      "  constructor() {}",
      "}",
      "const DEFAULT_LIMIT = 10;",
      "export const agentName = 'agent';",
      "export interface AgentOptions {",
      "  label?: string;",
      "}",
      "export type AgentResult = string;",
      "export enum AgentKind {",
      "  Passive = 'passive',",
      "}",
      "function helper() { return 1; }",
      "",
    ].join("\n"),
  ],
  ["src/oracle.ts", "export function scanOracle(root) {}\nconst MAX_SCAN_DEPTH = 16;\n"],
  ["lib/util.js", "export const LIB_VERSION = '1.0.0';\nexport function utilHelper() {}\n"],
  ["node_modules/keep.ts", "export function shouldBeIgnored() {}\n"],
];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-context-cost-"));
  makeTree(root, FIXTURE_FILES);
  return root;
}

function loadFixtureOracle(root: string, extra?: Parameters<typeof scanCodebaseOracle>[0]): CodebaseOracle {
  return loadCodebaseOracle({ cwd: root, ...extra });
}

// ── 1. scoped per-agent context ──────────────────────────────────────────────

test("context-cost: DEFAULT_SUBAGENT_SKILLS flips to none (scoped) — the default-on knob", () => {
  assert.equal(DEFAULT_SUBAGENT_SKILLS, "none");
  assert.ok(
    SUBAGENT_SKILL_STUB_BLOCK_TOKENS >= 3_000,
    "the documented skill-block saving is ~3.1 ktok per passive agent",
  );
});

test("scoped loading strips the skill block for passive slices by default; 'all' stays opt-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-context-skills-"));
  try {
    type Priv = { getSharedResourceLoader(agentDir: string): Promise<{ noSkills?: boolean }> };
    // Default (scoped): the passive slice skips the ~3.1 ktok skill-stub block.
    const passive = new WorkflowAgent({ cwd: dir });
    const passiveLoader = await (passive as unknown as Priv).getSharedResourceLoader(dir);
    assert.equal(passiveLoader.noSkills, true, "default-on scoped loading strips the skill block");

    // Explicit "all": the opt-in keeps the block (parity for skill-hungry slices).
    const full = new WorkflowAgent({ cwd: dir, subagentSkills: "all" });
    const fullLoader = await (full as unknown as Priv).getSharedResourceLoader(dir);
    assert.equal(fullLoader.noSkills, false, "'all' opt-in keeps the skill-stub block");
  } finally {
    await rmForce(dir);
  }
});

test("the shared loader is memoized PER MODE — mixed runs pay one build per mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-context-modes-"));
  try {
    type Priv = {
      getSharedResourceLoader(agentDir: string, mode?: "scoped" | "full"): Promise<{ noSkills?: boolean }>;
    };
    const agent = new WorkflowAgent({ cwd: dir, subagentSkills: "none" });
    const priv = agent as unknown as Priv;
    const scoped1 = priv.getSharedResourceLoader(dir, "scoped");
    const scoped2 = priv.getSharedResourceLoader(dir, "scoped");
    assert.equal(scoped1, scoped2, "same mode → the same promise (built once, shared across subagents)");
    const full1 = priv.getSharedResourceLoader(dir, "full");
    const full2 = priv.getSharedResourceLoader(dir, "full");
    assert.equal(full1, full2, "the full mode is independently memoized");
    assert.notEqual(scoped1, full1, "scoped and full loaders are distinct (mixed-run support)");
    const scopedLoader = await scoped1;
    const fullLoader = await full1;
    assert.equal(scopedLoader.noSkills, true);
    assert.equal(fullLoader.noSkills, false);
    scoped2.catch(() => {});
    full2.catch(() => {});
  } finally {
    await rmForce(dir);
  }
});

test("the loader never breaks an agent: both modes build a usable loader over a real agent dir", async () => {
  // The graceful-fallback contract: even when the SDK surface differs, the
  // loader still constructs (noSkills may be ignored — parity — but never a
  // throw that strands a subagent). A bare temp cwd is the hostile case.
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-context-hostile-"));
  try {
    type Priv = { getSharedResourceLoader(agentDir: string): Promise<unknown> };
    const agent = new WorkflowAgent({ cwd: dir });
    const loader = await (agent as unknown as Priv).getSharedResourceLoader(dir);
    assert.ok(loader !== undefined && typeof loader === "object", "scoped mode yields a usable loader");
    const fullAgent = new WorkflowAgent({ cwd: dir, subagentSkills: "all" });
    const fullLoader = await (fullAgent as unknown as Priv).getSharedResourceLoader(dir);
    assert.ok(fullLoader !== undefined && typeof fullLoader === "object", "full mode yields a usable loader");
  } finally {
    await rmForce(dir);
  }
});

// ── 2. shared codebase oracle: scan ──────────────────────────────────────────

test("oracle scan extracts functions/classes/consts/tokens with file:line (zero-LLM, deterministic)", () => {
  const root = fixtureRoot();
  try {
    const oracle = scanCodebaseOracle({ cwd: root });
    assert.equal(oracle.fileCount, 3, "ignored/ and non-source files are excluded");
    assert.ok(oracle.symbolCount >= 10, `expected a real symbol count, got ${oracle.symbolCount}`);

    const run = oracle.symbols.get("runagent");
    assert.ok(run && run.length === 1, "runAgent is indexed (name lowercased)");
    assert.equal(run[0].kind, "function");
    assert.equal(run[0].file, "src/agent.ts");
    assert.equal(run[0].line, 2);

    const runner = oracle.symbols.get("agentrunner");
    assert.ok(runner && runner[0].kind === "class", "class extracted");

    // UPPER_SNAKE consts are indexed as tokens.
    const defaultLimit = oracle.symbols.get("default_limit");
    assert.ok(defaultLimit && defaultLimit[0].kind === "token", "DEFAULT_LIMIT is a token");
    const libVersion = oracle.symbols.get("lib_version");
    assert.ok(libVersion && libVersion[0].kind === "token", "LIB_VERSION is a token");

    const result = oracle.symbols.get("agentresult");
    assert.ok(result && result[0].kind === "type", "type alias extracted");
    const options = oracle.symbols.get("agentoptions");
    assert.ok(options && options[0].kind === "interface", "interface extracted");
    const kind = oracle.symbols.get("agentkind");
    assert.ok(kind && kind[0].kind === "enum", "enum extracted");

    // Determinism: a second raw scan is identical.
    const again = scanCodebaseOracle({ cwd: root });
    assert.deepEqual([...again.symbols.keys()].sort(), [...oracle.symbols.keys()].sort());
    assert.equal(again.symbolCount, oracle.symbolCount);
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

test("oracle scan is cacheable: loadCodebaseOracle returns the same map for the same cwd+bounds", () => {
  const root = fixtureRoot();
  try {
    const first = loadCodebaseOracle({ cwd: root });
    const second = loadCodebaseOracle({ cwd: root });
    assert.equal(first, second, "module-level cache serves the identical oracle object");
    assert.equal(first.symbolCount, second.symbolCount);
    // A different bound is a different cache key (fresh scan).
    const bigger = loadCodebaseOracle({ cwd: root, maxSymbols: 10_000 });
    assert.notEqual(first, bigger, "a different bound re-scans (never serves a stale map)");
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

test("oracle scan is BOUNDED: maxFiles and maxSymbols caps + truncated flag", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-context-bound-"));
  try {
    const files: Array<[string, string]> = [];
    for (let i = 0; i < 20; i++) {
      files.push([`src/mod${String(i).padStart(2, "0")}.ts`, `export function fn${i}() {}\nexport const C${i} = 1;\n`]);
    }
    makeTree(root, files);

    const byFiles = scanCodebaseOracle({ cwd: root, maxFiles: 5 });
    assert.equal(byFiles.fileCount, 5, "maxFiles caps the walked file count");
    assert.equal(byFiles.truncated, true, "hitting maxFiles marks the map truncated (partial — fail-closed)");

    const bySymbols = scanCodebaseOracle({ cwd: root, maxFiles: 20, maxSymbols: 7 });
    assert.ok(bySymbols.symbolCount <= 7, `maxSymbols caps the retained symbols, got ${bySymbols.symbolCount}`);
    assert.equal(bySymbols.truncated, true, "hitting maxSymbols marks the map truncated");

    // A tree inside a bounded scan never walks excluded dirs.
    const oracle = scanCodebaseOracle({ cwd: root, maxFiles: 20 });
    assert.ok(
      oracle.files.every((f) => !f.includes("node_modules")),
      "node_modules/dist/.git are never scanned",
    );
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

// ── 2b. oracle recall + live-search fallback ────────────────────────────────

test("oracle recall is FAIL-CLOSED: exact hit, substring hit, absence ⇒ search-required (never a guess)", () => {
  const root = fixtureRoot();
  try {
    const oracle = loadFixtureOracle(root);
    // Exact name (case-insensitive) → hit with authoritative file:line.
    const exact = recallSymbol(oracle, "runAgent");
    assert.equal(exact.status, "hit");
    if (exact.status === "hit") {
      assert.equal(exact.symbols.length, 1);
      assert.equal(exact.symbols[0].file, "src/agent.ts");
      assert.equal(exact.symbols[0].line, 2);
    }
    // Substring → hit.
    const sub = recallSymbol(oracle, "agent");
    assert.equal(sub.status, "hit");
    if (sub.status === "hit") assert.ok(sub.symbols.length >= 1);
    // Absence → search-required, explicitly telling the caller to search.
    const absent = recallSymbol(oracle, "thisSymbolDoesNotExist");
    assert.equal(absent.status, "search-required");
    if (absent.status === "search-required") {
      assert.match(absent.note, /search/i, "the note directs a targeted search");
    }
    // Sigils are stripped before matching (backtick-quoted symbols).
    const ticked = recallSymbol(oracle, "`runAgent`");
    assert.equal(ticked.status, "hit");
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

test("live-search fallback finds REAL disk matches the index missed (new/string/comment text)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-context-live-"));
  try {
    // The index only extracts declarations — a string/comment mention is a
    // legitimate miss the live search must recover from.
    makeTree(root, [
      ["src/agent.ts", "export function runAgent() {}\n// see runAgent's sibling: runAgentBroker in this comment\n"],
    ]);
    const oracle = loadCodebaseOracle({ cwd: root });
    const recalled = recallSymbol(oracle, "runAgentBroker");
    assert.equal(recalled.status, "search-required", "the index has no such declaration");

    const resolved = resolveSymbol(oracle, "runAgentBroker");
    assert.equal(resolved.status, "hit");
    if (resolved.status === "hit") {
      assert.equal(resolved.source, "live-search", "fallback kicked in after the index missed");
      assert.equal(resolved.symbols[0].file, "src/agent.ts");
      assert.ok(resolved.symbols[0].line >= 2, "the matched line is real");
    }

    // A truly absent query stays search-required even after the fallback.
    const gone = resolveSymbol(oracle, "definitelyNotAnywhereZzz");
    assert.equal(gone.status, "search-required");
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

test("live-search honors its bounds (limitPerFile + maxHits)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-context-liveb-"));
  try {
    const lines = Array.from({ length: 50 }, (_, i) => `export const A${i} = 'needle-${i}';`).join("\n");
    makeTree(root, [
      ["src/a.ts", lines],
      ["src/b.ts", lines],
    ]);
    const hits = liveSearchFiles("needle", {
      cwd: root,
      files: ["src/a.ts", "src/b.ts"].map((f) => join(root, f)),
      limitPerFile: 3,
      maxHits: 5,
    });
    assert.ok(hits.length <= 5, `maxHits caps total hits, got ${hits.length}`);
    const perFile = new Map<string, number>();
    for (const hit of hits) perFile.set(hit.file, (perFile.get(hit.file) ?? 0) + 1);
    for (const count of perFile.values()) assert.ok(count <= 3, "limitPerFile caps per-file hits");
  } finally {
    void rmForce(root).catch(() => {});
  }
});

test("the oracle render is token-bounded and self-describing (bounded map)", () => {
  const root = fixtureRoot();
  try {
    const oracle = loadFixtureOracle(root);
    const render = renderOracle(oracle);
    assert.ok(
      estimateOracleTokens(render) <= DEFAULT_ORACLE_RENDER_MAX_TOKENS,
      `render ${estimateOracleTokens(render)} tokens ≤ ${DEFAULT_ORACLE_RENDER_MAX_TOKENS}`,
    );
    assert.match(render, /Codebase map \(\d+ symbols across \d+ files\)/);
    assert.match(render, /runAgent \(function\) src\/agent\.ts:2/);
    assert.match(render, /NOT in the map is NOT proof/, "fail-closed guidance is embedded");
    // A tiny budget truncates hard but the fail-closed guidance stays.
    const tiny = renderOracle(oracle, { maxTokens: 20 });
    assert.ok(tiny.includes("…"), "a small budget truncates the symbol list with the bounded-map marker");
    assert.ok(
      estimateOracleTokens(tiny) < estimateOracleTokens(renderOracle(oracle)),
      "a small budget produces a smaller render than the default",
    );
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

// ── 3. wiring: oracle into agent prompts, scoped prefix into the estimate ────

test("the oracle is DEFAULT-ON and injected into subagent prompts (bounded render)", () => {
  const root = fixtureRoot();
  try {
    assert.equal(isOracleEnabled(undefined), true, "default-on (context-cost)");
    assert.equal(isOracleEnabled(false), false, "explicit opt-out");
    assert.equal(isOracleEnabled({ enabled: false }), false);

    type Priv = { buildPrompt(prompt: string, options: object, structured: boolean): string };
    const agent = new WorkflowAgent({ cwd: root }) as unknown as Priv;
    const prompt = agent.buildPrompt("do the thing", {}, false);
    assert.match(prompt, /Codebase map \(\d+ symbols across \d+ files\)/, "the bounded map is injected");
    assert.match(prompt, /runAgent \(function\) src\/agent\.ts:2/, "a real symbol with file:line");

    // Disabled → no injection, no scan.
    const disabled = new WorkflowAgent({ cwd: root, codebaseOracle: false }) as unknown as Priv;
    const noOracle = disabled.buildPrompt("do the thing", {}, false);
    assert.ok(!noOracle.includes("Codebase map"), "explicitly disabled → no oracle block");
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

test("the oracle scan runs ONCE per run frame (per-instance memo + module cache)", () => {
  const root = fixtureRoot();
  try {
    let scans = 0;
    type Priv = {
      buildPrompt(prompt: string, options: object, structured: boolean): string;
    };
    const agent = new WorkflowAgent({
      cwd: root,
      codebaseOracle: {
        scan: (cwd: string) => {
          scans++;
          return scanCodebaseOracle({ cwd });
        },
      },
    }) as unknown as Priv & { resolveRunOracle(): CodebaseOracle | null };
    agent.buildPrompt("first", {}, false);
    agent.buildPrompt("second", {}, false);
    agent.buildPrompt("third", {}, false);
    assert.equal(scans, 1, "N subagents pay ONE scan — the memo serves the rest");
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

test("a failing oracle scan degrades to no injection — never a broken agent", () => {
  const root = fixtureRoot();
  try {
    type Priv = { buildPrompt(prompt: string, options: object, structured: boolean): string };
    const agent = new WorkflowAgent({
      cwd: root,
      codebaseOracle: {
        scan: () => {
          throw new Error("scan blew up");
        },
      },
    }) as unknown as Priv;
    const prompt = agent.buildPrompt("task", {}, false);
    assert.ok(!prompt.includes("Codebase map"), "scan failure → no oracle block, the prompt still builds");
  } finally {
    void clearOracleCache();
    void rmForce(root).catch(() => {});
  }
});

test("estimate-forecast reflects the scoped-context fixed per-agent context (opt-in, default 0)", () => {
  const script = `export const meta = { name: "context-cost-estimate", description: "estimate wiring" }
await agent("scan the repo", { label: "scan" });
await parallel([async () => agent("item one"), async () => agent("item two")]);
`;
  // Default (perAgentFixedContextTokens omitted) = legacy estimate, unchanged.
  const baseline = estimateWorkflowForecast(script);
  // Scoped-context wiring: a small fixed prefix per agent (scoped loading).
  const scoped = estimateWorkflowForecast(script, { perAgentFixedContextTokens: 500 });
  // Full-skills wiring: the full ~3.5 ktok prefix (incl. the ~3.1 ktok block).
  const full = estimateWorkflowForecast(script, { perAgentFixedContextTokens: 3_500 });

  assert.ok(scoped.totalTokens > baseline.totalTokens, "the fixed context term adds to the forecast");
  assert.ok(
    full.totalTokens - scoped.totalTokens >= (3_500 - 500) * 3,
    "3+ agents show the per-agent context saving (scoped vs full skills)",
  );
  assert.equal(
    baseline.totalTokens,
    estimateWorkflowForecast(script).totalTokens,
    "default remains byte-identical (no fixed term) — legacy forecasts unchanged",
  );
});
