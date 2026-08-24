import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { applyCommandWatchdogToTools, type CommandWatchdogOptions } from "./command-watchdog.js";
import {
  DEFAULT_SUBAGENT_SKILLS,
  DEFAULT_UNTAGGED_TIER,
  UNTAGGED_TIER_ECONOMY,
  UNTAGGED_TIER_INHERIT_MAIN,
} from "./config.js";
import { recordProvenance } from "./durable-store.js";
import {
  classifyContextOverflow,
  classifyProviderLimit,
  providerUnavailableWorkflowError,
  WorkflowError,
  WorkflowErrorCode,
} from "./errors.js";
import { tierNameForTask } from "./model-routing.js";
import {
  canonicalModelSpec,
  formatModelSpecWithThinking,
  resolveModelSpecWithThinking,
  splitModelSpecThinking,
} from "./model-spec.js";
import {
  buildDefaultTierConfig,
  coerceSpecThinkingForTier,
  formatTierFallbackNotice,
  loadModelTierConfig,
  type ModelTierConfig,
  type RankableModel,
  resolveTierModel,
} from "./model-tier-config.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";
import { withSubagentReadGuidance } from "./subagent/read-guidance.js";
import { type SafeTimer, safeSetTimeout } from "./timing.js";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

/**
 * Detect a provider context-window overflow recorded as an assistant message
 * with stopReason "error" (the SDK buries it, exactly like usage limits).
 * Classified CONTEXT_OVERFLOW (non-recoverable) so the run settles failed with
 * its journal preserved instead of being retried into the same wall or silently
 * nulled — resume() then replays completed agents and re-runs only the
 * overflowing one with a fresh session/context.
 */
export function throwIfContextOverflow(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  if (!classifyContextOverflow(err.errorMessage)) return;
  throw new WorkflowError(err.errorMessage ?? "Context window overflow", WorkflowErrorCode.CONTEXT_OVERFLOW, {
    recoverable: false,
    agentLabel: label,
  });
}

/**
 * Detect a provider outage/overload (5xx) recorded as an assistant message with
 * stopReason "error" (the SDK buries it, exactly like usage limits/overflow).
 * Shares the pause/retry construction with wrapError's thrown-error path via
 * providerUnavailableWorkflowError (F24): 503/504/529 pause the run
 * (PROVIDER_OVERLOADED, recoverable:false) so it checkpoints and resumes after
 * the endpoint recovers; 500/502 are recoverable (PROVIDER_UNAVAILABLE) so the
 * attempt is retried with backoff before the run fails resumable.
 */
export function throwIfProviderUnavailable(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const unavailable = providerUnavailableWorkflowError(err.errorMessage, label);
  if (unavailable) throw unavailable;
}

/**
 * The agent's FINAL answer: assistant text strictly after the last tool result.
 * Text before the final tool result is stale progress (the agent's last real
 * action was a tool call, not answering), so it must not count as an answer.
 * Shared by WorkflowAgent.finalAssistantText and the truncation gate (F20).
 */
export function finalAssistantTextOf(messages: unknown[]): string {
  // Locate the last tool result; only assistant text strictly after it counts.
  let lastToolResult = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string } | undefined)?.role === "toolResult") {
      lastToolResult = i;
      break;
    }
  }
  for (let i = messages.length - 1; i > lastToolResult; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

/**
 * Detect silent output truncation: the last assistant message finished with
 * stopReason "length" (max output tokens) and never emitted a final answer.
 * The trajectory is at its output ceiling, so neither a retry nor a same-session
 * nudge can succeed — classified CONTEXT_OVERFLOW (non-recoverable) so the run
 * settles failed with its journal preserved and resume() re-runs only the
 * overflowing agent with a fresh session, instead of burning a full retry into
 * the identical wall (#135). Unlike throwIfContextOverflow (which gates on
 * stopReason "error" + provider text), this uses the SDK's authoritative
 * stopReason union — a truncation is an overflow even when the provider buried
 * no error text in the transcript.
 *
 * F20 gate: a "length" stop whose last message still holds a complete final
 * answer is a SUCCESSFUL turn that merely hit the output ceiling — throwing
 * would force a full agent replay for nothing. Only a genuinely empty "length"
 * turn (no final answer at all) is the unrecoverable wall, and it must still
 * throw BEFORE the same-session nudge (#135) — the nudge cannot produce more
 * output than the ceiling that just truncated.
 */
function throwIfTruncatedOutput(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "length") return;
  if (finalAssistantTextOf(messages).trim()) return;
  throw new WorkflowError(
    "Model output truncated at max tokens before a final answer (stopReason length)",
    WorkflowErrorCode.CONTEXT_OVERFLOW,
    { recoverable: false, agentLabel: label },
  );
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    // T1-02: keep the provider prefix byte-identical on the FIRST repair — the
    // nudge alone drives most models to call structured_output, and the SDK
    // rebuilds the system prompt on every setActiveTools change, which re-prices
    // the whole trajectory at full input cost instead of cacheRead. Only a
    // SECOND failed repair restricts the toolset (last resort when the model
    // keeps calling other tools). Best-effort: the re-prompt alone still drives
    // most models to comply if setActiveToolsByName is absent or throws.
    if (attempt >= 1) {
      try {
        session.setActiveToolsByName?.(["structured_output"]);
      } catch {
        // ignore — the re-prompt alone still drives most models to comply
      }
    }
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit (or overflow the context
  // window, or hit a 5xx outage). Surface that as the real (recoverable/
  // checkpointed) cause instead of the misleading non-recoverable
  // SCHEMA_NONCOMPLIANCE. 5xx is classified before limit phrases (F06) so a
  // limit-phrased 503/504 stays PROVIDER_OVERLOADED, not a misleading
  // PROVIDER_USAGE_LIMIT.
  throwIfProviderUnavailable(session.messages, options.label);
  throwIfContextOverflow(session.messages, options.label);
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
/**
 * Prompt-aware tier default for the no-tiers-config fallback: classify the
 * task from its prompt and pick the fitting tier out of the available models
 * spread into defaults (see buildDefaultTierConfig). Degrades to mainModel
 * when the registry is empty or unavailable. `defaults` is an optional
 * precomputed tier map (F23: memoized per registry identity) that skips the
 * registry scan + rank sort when the caller already has one cached.
 */
export function resolvePromptAwareTier(
  prompt: string,
  mainModel: string | undefined,
  availableModels: readonly RankableModel[],
  defaults?: ModelTierConfig,
  phase?: string,
): string | undefined {
  const tierConfig = defaults ?? buildDefaultTierConfig(mainModel, availableModels);
  // GAP-2: the classifier's phase input. A pipeline run threads its persisted
  // stage ("0"/"1" — wayfinder/prewalk reconnaissance, clamped) so early-phase
  // scan/edit prompts route to the cheap tier instead of the generic
  // "runtime" default, whose prompt-level rules would let a recon prompt's
  // synthesize phrasing escalate it to the big tier. Absent a stage the
  // pre-fix behavior is unchanged.
  const tier = tierNameForTask(phase ?? "runtime", prompt);
  return resolveTierModel(tier, tierConfig, mainModel) ?? mainModel;
}

export function resolveAgentModelSpec(
  options: { model?: string; tier?: string; defaultUntaggedTier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
  onTierWithoutConfig?: (tier: string) => void,
  prompt?: string,
  listModels: () => readonly RankableModel[] = listAvailableModels,
  // F23: memoized default-tier builder keyed by (registry identity, mainModel).
  // When provided, the prompt-aware fallback reuses the cached rank instead of
  // re-scanning + re-sorting the full registry on every run().
  buildDefaults?: (mainModel: string | undefined) => ModelTierConfig,
  // GAP-2: the run's pipeline stage ("0"/"1", clamped from the persisted state
  // machine) threaded into the prompt-aware tier fallback so wayfinder/prewalk
  // reconnaissance classifies scan/edit prompts to the cheap tier. Absent this
  // (non-pipeline runs, or callers that predate the fix) classification uses
  // the generic "runtime" default exactly as before.
  phase?: string,
): string | undefined {
  // T2-11: an EXPLICIT opts.model always wins and is never thinking-capped
  // (explicit > tier precedence) — returned before any tier resolution.
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    // Tier requested but unconfigured (no model-tiers.json at all) → degrade
    // to mainModel; the caller surfaces that (once) so the no-op is
    // discoverable. When a prompt is available, prefer a prompt-aware default
    // (classify the task against the available models) so a "small" scan and a
    // "big" synthesis stay distinct instead of both collapsing onto mainModel.
    // A CONFIGURED config whose tier KEY is missing is NOT this case — that is
    // a config error the caller throws on (run()'s tier guard), so a user-
    // pinned tier can never silently bill the main agent's model.
    if (!config) {
      onTierWithoutConfig?.(options.tier);
      if (prompt) {
        // T2-11: cap the prompt-aware fallback's thinking by the tier the
        // CLASSIFIER picked (the requested tier name is a hint; classification
        // decides the actual small/medium/big slot under no config).
        const classifiedTier = tierNameForTask(phase ?? "runtime", prompt);
        const model = resolvePromptAwareTier(prompt, mainModel, listModels(), buildDefaults?.(mainModel), phase);
        return coerceSpecThinkingForTier(model, classifiedTier, null);
      }
      return mainModel;
    }
    // An "inherit:main" configured tier resolves to the session's main model
    // INSIDE resolveTierModel (PRD Task 3) — passing mainModel through is what
    // makes the sentinel mean "active chat session model" instead of leaking a
    // literal spec to the registry. A tier whose KEY is absent from the loaded
    // config returns undefined here (never mainModel), so run()'s tier guard
    // throws a named MODEL_NOT_FOUND instead of silently billing the main
    // agent's model for a call the user pinned to a configured tier.
    return coerceSpecThinkingForTier(resolveTierModel(options.tier, config, mainModel), options.tier, config);
  }
  // Untagged agent: default to the configured medium tier when one exists
  // (T2-03 plan matrix: "config -> existing precedence").
  if (config) {
    const medium = resolveTierModel("medium", config, mainModel);
    if (medium) return coerceSpecThinkingForTier(medium, "medium", config);
    return undefined;
  }
  // T2-03: no model-tiers.json at all — untagged calls route through the
  // economy default instead of collapsing onto the session's flagship main
  // model. The run/global knob (defaultUntaggedTier) selects the mode:
  //   "economy" (default)    → prompt-aware classifyTask (scan=small /
  //                            edit=medium / synthesize+analyze=big)
  //   "inherit:main"         → opt-out: session main model (pre-T2-03)
  //   any other tier name    → that tier against the registry-derived
  //                            default config
  const untaggedDefault = options.defaultUntaggedTier ?? DEFAULT_UNTAGGED_TIER;
  if (untaggedDefault === UNTAGGED_TIER_INHERIT_MAIN) return undefined;
  if (prompt) {
    if (untaggedDefault === UNTAGGED_TIER_ECONOMY) {
      const classifiedTier = tierNameForTask(phase ?? "runtime", prompt);
      const model = resolvePromptAwareTier(prompt, mainModel, listModels(), buildDefaults?.(mainModel), phase);
      return coerceSpecThinkingForTier(model, classifiedTier, null);
    }
    // A literal tier name with no config: resolve it against the registry-
    // derived default config (same ranking the prompt-aware fallback uses).
    const tierConfig = buildDefaults?.(mainModel) ?? buildDefaultTierConfig(mainModel, listModels());
    const model = resolveTierModel(untaggedDefault, tierConfig, mainModel);
    if (model) return coerceSpecThinkingForTier(model, untaggedDefault, null);
    return mainModel;
  }
  // No prompt (unit-test surface): deterministic — the session default, which
  // is the same model an undefined resolution would bind at runtime.
  return mainModel;
}

/**
 * Derive the provider pool's logical model key from a resolved model spec: the
 * spec minus a leading provider prefix and minus any :thinking suffix (the
 * caller already split that off via {@link splitModelSpecThinking}). Tiers and
 * phase routing select the LOGICAL id; the pool config maps that logical id to
 * each provider's real modelId alias. The provider prefix is matched against
 * the registry's known providers (same disambiguation as
 * resolveModelSpecWithThinking), so an aggregator-style id like
 * "openrouter/deepseek/x" keeps its vendor segment while "openai/gpt-5.5"
 * collapses to "gpt-5.5". A spec whose first segment is not a known provider
 * (e.g. a bare "accounts/fireworks/models/x") is returned unchanged; an
 * unmapped logical key makes the pool's acquire() return undefined and this
 * run falls back to legacy single-resolution.
 */
export function logicalModelKey(spec: string, registry: ModelRegistry): string {
  const slashIndex = spec.indexOf("/");
  if (slashIndex !== -1) {
    const provider = spec.slice(0, slashIndex).trim().toLowerCase();
    if (registry.getAll().some((model) => model.provider.toLowerCase() === provider)) {
      return spec.slice(slashIndex + 1);
    }
  }
  return spec;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /**
   * Extra tool NAMES to deny in the subagent session, on top of the always-on
   * defaults ({@link DEFAULT_EXCLUDED_SUBAGENT_TOOLS}). Lets the host exclude
   * other recursive-orchestration tools it registers (e.g. a pi-subagents tool)
   * so a workflow subagent can't fan out through them either (#107).
   */
  excludeTools?: string[];
  /** Override any createAgentSession option (model, modelRuntime, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
  /**
   * T2-03: routing for UNTAGGED agent() calls (no `model`, no `tier`) when no
   * model-tiers.json is configured. "economy" (default) routes untagged calls
   * through the prompt-aware classifyTask fallback (scan=small / edit=medium /
   * synthesize+analyze=big) instead of collapsing onto the session's main
   * model; "inherit:main" restores the pre-T2-03 session-default behavior; any
   * other value is treated as a literal tier name resolved against the
   * registry-derived default config. A per-run `defaultUntaggedTier` on
   * AgentRunOptions overrides this. With a model-tiers.json present this knob
   * is ignored — the configured "medium" default keeps its existing precedence.
   */
  defaultUntaggedTier?: string;
  /**
   * T-01: subagent skill loading ("all" default keeps the SDK's installed-skill
   * stubs in every read-capable subagent system prompt; "none" passes
   * `noSkills: true` to the shared resource loader so read-capable coding
   * agents skip the whole ~3.1 ktok/turn stub block — skill bodies stay
   * lazy-readable via the read tool on demand).
   */
  subagentSkills?: "all" | "none";
  /**
   * Shared model registry from the host Pi session. When provided, subagents
   * resolve tier/model specs against the same registry the main session uses,
   * including dynamically-registered providers such as ollama-cloud. Without
   * this, the agent builds an isolated registry from disk and may miss models
   * that are only available via extension registration.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory (keyed by the runner's project cwd), instead
   * of the default in-memory session that is discarded when the run ends.
   * Default: false (current behavior).
   */
  persistAgentSessions?: boolean;
  /**
   * Enable Prewalk-style session handoff for this agent instance: run() calls
   * that set `handoff: true` share ONE session, and the model is swapped
   * mid-session (AgentSession.setModel) when the resolved model changes. The
   * first-edit swap gate watches the session's tool surface: on the first
   * file-edit tool call (see {@link handoffToolFilter}) it swaps to
   * {@link handoffExecutionModel}, prunes the planning context, and reports
   * the transition via the run's `onSwap`. Off by default (unchanged
   * behavior: every run() gets a fresh session).
   */
  sessionHandoff?: boolean;
  /**
   * Model spec to swap the handoff session to when the first-edit swap gate
   * fires (resolved via the same registry the run uses). When omitted the gate
   * still flips to execution mode (planning context pruned) but leaves the
   * model unchanged. Requires `sessionHandoff: true`.
   */
  handoffExecutionModel?: string;
  /**
   * Swap-gate trigger predicate: called with each tool call name observed in
   * the handoff session; the first call returning true opens the gate.
   * Defaults to {@link isFileEditTool} (edit/write). Injectable for tests.
   */
  handoffToolFilter?: (toolName: string) => boolean;
  /**
   * Called with the handoff session's id on EVERY handoff run() (creation and
   * reuse) so observers can correlate a chained session across runs — the id
   * is unchanged across a model swap, proving continuation. Requires
   * `sessionHandoff: true`.
   */
  onHandoffSession?: (sessionId: string) => void;
  /**
   * P06 provenance: the stable run identity whose durable-store ledger this
   * instance's settle records should be routed into (resolved from the
   * durable-store module registry). The workflow runner passes its full run
   * options (which carry `runId`) even though this declared type is narrower;
   * the constructor reads `runId` from the runtime object when this field is
   * absent, so real runs emit automatically.
   */
  provenanceRunId?: string;
  /**
   * I1 command watchdog: lazy supplier of the resolved watchdog knobs, applied
   * by this runner to every DEFAULT bash def it creates (the 'off'-mode raw
   * createCodingTools fallback and the worktree-fresh createCodingTools(runCwd)
   * rebind). Default toolsets handed in via `tools` are already wrapped at the
   * toolset-assembly choke point and are NOT double-wrapped here. Absent →
   * current behavior (no wrap).
   */
  commandWatchdog?: () => CommandWatchdogOptions | undefined;
}

// pi >= 0.80.8: ModelRegistry is a sync facade over an async-created ModelRuntime
// (AuthStorage/ModelRegistry.create are gone). The disk-backed fallback is built
// lazily; sync callers see [] until it resolves and real specs on later reads.
let fallbackRuntimePromise: Promise<ModelRuntime> | undefined;
let fallbackRegistry: ModelRegistry | undefined;

function ensureFallbackRegistry(): Promise<ModelRegistry> {
  if (!fallbackRuntimePromise) {
    const dir = getAgentDir();
    // Same auth.json/models.json createAgentSession uses by default, so a model
    // resolved here carries valid credentials.
    fallbackRuntimePromise = (async () => {
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
      });
      // Warm the availability snapshot so the facade's sync getAvailable() is
      // populated immediately after this promise resolves.
      await runtime.getAvailable().catch(() => {});
      return runtime;
    })();
    // Don't cache a rejection: a transient failure (e.g. auth.json lock) would
    // otherwise wedge the fallback for the rest of the process.
    fallbackRuntimePromise.catch(() => {
      fallbackRuntimePromise = undefined;
    });
  }
  return fallbackRuntimePromise.then((runtime) => {
    fallbackRegistry ??= new ModelRegistry(runtime);
    return fallbackRegistry;
  });
}

let warnedNoRuntime = false;

/**
 * The ModelRuntime behind a registry facade. pi's ModelRegistry does not expose
 * its runtime publicly, so reach into the private field (stable since 0.80.8);
 * subagent sessions need it to share the host session's exact catalog and auth
 * (createAgentSession takes modelRuntime, not a registry, since 0.80.8).
 *
 * Exported so the test suite can pin this pi-internals contract: the cast means
 * neither tsc nor mock-based tests would notice pi renaming the field, and the
 * runtime consequence is silent (subagents fall back to a default runtime and
 * extension-registered providers vanish from routing).
 */
export function runtimeOf(registry: ModelRegistry): ModelRuntime | undefined {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime && !warnedNoRuntime) {
    warnedNoRuntime = true;
    console.warn(
      "[workflow] ModelRegistry no longer carries a private `runtime` field (pi internals changed); subagents fall back to a default-built runtime and may miss extension-registered providers",
    );
  }
  return runtime;
}

/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export function listAvailableModels(registry?: ModelRegistry): RankableModel[] {
  try {
    const modelRegistry = registry ?? fallbackRegistry;
    if (!modelRegistry) {
      // Kick off the async fallback build; this call reports [] and later
      // calls (e.g. the tool's lazy promptGuidelines re-reads) see real specs.
      void ensureFallbackRegistry().catch(() => {});
      return [];
    }
    return modelRegistry.getAvailable().map((model) => ({
      spec: canonicalModelSpec(model),
      costOutput: model.cost?.output,
      contextWindow: model.contextWindow,
    }));
  } catch {
    return [];
  }
}

/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry?: ModelRegistry): string[] {
  return listAvailableModels(registry).map((model) => model.spec);
}

/**
 * F23: memoized default-tier config keyed by (registry identity, mainModel).
 * The fresh-install prompt-aware path (no model-tiers.json configured) rebuilt
 * and re-ranked the full available-model list on every run() — a full registry
 * scan + capability sort per agent call. The registry object is a stable
 * reference for a run's lifetime (the shared modelRegistry flows through every
 * agent), so a WeakMap keyed on it never leaks and never serves stale output:
 * the default map depends only on the registry's model catalog, which is fixed
 * for the registry's lifetime.
 */
const defaultTierConfigByRegistry = new WeakMap<ModelRegistry, Map<string, ModelTierConfig>>();

function memoizedDefaultTierConfig(mainModel: string | undefined, registry: ModelRegistry): ModelTierConfig {
  let byMain = defaultTierConfigByRegistry.get(registry);
  if (!byMain) {
    byMain = new Map();
    defaultTierConfigByRegistry.set(registry, byMain);
  }
  const key = mainModel ?? "";
  let config = byMain.get(key);
  if (!config) {
    config = buildDefaultTierConfig(mainModel, listAvailableModels(registry));
    byMain.set(key, config);
  }
  return config;
}

/**
 * F21: live onHistory snapshots walk only this many trailing messages instead
 * of the whole transcript on every session event. The fit caps output at the
 * history DEFAULT_MAX_ENTRIES (40) entries; a 3x tail guarantees the last 40
 * entries stay covered even when a message produces no entry. The final
 * per-run emit (run()'s finally) still walks the full transcript for an exact
 * end state.
 */
const HISTORY_TAIL_MESSAGES = 120;
/** I2 activity bridge (df-3): throttle between onActivity emissions (~250ms, mirrors F21's history throttle). */
const ACTIVITY_EMIT_THROTTLE_MS = 250;

/**
 * F12: grace period after an abort before a run-owned session is force-
 * disposed. Long enough for a responsive session to settle its abort through
 * the normal finally path; bounded so a signal-ignoring subagent's session
 * cannot leak until process exit.
 */
const SECOND_CHANCE_DISPOSE_MS = 10_000;

/**
 * Emitted at most once per process: when an agent asks for a tier but no
 * model-tiers.json exists, the tier silently falls back to the session model.
 * Surface that once (with the mapping the user would get by configuring) so the
 * no-op is discoverable. Diagnostics only — never lets a failure break a run.
 */
let warnedTierUnconfigured = false;
function warnTierUnconfiguredOnce(mainModel: string | undefined, registry: ModelRegistry): void {
  if (warnedTierUnconfigured) return;
  warnedTierUnconfigured = true;
  try {
    console.warn(formatTierFallbackNotice(mainModel, listAvailableModels(registry)));
  } catch {
    // best-effort diagnostic
  }
}

/**
 * Emitted at most once per process when persistAgentSessions is enabled and a
 * session is actually persisted: full subagent transcripts (which may include
 * secrets or other sensitive context) are being written to disk. Surface the
 * privacy trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir: string): void {
  if (warnedPersistSecrets) return;
  warnedPersistSecrets = true;
  console.warn(
    `[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`,
  );
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/**
 * Sum of an AgentUsage's component counters — the invariant total (M26). Every
 * aggregate (workflow.ts's SharedRuntime.tokenUsage and the manager's persisted
 * snapshot) derives `total` from this helper so `total === input + output +
 * cacheRead + cacheWrite` holds by construction, instead of trusting a
 * provider-reported total that may disagree with its own breakdown.
 */
export function usageComponentsTotal(usage: Pick<AgentUsage, "input" | "output" | "cacheRead" | "cacheWrite">): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export function usageFromStats(stats: {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}): AgentUsage | undefined {
  const { tokens, cost } = stats;
  if (tokens.total <= 0 && cost <= 0) return undefined;
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    total: tokens.total,
    cost,
  };
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  /**
   * Display name recorded on the persisted session (session_info entry) when
   * `persistAgentSessions` is enabled, so transcripts are identifiable in
   * session pickers (e.g. `workflow:<runId> <label>`). Ignored for in-memory
   * sessions or when an explicit session.sessionManager override is injected.
   */
  sessionName?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost — but NOT when the provider reported no usage at all
   * (all-zero stats), so consumers keep their scalar fallback.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`, parsed with the same grammar as Pi CLI's `--model`. When it
   * can't be resolved to a known model, `run()` throws MODEL_NOT_FOUND rather
   * than silently substituting the session default — a wrong-model run would
   * otherwise look successful while quietly answering with different (or
   * unauthenticated) weights. When omitted, the session default applies.
   */
  model?: string;
  /**
   * Optional provider pool consulted at the model-resolution step, BEFORE the
   * model is bound to the session. Acquire pins this run to ONE pooled
   * provider for its whole life (sticky), routing by per-provider concurrency
   * caps + weights; the chosen provider's real modelId replaces the caller's
   * spec (thinking level re-applied). A model with no pool entries makes
   * acquire() return undefined and this run falls back to legacy resolution.
   * Handoff continuations bypass the pool entirely — their model is already
   * bound and must never be swapped. The workflow layer owns release/spend/
   * limit-event accounting at final settlement.
   */
  providerPool?: import("./gateway/provider-pool.js").ProviderPool;
  /**
   * Sticky key shared across every retry attempt of the same agent (the run's
   * deltaKey): the pool keeps the SAME provider pin across attempts so
   * provider-side prompt caching stays warm, and release only happens at the
   * run's final attempt. When omitted, each attempt re-balances. Only
   * meaningful with `providerPool`.
   */
  poolStickyKey?: string;
  /**
   * Model tier name (e.g. "small", "medium", "big"). The contract's standard
   * vocabulary is the closed union `"small" | "medium" | "big"` (PRD Task 3);
   * a user-configured route outside it is honored only when context supplies
   * its name and purpose. When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. A tier whose configured entry is the
   * sentinel `"inherit:main"` resolves to the session's main/active model (PRD
   * Task 3) — useful for a `"big"` tier that should track whatever model the
   * user is currently chatting with. An explicit `model` always takes priority,
   * so workflow scripts can use `{ tier: "small" }` for coarse routing without
   * caring which concrete model backs that tier.
   *
   * A script-requested tier that resolves to an unavailable model spec is just
   * as loud as an explicit `model` pin — `run()` throws MODEL_NOT_FOUND naming
   * the tier and the spec it resolved to, e.g. `tier "big" from
   * model-tiers.json resolves to "deadprov/x", which is not available`.
   *
   * That's deliberately asymmetric with the IMPLICIT default tier an untagged
   * agent (neither `model` nor `tier` set) gets routed through: since the
   * script never asked for that tier, a broken default degrades to the
   * session default instead of failing every untagged agent in the run — see
   * onModelFallback below for how that degrade stays visible.
   */
  tier?: string;
  /**
   * T2-03: per-run override of the untagged-agent default tier (no `model`,
   * no `tier` set, no model-tiers.json). "economy" (default) uses the
   * prompt-aware classifyTask fallback; "inherit:main" opts out to the session
   * main model; any other value is a literal tier name. Ignored when a
   * model-tiers.json config exists (the configured "medium" default keeps its
   * existing precedence) or when `model`/`tier` are set explicitly.
   */
  defaultUntaggedTier?: string;
  /**
   * Pipeline stage of the top-level pipeline/phaseState run this agent belongs
   * to ("0"|"1" — the persisted state machine's activePhase clamped to 0..1;
   * wayfinder/prewalk reconnaissance). Threaded into the prompt-aware tier
   * fallback (see resolveAgentModelSpec's `phase`) so scan/edit prompts during
   * those read-only recon stages route to the cheap tier instead of the
   * generic "runtime" classification. Absent (non-pipeline runs), the
   * prompt-aware fallback classifies exactly as it did before GAP-2.
   */
  pipelineStage?: "0" | "1";
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /**
   * Called (at most once per WorkflowAgent instance) when an UNTAGGED agent's
   * implicit default "medium" tier resolves to a model spec that isn't
   * available. This is the one case that degrades to the session default
   * instead of throwing MODEL_NOT_FOUND (see `tier` above) — but the degrade
   * must still land in the run's own log/event stream, not just a
   * console.warn, or a broken default tier silently drifts every untagged
   * agent's model with zero trace in the run itself.
   */
  onModelFallback?: (info: { tier: string; requestedSpec: string }) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /**
   * I2 idle automation (df-3): called (throttled to ~250ms) on ANY activity
   * in the session's FULL event stream — tool_execution_start/update/end and
   * message_start/update/end — NOT just message boundaries. The run-level
   * idle watcher stamps lastActiveAtMs from these, so streaming bash output
   * (`tool_execution_update` partial results) or one long message never makes
   * a productive agent look idle. Runtime metadata only — never a resume
   * hash input.
   */
  onActivity?: () => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * I1 command watchdog: per-call override of the instance-level watchdog
   * supplier (applied to the worktree-fresh createCodingTools(runCwd) defs).
   * Absent → the instance/run-level supplier applies. Never a resume hash
   * input.
   */
  commandWatchdog?: () => CommandWatchdogOptions | undefined;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts before falling back
   * to strict prose extraction. The FIRST repair keeps the full toolset so the
   * provider prefix stays byte-identical (repair turns bill history at cacheRead,
   * T1-02); only a second failed repair restricts the session to
   * structured_output. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Tools that are always injected AFTER the tool-policy filter (`toolNames` /
   * `disallowedToolNames`), so they are available even under a restrictive
   * allowlist. Used by the workflow runtime to inject shared-store tools into
   * every agent regardless of its agentType definition.
   */
  systemTools?: ToolDefinition[];
  /**
   * Per-run model registry override. Takes precedence over the constructor's
   * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
   * resolution and the `createAgentSession` call this run makes. Falls back to
   * the constructor's shared registry, then a lazily-built disk registry, when
   * omitted.
   */
  modelRegistry?: ModelRegistry;
  /**
   * The original workflow-script line of the agent() call this run serves,
   * captured by the workflow layer at call time. Stamped onto every operation
   * trace this run records so a failing tool call is attributable to its
   * owning script line (the differentiator across journal entries).
   */
  scriptLine?: number;
  /**
   * Called once per run (success AND error paths, before run() settles) with
   * this run's tool-call traces, in execution order. Each trace is
   * `{line, op, outcome}` — see {@link OperationTrace}. Absent when the run's
   * session reported no tool calls (or the runner is a test double that never
   * invokes the callback).
   */
  onOperations?: (operations: OperationTrace[]) => void;
  /**
   * Continue the WorkflowAgent's handoff session for this run instead of
   * creating a fresh one: the session (and its trajectory) is kept across
   * handoff runs, and the model is swapped mid-session (setModel) when the
   * resolved model differs. Only meaningful when the agent was constructed
   * with `sessionHandoff: true`; otherwise ignored (fresh session, unchanged
   * behavior).
   */
  handoff?: boolean;
  /**
   * When the model finishes its turn with no final assistant text (a tool-call
   * ending or a thinking-only finish), re-prompt the SAME session once asking
   * for the final answer before declaring AGENT_EMPTY_OUTPUT. A same-session
   * nudge is far cheaper than the workflow-level retry, which re-runs the
   * entire agent from scratch. Only text emitted after the nudge is accepted;
   * an empty nudge still throws AGENT_EMPTY_OUTPUT (recoverable). Silently
   * truncated output (stopReason "length") is never nudged — it is classified
   * CONTEXT_OVERFLOW before this option is consulted. Default true. Set false
   * to pin the legacy immediate-throw behavior.
   */
  emptyOutputNudge?: boolean;
  /**
   * T2-02: optional ceiling on this run's ESTIMATED input tokens (chars/4
   * heuristic over the system-prefix estimate + tool defs + session history +
   * the rendered prompt). When the estimate exceeds the ceiling, run() throws
   * CONTEXT_OVERFLOW BEFORE any prompt is sent — fail fast instead of paying a
   * provider-side context-overflow round-trip mid-stream. Deliberately the
   * same non-recoverable class as a real overflow (the run settles failed +
   * resumable with the same guidance: shorten the prompt or use a larger-
   * context model); retrying the same estimate hits the identical wall, so
   * this is never retried into the same failure. Soft guard: absent, or an
   * unknowable estimate, falls through to today's behavior exactly.
   */
  maxInputTokens?: number;
  /**
   * Called once, when this run's first-edit swap gate fires — i.e. the first
   * file-edit tool call observed in the handoff session. Carries the model
   * change (undefined when no execution model is configured) and the session
   * id, which is UNCHANGED across the swap (the same session continues).
   */
  onSwap?: (info: HandoffSwapInfo) => void;
  /**
   * P06 provenance: the stable run identity whose durable-store ledger this
   * agent's settle should be recorded into (resolved from the durable-store
   * module registry; no-op when unset or the run bound no store). The workflow
   * runner threads the run's runId at construction (WorkflowAgent receives the
   * full run options), so agent() calls in real runs emit automatically.
   */
  provenanceRunId?: string;
  /**
   * P06 provenance: the workflow phase this call was attributed to, recorded
   * on the settle entry. Optional — the workflow layer owns phase routing and
   * does not pass it per call, so real-run settle entries carry no phase (the
   * run report recovers per-agent phases from the persisted roster instead).
   */
  provenancePhase?: string;
}

/**
 * One typed operation trace (Fabric-style): a single tool call observed in a
 * subagent session, pinned to the workflow-script line of the agent() call
 * that owns it. The line is the differentiator across journal entries; within
 * one entry, the op/outcome sequence tells the call's story.
 */
export interface OperationTrace {
  /** Original workflow-script line of the owning agent() call (0 when unknown). */
  line: number;
  /** Tool name, e.g. "edit", "read", "structured_output". */
  op: string;
  /** "ok" | "error: <reason>" | "aborted" — the tool call's terminal outcome. */
  outcome: string;
}

/** Payload delivered when the first-edit swap gate opens (see onSwap). */
export interface HandoffSwapInfo {
  /** Canonical spec of the model the session was on before the swap. */
  fromModel?: string;
  /** Canonical spec of the model the session swapped to, when one was configured. */
  toModel?: string;
  /** Why the gate opened — always "first-edit" today. */
  reason: "first-edit";
  /** Session id — unchanged across the swap (the same session continues). */
  sessionId: string;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

/**
 * Orchestration tools ALWAYS denied to workflow subagents. The `workflow` and
 * `workflow_control` tools are registered globally by the extension, so — unless
 * excluded — a subagent's session sees them and can start its own independent
 * background workflows. Those nested runs recursively fan out and are NOT bounded
 * by the parent run's maxAgents / concurrency / progress / accounting, and can
 * drain a shared provider quota and pile up paused runs (#107). Callers may deny
 * additional tool names via WorkflowAgentOptions.excludeTools.
 */
export const DEFAULT_EXCLUDED_SUBAGENT_TOOLS = ["workflow", "workflow_control"];

/**
 * The full subagent tool denylist: the always-on defaults plus any names the
 * caller added (via WorkflowAgentOptions.excludeTools) or set on the injected
 * session options. Extracted so the merge — and its order — is unit-testable;
 * a spread-order regression that dropped the defaults would slip past a test
 * that only asserts the constant. The SDK dedupes, so overlap is harmless.
 */
export function subagentExcludedTools(extra?: string[], sessionExclude?: string[]): string[] {
  return [...DEFAULT_EXCLUDED_SUBAGENT_TOOLS, ...(sessionExclude ?? []), ...(extra ?? [])];
}

/**
 * Tool names whose execution mutates project files. The first-edit swap gate
 * watches for these: planning runs on the handoff session's cheap model until
 * the first such call, then the gate opens and execution mode (model swap +
 * planning-context pruning) begins.
 */
const FILE_EDIT_TOOL_NAMES = new Set(["edit", "write"]);

/** Default swap-gate trigger predicate: any file-mutating coding tool call. */
function isFileEditTool(toolName: string): boolean {
  return FILE_EDIT_TOOL_NAMES.has(toolName);
}

/**
 * Planning-mode system guidance, prepended to every handoff run()'s prompt
 * while the first-edit swap gate is still closed. Once the gate opens
 * (first file-edit tool call) this block is pruned from subsequent prompts —
 * execution mode no longer re-reads the planning brief; the plan itself lives
 * in the continued session trajectory.
 */
const PLANNING_GUIDANCE =
  "You are in the PLANNING phase: explore and produce a plan. Do not modify project files yet — your analysis must be read-only.";

/**
 * T2-02: fixed chars estimate of the loader-produced system prefix (system
 * prompt + AGENTS.md + skills stubs) that the preflight cannot measure
 * directly — the token-efficiency audit measured ~13.4 KiB ≈ 3,435 tok for the
 * static per-agent prefix. chars/4 over this + tool defs + session history + the
 * rendered prompt is the preflight's incoming-context estimate. Advisory only.
 */
const SYSTEM_PREFIX_ESTIMATE_CHARS = 14_000;

/**
 * T2-02: the reserve kept below the resolved model's context window, matching
 * the SDK's reactive auto-compaction trigger (window − 16,384). The preflight
 * acts (proactive compact / ceiling throw) only when the estimate crosses into
 * the reserve — the same wall the SDK would otherwise hit reactively.
 */
const CONTEXT_HEADROOM_RESERVE_TOKENS = 16_384;

/**
 * Compress a failed tool call's result payload into a short, log-safe reason
 * string for an operation trace's `outcome` field. Never includes raw file
 * contents or secrets — only a truncated text snippet from the tool result.
 */
function summarizeToolError(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "unknown tool error").slice(0, 200);
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return "tool error";
  const text = content
    .filter((part): part is { type: string; text: string } => typeof part?.text === "string")
    .map((part) => part.text)
    .join(" ")
    .trim();
  return (text || "tool error").slice(0, 200);
}

/** Internal operation trace with the tool-call pairing key; stripped before reporting. */
type PendingOperationTrace = OperationTrace & { toolCallId: string };

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  /** I1 command watchdog supplier (see WorkflowAgentOptions.commandWatchdog). */
  private readonly commandWatchdog?: () => CommandWatchdogOptions | undefined;
  /** Extra subagent tool-name denylist, merged with the always-on defaults. */
  private readonly excludeTools: string[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly persistAgentSessions: boolean;
  /**
   * F22: the persist session dir is instance-fixed (keyed by this.cwd), so the
   * write probe (2 syscalls) runs once per WorkflowAgent instead of once per
   * run() call (2 syscalls x up to 1000 agents/run). Only set on success — a
   * failed probe retries next run(), preserving the per-run degrade behavior.
   */
  private sessionDirWritableProbed = false;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  /** T2-03: untagged-agent default routing when no model-tiers.json exists. */
  private readonly defaultUntaggedTier?: string;
  /** T-01: "all" loads skill stubs (parity); "none" skips them (noSkills). */
  private readonly subagentSkills: "all" | "none";
  /** Shared registry from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registry?: ModelRegistry;
  /**
   * Memoized model-tiers.json snapshot, boxed so a legitimately-null config
   * (file absent/invalid) is distinguishable from "not loaded yet". See
   * loadTierConfig() below for why this is scoped per-instance.
   */
  private tierConfigBox?: { value: ModelTierConfig | null };
  /**
   * Shared resource loader for every subagent of this run, built once. See
   * getSharedResourceLoader — this is the #109 memory mitigation.
   */
  private sharedResourceLoaderPromise?: Promise<DefaultResourceLoader>;
  /**
   * Emitted at most once per instance (~= once per run, see the class-level
   * lifetime note above): the untagged/default "medium" tier resolved to a
   * model spec that isn't available. Deliberately per-instance rather than a
   * MODEL_NOT_FOUND throw — an untagged agent never asked for that specific
   * model, so a broken default tier shouldn't fail every untagged agent in the
   * run. See onModelFallback below for the (still-loud) degrade path.
   */
  private warnedDefaultTierUnavailable = false;
  /** Handoff machinery is enabled for this instance (see WorkflowAgentOptions). */
  private readonly sessionHandoff: boolean;
  /** Model spec the first-edit swap gate swaps to; undefined = mode-flip only. */
  private readonly handoffExecutionModel?: string;
  /** Injectable swap-gate trigger predicate (defaults to isFileEditTool). */
  private readonly handoffToolFilter: (toolName: string) => boolean;
  /**
   * The shared handoff session, created on the first handoff run() and kept
   * alive until close(). One session per WorkflowAgent instance (~= one run
   * frame) — see run() for the reuse path.
   */
  private handoffSession?: AgentSession;
  /** True once the handoff session has been disposed (close() or a fatal create error). */
  private handoffSessionClosed = false;
  /** Canonical spec of the model the handoff session is currently on. */
  private handoffSessionModel?: string;
  /** True once the first-edit swap gate has opened for the handoff session. */
  private handoffSwapped = false;
  /** True while a settled swap still owes the session its planning-context prune. */
  private handoffPrunePending = false;
  /** Planning guidance is pruned once the swap gate opens (mode flip). */
  private handoffExecutionMode = false;
  /** Unsubscribe handle for the handoff session's gate/ops listener. */
  private handoffUnsubscribe?: () => void;
  /** Observer hook: session id of every handoff run (see WorkflowAgentOptions). */
  private readonly onHandoffSession?: (sessionId: string) => void;
  /**
   * P06 provenance: the run identity this instance belongs to, captured at
   * construction from the run options the workflow layer passes (the runtime
   * object carries `runId`; a direct embed without one leaves it undefined and
   * the settle hook no-ops). See AgentRunOptions.provenanceRunId.
   */
  private readonly provenanceRunId?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    // I1 command watchdog: wrap the RUNNER-OWNED default bash defs ('off'-mode
    // raw defaults — when no toolset is handed in). Caller-supplied tools are
    // already watchdog-wrapped at the toolset-assembly choke point and must NOT
    // be double-wrapped (nested idle timers). Absent knobs → thin passthrough.
    this.commandWatchdog = options.commandWatchdog;
    // T-02: the search-first read nudge rides ONLY the runner-owned raw default
    // coding tools (the 'off'-mode / direct-embed fallback, when no toolset is
    // handed in). Caller-supplied tools are already nudged at the
    // toolset-assembly choke points (assembler / builtinToolsetTools) and must
    // pass through with array identity preserved (no double wrap, no re-spread).
    this.baseTools =
      options.tools ??
      withSubagentReadGuidance(
        applyCommandWatchdogToTools(createCodingTools(this.cwd), this.cwd, options.commandWatchdog?.()),
      );
    this.excludeTools = options.excludeTools ?? [];
    this.sessionOptions = options.session ?? {};
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    // P06: the workflow runner constructs us with its full WorkflowRunOptions
    // (runId present on the manager path) even though our declared type is the
    // narrower WorkflowAgentOptions — read the run's stable identity so the
    // settle hook can route provenance to the run's durable store (registered
    // by the runtime injection). Explicit per-call overrides win.
    this.provenanceRunId = options.provenanceRunId ?? (options as { runId?: string }).runId;
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.defaultUntaggedTier = options.defaultUntaggedTier;
    this.subagentSkills = options.subagentSkills ?? DEFAULT_SUBAGENT_SKILLS;
    this.sharedRegistry = options.modelRegistry;
    this.sessionHandoff = options.sessionHandoff ?? false;
    this.handoffExecutionModel = options.handoffExecutionModel;
    this.handoffToolFilter = options.handoffToolFilter ?? isFileEditTool;
    this.onHandoffSession = options.onHandoffSession;
  }

  /**
   * Dispose the shared handoff session (if any) and detach its listeners. Safe
   * to call more than once. The workflow layer calls this when the run frame
   * tears down so a chained session never outlives its run.
   */
  close(): void {
    this.handoffUnsubscribe?.();
    this.handoffUnsubscribe = undefined;
    if (this.handoffSession && !this.handoffSessionClosed) {
      try {
        this.handoffSession.dispose();
      } catch {
        // best-effort teardown; never mask a run result
      }
    }
    this.handoffSession = undefined;
    this.handoffSessionClosed = true;
  }

  /**
   * A resource loader shared by every subagent of this run, built once (#109).
   *
   * Without a resourceLoader, createAgentSession() builds a fresh
   * DefaultResourceLoader per subagent and reloads it — re-running EVERY installed
   * extension factory each time (verified: N subagents → N factory runs). Each
   * such factory that arms a load-time timer/listener then roots its subagent
   * session forever, because AgentSession.dispose() emits no session_shutdown to
   * run the cleanup — the dominant #109 leak, and one our own extension
   * (UsageLimitScheduler) can trigger.
   *
   * `noExtensions: true` skips loading host extensions; skills, prompts, and
   * AGENTS.md context still load. The subagent keeps the tools this workflow
   * hands it via `customTools` (coding tools + any toolset like web-research) —
   * those are unaffected. What it loses is HOST EXTENSION-REGISTERED tools (MCP
   * bridges, browser tools, anything a host extension added via ctx.registerTool):
   * pre-change a subagent session inherited those from the full host extension
   * set, now it does not, so an agentType `tools` allowlist naming one matches
   * nothing. This is a deliberate trade-off — it also structurally kills recursive
   * orchestration in subagents (no extension runtime at all), beyond the name-level
   * #107 denylist — and must be release-noted. `createAgentSession` with a shared
   * resourceLoader is a supported embedding pattern. runWorkflow builds one
   * WorkflowAgent per run, so this loader's lifetime is exactly one run: built
   * once, reused by all its subagents, then dropped with the agent.
   */
  private getSharedResourceLoader(agentDir: string): Promise<DefaultResourceLoader> {
    if (!this.sharedResourceLoaderPromise) {
      this.sharedResourceLoaderPromise = (async () => {
        const loader = new DefaultResourceLoader({
          cwd: this.cwd,
          agentDir,
          settingsManager: SettingsManager.create(this.cwd, agentDir),
          noExtensions: true,
          // T-01: subagentSkills "none" strips the skill-stub block (~3.1 ktok)
          // from every read-capable subagent system prompt; the skill bodies
          // stay lazy-readable via the read tool on demand. Default parity
          // holds: "all" leaves noSkills unset exactly as before.
          noSkills: this.subagentSkills === "none" ? true : undefined,
        });
        await loader.reload();
        return loader;
      })().catch((err) => {
        // Don't let a transient build failure (e.g. EMFILE during reload's disk
        // I/O) poison every subagent AND every retry of this run — clear the memo
        // so the next caller rebuilds instead of replaying the same rejection.
        this.sharedResourceLoaderPromise = undefined;
        throw err;
      });
    }
    return this.sharedResourceLoaderPromise;
  }

  /**
   * T2-03: the tier name behind an UNTAGGED agent's implicit default, for the
   * onModelFallback degrade label. Mirrors resolveAgentModelSpec's branches:
   * configured "medium" when a model-tiers.json exists, else the prompt-aware
   * classification tier (economy default). Purely diagnostic — the resolved
   * spec itself is what matters.
   */
  private implicitTierName(
    options: { defaultUntaggedTier?: string; pipelineStage?: "0" | "1" },
    prompt: string,
  ): string {
    if (this.loadTierConfig() != null) return "medium";
    const untaggedDefault = options.defaultUntaggedTier ?? this.defaultUntaggedTier ?? DEFAULT_UNTAGGED_TIER;
    if (untaggedDefault === UNTAGGED_TIER_ECONOMY) {
      return tierNameForTask(options.pipelineStage ?? "runtime", prompt);
    }
    if (untaggedDefault === UNTAGGED_TIER_INHERIT_MAIN) return "medium";
    return untaggedDefault;
  }

  /**
   * Resolve the registry for a run: an explicit per-run registry wins, then the
   * constructor's shared registry, then a lazily-built disk registry (shared
   * across calls once built). Async because pi >= 0.80.8 builds registries from
   * an async-created ModelRuntime.
   */
  private async getRegistry(perRunRegistry?: ModelRegistry): Promise<ModelRegistry> {
    if (perRunRegistry) {
      return perRunRegistry;
    }
    if (this.sharedRegistry) {
      return this.sharedRegistry;
    }
    if (!this.registry) {
      this.registry = await ensureFallbackRegistry();
    }
    return this.registry;
  }

  /**
   * Read+parse ~/.pi/workflows/model-tiers.json at most once for this
   * instance's lifetime, instead of on every run() call. `resolveAgentModelSpec`
   * previously received `loadModelTierConfig` directly (sync existsSync +
   * readFileSync + JSON.parse from disk), which it calls unconditionally for
   * any agent without an explicit options.model — so a large fan-out did N
   * redundant synchronous disk reads that blocked the event loop and stalled
   * concurrent agents' I/O.
   *
   * `runWorkflow()` constructs a fresh `WorkflowAgent` per run (see
   * `new WorkflowAgent(options)` in workflow.ts, unless a caller injects its
   * own `options.agent` runner — a test-only escape hatch per
   * WorkflowManagerOptions.agent's doc comment), so a WorkflowAgent instance's
   * lifetime is one run in production. Memoizing on `this` therefore has the
   * same scope and lifetime as the agentRegistry snapshot workflow.ts already
   * takes once per run "for determinism" — the config file isn't expected to
   * change mid-run, and two different runs (= two different WorkflowAgent
   * instances) each get their own fresh read of whatever is on disk at the
   * time, so this does not leak stale config across runs or break tests that
   * construct fresh agents with different configs.
   *
   * `loader` is injectable for tests (defaults to the real disk read); it is
   * only ever consulted once, on the first call, regardless of what is passed
   * on later calls.
   */
  private loadTierConfig(loader: () => ModelTierConfig | null = loadModelTierConfig): ModelTierConfig | null {
    if (!this.tierConfigBox) {
      this.tierConfigBox = { value: loader() };
    }
    return this.tierConfigBox.value;
  }

  /**
   * Session manager for one subagent run. File-backed (persisted under the
   * standard sessions dir, keyed by the runner's project cwd — never a
   * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
   *
   * SessionManager.create() only creates the session directory — the SDK writes
   * the session file lazily (synchronous fs calls, uncaught) on the first
   * assistant message, deep inside session.prompt(). A failure there would
   * otherwise throw mid-run and abort this subagent. Probe writability up front
   * so any create/write failure (permissions, disk full) degrades this single
   * agent to an in-memory session instead — the run continues, just without a
   * persisted transcript.
   */
  private createSessionManager(): SessionManager {
    if (!this.persistAgentSessions) return SessionManager.inMemory();
    try {
      const manager = SessionManager.create(this.cwd);
      // The probe is 2 sync syscalls and the dir is fixed for this instance's
      // lifetime — run it once, not on every run() (F22).
      if (!this.sessionDirWritableProbed) {
        this.assertSessionDirWritable(manager.getSessionDir());
        this.sessionDirWritableProbed = true;
      }
      warnPersistSecretsOnce(manager.getSessionDir());
      return manager;
    } catch (error) {
      console.warn(
        `[workflow] persistAgentSessions: could not persist this agent's session (${
          error instanceof Error ? error.message : String(error)
        }); continuing with an in-memory session`,
      );
      return SessionManager.inMemory();
    }
  }

  /** Best-effort write probe: throws if the session directory isn't actually writable. */
  private assertSessionDirWritable(dir: string): void {
    const probePath = join(dir, `.write-probe-${randomUUID()}`);
    writeFileSync(probePath, "");
    unlinkSync(probePath);
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
    // since tools capture their cwd at construction and can't be relocated.
    // I1 command watchdog: the worktree-fresh defs are wrapped here too (the
    // bypass the default-toolset choke point would otherwise leave open); the
    // per-call watchdog override wins over the instance-level supplier, and
    // absent knobs → thin passthrough (byte-identical).
    const runCwd = options.cwd ?? this.cwd;
    const watchdog = options.commandWatchdog ?? this.commandWatchdog;
    const baseTools =
      runCwd === this.cwd
        ? this.baseTools
        : withSubagentReadGuidance(applyCommandWatchdogToTools(createCodingTools(runCwd), runCwd, watchdog?.()));
    // Apply the agentType tool policy BEFORE adding structured_output, so a
    // restrictive allowlist never strips the schema tool.
    const customTools: ToolDefinition[] = applyToolPolicy(
      [...baseTools, ...(options.tools ?? [])],
      options.toolNames,
      options.disallowedToolNames,
    );

    // System tools bypass the allowlist/denylist filter (e.g. shared-store tools).
    if (options.systemTools?.length) {
      customTools.push(...options.systemTools);
    }

    if (options.schema) {
      // Strict OpenAI-compatible providers (e.g. DeepSeek) reject a tool whose top-level
      // parameters schema isn't a JSON object with a transport-level 400, before any of
      // this file's SCHEMA_NONCOMPLIANCE/empty-output classification ever runs. Fail fast
      // here instead, so a script's non-object opts.schema surfaces a clear workflow error.
      const schemaType = (options.schema as { type?: unknown }).type;
      if (schemaType !== "object") {
        throw new WorkflowError(
          `agent() opts.schema must be a top-level JSON object schema (type: "object") — got type: ${schemaType ?? "undefined"}; wrap array/primitive results in an object, e.g. { type: "object", properties: { items: <your schema> } }`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    // Per-run modelRegistry wins over the constructor's shared registry, then
    // the lazily-built disk fallback. Used for tier diagnostics, model
    // resolution, and the subagent session's runtime below.
    const modelRegistry = await this.getRegistry(options.modelRegistry);

    // Resolve the model spec (explicit model > tier > session default). This
    // composes with phase-based routing in workflow.ts, which only supplies
    // options.model when a phase pattern matches — so an explicit model wins.
    let modelSpec = resolveAgentModelSpec(
      // T2-03: merge the constructor-level untagged-default knob under the
      // per-call override (the option object is per-call, so the spread is
      // cheap and the merged value is what the economy branch reads).
      {
        model: options.model,
        tier: options.tier,
        defaultUntaggedTier: options.defaultUntaggedTier ?? this.defaultUntaggedTier,
      },
      this.mainModel,
      () => this.loadTierConfig(),
      () => warnTierUnconfiguredOnce(this.mainModel, modelRegistry),
      prompt,
      // Rank the prompt-aware tier fallback against the SAME registry the
      // warning above uses — otherwise an injected options.modelRegistry
      // (tests, multi-registry setups) would be ranked against the
      // module-level disk fallback and could pick a model absent from the
      // injected registry (routing-budgets:i3).
      () => listAvailableModels(modelRegistry),
      // F23: reuse the per-registry default-tier rank across run() calls
      // instead of re-scanning + re-ranking the full registry on every agent
      // (fresh-install path, no model-tiers.json).
      (main) => memoizedDefaultTierConfig(main, modelRegistry),
      // GAP-2: the pipeline stage threaded by workflow.ts (clamped 0..1 from
      // the persisted state machine) so wayfinder/prewalk reconnaissance
      // classifies scan/edit prompts to the cheap tier. Absent on non-pipeline
      // runs — the prompt-aware fallback then classifies as "runtime" as before.
      options.pipelineStage,
    );

    // Provider pool: consult BEFORE model resolution so the session binds the
    // POOLED provider. The logical key is the resolved spec with any provider
    // prefix and :thinking suffix stripped (tiers/routing select the logical
    // id; the pool maps it to per-provider modelId aliases). A choice
    // overrides the caller's spec with `<provider>/<modelId>` (thinking level
    // re-applied), so the pool's caps + auth decide the concrete endpoint.
    // Handoff continuations bypass the pool: their model is already bound and
    // must never be swapped (acquire would re-count/rebind). Acquire errors
    // (abort, PROVIDER_SATURATED) propagate unchanged — the workflow layer
    // owns release/spend/limit-event accounting at final settlement.
    const poolHandoffContinuation =
      this.sessionHandoff &&
      options.handoff === true &&
      this.handoffSession !== undefined &&
      !this.handoffSessionClosed;
    if (options.providerPool && !poolHandoffContinuation && modelSpec) {
      const { modelSpec: logicalSpec, thinkingLevel } = splitModelSpecThinking(modelSpec);
      const choice = await options.providerPool.acquire(logicalModelKey(logicalSpec, modelRegistry), {
        stickyKey: options.poolStickyKey,
        signal: options.signal,
      });
      if (choice) {
        modelSpec = formatModelSpecWithThinking(`${choice.provider}/${choice.modelId}`, thinkingLevel);
      }
    }

    // Resolve a requested model spec to a Model object. Specs use Pi CLI-style
    // parsing, including an optional :thinking suffix such as gpt-5.5:xhigh.
    //
    // A given-but-unresolved spec's behavior is asymmetric by design (#131):
    //   - options.model or options.tier was explicitly set by the script (or by
    //     workflow.ts's phase-based routing, which only ever supplies
    //     options.model when the user configured that phase) → throw
    //     MODEL_NOT_FOUND naming the source. Resolution is deterministic, so
    //     retrying the same spec is pointless (recoverable:false), and a silent
    //     substitution would otherwise run real API calls against a different
    //     (or unauthenticated) model while the caller believes its pin/tier was
    //     honored.
    //   - neither was set: the agent is UNTAGGED and only got routed through
    //     the implicit default "medium" tier because *some other* agent's tier
    //     is configured (see resolveAgentModelSpec). This agent never asked for
    //     that model, so a broken default tier degrades to the session default
    //     instead of failing every untagged agent in the run — but the degrade
    //     still needs to be loud (onModelFallback), not a silent continuation.
    const isExplicitRequest = Boolean(options.model || options.tier);
    // A tier whose KEY is absent from the loaded model-tiers.json is a config
    // error, not a degrade: resolveAgentModelSpec returns undefined for the
    // key-miss (instead of silently substituting mainModel), so surface it as
    // a hard, named error. The untagged/implicit-medium path (options.tier
    // unset) keeps its designed degrade to the session default below.
    if (options.tier && modelSpec === undefined) {
      throw new WorkflowError(
        `tier "${options.tier}" is not configured in model-tiers.json; add it with /workflows-models`,
        WorkflowErrorCode.MODEL_NOT_FOUND,
        { recoverable: false, agentLabel: options.label },
      );
    }
    let resolvedModel: Model<any> | undefined;
    let resolvedThinkingLevel: CreateAgentSessionOptions["thinkingLevel"] | undefined;
    if (modelSpec) {
      const resolved = resolveModelSpecWithThinking(modelSpec, modelRegistry);
      if (resolved.warning) console.warn(`[workflow] ${resolved.warning}`);
      if (!resolved.model) {
        if (isExplicitRequest) {
          // The resolver's error already names the spec and the remedy; the tier
          // branch swaps in its own message so the config source is named too.
          const message = options.model
            ? (resolved.error ?? `Model "${modelSpec}" not found. Use /workflows-models to choose an available model.`)
            : `tier "${options.tier}" from model-tiers.json resolves to "${modelSpec}", which is not available. Use /workflows-models to choose an available model.`;
          throw new WorkflowError(message, WorkflowErrorCode.MODEL_NOT_FOUND, {
            recoverable: false,
            agentLabel: options.label,
          });
        }
        if (!this.warnedDefaultTierUnavailable) {
          this.warnedDefaultTierUnavailable = true;
          // T2-03: label the degrade with the tier that actually produced the
          // spec — the configured "medium" default, or the prompt-aware
          // classification tier under the no-config economy default.
          options.onModelFallback?.({
            tier: this.implicitTierName(options, prompt),
            requestedSpec: modelSpec,
          });
        }
      } else {
        resolvedModel = resolved.model;
        resolvedThinkingLevel = resolved.thinkingLevel;
        options.onModelResolved?.(resolved.resolvedSpec ?? canonicalModelSpec(resolved.model));
      }
    }

    const agentDir = getAgentDir();
    // The runtime behind the resolved registry, handed to the subagent session
    // below so it shares the host session's exact catalog and auth.
    const modelRuntime = runtimeOf(modelRegistry);
    // Key persisted sessions by the runner's project cwd (this.cwd), NOT the
    // per-call runCwd: agents working in short-lived git worktrees should still
    // group under the project's session dir instead of scattering across
    // temporary worktree paths.
    const sessionManager = this.createSessionManager();
    // Tool-call traces for THIS run, collected from the session's tool events
    // in execution order. Pinned to the owning agent() call's script line.
    const operations: PendingOperationTrace[] = [];
    // F18: toolCallId → trace index for O(1) end-event lookup instead of a
    // linear scan per tool-call end (O(n^2) over a long tool-heavy session).
    // Per-run, so it never leaks across runs; the array still owns order.
    const operationsByToolCallId = new Map<string, PendingOperationTrace>();
    // Resolves once the first-edit swap gate's model change settles (if the
    // gate fired this run); awaited in the finally so the swap is deterministic
    // by the time run() settles.
    let gateSwapPromise: Promise<void> | undefined;

    /**
     * Prewalk handoff: a handoff run() continues the instance's shared session
     * instead of creating a fresh one — phase N+1's trajectory carries over and
     * the model is swapped mid-session when it changes. The session is retained
     * (not disposed in the finally) until close().
     */
    const activeHandoffSession =
      this.sessionHandoff && options.handoff === true && this.handoffSession !== undefined && !this.handoffSessionClosed
        ? this.handoffSession
        : undefined;
    const reuseHandoff = activeHandoffSession !== undefined;

    let session: AgentSession;
    if (reuseHandoff) {
      session = activeHandoffSession;
      // Swap the model mid-session when this run's resolved model differs from
      // the model the session is currently on (the SDK supports continuation
      // across a model change via setModel).
      if (resolvedModel && canonicalModelSpec(resolvedModel) !== this.handoffSessionModel) {
        await session.setModel(resolvedModel);
        this.handoffSessionModel = canonicalModelSpec(resolvedModel);
      }
      this.onHandoffSession?.(session.sessionId);
    } else {
      const created = await createAgentSession({
        cwd: runCwd,
        agentDir,
        sessionManager,
        // Use real SettingsManager to inherit user's default provider/model settings.
        // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
        // would fall back to the first available model (e.g. openai-codex) which may
        // not have valid auth, causing silent empty responses.
        settingsManager: SettingsManager.create(this.cwd, agentDir),
        customTools,
        // Shared per-run loader with no host extensions (#109) — see
        // getSharedResourceLoader. An injected resourceLoader (tests / embedders)
        // wins and skips the shared build entirely; the ...this.sessionOptions
        // spread below re-applies the same injected value harmlessly.
        resourceLoader: this.sessionOptions.resourceLoader ?? (await this.getSharedResourceLoader(agentDir)),
        // Share the resolved registry's ModelRuntime (catalog + auth, including
        // extension-registered providers) with the subagent session. pi >= 0.80.8
        // takes modelRuntime here; the old modelRegistry option is gone.
        ...(modelRuntime ? { modelRuntime } : {}),
        ...this.sessionOptions,
        // Per-call model/thinking wins over any sessionOptions defaults.
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel } : {}),
        // Deny recursive-orchestration tools in the subagent (#107). Placed after
        // the sessionOptions spread so it always applies; folds in any denylist
        // the caller set on sessionOptions rather than dropping it.
        excludeTools: subagentExcludedTools(this.excludeTools, this.sessionOptions.excludeTools),
      });
      session = created.session;
      if (this.sessionHandoff && options.handoff === true) {
        // This run is the root of (or a continuation of) the handoff chain;
        // retain the session + manager so later handoff runs continue it.
        this.handoffSession = session;
        this.handoffSessionClosed = false;
        // Track the model the session actually started on (the resolved spec
        // when one was set, else the session's own default) so later swaps can
        // compare and report an honest fromModel.
        this.handoffSessionModel =
          (resolvedModel !== undefined ? canonicalModelSpec(resolvedModel) : undefined) ??
          (session.model ? canonicalModelSpec(session.model) : undefined) ??
          this.handoffSessionModel;
        this.onHandoffSession?.(session.sessionId);
      }
    }

    // Name the persisted session so it's identifiable in session pickers.
    // Skip when an injected session.sessionManager override won (tests/embedders)
    // or the session is a reused handoff continuation.
    if (this.persistAgentSessions && !this.sessionOptions.sessionManager && options.sessionName && !reuseHandoff) {
      try {
        sessionManager.appendSessionInfo(options.sessionName);
      } catch {
        // Naming is best-effort; never fail the run over it.
      }
    }

    // Observe the session's tool surface: collect typed operation traces and,
    // for handoff sessions, arm the first-edit swap gate. Both share one
    // subscription so concurrent tool batches stay in one event stream. The
    // SAME stream also drives the I2 activity bridge (df-3): every
    // tool_execution_*/message_* event counts as activity (250ms-throttled),
    // so streaming bash output and one long message keep the run-level idle
    // watcher's lastActiveAtMs fresh.
    let lastActivityEmit = 0;
    const emitActivity = () => {
      if (!options.onActivity) return;
      const now = Date.now();
      if (now - lastActivityEmit < ACTIVITY_EMIT_THROTTLE_MS) return;
      lastActivityEmit = now;
      options.onActivity();
    };
    const removeToolListener = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const trace: PendingOperationTrace = {
          toolCallId: event.toolCallId,
          line: options.scriptLine ?? 0,
          op: event.toolName,
          outcome: "running",
        };
        operations.push(trace);
        operationsByToolCallId.set(event.toolCallId, trace);
        if (this.sessionHandoff && !this.handoffSwapped && this.handoffToolFilter(event.toolName)) {
          // First file-edit tool call: open the gate. Execution mode begins
          // (planning guidance pruned) and the model swap runs detached, awaited
          // in the finally so run() settles only after it resolves.
          this.handoffSwapped = true;
          this.handoffExecutionMode = true;
          this.handoffPrunePending = true;
          gateSwapPromise = this.performSwap(session, options).catch((error) => {
            console.warn(
              `[workflow] first-edit swap failed: ${error instanceof Error ? error.message : String(error)}; continuing in execution mode on the current model`,
            );
          });
        }
      } else if (event.type === "tool_execution_end") {
        const trace = operationsByToolCallId.get(event.toolCallId);
        if (trace) {
          trace.outcome = event.isError ? `error: ${summarizeToolError(event.result)}` : "ok";
        }
      }
      // I2 activity bridge (df-3): the FULL session event stream — the model
      // working (tool_execution_*) and the model talking (message_*). Never
      // keyed on bash_execution_update (session.executeBash-only).
      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end" ||
        event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end"
      ) {
        emitActivity();
      }
    });

    let removeAbortListener: (() => void) | undefined;
    let removeHistoryListener: (() => void) | undefined;
    let lastHistoryEmit = 0;
    /** F21: last observed message count — an unchanged length means no new content. */
    let lastHistoryLength = -1;
    const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
    const maybeEmitHistory = () => {
      if (!options.onHistory) return;
      // Most session events (tool_execution_start/end, model events) do NOT
      // append a message; skip the full compaction+emit when nothing grew.
      if (session.messages.length === lastHistoryLength) return;
      const now = Date.now();
      if (now - lastHistoryEmit < 250) return;
      lastHistoryEmit = now;
      lastHistoryLength = session.messages.length;
      // Live progress snapshot: walk only the recent tail, not the whole
      // transcript on every event (the fit keeps only the last entries).
      options.onHistory?.(compactAgentHistory(session.messages.slice(-HISTORY_TAIL_MESSAGES)));
    };

    // F12: second-chance dispose safety net. When a workflow-level timeout (or
    // any abort) fires but the subagent ignores the abort — a hung tool call or
    // a non-abortable provider stream — session.prompt never settles and the
    // finally never runs, leaking the session (listeners, timers, resources)
    // until process exit. The abort handler arms a bounded timer that
    // force-disposes the run-owned session; run() settling first cancels it,
    // and disposeRunSession's guard skips a double-dispose.
    const runOwnsSession = !(reuseHandoff || (this.sessionHandoff && options.handoff === true));
    let secondChanceTimer: SafeTimer | undefined;
    let sessionDisposed = false;
    const disposeRunSession = () => {
      if (sessionDisposed) return;
      sessionDisposed = true;
      try {
        session.dispose();
      } catch {
        // best-effort teardown; never mask the run result
      }
    };
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => {
          void session.abort();
          // F12: give a responsive session its normal settle path; force-
          // dispose only after the grace period, and only run-owned sessions
          // (a handoff session survives run() and close() owns its teardown).
          if (runOwnsSession && !sessionDisposed) {
            secondChanceTimer = safeSetTimeout(() => disposeRunSession(), SECOND_CHANCE_DISPOSE_MS).unref();
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onHistory) {
        removeHistoryListener = session.subscribe(() => maybeEmitHistory());
      }

      // T2-02 context-window headroom preflight: estimate the incoming context
      // BEFORE prompting so a long trajectory fails fast (maxInputTokens) or
      // compacts proactively instead of paying a provider-side CONTEXT_OVERFLOW
      // round-trip mid-stream. Advisory and soft-guarded — an unknowable
      // estimate/window falls through to today's behavior exactly, and the
      // CONTEXT_OVERFLOW class stays non-recoverable (the ceiling only fires it
      // earlier).
      await this.maybePreflightContextHeadroom(
        session,
        prompt,
        options as AgentRunOptions<any>,
        customTools,
        Boolean(options.schema),
        modelRegistry,
        resolvedModel,
      );

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path). Context
      // overflow is buried the same way; detect it first so it settles the run
      // failed+resumable rather than exhausting retries into a silent null. A 5xx
      // outage is buried the same way: 503/504 pause the run, 500/502 retry with
      // backoff (see throwIfProviderUnavailable). The 5xx classifier runs BEFORE
      // the limit classifier (F06) so a limit-phrased 503/504 — e.g. "503 rate
      // limit exceeded" — surfaces as PROVIDER_OVERLOADED (the real pause-worthy
      // cause) rather than a misleading PROVIDER_USAGE_LIMIT; pure limit text
      // (429/quota/rate) still matches throwIfProviderLimit afterwards.
      throwIfProviderUnavailable(session.messages, options.label);
      throwIfContextOverflow(session.messages, options.label);
      throwIfProviderLimit(session.messages, options.label);
      // Silent truncation with no final answer is an overflow even with no
      // provider error text: the trajectory hit its output ceiling, so neither a
      // retry nor the nudge below can recover it. Classified before BOTH the
      // schema branch and the nudge so a truncated schema agent settles
      // CONTEXT_OVERFLOW (correct guidance: the context wall) instead of
      // SCHEMA_NONCOMPLIANCE (wrong guidance: the schema). A "length" stop that
      // still holds a complete final answer passes the gate (F20) and returns.
      throwIfTruncatedOutput(session.messages, options.label);

      if (options.schema) {
        return (await resolveStructuredOutput(session, capture, options.schema, options, (m) =>
          this.lastAssistantText(m),
        )) as AgentRunResult<TSchemaDef>;
      }

      // Unstructured result: require assistant text AFTER the last tool result.
      // Text emitted before it is stale progress (the agent's last real action was
      // a tool call) — accepting it would report an incomplete run as successful
      // and suppress the AGENT_EMPTY_OUTPUT retry (#111).
      let text = this.finalAssistantText(session.messages);
      if (!text.trim() && options.emptyOutputNudge !== false) {
        // Same-session recovery nudge (#135): an empty final message is usually a
        // model that ended its turn on a tool call or a thinking-only finish, not
        // a real failure. One cheap follow-up prompt recovers it in place — far
        // cheaper than the workflow-level retry, which re-runs the ENTIRE agent
        // from scratch. Only text emitted AFTER the nudge is accepted, so an empty
        // nudge still throws AGENT_EMPTY_OUTPUT below (recoverable).
        await session.prompt(
          "Your last turn ended without a final answer. Produce your final answer now as plain text — a concise summary of what you did and the result. Do not call any tools.",
        );
        if (options.signal?.aborted) throw new Error("Subagent was aborted");
        // The nudge turn itself can hit a usage limit / overflow / 5xx / truncation
        // — surface that as the real cause, never as a bogus empty-output null.
        // 5xx is classified before limit phrases (F06), same as the main path.
        throwIfProviderUnavailable(session.messages, options.label);
        throwIfContextOverflow(session.messages, options.label);
        throwIfProviderLimit(session.messages, options.label);
        throwIfTruncatedOutput(session.messages, options.label);
        text = this.finalAssistantText(session.messages);
      }
      if (!text.trim()) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: options.label,
        });
      }
      return text as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      removeHistoryListener?.();
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      // A run that never settled a tool call leaves "running" traces — an
      // abort/timeout mid-call. Normalize them before reporting so consumers
      // never see a non-terminal outcome.
      for (const trace of operations) {
        if (trace.outcome === "running") trace.outcome = "aborted";
      }
      // Settle the first-edit swap (model change) before this run reports, so
      // a caller observing onSwap/onOperations sees a consistent end state.
      if (gateSwapPromise) {
        try {
          await gateSwapPromise;
        } catch {
          // performSwap already logs; never let the swap mask the real result.
        }
        gateSwapPromise = undefined;
      }
      // Planning context prune: once the swap gate has opened, fold the raw
      // planning transcript into a compact summary so execution-mode turns send
      // less context (best-effort — the SDK refuses tiny sessions, and a prune
      // failure degrades to keeping the trajectory, which is still correct).
      if (this.handoffPrunePending && !this.handoffSessionClosed) {
        this.handoffPrunePending = false;
        try {
          await session.compact(
            "The planning phase is complete. Keep only the agreed plan and any decisions; discard raw exploration context.",
          );
        } catch {
          // best-effort pruning; execution continues on the unpruned trajectory
        }
      }
      if (options.onOperations) {
        try {
          options.onOperations(operations.map(({ toolCallId: _id, ...trace }) => trace));
        } catch {
          // Traces are diagnostic; never let them mask the real result/error.
        }
      }
      // Read real usage before disposing — dispose tears down the session state.
      if (options.onUsage) {
        try {
          const usage = usageFromStats(session.getSessionStats());
          if (usage) options.onUsage(usage);
        } catch {
          // Usage is best-effort; never let stats failure mask the real result/error.
        }
      }
      // Handoff sessions survive run() so the next handoff call can continue
      // the trajectory; every other session is disposed as before. The guard is
      // shared with the F12 second-chance timer: a force-dispose that raced a
      // settling run must never be applied twice, and a pending timer is
      // cancelled since the normal path is about to dispose anyway.
      secondChanceTimer?.clear();
      secondChanceTimer = undefined;
      if (runOwnsSession) {
        disposeRunSession();
      }
      // P06 provenance at agent settle: record this run's settle in the run's
      // durable-store ledger (resolved by runId from the module registry — a
      // no-op when the run bound no store or the identity is absent). Fires on
      // BOTH success and error paths, exactly once per run() call; the ledger
      // dedupes repeats (same source+agent) so a retried attempt collapses.
      // Best-effort by design: a durable-store write must never mask the run
      // result or delay teardown.
      if (this.provenanceRunId) {
        try {
          await recordProvenance(this.provenanceRunId, {
            source: "agent",
            agent: options.label,
            phase: options.provenancePhase,
          });
        } catch {
          // provenance is observability, not execution
        }
      }
      removeToolListener();
    }
  }

  /**
   * T2-02: the resolved model's context window, when the registry reports one.
   * Uses the same listAvailableModels projection the tier fallback ranks
   * against (read-only — never mutates model resolution; slice C owns the
   * resolution semantics). Resolves via the session's current model when no
   * explicit model was resolved (handoff continuations keep the session's
   * model). undefined = unknown window → the preflight is a no-op (soft guard).
   */
  private resolvedContextWindow(
    modelRegistry: ModelRegistry | undefined,
    resolvedModel: Model<any> | undefined,
    session: AgentSession,
  ): number | undefined {
    try {
      const spec = resolvedModel
        ? canonicalModelSpec(resolvedModel)
        : session.model
          ? canonicalModelSpec(session.model)
          : undefined;
      if (!spec) return undefined;
      return listAvailableModels(modelRegistry).find((m) => m.spec === spec)?.contextWindow;
    } catch {
      // A registry/refresh failure must never break the run — advisory only.
      return undefined;
    }
  }

  /**
   * T2-02: chars/4 estimate of the incoming context for the NEXT prompt: the
   * rendered prompt (system instructions + planning guidance + task + schema
   * contract), the JSON of the tool definitions this run serves, the existing
   * session history (handoff trajectories), and a documented fixed estimate of
   * the loader-produced system prefix the code cannot measure directly.
   * Returns undefined when nothing knowable is comparable (never throws) —
   * the soft guard that falls through to today's behavior.
   */
  private estimateIncomingInputTokens(
    prompt: string,
    options: AgentRunOptions<any>,
    tools: ToolDefinition[],
    session: AgentSession,
    structured: boolean,
  ): number | undefined {
    try {
      let chars = SYSTEM_PREFIX_ESTIMATE_CHARS + this.buildPrompt(prompt, options, structured).length;
      try {
        chars += JSON.stringify(tools).length;
      } catch {
        // Tool defs are plain objects; a stringify failure is not worth failing on.
      }
      const history = session.messages;
      if (Array.isArray(history)) {
        try {
          chars += JSON.stringify(history).length;
        } catch {
          // History may hold non-stringifiable content — skip it.
        }
      }
      return Math.ceil(chars / 4);
    } catch {
      return undefined;
    }
  }

  /**
   * T2-02 context-window headroom preflight: estimate the incoming context
   * BEFORE prompting so a long trajectory fails fast or compacts instead of
   * paying a provider-side CONTEXT_OVERFLOW round-trip mid-stream. Advisory by
   * design — chars/4 heuristics + a fixed system-prefix estimate; any
   * unknowable input (no window reported, estimate failure, no model) falls
   * through to today's behavior exactly. Never changes model resolution and
   * never converts CONTEXT_OVERFLOW into a recoverable class: the
   * maxInputTokens ceiling throws the SAME non-recoverable CONTEXT_OVERFLOW
   * the provider would, just earlier (workflow-prompt-budget tests rely on the
   * non-recoverable semantics).
   *
   * Actions:
   * - estimate > maxInputTokens → throw before any prompt is sent.
   * - estimate > window − 16,384 (the SDK's auto-compact reserve) with real
   *   history → proactively session.compact(custom summary) so the next prompt
   *   fits; a fresh/empty session has nothing to compact (the oversized part
   *   is the static prefix + prompt, which compaction cannot shrink) and gets
   *   a warning instead.
   */
  private async maybePreflightContextHeadroom(
    session: AgentSession,
    prompt: string,
    options: AgentRunOptions<any>,
    tools: ToolDefinition[],
    structured: boolean,
    modelRegistry: ModelRegistry | undefined,
    resolvedModel: Model<any> | undefined,
  ): Promise<void> {
    const estimate = this.estimateIncomingInputTokens(prompt, options, tools, session, structured);
    if (estimate === undefined) return; // soft guard: nothing knowable to compare
    if (options.maxInputTokens !== undefined && estimate > options.maxInputTokens) {
      throw new WorkflowError(
        `Estimated input (${estimate} tokens) exceeds agentOptions.maxInputTokens (${options.maxInputTokens}); the agent never started — shorten the prompt, reduce the session history, or raise the ceiling`,
        WorkflowErrorCode.CONTEXT_OVERFLOW,
        { recoverable: false, agentLabel: options.label },
      );
    }
    const window = this.resolvedContextWindow(modelRegistry, resolvedModel, session);
    if (window === undefined || !Number.isFinite(window) || window <= 0) return; // soft guard
    const reserve = Math.max(0, window - CONTEXT_HEADROOM_RESERVE_TOKENS);
    if (estimate <= reserve) return;
    const historyCount = Array.isArray(session.messages) ? session.messages.length : 0;
    if (historyCount < 2) {
      // Fresh session: the static prefix + prompt dominate and cannot be
      // compacted — advise, don't act (a compact of an empty trajectory is a
      // no-op anyway and the SDK refuses tiny sessions).
      console.warn(
        `[workflow] agent "${options.label ?? ""}" estimated input ${estimate} tokens is over the ${window}-token context window's reserve (${reserve}); the static prefix dominates — prefer a shorter prompt or a larger-context model`,
      );
      return;
    }
    try {
      await session.compact(
        "The conversation is approaching the context window. Keep only the essential plan, decisions, and pending work; discard raw exploration and tool output.",
      );
      console.warn(
        `[workflow] agent "${options.label ?? ""}" proactively compacted ${historyCount} history messages before prompting (estimated ${estimate} tokens vs a ${window}-token window)`,
      );
    } catch (error) {
      // Best-effort: an SDK compaction refusal degrades to the reactive path.
      console.warn(
        `[workflow] proactive compaction failed for agent "${options.label ?? ""}": ${error instanceof Error ? error.message : String(error)}; relying on reactive auto-compaction`,
      );
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      // Planning guidance is injected ONLY for handoff sessions while the
      // first-edit swap gate is still closed; it is pruned once the gate
      // opens (execution mode). Ordinary (non-handoff) agents are untouched.
      this.sessionHandoff && !this.handoffExecutionMode ? PLANNING_GUIDANCE : undefined,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  /**
   * The first-edit swap gate's model half: swap the handoff session to the
   * configured execution model (best-effort — an unresolvable/unauthenticated
   * spec degrades to keeping the current model with a warning, never a throw),
   * then report the transition via onSwap. Called detached from the tool event
   * listener; run()'s finally awaits the returned promise so the swap is
   * settled before run() reports.
   */
  private async performSwap(session: AgentSession, options: AgentRunOptions<any>): Promise<void> {
    const fromModel = this.handoffSessionModel;
    let toModel = fromModel;
    if (this.handoffExecutionModel) {
      try {
        const registry = await this.getRegistry(options.modelRegistry);
        const resolved = resolveModelSpecWithThinking(this.handoffExecutionModel, registry);
        if (resolved.warning) console.warn(`[workflow] ${resolved.warning}`);
        if (resolved.model && canonicalModelSpec(resolved.model) !== this.handoffSessionModel) {
          await session.setModel(resolved.model);
          this.handoffSessionModel = canonicalModelSpec(resolved.model);
          toModel = this.handoffSessionModel;
        }
      } catch (error) {
        console.warn(
          `[workflow] could not swap the handoff session to execution model "${this.handoffExecutionModel}" ` +
            `(${error instanceof Error ? error.message : String(error)}); continuing in execution mode on the current model`,
        );
      }
    }
    options.onSwap?.({
      fromModel,
      toModel,
      reason: "first-edit",
      sessionId: session.sessionId,
    });
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }

  /**
   * The unstructured agent's FINAL answer: assistant text that appears after the
   * last tool result. Text before the final tool result is stale progress (the
   * agent's last real action was a tool call, not answering), so returning it
   * would mask an incomplete run and suppress AGENT_EMPTY_OUTPUT retries (#111).
   *
   * Distinct from lastAssistantText(), which stays deliberately lenient — the
   * schema path's prose-JSON recovery (resolveStructuredOutput) may need to read
   * the structured payload out of any assistant message, not only the terminal one.
   */
  private finalAssistantText(messages: unknown[]): string {
    return finalAssistantTextOf(messages);
  }
}
