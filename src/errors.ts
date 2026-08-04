/**
 * Workflow-specific error types.
 */

/** Dependency-neutral diagnostic payload retained by capability contract failures. */
export interface CapabilityErrorDiagnostic {
  code: string;
  severity: "error" | "warning" | "information";
  subject: string;
  message: string;
}

/** Dependency-neutral skill-loading payload retained by generation failures. */
export interface ModelGenerationSkillLoadingEvidence {
  discovered: boolean;
  loaded: boolean;
  toolCalls: Array<{ tool: string; path?: string }>;
}

/** Dependency-neutral provider-usage payload retained by generation failures. */
export interface ModelGenerationTokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Stable runtime and persistence failure codes exposed to callers and UI surfaces. */
export enum WorkflowErrorCode {
  /** Agent exceeded timeout. */
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  /** Workflow was aborted by user. */
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  /** Agent limit exceeded. */
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  /** Token budget exhausted. */
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /**
   * The provider's subscription/usage/quota/rate limit was hit. Distinct from the
   * user's self-imposed TOKEN_BUDGET_EXHAUSTED: a provider limit refills on its own,
   * so the run is checkpointed (paused) and replayed by resume() rather than failed.
   */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  /**
   * The request exceeded the model's context window (provider error). Unlike a
   * usage/quota limit this does NOT refill on its own: retrying the same prompt
   * hits the identical wall, so the run settles failed (journal preserved) and the
   * orchestrator must resume with an edited script (shorter prompt / different
   * model) instead of being retried into the same wall or silently nulled.
   */
  CONTEXT_OVERFLOW = "CONTEXT_OVERFLOW",
  /**
   * Run-level failure raised by the manager when agents returned null (exhausted
   * recoverable retries or parallel-absorbed item failures) and the run opted into
   * strict completion (failOnExhaustedAgent). Settles the run failed — resumable,
   * journal preserved — so the orchestrator resumes instead of restarting.
   */
  AGENT_EXHAUSTED = "AGENT_EXHAUSTED",
  /** Script validation failed. */
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** A schema agent never produced valid structured_output (after repair + extraction). */
  SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
  /** A non-schema agent completed without any assistant text output. */
  AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
  /**
   * An agent()'s `model`/`tier` spec did not resolve to any known model. Never
   * silently substituted for the session default — resolution is deterministic,
   * so retrying the same spec would fail identically every time.
   */
  MODEL_NOT_FOUND = "MODEL_NOT_FOUND",
  /** Agent execution failed. */
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  /** Run state persistence failed. */
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  /** Unknown error. */
  UNKNOWN = "UNKNOWN",
  /**
   * Attempted a non-forward phase transition (numeric value keeps the legacy
   * `PHASE_TRANSITION_INVALID` constant from phases/state-machine.ts in sync).
   */
  PHASE_TRANSITION_INVALID = -31001,
  /**
   * Subagent spawn blocked because Phase 3 or human approval not reached
   * (legacy numeric alias `SUBAGENT_SPAWN_BLOCKED`).
   */
  SUBAGENT_SPAWN_BLOCKED = -31002,
  /**
   * Human approval required before the requested action is allowed (legacy
   * numeric alias `APPROVAL_REQUIRED`).
   */
  APPROVAL_REQUIRED = -31003,
}

/** Classified workflow failure with recoverability and optional agent/provider context. */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
  readonly resetHint?: string;

  constructor(
    message: string,
    code: WorkflowErrorCode,
    options: { recoverable?: boolean; agentLabel?: string; details?: unknown; resetHint?: string } = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
  }
}

/** Contract failure that retains every definition or assembly diagnostic. */
export class WorkflowCapabilityContractError extends Error {
  readonly diagnostics: readonly CapabilityErrorDiagnostic[];

  constructor(message: string, diagnostics: readonly CapabilityErrorDiagnostic[]) {
    super(message);
    this.name = "WorkflowCapabilityContractError";
    this.diagnostics = diagnostics;
  }
}

/** Generation failure that retains loading and token evidence for diagnosis. */
export class ModelGenerationError extends Error {
  readonly skillLoadingEvidence: ModelGenerationSkillLoadingEvidence;
  readonly tokenUsage: ModelGenerationTokenUsage;

  constructor(
    message: string,
    skillLoadingEvidence: ModelGenerationSkillLoadingEvidence,
    tokenUsage: ModelGenerationTokenUsage,
  ) {
    super(message);
    this.name = "ModelGenerationError";
    this.skillLoadingEvidence = skillLoadingEvidence;
    this.tokenUsage = tokenUsage;
  }
}

/** Narrow an unknown failure to WorkflowError. */
export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

/** Report whether an unknown failure is a provider usage-limit checkpoint condition. */
export function isProviderUsageLimit(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
}

/**
 * Detect a provider subscription/usage/quota/rate-limit exhaustion from free-form
 * error text, and extract the provider's human reset hint when present.
 *
 * The pi SDK does NOT throw these — it records them as an assistant message with
 * stopReason "error" and an errorMessage like "Codex usage limit reached (plus
 * plan). Resets in ~3h.". Callers reading message metadata MUST gate on
 * stopReason === "error" before trusting this, so a task whose own output merely
 * mentions "rate limit" is never misclassified. Patterns mirror the SDK's own
 * non-retryable-limit table and are ANCHORED to limit semantics (H2): a bare
 * "quota" or "billing" mention in an unrelated error — "quota usage at 40%",
 * "billing is handled separately" — must never checkpoint-pause a run.
 * Deliberately excludes transient overloaded/5xx errors, which stay recoverable
 * and keep retrying.
 */
const PROVIDER_LIMIT_PATTERN =
  /usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError/i;

export function classifyProviderLimit(text: string | undefined): { matched: boolean; resetHint?: string } {
  if (!text) return { matched: false };
  if (!PROVIDER_LIMIT_PATTERN.test(text)) return { matched: false };
  const reset = text.match(/resets?\s+(?:in|at)\s+[^.\n]+/i);
  return { matched: true, resetHint: reset?.[0]?.trim() };
}

/**
 * Context-window overflow error text, per provider. Mirrors the SDK's own
 * overflow table (pi-ai utils/overflow OVERFLOW_PATTERNS) restricted to the
 * text-detectable cases — the SDK additionally detects silent overflow via
 * usage-vs-contextWindow and length-stop heuristics, which need usage data a
 * text classifier cannot see. Kept local (no SDK import) so the extension
 * compiles and runs against any pinned SDK version (feature-detect rule).
 *
 * Example wordings:
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
];

/**
 * Non-overflow errors that would accidentally match an overflow pattern. Mirrors
 * the SDK's NON_OVERFLOW_PATTERNS: e.g. Bedrock throttling is worded
 * "ThrottlingException: Too many tokens, please wait before trying again." and
 * must NOT be classified as overflow (it is a transient provider limit instead).
 */
const CONTEXT_NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock human-readable prefixes
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

/**
 * Detect provider context-window overflow from free-form error text. Anchored
 * (H2-style): a task whose own output merely mentions "context length" is never
 * misclassified — callers gate on stopReason === "error" (agent.ts) or the
 * thrown-error path (wrapError) before trusting this.
 */
export function classifyContextOverflow(text: string | undefined): boolean {
  if (!text) return false;
  if (CONTEXT_NON_OVERFLOW_PATTERNS.some((p) => p.test(text))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(text));
}

/** Report whether an unknown failure is a context-overflow WorkflowError. */
export function isContextOverflowError(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.CONTEXT_OVERFLOW;
}

/**
 * Standard JS error names a workflow SCRIPT can throw directly. These can never
 * be SDK/API-layer failures, so their messages must not be classified as
 * provider limits (H2 gating) — a script bug whose message merely mentions
 * "usage limit" is still a bug, not a quota pause.
 */
const SCRIPT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
]);

/**
 * Recognize abort-like errors: gate on the standard `error.name` first, then an
 * ANCHORED message match (L12). A message-substring scan would classify a task
 * that merely QUOTES "aborted" in its output as an abort.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return /^\s*(?:the operation was |subagent was |request was )?abort(?:ed)?\.?\s*$/i.test(error.message);
}

/**
 * Recognize timeout-like errors: gate on the standard `error.name` first, then
 * an ANCHORED message match (L12) covering the real SDK phrasings ("request
 * timed out after Nms", "connect timed out after Nms") without substring-
 * matching arbitrary text that merely mentions the word timeout.
 */
export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  return /^\s*(?:the )?(?:request|connect|socket|operation)?\s*(?:timed out|timeout)/i.test(error.message);
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export function wrapError(error: unknown, context?: { agentLabel?: string }): WorkflowError {
  if (isWorkflowError(error)) return error;

  if (isAbortError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Workflow was aborted",
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    );
  }

  if (isTimeoutError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Agent timed out",
      WorkflowErrorCode.AGENT_TIMEOUT,
      { recoverable: true, agentLabel: context?.agentLabel },
    );
  }

  // Defense-in-depth: today the SDK buries provider limits AND context overflow
  // in an assistant message (detected in agent.ts), but a future SDK might throw
  // them. Classify thrown context overflow FIRST (more specific; settles the run
  // failed rather than paused — a context wall never refills on its own), then
  // provider limits (recoverable:false so the run checkpoints/pauses instead of
  // being retried into the same wall or silently nulled). Gated to
  // non-script-origin errors (H2): a plain script bug whose message merely
  // mentions quota/context must stay a normal recoverable execution error.
  if (error instanceof Error && !SCRIPT_ERROR_NAMES.has(error.name)) {
    if (classifyContextOverflow(error.message)) {
      return new WorkflowError(error.message, WorkflowErrorCode.CONTEXT_OVERFLOW, {
        recoverable: false,
        agentLabel: context?.agentLabel,
      });
    }
    const limit = classifyProviderLimit(error.message);
    if (limit.matched) {
      return new WorkflowError(error.message, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
        agentLabel: context?.agentLabel,
        resetHint: limit.resetHint,
      });
    }
  }

  return new WorkflowError(
    error instanceof Error ? error.message : String(error),
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: true, agentLabel: context?.agentLabel, details: error },
  );
}
