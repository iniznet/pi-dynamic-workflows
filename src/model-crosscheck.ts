import { join } from "node:path";
import type { Api, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CROSSCHECK_TIMEOUT_MS } from "./config.js";
import { providerFromCanonicalSpec, splitModelSpecThinking } from "./model-spec.js";
import { withTimeout } from "./timing.js";

/**
 * P09 — second-logical-model cross-checker over pi's public ModelRuntime
 * surface (ModelRuntime.create + completeSimple; dist/core/model-runtime.d.ts
 * exposes exactly those, no agent-execution API exists at :116-122).
 *
 * The cross-check is a DIRECT ModelRuntime call: it consumes no agent slot,
 * journals nothing, and never touches the run's shared.spent/tokenUsage
 * accounting (the "economy-tier must not double-charge" invariant) — the
 * quality helpers' primary votes keep their economy tier and the cross-check
 * bills outside the run's ledger. Any failure (auth/config/network/timeout)
 * resolves `null` (unavailable) and the caller falls back to the same-model
 * verdict; a hung request is bounded by withTimeout.
 */

/** Minimal cross-checker surface the workflow quality helpers depend on. */
export interface ModelCrosschecker {
  /**
   * Ask the second model a free-form question and return its raw text answer.
   * Resolves null when the model cannot be reached (auth/config/network/
   * timeout) or the reply carries no text — the caller must fall back.
   */
  ask(question: string, modelSpec: string): Promise<string | null>;
}

export interface ModelCrosscheckerOptions {
  /** Prebuilt runtime (tests inject a fake); absent → memoized real runtime. */
  runtime?: ModelRuntime;
  /** Auth file path for the lazily-created runtime (default: agentDir/auth.json). */
  authPath?: string;
  /** Models catalog path for the lazily-created runtime (default: agentDir/models.json). */
  modelsPath?: string;
  /** Per-request timeout (default DEFAULT_CROSSCHECK_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** A parsed second-model verdict. */
export interface CrosscheckVerdict {
  verdict: boolean;
  reasoning: string | null;
}

const CROSSCHECK_MAX_TOKENS = 256;

/** Module-level memoized real runtime; busted on rejection like agent.ts's fallback. */
let defaultRuntimePromise: Promise<ModelRuntime> | undefined;

function ensureRuntime(options: ModelCrosscheckerOptions): Promise<ModelRuntime> {
  if (options.runtime) return Promise.resolve(options.runtime);
  if (!defaultRuntimePromise) {
    defaultRuntimePromise = (async () => {
      const dir = getAgentDir();
      return ModelRuntime.create({
        authPath: options.authPath ?? join(dir, "auth.json"),
        modelsPath: options.modelsPath ?? join(dir, "models.json"),
      });
    })();
    defaultRuntimePromise.catch(() => {
      defaultRuntimePromise = undefined;
    });
  }
  return defaultRuntimePromise;
}

/**
 * Resolve a `provider/modelId` (or bare `modelId`, or a `:thinking`-suffixed
 * spec) against a runtime's catalog. The model id may itself carry a vendor
 * slash (openrouter's "deepseek/x"), so the provider is split at the FIRST
 * slash via providerFromCanonicalSpec.
 */
export function resolveModelForCrosscheck(runtime: ModelRuntime, modelSpec: string): Model<Api> | undefined {
  const { modelSpec: base } = splitModelSpecThinking(modelSpec);
  const provider = providerFromCanonicalSpec(base);
  if (provider) {
    const model = runtime.getModel(provider, base.slice(provider.length + 1));
    if (model) return model;
  }
  // Bare id: first provider whose catalog carries it.
  for (const candidate of runtime.getModels()) {
    if (candidate.id === base) return candidate;
  }
  return undefined;
}

/** Concatenate the text content of an assistant reply. */
function textOf(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}

/**
 * Lenient TRUE/FALSE parser over a model's free-text reply: the first
 * word-boundary occurrence of "true" or "false" decides (the cross-check
 * prompt forces "Reply with exactly one word: TRUE or FALSE", so prefixes
 * like "TRUE: because ..." parse correctly). Null when neither appears.
 */
export function parseCrosscheckVerdict(text: string | null | undefined): boolean | null {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();
  const trueMatch = /\btrue\b/.exec(normalized);
  const falseMatch = /\bfalse\b/.exec(normalized);
  const trueIndex = trueMatch?.index;
  const falseIndex = falseMatch?.index;
  if (trueIndex === undefined && falseIndex === undefined) return null;
  if (trueIndex === undefined) return false;
  if (falseIndex === undefined) return true;
  return trueIndex <= falseIndex;
}

/** Build a runtime-backed crosschecker (memoized singleton; injectable for tests). */
export function createModelCrosschecker(options: ModelCrosscheckerOptions = {}): ModelCrosschecker {
  const resolvedOptions = { ...options };
  const ask = async (question: string, modelSpec: string): Promise<string | null> => {
    try {
      const runtime = await ensureRuntime(resolvedOptions);
      const model = resolveModelForCrosscheck(runtime, modelSpec);
      if (!model) return null;
      const optionsForRequest: ModelsSimpleStreamOptions = { maxTokens: CROSSCHECK_MAX_TOKENS };
      const message = await withTimeout(
        runtime.completeSimple(
          model,
          { messages: [{ role: "user", content: question, timestamp: 0 }] },
          optionsForRequest,
        ),
        resolvedOptions.timeoutMs ?? DEFAULT_CROSSCHECK_TIMEOUT_MS,
        "model crosscheck",
      );
      return textOf(message);
    } catch {
      // auth/config/network/timeout — the cross-check is unavailable, never a run failure.
      return null;
    }
  };
  return { ask };
}
