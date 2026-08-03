/**
 * Configuration constants for pi-dynamic-workflows.
 */

// Type-only to avoid a runtime import cycle: workflow-settings.ts imports value
// bindings (MAX_AGENT_RETRIES, ...) from this module, so importing its type is
// erased at compile time and never re-enters it at load.
import type { WorkflowSettings } from "./workflow-settings.js";

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/** Default timeout for a single agent in milliseconds. null means no hard timeout. */
export const DEFAULT_AGENT_TIMEOUT_MS = null;

/**
 * Drain-side backstop deadline in milliseconds. After a workflow script has
 * finished, the top-level run waits up to this long for outstanding (possibly
 * un-awaited) agent() calls to settle before aborting them via the run's fatal
 * controller and completing the run anyway. Guards the drain against the wedge
 * where a signal-ignoring agent with agentTimeoutMs: null would otherwise block
 * run completion forever. Deterministic termination — this is a hard deadline,
 * not a heuristic poll.
 */
export const DRAIN_ABORT_TIMEOUT_MS = 60_000;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/**
 * Hard ceiling on live nested workflow() frames, enforced at the vm wrapper —
 * the single choke point every script execution passes through. This is a
 * RUNAWAY guard, not a security boundary: the vm is deliberately not a
 * sandbox, so this only stops runaway recursion from piling frames up
 * unbounded, it makes no isolation promise. The `maxNestedWorkflowDepth`
 * runWorkflow option (default 1, the documented one-level-deep policy) is
 * clamped to at most this value; once a frame's nesting reaches the ceiling
 * the run fails with a clear SCRIPT_VALIDATION_ERROR instead of recursing on.
 */
export const MAX_NESTED_WORKFLOW_DEPTH = 8;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;

/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;

/** Legacy project-relative directory for persisted workflow run state. New writes use workflowProjectPaths(). */
export const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";

/** Legacy project-relative directory for saved workflow commands. New writes use workflowProjectPaths(). */
export const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";

/** User-level saved workflows directory. */
export const USER_WORKFLOW_SAVED_DIR = "~/.pi/workflows/saved";

/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";

/** User-level workflow extension settings file, relative to the home directory. */
export const WORKFLOW_SETTINGS_FILE = ".pi/workflows/settings.json";

// ─── Environment-var settings override layer (headless/CI/containerized) ─────
// Env vars are the only settings channel that works without a writable home
// directory or settings.json. They override the merged global+project file
// settings at load time and never write back to disk (save paths are
// untouched), so a CI job can pin concurrency/budgets without mutating a
// developer's machine.

/** Prefix for every workflow settings override env var. */
export const WORKFLOW_ENV_PREFIX = "PI_WORKFLOW_";

/**
 * Env var name per settings key. `as const satisfies` keeps this exhaustive:
 * adding a WorkflowSettings key without an env mapping is a compile error.
 */
export const WORKFLOW_ENV_VARS = {
  keywordTriggerEnabled: "PI_WORKFLOW_KEYWORD_TRIGGER_ENABLED",
  keywordTriggerWord: "PI_WORKFLOW_KEYWORD_TRIGGER_WORD",
  defaultAgentTimeoutMs: "PI_WORKFLOW_DEFAULT_AGENT_TIMEOUT_MS",
  defaultTokenBudget: "PI_WORKFLOW_DEFAULT_TOKEN_BUDGET",
  defaultConcurrency: "PI_WORKFLOW_DEFAULT_CONCURRENCY",
  defaultAgentRetries: "PI_WORKFLOW_DEFAULT_AGENT_RETRIES",
  progressPanelMode: "PI_WORKFLOW_PROGRESS_PANEL_MODE",
  progressPanelMaxAgents: "PI_WORKFLOW_PROGRESS_PANEL_MAX_AGENTS",
  persistAgentSessions: "PI_WORKFLOW_PERSIST_AGENT_SESSIONS",
  deliveredResultMaxChars: "PI_WORKFLOW_DELIVERED_RESULT_MAX_CHARS",
  excludeSubagentTools: "PI_WORKFLOW_EXCLUDE_SUBAGENT_TOOLS",
  subagentHostTools: "PI_WORKFLOW_SUBAGENT_HOST_TOOLS",
} as const satisfies Record<keyof WorkflowSettings, string>;

type EnvSource = Record<string, string | undefined>;

/** Parse a strict boolean env value ("true"/"false", case-insensitive). */
function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/** Parse an integer env value inside [min, max]; out-of-range/unparseable → undefined. */
function envInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value.trim());
  if (!Number.isFinite(number) || number < min) return undefined;
  return Math.min(max, Math.floor(number));
}

/**
 * Parse an env value that may explicitly mean "null" (empty string or the
 * literal "null") — mirrors settings.json's `null` semantics, e.g. a project
 * override that cancels a global token budget.
 */
function envNullableInteger(value: string | undefined, min: number, max: number): number | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return null;
  return envInteger(trimmed, min, max);
}

/**
 * Parse the PI_WORKFLOW_* env surface into a WorkflowSettings-shaped object.
 * Only present, parseable values are emitted: garbage, out-of-range numbers,
 * and unknown values are silently ignored (the same drop-on-violation
 * leniency the settings.json normalization applies), so a misconfigured CI
 * env can never crash the extension — it just falls back to the file value.
 * `excludeSubagentTools` is a comma-separated list.
 */
export function workflowSettingsFromEnv(env: EnvSource = process.env): WorkflowSettings {
  const settings: WorkflowSettings = {};
  const keywordTriggerEnabled = envBoolean(env[WORKFLOW_ENV_VARS.keywordTriggerEnabled]);
  if (keywordTriggerEnabled !== undefined) settings.keywordTriggerEnabled = keywordTriggerEnabled;
  const keywordTriggerWord = normalizeKeywordTriggerWord(env[WORKFLOW_ENV_VARS.keywordTriggerWord]);
  if (keywordTriggerWord !== undefined) settings.keywordTriggerWord = keywordTriggerWord;
  const defaultAgentTimeoutMs = envNullableInteger(
    env[WORKFLOW_ENV_VARS.defaultAgentTimeoutMs],
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (defaultAgentTimeoutMs !== undefined) settings.defaultAgentTimeoutMs = defaultAgentTimeoutMs;
  const defaultTokenBudget = envNullableInteger(env[WORKFLOW_ENV_VARS.defaultTokenBudget], 1, Number.MAX_SAFE_INTEGER);
  if (defaultTokenBudget !== undefined) settings.defaultTokenBudget = defaultTokenBudget;
  const defaultConcurrency = envInteger(env[WORKFLOW_ENV_VARS.defaultConcurrency], 1, MAX_CONCURRENCY);
  if (defaultConcurrency !== undefined) settings.defaultConcurrency = defaultConcurrency;
  const defaultAgentRetries = envInteger(env[WORKFLOW_ENV_VARS.defaultAgentRetries], 0, MAX_AGENT_RETRIES);
  if (defaultAgentRetries !== undefined) settings.defaultAgentRetries = defaultAgentRetries;
  const progressPanelMode = env[WORKFLOW_ENV_VARS.progressPanelMode]?.trim();
  if (progressPanelMode === "compact" || progressPanelMode === "detailed") {
    settings.progressPanelMode = progressPanelMode;
  }
  const progressPanelMaxAgents = envInteger(env[WORKFLOW_ENV_VARS.progressPanelMaxAgents], 1, 1000);
  if (progressPanelMaxAgents !== undefined) settings.progressPanelMaxAgents = progressPanelMaxAgents;
  const persistAgentSessions = envBoolean(env[WORKFLOW_ENV_VARS.persistAgentSessions]);
  if (persistAgentSessions !== undefined) settings.persistAgentSessions = persistAgentSessions;
  const deliveredResultMaxChars = envInteger(env[WORKFLOW_ENV_VARS.deliveredResultMaxChars], 1, 1_000_000);
  if (deliveredResultMaxChars !== undefined) settings.deliveredResultMaxChars = deliveredResultMaxChars;
  const excludeSubagentTools = env[WORKFLOW_ENV_VARS.excludeSubagentTools]
    ?.split(",")
    .map((name) => name.trim())
    .filter((name): name is string => name.length > 0);
  if (excludeSubagentTools?.length) settings.excludeSubagentTools = excludeSubagentTools;
  const subagentHostTools = env[WORKFLOW_ENV_VARS.subagentHostTools]?.trim();
  if (subagentHostTools === "auto" || subagentHostTools === "on" || subagentHostTools === "off") {
    settings.subagentHostTools = subagentHostTools;
  }
  return settings;
}

/**
 * Merge env overrides on top of file-loaded settings. Env wins per key;
 * keys without an env var are untouched. `env` is injectable for tests.
 */
export function applyEnvSettingsOverride(settings: WorkflowSettings, env: EnvSource = process.env): WorkflowSettings {
  return { ...settings, ...workflowSettingsFromEnv(env) };
}

/** Default keyword that arms workflows mode from interactive input. */
export const DEFAULT_KEYWORD_TRIGGER_WORD = "workflow";

/** Normalize a user-configured keyword trigger word. */
export function normalizeKeywordTriggerWord(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim();
  if (!word || word.startsWith("/") || /\s/.test(word)) return undefined;
  return word;
}

/**
 * Named workflow subagent definitions directory. Resolved project-relative
 * (cwd/.pi/agents), plus user-level at `~/.pi/agent/agents/` (the primary
 * location, via `getAgentDir()` in agent-registry.ts) with the legacy
 * `~/.pi/agents/` (this constant, home-relative) scanned as a deprecated
 * fallback. Project entries win on name collision, then the primary user
 * location, then the legacy one. Each `*.md` file is an agent definition
 * (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";
