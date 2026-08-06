import type { Api, Model } from "@earendil-works/pi-ai";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ResolvedModelSpec {
  requestedSpec: string;
  model?: Model<Api>;
  thinkingLevel?: ModelThinkingLevel;
  resolvedSpec?: string;
  warning?: string;
  error?: string;
}

interface ParseModelPatternOptions {
  allowInvalidThinkingLevelFallback?: boolean;
}

interface ParsedModelPattern {
  model?: Model<Api>;
  thinkingLevel?: ModelThinkingLevel;
  warning?: string;
}

const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.4",
  "azure-openai-responses": "gpt-5.4",
  "openai-codex": "gpt-5.5",
  deepseek: "deepseek-v4-pro",
  google: "gemini-3.1-pro-preview",
  "google-vertex": "gemini-3.1-pro-preview",
  "github-copilot": "gpt-5.4",
  openrouter: "moonshotai/kimi-k2.6",
  "vercel-ai-gateway": "zai/glm-5.1",
  zai: "glm-5.1",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  moonshotai: "kimi-k2.6",
  "moonshotai-cn": "kimi-k2.6",
  huggingface: "moonshotai/Kimi-K2.6",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  together: "moonshotai/Kimi-K2.6",
  opencode: "kimi-k2.6",
  "opencode-go": "kimi-k2.6",
  "kimi-coding": "kimi-for-coding",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
  xiaomi: "mimo-v2.5-pro",
  "xiaomi-token-plan-cn": "mimo-v2.5-pro",
  "xiaomi-token-plan-ams": "mimo-v2.5-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function formatModelSpecWithThinking(modelSpec: string, thinkingLevel: ModelThinkingLevel | undefined): string {
  return thinkingLevel ? `${modelSpec}:${thinkingLevel}` : modelSpec;
}

export function canonicalModelSpec(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Extract the provider from a canonical `provider/model` spec. The first path
 * segment is always the provider — even when the model id itself carries a
 * vendor slash (e.g. openrouter's "deepseek/x"). Returns undefined for a spec
 * with no "/".
 *
 * Verbatim, not lowercased: canonical specs are built as `${provider}/${id}`
 * straight from the registry, whose provider map is keyed case-sensitively
 * (ModelRegistry.find → exact Map lookup). Lowercasing here would produce a
 * provider id that never resolves for mixed-case custom providers.
 */
export function providerFromCanonicalSpec(spec: string): string | undefined {
  const slashIndex = spec.indexOf("/");
  if (slashIndex === -1) return undefined;
  const provider = spec.slice(0, slashIndex).trim();
  return provider || undefined;
}

/**
 * Split a stored tier spec for display/editing. Exact known model specs win, so
 * model ids that legitimately contain colons are not mistaken for thinking.
 */
export function splitModelSpecThinking(
  spec: string | undefined,
  knownModelSpecs?: readonly string[],
): { modelSpec: string; thinkingLevel?: ModelThinkingLevel } {
  const trimmed = spec?.trim() ?? "";
  if (!trimmed) return { modelSpec: "", thinkingLevel: undefined };

  const known = knownModelSpecs ? new Set(knownModelSpecs) : undefined;
  if (known?.has(trimmed)) return { modelSpec: trimmed, thinkingLevel: undefined };

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { modelSpec: trimmed, thinkingLevel: undefined };

  const prefix = trimmed.slice(0, lastColon);
  const suffix = trimmed.slice(lastColon + 1);
  if (!prefix || !isThinkingLevel(suffix)) return { modelSpec: trimmed, thinkingLevel: undefined };
  if (known && !known.has(prefix)) return { modelSpec: trimmed, thinkingLevel: undefined };
  return { modelSpec: prefix, thinkingLevel: suffix };
}

function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;
  const normalizedReference = trimmedReference.toLowerCase();

  const canonicalMatches = availableModels.filter(
    (model) => canonicalModelSpec(model).toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.slice(0, slashIndex).trim();
    const modelId = trimmedReference.slice(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const normalizedPattern = modelPattern.trim().toLowerCase();
  // An empty/whitespace-only pattern matches EVERY model via String.includes("") —
  // reject it up front (M10) instead of silently resolving an arbitrary model.
  if (!normalizedPattern) return undefined;

  const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
  if (exactMatch) return exactMatch;

  const matches = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(normalizedPattern) || model.name?.toLowerCase().includes(normalizedPattern),
  );
  if (matches.length === 0) return undefined;

  // Version-aware ordering (L5): rank by how closely the id matches the pattern
  // — exact id first, then prefix matches, then plain substrings — and within a
  // band prefer stable ids over dated snapshots, the shortest (base) id over
  // suffixed variants, and the newest date for snapshots. The previous
  // lexicographic sort picked "gpt-4o-mini" over "gpt-4o" for pattern "gpt-4o"
  // — the exact opposite of what a user means.
  const proximity = (model: Model<Api>): number => {
    const id = model.id.toLowerCase();
    if (id === normalizedPattern) return 0;
    if (id.startsWith(normalizedPattern)) return 1;
    return 2;
  };
  matches.sort((a, b) => {
    const proximityA = proximity(a);
    const proximityB = proximity(b);
    if (proximityA !== proximityB) return proximityA - proximityB;
    const aAlias = isAlias(a.id);
    const bAlias = isAlias(b.id);
    if (aAlias !== bAlias) return aAlias ? -1 : 1;
    if (aAlias) {
      if (a.id.length !== b.id.length) return a.id.length - b.id.length;
      return a.id.localeCompare(b.id);
    }
    // Dated snapshots carry a fixed-width -YYYYMMDD suffix, so plain
    // lexicographic order is newest-first.
    return b.id.localeCompare(a.id);
  });
  return matches[0];
}

/**
 * True when `pattern` matched `model` only as a substring — neither an exact
 * id/name nor an id prefix. Used to warn that a fuzzy resolution may not be
 * what the caller meant (L5).
 */
function isSubstringOnlyMatch(pattern: string, model: Model<Api>): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  const id = model.id.toLowerCase();
  return id !== normalized && !id.startsWith(normalized) && !(model.name?.toLowerCase() === normalized);
}

function parseModelPattern(
  pattern: string,
  availableModels: Model<Api>[],
  options?: ParseModelPatternOptions,
): ParsedModelPattern {
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) return { model: exactMatch };

  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) return {};

  const prefix = pattern.slice(0, lastColonIndex);
  const suffix = pattern.slice(lastColonIndex + 1);
  if (isThinkingLevel(suffix)) {
    const result = parseModelPattern(prefix, availableModels, options);
    if (!result.model) return result;
    return {
      model: result.model,
      thinkingLevel: result.warning ? undefined : suffix,
      warning: result.warning,
    };
  }

  if (options?.allowInvalidThinkingLevelFallback === false) return {};

  const result = parseModelPattern(prefix, availableModels, options);
  if (!result.model) return result;
  return {
    model: result.model,
    warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
  };
}

function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const providerModels = availableModels.filter((model) => model.provider === provider);
  if (providerModels.length === 0) return undefined;
  const defaultId = DEFAULT_MODEL_PER_PROVIDER[provider];
  const baseModel = defaultId
    ? (providerModels.find((model) => model.id === defaultId) ?? providerModels[0])
    : providerModels[0];
  return { ...baseModel, id: modelId, name: modelId };
}

/**
 * Resolve a workflow model-tier/agent model string with the same user-facing
 * grammar as Pi CLI `--model`: `provider/modelId[:thinking]`, bare model ids,
 * fuzzy patterns, and exact colon-containing model ids. This is a manual port of
 * pi-coding-agent's `resolveCliModel` (core/model-resolver.ts) — kept in sync by
 * the cross-check property test in tests/model-spec.test.ts, which runs both
 * implementations against the same fuzzed inputs and fails loudly the moment they
 * diverge (see that file for why we don't call pi's export directly: it requires
 * a real `ModelRuntime`, which has a private constructor pi doesn't expose a
 * lightweight adapter for).
 */
export function resolveModelSpecWithThinking(
  spec: string,
  modelRegistry: Pick<ModelRegistry, "getAll"> & Partial<Pick<ModelRegistry, "hasConfiguredAuth">>,
): ResolvedModelSpec {
  const requestedSpec = spec.trim();
  if (!requestedSpec) return { requestedSpec, error: "No model spec provided." };

  const availableModels = modelRegistry.getAll();
  if (availableModels.length === 0) {
    return {
      requestedSpec,
      error: "No models available. Check your installation or add models to models.json.",
    };
  }

  const providerMap = new Map<string, string>();
  for (const model of availableModels) {
    providerMap.set(model.provider.toLowerCase(), model.provider);
  }

  let provider: string | undefined;
  let pattern = requestedSpec;
  let inferredProvider = false;
  const slashIndex = requestedSpec.indexOf("/");
  if (slashIndex !== -1) {
    const maybeProvider = requestedSpec.slice(0, slashIndex);
    const canonicalProvider = providerMap.get(maybeProvider.toLowerCase());
    if (canonicalProvider) {
      provider = canonicalProvider;
      pattern = requestedSpec.slice(slashIndex + 1);
      inferredProvider = true;
    }
  }

  if (!provider) {
    const exact = findExactModelReferenceMatch(requestedSpec, availableModels);
    if (exact) {
      return { requestedSpec, model: exact, resolvedSpec: canonicalModelSpec(exact) };
    }
  }

  const candidates = provider ? availableModels.filter((model) => model.provider === provider) : availableModels;
  const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
    allowInvalidThinkingLevelFallback: false,
  });
  if (model) {
    // The provider was inferred from a slash prefix (e.g. "moonshotai/kimi-k3"),
    // but "moonshotai" can be BOTH a real provider name and the vendor segment of
    // an aggregator's compound model id (OpenRouter et al. name models
    // "vendor/model"). If the inferred provider has no configured auth and the
    // exact same string is also a literal model id on a different, authenticated
    // provider, prefer that one — otherwise a bare aggregator-style pin silently
    // resolves against an unauthenticated native provider instead of the
    // aggregator the caller actually has access to.
    if (inferredProvider && modelRegistry.hasConfiguredAuth && !modelRegistry.hasConfiguredAuth(model)) {
      const rawExactMatches = availableModels.filter(
        (candidate) => candidate.id.toLowerCase() === requestedSpec.toLowerCase() && !modelsAreEqual(candidate, model),
      );
      const authenticatedRawMatches = rawExactMatches.filter((candidate) =>
        modelRegistry.hasConfiguredAuth?.(candidate),
      );
      if (authenticatedRawMatches.length === 1) {
        const preferred = authenticatedRawMatches[0];
        return { requestedSpec, model: preferred, resolvedSpec: canonicalModelSpec(preferred) };
      }
    }
    // Warn when the pattern only matched as a substring — the resolution may
    // not be what the caller meant (L5). Strip a resolved thinking suffix
    // first: "gpt-5.6-sol:max" must be judged against "gpt-5.6-sol", which is
    // an exact id match, not a fuzzy one.
    const patternWithoutThinking =
      thinkingLevel && pattern.endsWith(`:${thinkingLevel}`) ? pattern.slice(0, -(thinkingLevel.length + 1)) : pattern;
    const substringWarning = isSubstringOnlyMatch(patternWithoutThinking, model)
      ? `Pattern "${patternWithoutThinking}" only partially matches model "${canonicalModelSpec(model)}"; resolved by substring match.`
      : undefined;
    return {
      requestedSpec,
      model,
      thinkingLevel,
      warning: warning ?? substringWarning,
      resolvedSpec: formatModelSpecWithThinking(canonicalModelSpec(model), thinkingLevel),
    };
  }

  if (inferredProvider) {
    const exact = findExactModelReferenceMatch(requestedSpec, availableModels);
    if (exact) {
      return { requestedSpec, model: exact, resolvedSpec: canonicalModelSpec(exact) };
    }

    const fallback = parseModelPattern(requestedSpec, availableModels, {
      allowInvalidThinkingLevelFallback: false,
    });
    if (fallback.model) {
      return {
        requestedSpec,
        model: fallback.model,
        thinkingLevel: fallback.thinkingLevel,
        warning: fallback.warning,
        resolvedSpec: formatModelSpecWithThinking(canonicalModelSpec(fallback.model), fallback.thinkingLevel),
      };
    }
  }

  if (provider) {
    let fallbackPattern = pattern;
    let fallbackThinking: ModelThinkingLevel | undefined;
    const lastColon = pattern.lastIndexOf(":");
    if (lastColon !== -1) {
      const suffix = pattern.slice(lastColon + 1);
      if (isThinkingLevel(suffix)) {
        fallbackPattern = pattern.slice(0, lastColon);
        fallbackThinking = suffix;
      }
    }

    // An empty/whitespace-only pattern (e.g. "openai/") must not fabricate a
    // custom model with an empty id — report it as not found instead (M10).
    if (!fallbackPattern.trim()) {
      return {
        requestedSpec,
        warning,
        error: `Model "${provider}/${pattern}" not found. Use /workflows-models to choose an available model.`,
      };
    }

    const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
    if (fallbackModel) {
      const modelWithReasoning =
        fallbackThinking && fallbackThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel;
      const fallbackWarning = warning
        ? `${warning} Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`
        : `Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`;
      return {
        requestedSpec,
        model: modelWithReasoning,
        thinkingLevel: fallbackThinking,
        warning: fallbackWarning,
        resolvedSpec: formatModelSpecWithThinking(canonicalModelSpec(modelWithReasoning), fallbackThinking),
      };
    }
  }

  const display = provider ? `${provider}/${pattern}` : requestedSpec;
  return {
    requestedSpec,
    warning,
    error: `Model "${display}" not found. Use /workflows-models to choose an available model.`,
  };
}
