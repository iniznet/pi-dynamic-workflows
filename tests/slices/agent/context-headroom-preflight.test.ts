import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../../../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../../../src/errors.js";

// ─── T2-02: context-window headroom preflight ───────────────────────────────────
// Unit tests over the preflight's private surface with synthetic windows:
// maxInputTokens throws the SAME non-recoverable CONTEXT_OVERFLOW the provider
// would, just earlier; over the window−16,384 reserve with real history the
// session is proactively compacted; every unknowable input (no window, no
// model, fresh session) falls through to today's behavior (soft guard).

type PreflightPrivates = {
  estimateIncomingInputTokens(
    prompt: string,
    options: Record<string, unknown>,
    tools: unknown[],
    session: { messages: unknown[]; model?: unknown; compact?(instructions: string): Promise<unknown> },
    structured: boolean,
  ): number | undefined;
  resolvedContextWindow(
    modelRegistry: ModelRegistry | undefined,
    resolvedModel: unknown,
    session: { messages: unknown[]; model?: unknown },
  ): number | undefined;
  maybePreflightContextHeadroom(
    session: { messages: unknown[]; model?: unknown; compact?(instructions: string): Promise<unknown> },
    prompt: string,
    options: Record<string, unknown>,
    tools: unknown[],
    structured: boolean,
    modelRegistry: ModelRegistry | undefined,
    resolvedModel: unknown,
  ): Promise<void>;
};

/** Minimal registry whose getAvailable() feeds listAvailableModels (spec/cost/contextWindow). */
function mockRegistry(
  models: Array<{ provider: string; id: string; costOutput?: number; contextWindow?: number }>,
): ModelRegistry {
  return {
    getAvailable: () =>
      models.map((m) => ({
        provider: m.provider,
        id: m.id,
        cost: m.costOutput === undefined ? undefined : { output: m.costOutput },
        contextWindow: m.contextWindow,
      })),
    find: () => undefined,
    getAll: () => [],
  } as unknown as ModelRegistry;
}

const TINY_MODEL = { provider: "prov", id: "tiny" };
const TINY_REGISTRY = mockRegistry([{ provider: "prov", id: "tiny", contextWindow: 20_000 }]);
const NO_WINDOW_REGISTRY = mockRegistry([{ provider: "prov", id: "tiny" }]);
const EMPTY_SESSION = { messages: [] };

function preflight(): { agent: WorkflowAgent; priv: PreflightPrivates } {
  // codebaseOracle: false keeps the estimate hermetic — /tmp may hold unrelated
  // files on some hosts, and the oracle render is a prompt-token input.
  const agent = new WorkflowAgent({ cwd: "/tmp", codebaseOracle: false });
  return { agent, priv: agent as unknown as PreflightPrivates };
}

test("T2-02: maxInputTokens throws CONTEXT_OVERFLOW (non-recoverable) BEFORE any prompt is sent", async () => {
  const { priv } = preflight();
  await assert.rejects(
    priv.maybePreflightContextHeadroom(
      EMPTY_SESSION,
      "x".repeat(4_000), // ~1K tokens on top of the ~3.5K system-prefix estimate
      { maxInputTokens: 100 },
      [],
      false,
      undefined,
      undefined,
    ),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.CONTEXT_OVERFLOW &&
      error.recoverable === false &&
      /maxInputTokens/.test(error.message),
    "the ceiling must throw the SAME non-recoverable class as a real overflow, just earlier",
  );
});

test("T2-02: no maxInputTokens + no window → the preflight is a no-op (soft guard)", async () => {
  const { priv } = preflight();
  await priv.maybePreflightContextHeadroom(EMPTY_SESSION, "x".repeat(4_000), {}, [], false, undefined, undefined);
  await priv.maybePreflightContextHeadroom(
    EMPTY_SESSION,
    "x".repeat(4_000),
    {},
    [],
    false,
    NO_WINDOW_REGISTRY,
    TINY_MODEL,
  );
  // resolves — today's behavior is untouched when nothing knowable is comparable
});

test("T2-02: over the reserve on a FRESH session → advisory warning only, no compact, run proceeds", async () => {
  const { priv } = preflight();
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => warns.push(String(msg));
  try {
    await priv.maybePreflightContextHeadroom(
      EMPTY_SESSION,
      "x".repeat(40_000), // ~10K tokens prompt + 3.5K system prefix > 20K − 16K reserve
      {},
      [],
      false,
      TINY_REGISTRY,
      TINY_MODEL,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warns.some((w) => w.includes("over the 20000-token context window") && w.includes("static prefix dominates")),
    "a fresh session has nothing to compact — advise, don't act",
  );
});

test("T2-02: over the reserve WITH history → the session is proactively compacted before prompting", async () => {
  const { priv } = preflight();
  let compacted: string | undefined;
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "y".repeat(20_000) }] },
      { role: "assistant", content: "z" },
    ],
    compact: async (instructions: string) => {
      compacted = instructions;
      return { ok: true };
    },
  };
  await priv.maybePreflightContextHeadroom(session, "task", {}, [], false, TINY_REGISTRY, TINY_MODEL);
  assert.ok(
    typeof compacted === "string" && /approaching the context window/i.test(compacted),
    "a long trajectory is compacted with a custom summary BEFORE the provider rejects it",
  );
});

test("T2-02: within the window reserve → no compact, no warning, run proceeds unchanged", async () => {
  const { priv } = preflight();
  let compacted = false;
  const session = {
    messages: [{ role: "user", content: "small" }],
    compact: async () => {
      compacted = true;
      return { ok: true };
    },
  };
  await priv.maybePreflightContextHeadroom(session, "tiny task", {}, [], false, TINY_REGISTRY, TINY_MODEL);
  assert.equal(compacted, false, "an estimate inside window − 16,384 never compacts");
});

test("T2-02: a compaction refusal degrades to the reactive path (best-effort, never throws)", async () => {
  const { priv } = preflight();
  const session = {
    messages: [
      { role: "user", content: "y".repeat(20_000) },
      { role: "assistant", content: "z" },
    ],
    compact: async () => {
      throw new Error("SDK refuses tiny sessions");
    },
  };
  await priv.maybePreflightContextHeadroom(session, "task", {}, [], false, TINY_REGISTRY, TINY_MODEL);
  // resolves — a compaction failure never fails the run
});

test("T2-02: resolvedContextWindow reads the registry's window; absent → undefined", () => {
  const { priv } = preflight();
  assert.equal(priv.resolvedContextWindow(TINY_REGISTRY, TINY_MODEL, EMPTY_SESSION), 20_000);
  assert.equal(
    priv.resolvedContextWindow(NO_WINDOW_REGISTRY, TINY_MODEL, EMPTY_SESSION),
    undefined,
    "no reported window → soft guard",
  );
  assert.equal(priv.resolvedContextWindow(TINY_REGISTRY, undefined, EMPTY_SESSION), undefined, "no model → soft guard");
});

test("T2-02: estimateIncomingInputTokens is chars/4 over system prefix + tools + history + prompt (mode-aware)", () => {
  const { priv } = preflight();
  const scoped = priv.estimateIncomingInputTokens(
    "a".repeat(400), // 100 tokens
    {},
    [{ name: "tool", description: "desc" }], // small
    { messages: [] },
    false,
  );
  assert.ok(
    scoped !== undefined && scoped > 500,
    "scoped system-prefix estimate (~500 tokens, no skill block) is included",
  );
  assert.ok(scoped < 1_500, "a 400-char prompt adds ~100 tokens on top of the scoped prefix");

  // Context-cost: the full-skills opt-in keeps the ~3.5K-token prefix estimate
  // (system prompt + AGENTS.md + the ~3.1 ktok skill-stub block).
  const full = new WorkflowAgent({ cwd: "/tmp", subagentSkills: "all", codebaseOracle: false }) as unknown as PreflightPrivates;
  const fullEstimate = full.estimateIncomingInputTokens(
    "a".repeat(400),
    {},
    [{ name: "tool", description: "desc" }],
    { messages: [] },
    false,
  );
  assert.ok(
    fullEstimate !== undefined && fullEstimate > 3_500,
    "full system-prefix estimate (~3.5K tokens incl. skills) is included",
  );
  assert.ok(
    (fullEstimate as number) - (scoped as number) >= 2_900,
    "scoped loading drops the ~3.1 ktok skill block from the incoming-context estimate",
  );
});
