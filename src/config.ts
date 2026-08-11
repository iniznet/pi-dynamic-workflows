/**
 * Configuration constants for pi-dynamic-workflows.
 */

// Provider-pool env override: provider-pool-config.ts is a runtime leaf (it
// only imports types from provider-pool.ts, which imports from errors.ts), so
// this value import never creates a cycle back into config.ts.
import { PROVIDER_POOL_ENV_VAR, providerPoolFromEnv } from "./gateway/provider-pool-config.js";
import type { ExtensionToolSourceId } from "./subagent/extension-tools-capture.js";
import { isKnownExtensionToolSourceId } from "./subagent/extension-tools-capture.js";
// Type-only to avoid a runtime import cycle: workflow-settings.ts imports value
// bindings (MAX_AGENT_RETRIES, ...) from this module, so importing its type is
// erased at compile time and never re-enters it at load.
import type { WorkflowSettings } from "./workflow-settings.js";

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

/**
 * Default for the `subagentExtensionTools` setting (P04): "on" captures the
 * installed research-extension sources (supi-web, pi-codegraph,
 * pi-vision-handoff) into every subagent toolset — the single gate that
 * decides whether codegraph_* / web / vision defs exist at all. One knob shared by
 * the consumption site (extensions/workflow.ts `?? DEFAULT_...`) and the UI
 * default display (workflow-settings-fields.ts), so the flip is testable and
 * can never drift between the runtime and the settings surface.
 */
export const DEFAULT_SUBAGENT_EXTENSION_TOOLS = "on" as const;

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
 * P12: default parallel()/pipeline() fan-out size above which a human
 * approval is required (TUI pause via ui.confirm; headless runs throw
 * WORKFLOW_ABORTED unless the script passes autoApproved: true). Mirrors the
 * existing plan-approval step limit (plan-size.ts PLAN_APPROVAL_STEP_LIMIT_DEFAULT)
 * so the two "beyond this many parallel units" rules read consistently.
 * Overridable per user via the fanOutApprovalThreshold settings key (null
 * disables the gate) and per run via runWorkflow's fanOutApprovalThreshold.
 */
export const FAN_OUT_APPROVAL_THRESHOLD_DEFAULT = 8;

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

/**
 * Base exponential-backoff delay between retry attempts after a recoverable
 * agent failure (default 1s; each further retry doubles up to 8× the base).
 * 0 disables the wait entirely (tests). A pure timing knob — never frozen per
 * run, unlike agentRetries which is safety-relevant.
 */
export const DEFAULT_RETRY_BACKOFF_MS = 1000;

/** Hard ceiling for a single backoff wait, so a long retry chain never stalls a run. */
export const MAX_RETRY_BACKOFF_MS = 60_000;

/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;

/**
 * P05: default character cap on a single agent() result (unstructured text
 * results only). Matches pi's tool-result ceiling so a fan-out's synthesis
 * context stays bounded; results larger than this are tail-preservingly
 * truncated at the workflow layer (see capAgentResultText in workflow.ts) with
 * the full text written to an artifact path for retrieval, and the capped
 * output counts against the run budget. Explicitly excluded from hashAgentCall
 * (it transforms the RESULT, never the inputs — resume replay stays stable).
 */
export const DEFAULT_MAX_AGENT_RESULT_CHARS = 50_000;

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

// ─── Routing economics (T2-03/T2-04/T2-05/T2-11 slice) ────────────────────────

/**
 * Default tier routing for UNTAGGED agent() calls (no `model`, no `tier`)
 * when no model-tiers.json is configured (T2-03). "economy" routes through the
 * prompt-aware classifyTask fallback (scan=small / edit=medium /
 * synthesize+analyze=big, see model-routing.ts) so untagged calls no longer
 * collapse onto the session's flagship main model.
 */
export const UNTAGGED_TIER_ECONOMY = "economy";

/**
 * Opt-out value for the untagged-agent default: restore the pre-T2-03
 * behavior where an untagged call without a tier config resolves to the
 * session's main model. Same literal as model-tier-config.ts's
 * TIER_INHERIT_MAIN (kept as a separate constant here because config.ts is a
 * runtime leaf and importing model-tier-config.ts would form a cycle).
 */
export const UNTAGGED_TIER_INHERIT_MAIN = "inherit:main";

/** runWorkflow/WorkflowAgent default for `defaultUntaggedTier`. */
export const DEFAULT_UNTAGGED_TIER = UNTAGGED_TIER_ECONOMY;

/**
 * Resume-replay routing-policy version (T2-03/T2-05/T2-11). Included in
 * hashAgentCall's identity so a routing-policy change (economy default,
 * builtin per-phase tier defaults, per-tier thinking caps) invalidates cached
 * journaled results: journals persisted before the bump mismatch and re-run
 * live instead of silently replaying results computed under the OLD policy.
 * Bump whenever a routing-policy default changes.
 */
export const ROUTING_POLICY_VERSION = 2;

/**
 * Default tier for the script-API quality helpers' votes (T2-04): verify() /
 * judgePanel() / consensus() / completenessCheck() / route() bind their
 * short structured outputs to this tier unless the caller passes opts.tier.
 */
export const DEFAULT_HELPER_TIER = "small";

// ─── W2 P01/P09: testGate + multi-model cross-check defaults ────────────────

/**
 * Default bounded rework attempts for testGate() (P01) — mirrors gate()'s
 * default so the machine-checked postcondition gate and the validator gate
 * share the same bounded-rework shape (never silent, never unbounded).
 */
export const DEFAULT_TEST_GATE_ATTEMPTS = 3;

/** Default tool the testGate() test subagent may use to run its command. */
export const DEFAULT_TEST_GATE_TOOL = "bash" as const;

/**
 * Cap (milliseconds) on ONE ModelRuntime cross-check call (P09). A hung
 * second-model request must not stall the whole run; withTimeout fails the
 * call closed and the quality helper falls back to the same-model verdict.
 */
export const DEFAULT_CROSSCHECK_TIMEOUT_MS = 30_000;

// NOTE (cross-slice, B2-owned): surfacing `defaultUntaggedTier` in
// settings.json (workflow-settings.ts schema + workflow-settings-fields.ts UI)
// and wiring it through extensions/workflow.ts is deliberately NOT done here —
// the run/global option on runWorkflow/WorkflowAgent is the primary channel
// for this slice. See tasks/token-efficiency-audit/slice-c/handoff.md.

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
  tokenBudgetCountsCacheRead: "PI_WORKFLOW_TOKEN_BUDGET_COUNTS_CACHE_READ",
  defaultConcurrency: "PI_WORKFLOW_DEFAULT_CONCURRENCY",
  defaultAgentRetries: "PI_WORKFLOW_DEFAULT_AGENT_RETRIES",
  progressPanelMode: "PI_WORKFLOW_PROGRESS_PANEL_MODE",
  progressPanelMaxAgents: "PI_WORKFLOW_PROGRESS_PANEL_MAX_AGENTS",
  fanOutApprovalThreshold: "PI_WORKFLOW_FAN_OUT_APPROVAL_THRESHOLD",
  persistAgentSessions: "PI_WORKFLOW_PERSIST_AGENT_SESSIONS",
  deliveredResultMaxChars: "PI_WORKFLOW_DELIVERED_RESULT_MAX_CHARS",
  // P05: char cap on a single agent() result (see DEFAULT_MAX_AGENT_RESULT_CHARS).
  maxAgentResultChars: "PI_WORKFLOW_MAX_AGENT_RESULT_CHARS",
  excludeSubagentTools: "PI_WORKFLOW_EXCLUDE_SUBAGENT_TOOLS",
  subagentHostTools: "PI_WORKFLOW_SUBAGENT_HOST_TOOLS",
  subagentTools: "PI_WORKFLOW_SUBAGENT_TOOLS",
  subagentChromeTools: "PI_WORKFLOW_SUBAGENT_CHROME_TOOLS",
  subagentExtensionTools: "PI_WORKFLOW_SUBAGENT_EXTENSION_TOOLS",
  subagentDamageControlTools: "PI_WORKFLOW_SUBAGENT_DAMAGE_CONTROL_TOOLS",
  // Full-JSON override (see providerPoolFromEnv) — headless/CI channel for the
  // same `providerPool` key that settings.json carries under "workflows".
  providerPool: PROVIDER_POOL_ENV_VAR,
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
  const tokenBudgetCountsCacheRead = envBoolean(env[WORKFLOW_ENV_VARS.tokenBudgetCountsCacheRead]);
  if (tokenBudgetCountsCacheRead !== undefined) settings.tokenBudgetCountsCacheRead = tokenBudgetCountsCacheRead;
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
  // P12: fan-out approval threshold — null ("" or the literal "null") disables
  // the gate; a positive integer sets the fan-out size that requires approval.
  const fanOutApprovalThreshold = envNullableInteger(
    env[WORKFLOW_ENV_VARS.fanOutApprovalThreshold],
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (fanOutApprovalThreshold !== undefined) settings.fanOutApprovalThreshold = fanOutApprovalThreshold;
  const persistAgentSessions = envBoolean(env[WORKFLOW_ENV_VARS.persistAgentSessions]);
  if (persistAgentSessions !== undefined) settings.persistAgentSessions = persistAgentSessions;
  const deliveredResultMaxChars = envInteger(env[WORKFLOW_ENV_VARS.deliveredResultMaxChars], 1, 1_000_000);
  if (deliveredResultMaxChars !== undefined) settings.deliveredResultMaxChars = deliveredResultMaxChars;
  // P05: per-agent result cap default (positive integer; "" / "null" = no default cap).
  const maxAgentResultChars = envNullableInteger(
    env[WORKFLOW_ENV_VARS.maxAgentResultChars],
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (maxAgentResultChars !== undefined) settings.maxAgentResultChars = maxAgentResultChars;
  const excludeSubagentTools = env[WORKFLOW_ENV_VARS.excludeSubagentTools]
    ?.split(",")
    .map((name) => name.trim())
    .filter((name): name is string => name.length > 0);
  if (excludeSubagentTools?.length) settings.excludeSubagentTools = excludeSubagentTools;
  const subagentHostTools = env[WORKFLOW_ENV_VARS.subagentHostTools]?.trim();
  if (subagentHostTools === "auto" || subagentHostTools === "on" || subagentHostTools === "off") {
    settings.subagentHostTools = subagentHostTools;
  }
  const subagentTools = env[WORKFLOW_ENV_VARS.subagentTools]?.trim();
  if (subagentTools === "all") {
    settings.subagentTools = "all";
  } else if (subagentTools) {
    // Allowlist: comma-separated exact mcp_* tool names (matching the file
    // form). "all" is the only magic value; anything else is a name list.
    const names = [
      ...new Set(
        subagentTools
          .split(",")
          .map((name) => name.trim())
          .filter((name): name is string => name.length > 0),
      ),
    ];
    if (names.length) settings.subagentTools = names;
  }
  const subagentChromeTools = env[WORKFLOW_ENV_VARS.subagentChromeTools]?.trim();
  if (subagentChromeTools === "on" || subagentChromeTools === "off") {
    settings.subagentChromeTools = subagentChromeTools;
  }
  const subagentDamageControlTools = env[WORKFLOW_ENV_VARS.subagentDamageControlTools]?.trim();
  if (
    subagentDamageControlTools === "off" ||
    subagentDamageControlTools === "readonly" ||
    subagentDamageControlTools === "on"
  ) {
    settings.subagentDamageControlTools = subagentDamageControlTools;
  }
  const subagentExtensionTools = env[WORKFLOW_ENV_VARS.subagentExtensionTools]?.trim();
  if (subagentExtensionTools === "on" || subagentExtensionTools === "off") {
    settings.subagentExtensionTools = subagentExtensionTools;
  } else if (subagentExtensionTools) {
    // Allowlist: comma-separated exact source ids ("supi-web",
    // "pi-codegraph"). "on"/"off" are the only magic values; anything else
    // is a source-id list. Unknown ids are dropped leniently.
    const ids = [
      ...new Set(
        subagentExtensionTools
          .split(",")
          .map((id) => id.trim())
          .filter((id): id is ExtensionToolSourceId => isKnownExtensionToolSourceId(id)),
      ),
    ];
    if (ids.length) settings.subagentExtensionTools = ids;
  }
  const providerPool = providerPoolFromEnv(env);
  if (providerPool !== undefined) settings.providerPool = providerPool;
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
