/**
 * Configuration constants for pi-dynamic-workflows.
 */

import type { RiskClass, RiskPolicy } from "./approval-policy.js";
import type { CommandWatchdogOptions } from "./command-watchdog.js";
// Provider-pool env override: provider-pool-config.ts is a runtime leaf (it
// only imports types from provider-pool.ts, which imports from errors.ts), so
// this value import never creates a cycle back into config.ts.
import { PROVIDER_POOL_ENV_VAR, providerPoolFromEnv } from "./gateway/provider-pool-config.js";
// Type-only to avoid a runtime import cycle: approval-policy.ts imports VALUE
// bindings from this module, so importing its types is erased at compile time
// and never re-enters it at load (workflow-settings.ts precedent below).
// The agent-label ALS comes from the dependency-free idle-context module, NOT
// command-watchdog.js — command-watchdog imports the SDK barrel (pi-tui at
// module scope), which would break this module's headless pi-tui-free guarantee
// (import-survival.test.ts). The watchdog OPTION TYPE is type-only (erased).
import { agentLabelContext } from "./idle-context.js";
import type { ExtensionToolSourceId } from "./subagent/extension-tools-capture.js";
import { isKnownExtensionToolSourceId } from "./subagent/extension-tools-capture.js";
// Type-only to avoid a runtime import cycle: workflow-settings.ts imports value
// bindings (MAX_AGENT_RETRIES, ...) from this module, so importing its type is
// erased at compile time and never re-enters it at load.
import type { WorkflowSettings } from "./workflow-settings.js";

/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;

// ─── I1 command watchdog knobs (idle-detector design-final.json §commandWatchdog) ──
// Conservative defaults: 0 = disabled → current behavior (thin passthrough).
// A command that emits no onData bytes for commandIdleTimeoutMs is killed via
// the bash tool's signal (process-tree abort) and returns partial output + a
// kill marker; commandHardTimeoutMs is a run-level default bash timeout (the
// model's explicit per-call timeout ALWAYS wins). Both are pure runtime
// envelopes — never part of any agent() resume hash.

/** Default command idle timeout (ms); 0 = disabled. */
export const DEFAULT_COMMAND_IDLE_TIMEOUT_MS = 0;
/** Default run-level command hard timeout (ms); 0 = disabled. */
export const DEFAULT_COMMAND_HARD_TIMEOUT_MS = 0;
/**
 * SDK bash timeout ceiling (dist/core/tools/bash.js resolveTimeoutMs): a
 * timeout in SECONDS must not exceed MAX_TIMEOUT_SECONDS = 2_147_483. The
 * hard-timeout knob is clamped to this ×1000 at resolution so the forwarded
 * value can never trip the SDK's "Invalid timeout" guard.
 */
export const MAX_COMMAND_HARD_TIMEOUT_MS = 2_147_483_000;
/** Default consecutive idle kills before the run-level watcher escalates. */
// I1 DC-8: this is the CONTRACT copy (check-entry-contract.ts:354; index.ts does
// `export * from "./config.js"`). Kept alongside the command-watchdog copy —
// consolidating would force config.ts to value-import command-watchdog.js,
// violating the headless pi-tui-free guarantee (config.ts:11-16).
export const DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS = 3;

// ─── I2 run-level idle automation defaults (design-final.json §agentIdleAutomation) ──
// Conservative defaults: 0/null = disabled → current behavior (no watcher, no
// auto-resume). The run-level watcher aborts an in-flight agent call with no
// tool-result/token/activity movement for agentIdleTimeoutMs and lets the
// EXISTING journaled retry machinery auto-resume it; agentIdleRetries is the
// auto-retry budget (unset → 1 when the idle timeout is enabled, else 0 — the
// conditional default is resolved at run start, not in settings normalization).
// Pure runtime envelopes — never part of any agent() resume hash.

/** Default agent idle timeout (ms); 0/null = disabled. */
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 0;
/** Default agent idle auto-retry budget; null = conditional (1 when enabled, else 0). */
export const DEFAULT_AGENT_IDLE_RETRIES: number | null = null;

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

/**
 * Default for the `subagentSkills` setting (T-01 + context-cost): "none"
 * passes `noSkills: true` to the shared DefaultResourceLoader, stripping the
 * ~3.1 ktok skill-stub block from every subagent system prompt (the skill
 * body stays lazy-loaded on demand by the agent via the read tool). "all"
 * loads the installed skill set (frontmatter name + description stubs only)
 * into read-capable subagent sessions — kept as an opt-in for slices that
 * genuinely need skill discovery in the system prompt (e.g. svelte editing).
 *
 * CONTEXT-COST DEFAULT FLIP: scoped loading is the default-on behavior — a
 * passive/mechanical slice must not pay ~3.1 ktok/turn for skill stubs it
 * never uses. One knob shared by the consumption site (agent.ts
 * getSharedResourceLoader `?? DEFAULT_...`) and the UI default display
 * (workflow-settings-fields.ts), so the flip is testable and can never drift
 * between the runtime and the settings surface.
 */
export const DEFAULT_SUBAGENT_SKILLS = "none" as const;

/**
 * Context-cost (T2-B1): measured size of the installed-skill stub block the
 * scoped default strips from every read-capable subagent system prompt (~3.1
 * ktok/turn, token-efficiency audit). Drives the documented expected-savings
 * and the mode-aware system-prefix estimate (agent.ts).
 */
export const SUBAGENT_SKILL_STUB_BLOCK_TOKENS = 3_100;

/**
 * V2-P12: per-actor activation budget — the maximum number of deliveries one
 * host-event actor may make per session before its delivery is suppressed
 * (recorded as a `delivery_suppressed` event). The per-actor budget knob the
 * proposal calls for (roadmap-v2.md V2-P12 invariants); the run-level spend
 * interplay stays on the workflow side (out of scope for this slice).
 */
export const HOST_ACTORS_ACTIVATION_CAP_DEFAULT = 32;

/**
 * V2-P12: per-actor serial-mailbox journal cap. Each actor's processed-event
 * queue (the persisted audit trail under getAgentDir()/workflows/actors/) is
 * bounded FIFO — the newest `HOST_ACTORS_QUEUE_MAX` events are retained.
 */
export const HOST_ACTORS_QUEUE_MAX = 64;

/**
 * V2-P12: default watchdog drift threshold. A before_agent_start prompt whose
 * Jaccard token-set similarity to the actor's declared goal falls below this
 * value is flagged as goal drift. Pure, deterministic heuristic — never part
 * of any resume hash.
 */
export const HOST_ACTORS_WATCHDOG_DRIFT_THRESHOLD_DEFAULT = 0.2;

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

// ─── V2-P07: recursive() decomposition primitive knobs ───────────────────────

/**
 * Hard ceiling on `recursive()` decomposition depth — the per-branch recursion
 * limit is clamped to at most this value and the live nested-`recursive()`
 * counter is enforced against it (the own-depth-counter counterpart of
 * MAX_NESTED_WORKFLOW_DEPTH: recursive() never routes through workflow()
 * nesting). A runaway guard, not a sandbox: a split function that never
 * reduces partition size is stopped by this ceiling with a clear
 * SCRIPT_VALIDATION_ERROR.
 */
export const MAX_RECURSIVE_DEPTH = 8;

/** Default per-branch recursion depth for recursive() when opts.maxDepth is omitted. */
export const DEFAULT_RECURSIVE_DEPTH = 2;

/**
 * Default per-level fan-out wave width for recursive() (maxRecursiveRoots).
 * Mirrors MAX_CONCURRENCY so a recursion level's partition fan-out is bounded
 * by the same width the run limiter bounds real agent parallelism with.
 */
export const DEFAULT_RECURSIVE_MAX_ROOTS = 16;

// ─── V2-P11: budget-adaptive re-planning knob ────────────────────────────────

/**
 * Default re-plan threshold (fraction of the run's token budget): when the
 * forecast burn `spent + Σ remaining phase budgets` reaches
 * `tokenBudget * DEFAULT_REPLAN_THRESHOLD`, the runtime emits a re-plan
 * signal BEFORE the hard caps trip so the script can re-scope remaining
 * phases. Read-only observation — never a VM mutation, never part of any
 * agent() resume identity.
 */
export const DEFAULT_REPLAN_THRESHOLD = 0.9;

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

/**
 * V2-QW3: default run-level total-output ceiling. No default — the ceiling is
 * opt-in exactly like the token budget (a run must pass `maxTotalOutputChars`
 * or the user must set PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS). The accumulator
 * counts the FINAL agent() result chars (post-P05-cap) across the whole run
 * tree and the pre-call gate trips OUTPUT_BUDGET_EXCEEDED once the total
 * crosses the ceiling. Never part of any agent() resume identity (it
 * transforms the RESULT budget, never the inputs — same exclusion as
 * maxAgentResultChars).
 */
export const DEFAULT_MAX_TOTAL_OUTPUT_CHARS = null;

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
 *
 * cost:model note: when a model-tiers.json IS configured, the configured
 * "medium"-default precedence was replaced by the cheapest-first role-split
 * (resolveRoleSplitTier in model-tier-config.ts): mechanical slices route to
 * the cheapest configured tier when a genuinely cheaper model exists (safety-
 * gated, never a silent quality loss), and hard slices escalate to "big". The
 * knob below stays scoped to the no-config path (its documented surface).
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
 * Resume-replay routing-policy version (T2-03/T2-05/T2-11, cost:model).
 * Included in hashAgentCall's identity so a routing-policy change (economy
 * default, builtin per-phase tier defaults, per-tier thinking caps, and the
 * cost:model role-split default for untagged calls under a configured
 * model-tiers.json) invalidates cached journaled results: journals persisted
 * before the bump mismatch and re-run live instead of silently replaying
 * results computed under the OLD policy. Bump whenever a routing-policy
 * default changes.
 */
export const ROUTING_POLICY_VERSION = 3;

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

// ─── V2-P01: risk-classified approval policy + auto-approval classifier ─────

/**
 * Default per-risk-class approval policy (V2-P01). Low-risk reads auto-flow;
 * every higher-risk class asks a human before proceeding (the P12 count
 * threshold still applies at the fan-out gate — the policy refines what
 * happens AT the threshold, it never re-opens small fan-outs). `auto` routes
 * one exact action to the LLM classifier; `deny` refuses outright. Overridable
 * per run via WorkflowRunOptions.approvalPolicy — approval is host-side
 * policy, never part of any agent() resume identity.
 */
export const DEFAULT_APPROVAL_POLICY: Record<RiskClass, RiskPolicy> = {
  read: "allow",
  write: "ask",
  execute: "ask",
  network: "ask",
  agent: "ask",
};

/**
 * Cap (milliseconds) on ONE approval-classifier ModelRuntime call (V2-P01).
 * A hung classifier must not stall the gate; withTimeout resolves the call
 * unavailable and the caller escalates (fail closed), never auto-approves.
 */
export const DEFAULT_APPROVAL_CLASSIFIER_TIMEOUT_MS = 30_000;

/** Response token cap for the approval classifier's verdict. */
export const DEFAULT_APPROVAL_CLASSIFIER_MAX_TOKENS = 128;

/**
 * Cap (chars) on the bounded transcript evidence fed to the approval
 * classifier — the classifier sees recent run activity only, never the whole
 * transcript, so the request stays cheap and the evidence can't leak a
 * mid-run secret wholesale.
 */
export const APPROVAL_CLASSIFIER_MAX_EVIDENCE_CHARS = 6_000;

// DS-4: `defaultUntaggedTier` IS surfaced in settings.json (workflow-settings.ts
// schema + workflow-settings-fields.ts UI) and wired through extensions/
// workflow.ts (PI_WORKFLOW_DEFAULT_UNTAGGED_TIER for headless/CI). The
// run/global option on runWorkflow/WorkflowAgent stays the primary channel;
// the settings surface is the user-facing knob. See
// tasks/token-efficiency-audit/slice-c/handoff.md for the original deferral.

// ─── Environment-var settings override layer (headless/CI/containerized) ─────
// Env vars are the only settings channel that works without a writable home
// directory or settings.json. They override the merged global+project file
// settings at load time and never write back to disk (save paths are
// untouched), so a CI job can pin concurrency/budgets without mutating a
// developer's machine.

/** Prefix for every workflow settings override env var. */
export const WORKFLOW_ENV_PREFIX = "PI_WORKFLOW_";

/**
 * V2-QW3: resolve the run-level total-output ceiling for one run. An explicit
 * value (number | null) wins and is used as-is (null disables the ceiling);
 * undefined falls back to the PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS env var, then
 * null (no ceiling). Reads env per call (plan-size.ts's resolveApprovalLimits
 * precedent) so tests can set process.env between runs; the workflow runtime
 * freezes the result once per run. Never part of any resume hash.
 */
export function resolveMaxTotalOutputChars(
  value: number | null | undefined,
  env: EnvSource = process.env,
): number | null {
  if (value !== undefined) return value;
  return envNullableInteger(env[WORKFLOW_ENV_VARS.maxTotalOutputChars], 1, Number.MAX_SAFE_INTEGER) ?? null;
}

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
  // V2-QW3: run-level total-output ceiling (see DEFAULT_MAX_TOTAL_OUTPUT_CHARS).
  maxTotalOutputChars: "PI_WORKFLOW_MAX_TOTAL_OUTPUT_CHARS",
  excludeSubagentTools: "PI_WORKFLOW_EXCLUDE_SUBAGENT_TOOLS",
  subagentHostTools: "PI_WORKFLOW_SUBAGENT_HOST_TOOLS",
  subagentTools: "PI_WORKFLOW_SUBAGENT_TOOLS",
  subagentChromeTools: "PI_WORKFLOW_SUBAGENT_CHROME_TOOLS",
  subagentExtensionTools: "PI_WORKFLOW_SUBAGENT_EXTENSION_TOOLS",
  subagentSkills: "PI_WORKFLOW_SUBAGENT_SKILLS",
  // DS-4: headless/CI channel for the untagged-agent tier default (economy /
  // inherit:main / a literal tier name).
  defaultUntaggedTier: "PI_WORKFLOW_DEFAULT_UNTAGGED_TIER",
  subagentDamageControlTools: "PI_WORKFLOW_SUBAGENT_DAMAGE_CONTROL_TOOLS",
  // V2-P12: session-scoped host-event actors (watchdog/advisor/spec) gate.
  hostActors: "PI_WORKFLOW_HOST_ACTORS",
  // I1 command watchdog: idle-kill threshold + run-level hard timeout (ms).
  commandIdleTimeoutMs: "PI_WORKFLOW_COMMAND_IDLE_TIMEOUT_MS",
  commandHardTimeoutMs: "PI_WORKFLOW_COMMAND_HARD_TIMEOUT_MS",
  // I2 run-level idle automation (resolved at execution start).
  agentIdleTimeoutMs: "PI_WORKFLOW_AGENT_IDLE_TIMEOUT_MS",
  agentIdleRetries: "PI_WORKFLOW_AGENT_IDLE_RETRIES",
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
  // V2-QW3: run-level total-output ceiling default (positive integer; "" /
  // "null" = no default ceiling — same nullable semantics as the token budget).
  const maxTotalOutputChars = envNullableInteger(
    env[WORKFLOW_ENV_VARS.maxTotalOutputChars],
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (maxTotalOutputChars !== undefined) settings.maxTotalOutputChars = maxTotalOutputChars;
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
  const subagentSkills = env[WORKFLOW_ENV_VARS.subagentSkills]?.trim();
  if (subagentSkills === "all" || subagentSkills === "none") {
    settings.subagentSkills = subagentSkills;
  }
  const defaultUntaggedTier = env[WORKFLOW_ENV_VARS.defaultUntaggedTier]?.trim();
  if (defaultUntaggedTier && defaultUntaggedTier.length > 0) {
    settings.defaultUntaggedTier = defaultUntaggedTier;
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
  // V2-P12: host-event actors gate ("on" registers before_agent_start / context
  // / session_compact observers; anything else drops to default off).
  const hostActors = env[WORKFLOW_ENV_VARS.hostActors]?.trim();
  if (hostActors === "on" || hostActors === "off") {
    settings.hostActors = hostActors;
  }
  // I1 command watchdog knobs: nullable positive ints (ms), null/absent = off.
  const commandIdleTimeoutMs = envNullableInteger(
    env[WORKFLOW_ENV_VARS.commandIdleTimeoutMs],
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (commandIdleTimeoutMs !== undefined) settings.commandIdleTimeoutMs = commandIdleTimeoutMs;
  const commandHardTimeoutMs = envNullableInteger(
    env[WORKFLOW_ENV_VARS.commandHardTimeoutMs],
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (commandHardTimeoutMs !== undefined) settings.commandHardTimeoutMs = commandHardTimeoutMs;
  // I2 run-level idle automation knobs: nullable positive ints (ms / retries).
  const agentIdleTimeoutMs = envNullableInteger(env[WORKFLOW_ENV_VARS.agentIdleTimeoutMs], 1, Number.MAX_SAFE_INTEGER);
  if (agentIdleTimeoutMs !== undefined) settings.agentIdleTimeoutMs = agentIdleTimeoutMs;
  const agentIdleRetries = envNullableInteger(env[WORKFLOW_ENV_VARS.agentIdleRetries], 0, Number.MAX_SAFE_INTEGER);
  if (agentIdleRetries !== undefined) settings.agentIdleRetries = agentIdleRetries;
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

/**
 * I1: resolve the command-watchdog knobs from a settings object. All knobs
 * 0/absent → undefined = disabled → thin passthrough (current behavior).
 * Applied at the toolset-assembly choke point, so the resolved values follow
 * the CURRENT settings each toolset build. `commandHardTimeoutMs` is clamped
 * to the SDK bash ceiling (MAX_COMMAND_HARD_TIMEOUT_MS) and non-finite values
 * are rejected (hard-timeout-validation); the s/ms forwarding is pinned by a
 * unit test so unit confusion can never regress.
 *
 * The resolved options ALSO carry the production label fn (reads the workflow
 * layer's agent-label ALS, set around every agentRunner.run) and the
 * consecutive-kill bound, so command idle-kills are recorded under the AGENT
 * label in the shared registry and the run-level watcher's isStalling bound
 * fires in production (df-5) — not only under a manually-seeded test.
 */
export function resolveCommandWatchdogOptions(
  settings: Pick<WorkflowSettings, "commandIdleTimeoutMs" | "commandHardTimeoutMs">,
): CommandWatchdogOptions | undefined {
  const idleTimeoutMs = normalizeWatchdogMs(settings.commandIdleTimeoutMs);
  const hardTimeoutMs = normalizeWatchdogMs(settings.commandHardTimeoutMs, MAX_COMMAND_HARD_TIMEOUT_MS);
  if (idleTimeoutMs <= 0 && hardTimeoutMs <= 0) return undefined;
  return {
    idleTimeoutMs,
    hardTimeoutMs,
    maxConsecutiveIdleKills: DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS,
    // df-5 production label: the workflow layer's per-agent label when a
    // subagent is running (falls back to the command text otherwise).
    label: () => agentLabelContext.getStore(),
  };
}

/** Normalize a nullable ms knob to a non-negative integer; non-finite/negative → 0. */
function normalizeWatchdogMs(value: number | null | undefined, max: number = Number.MAX_SAFE_INTEGER): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.min(max, Math.floor(value));
}

// ─── V2-N4: pre-flight estimate (workflow --estimate) forecast assumptions ──

/**
 * Default reply-token assumption per agent for the pre-flight forecast
 * (V2-N4). The shipped estimator (estimateTokens) is a per-VALUE estimator:
 * a static AST scan can measure the prompt, but the reply size is unknowable
 * before the model runs. This is the documented best-effort default for the
 * reply side of the forecast, overridable per call via
 * EstimateOptions.replyTokensPerAgent. NEVER part of any resume identity —
 * the forecast is a read-only pre-flight, distinct from the runtime budget
 * (which meters real spend).
 */
export const ESTIMATE_REPLY_TOKENS_PER_AGENT_DEFAULT = 2_000;

/**
 * Default effective token throughput (tokens per second) for the pre-flight
 * DURATION forecast (V2-N4). Converts a token forecast into wall-clock time
 * (tokens ÷ throughput + per-agent overhead). A pure, deterministic model
 * constant — never a wall-clock runtime value, never part of any resume hash.
 * Overridable per call via EstimateOptions.tokensPerSecond.
 */
export const ESTIMATE_TOKENS_PER_SECOND_DEFAULT = 60;

/**
 * Default fixed per-agent overhead (ms) in the duration forecast (V2-N4):
 * scheduling, toolset assembly, latency, and settle costs that no token-count
 * model can see. Added once per agent execution. Overridable per call via
 * EstimateOptions.agentOverheadMs.
 */
export const ESTIMATE_AGENT_OVERHEAD_MS_DEFAULT = 8_000;

/**
 * Budget-proximity threshold for the pre-flight forecast (V2-N4): when the
 * forecast total reaches `tokenBudget * ESTIMATE_WARNING_BUDGET_FRACTION` the
 * estimate flags `nearBudget` (and `exceedsBudget` once it passes 100%).
 * Mirrors DEFAULT_REPLAN_THRESHOLD's 0.9 reading of "unsustainable burn" so
 * the two surfaces agree on where a forecast starts looking risky.
 */
export const ESTIMATE_WARNING_BUDGET_FRACTION = 0.9;

/**
 * Relative per-tier cost weights for the pre-flight forecast (V2-N4). There
 * is NO dollar denomination anywhere in the tree (V2-P09 verify() finding), so
 * "per-model tier pricing" is a RELATIVE cost proxy: agent tokens are weighted
 * by their resolved tier (small = 0.25×, medium = 1× reference, big = 3×) and
 * summed into the estimate's costWeightedTokens. Unknown/unset tiers use the
 * 1× reference. Pure config — overridable per call via
 * EstimateOptions.tierCostWeights.
 */
export const ESTIMATE_TIER_COST_WEIGHTS: Readonly<Record<string, number>> = {
  small: 0.25,
  medium: 1,
  big: 3,
};

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

// ─── Context-cost: shared codebase oracle (T2-B1) defaults ─────────────────
// Deterministic, ZERO-LLM symbol/type/declaration scan injected once per run so
// parallel subagents reuse a bounded repo map instead of each re-discovering
// structure. Every knob is a hard bound: the scan must be cheap (file count,
// per-file bytes, symbol count) and the render must be token-bounded. Pure
// config — the runtime leaf (config.ts) stays pi-tui-free, and codebase-oracle.ts
// only imports this module + node builtins.

/** Whether the shared codebase oracle is injected by default (context-cost, default-on). */
export const DEFAULT_ORACLE_ENABLED = true;

/** Hard cap on the number of source files one oracle scan walks. */
export const DEFAULT_ORACLE_MAX_FILES = 400;

/** Hard cap on the number of symbols retained per oracle scan. */
export const DEFAULT_ORACLE_MAX_SYMBOLS = 400;

/** Per-file read cap (bytes) — a giant generated file never dominates the scan. */
export const DEFAULT_ORACLE_MAX_BYTES_PER_FILE = 64_000;

/**
 * Token cap on the oracle's compact render injected into subagent prompts.
 * A bounded map (≤ this many tokens) is far cheaper than every agent paying
 * its own repo-discovery round trips, and far smaller than the ~3.1 ktok
 * skill block the scoped default strips.
 */
export const DEFAULT_ORACLE_RENDER_MAX_TOKENS = 800;

/**
 * Context-cost expected-savings constant (documented, pure config): the net
 * per-agent input-token saving of scoped loading on a passive slice — the
 * ~3.1 ktok skill block minus the bounded oracle render it is replaced by.
 * Not a runtime gate — a documented estimate for the forecast/reporting
 * surfaces (estimate-forecast.ts + the slice handoff).
 */
export const SCOPED_CONTEXT_NET_SAVINGS_TOKENS_PER_AGENT =
  SUBAGENT_SKILL_STUB_BLOCK_TOKENS - DEFAULT_ORACLE_RENDER_MAX_TOKENS;

// ─── Spend governance: measured price book (slice C) ─────────────────────────
// Real per-model USD prices replace the ASSUMED relative tier weights
// (ESTIMATE_TIER_COST_WEIGHTS above) as the dollar denomination of the
// pre-flight forecast. The relative weights stay exported as the legacy cost
// proxy (costWeightedTokens) so existing consumers keep compiling; the quote
// gate and the --estimate USD range are computed from THIS measured book.

/** Measured USD price (per 1,000 tokens) for one model — the real-price quote basis. */
export interface ModelPriceUsd {
  /** USD per 1,000 INPUT tokens. */
  inputPer1kUsd: number;
  /** USD per 1,000 OUTPUT tokens. */
  outputPer1kUsd: number;
}

/**
 * MEASURED per-model price book (spend governance): public provider LIST
 * prices (USD per 1k tokens) keyed by the canonical "provider/model" spec —
 * the same spec form model-tiers.json and agent() opts.model carry. The quote
 * is a conservative planning basis, never a billing contract: actual spend is
 * metered from provider-reported usage at run end (the run's ledger records
 * real cost). Missing entries resolve via resolveModelPrice's id/fragment
 * fallback, then tier defaults, then DEFAULT_MODEL_PRICE_USD.
 */
export const MODEL_PRICE_BOOK: Readonly<Record<string, ModelPriceUsd>> = {
  // OpenAI
  "openai/gpt-4.1-mini": { inputPer1kUsd: 0.0004, outputPer1kUsd: 0.0016 },
  "openai/gpt-4.1": { inputPer1kUsd: 0.002, outputPer1kUsd: 0.008 },
  "openai/gpt-4o": { inputPer1kUsd: 0.0025, outputPer1kUsd: 0.01 },
  "openai/gpt-4o-mini": { inputPer1kUsd: 0.00015, outputPer1kUsd: 0.0006 },
  "openai/o3-mini": { inputPer1kUsd: 0.0011, outputPer1kUsd: 0.0044 },
  // Anthropic
  "anthropic/claude-3-5-haiku": { inputPer1kUsd: 0.0008, outputPer1kUsd: 0.004 },
  "anthropic/claude-3-5-sonnet": { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
  "anthropic/claude-haiku-4": { inputPer1kUsd: 0.001, outputPer1kUsd: 0.005 },
  "anthropic/claude-sonnet-4": { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
  "anthropic/claude-opus-4": { inputPer1kUsd: 0.015, outputPer1kUsd: 0.075 },
  // Google
  "google/gemini-2.0-flash": { inputPer1kUsd: 0.0001, outputPer1kUsd: 0.0004 },
  "google/gemini-2.5-flash": { inputPer1kUsd: 0.0003, outputPer1kUsd: 0.0025 },
  "google/gemini-2.5-pro": { inputPer1kUsd: 0.00125, outputPer1kUsd: 0.01 },
  // DeepSeek
  "deepseek/deepseek-chat": { inputPer1kUsd: 0.00027, outputPer1kUsd: 0.0011 },
  "deepseek/deepseek-reasoner": { inputPer1kUsd: 0.00055, outputPer1kUsd: 0.00219 },
};

/**
 * Per-tier reference prices for the forecast when the scan knows a tier but
 * not its resolved model spec (small/medium/big map to the cheap/mid/flagship
 * price classes). Kept in lockstep with the game-change's cheapest-first
 * tiering: small is the cheapest class, so untagged/economy slices quote low.
 */
export const TIER_PRICE_DEFAULTS: Readonly<Record<string, ModelPriceUsd>> = {
  small: { inputPer1kUsd: 0.0004, outputPer1kUsd: 0.0016 }, // gpt-4.1-mini class
  medium: { inputPer1kUsd: 0.002, outputPer1kUsd: 0.008 }, // gpt-4.1 class
  big: { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 }, // sonnet-4 class
};

/** Reference price for models/tiers with no price-book entry (a mid-range gpt-4.1-class model). */
export const DEFAULT_MODEL_PRICE_USD: ModelPriceUsd = TIER_PRICE_DEFAULTS.medium;

/**
 * Most expensive price across the book + tier defaults — the conservative
 * worst-case quote for a model the scan cannot resolve at all.
 */
export const MAX_MODEL_PRICE_USD: ModelPriceUsd = (() => {
  let input = 0;
  let output = 0;
  for (const price of [...Object.values(MODEL_PRICE_BOOK), ...Object.values(TIER_PRICE_DEFAULTS)]) {
    input = Math.max(input, price.inputPer1kUsd);
    output = Math.max(output, price.outputPer1kUsd);
  }
  return { inputPer1kUsd: input, outputPer1kUsd: output };
})();

/**
 * Resolve a model spec to its price-book entry. Robust to the spec forms the
 * tree carries: strips any `:thinking` suffix, tries the exact canonical
 * "provider/model" key, then the bare model id after the last "/", then a
 * suffix match against book keys (so vendor-qualified ids resolve too).
 * undefined = no entry in the book.
 */
export function resolveModelPrice(
  spec: string | undefined,
  book: Readonly<Record<string, ModelPriceUsd>> = MODEL_PRICE_BOOK,
): ModelPriceUsd | undefined {
  if (!spec) return undefined;
  const normalized = spec.trim().split(":")[0] ?? "";
  const exact = book[normalized];
  if (exact) return exact;
  // Bare model id (after the last "/", or the whole spec when unqualified) —
  // tried as an exact book key, then via a suffix scan so vendor-qualified
  // book entries ("openai/gpt-4.1-mini") resolve from "gpt-4.1-mini" too.
  const slash = normalized.lastIndexOf("/");
  const id = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  if (book[id]) return book[id];
  for (const key of Object.keys(book)) {
    if (key.endsWith(`/${id}`)) return book[key];
  }
  return undefined;
}

/**
 * The price the estimator quotes for ONE agent call: an explicit model's
 * price-book entry wins, then the tier's reference price, then the default
 * reference price. Pure and deterministic — never reads the registry.
 */
export function modelPriceForEstimate(
  model: string | undefined,
  tier: string | undefined,
  book: Readonly<Record<string, ModelPriceUsd>> = MODEL_PRICE_BOOK,
): ModelPriceUsd {
  const fromModel = resolveModelPrice(model, book);
  if (fromModel) return fromModel;
  if (tier && TIER_PRICE_DEFAULTS[tier]) return TIER_PRICE_DEFAULTS[tier];
  return DEFAULT_MODEL_PRICE_USD;
}

// ─── Spend governance: quote-before-spend + tau gate (slice C) ────────────────
// The gate quotes the run's worst-case USD (measured price book) BEFORE any
// agent launches and compares it against a spend ceiling. Tau is the run's
// value-to-budget ratio: ceiling = budget × tau (tau = value ÷ budget, so the
// ceiling is at most the run's value). tau = 0/null disables the gate and
// restores current behavior (no quote, no refusal).

/**
 * Default tau for the quote gate: the worst-case USD quote must stay under
 * `spendBudgetUsd × tau`. Default 1 = spend at most the configured budget;
 * 0 or null disables the gate entirely (current behavior).
 */
export const DEFAULT_SPEND_TAU = 1;

/**
 * Default quote-gate mode: "warn" = warn-and-require-confirm before an
 * over-budget launch when a UI is available (headless/background runs REFUSE
 * — never silently launch over budget); "refuse" = always refuse; "off" =
 * gate disabled. Only engaged when a spend ceiling is configured.
 */
export const DEFAULT_SPEND_QUOTE_GATE = "warn" as const;

/** Quote-gate mode literal. */
export type SpendQuoteGateMode = "warn" | "refuse" | "off";

/**
 * Resolve the effective tau: explicit 0/null = disabled (null); a positive
 * finite number wins; anything else falls back to DEFAULT_SPEND_TAU.
 */
export function resolveSpendTau(value: number | null | undefined): number | null {
  if (value === null || value === 0) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_SPEND_TAU;
}

/**
 * Resolve the run's spend ceiling (USD): an explicit quoted value wins (the
 * run's worth — the ceiling is the value); else budget × tau. null = no
 * ceiling = the gate is disabled (current behavior).
 */
export function resolveSpendCeilingUsd(
  spendBudgetUsd: number | null | undefined,
  quotedValueUsd: number | null | undefined,
  spendTau: number | null | undefined,
): number | null {
  if (typeof quotedValueUsd === "number" && Number.isFinite(quotedValueUsd) && quotedValueUsd > 0) {
    return quotedValueUsd;
  }
  if (typeof spendBudgetUsd === "number" && Number.isFinite(spendBudgetUsd) && spendBudgetUsd > 0) {
    const tau = resolveSpendTau(spendTau);
    if (tau !== null) return spendBudgetUsd * tau;
  }
  return null;
}

// ─── Spend governance: no-progress guard (slice C) ──────────────────────────
// Default-on: an agent that reports SUCCESS with zero work evidence (no tool
// events, no edit results) is flagged, its consecutive zero-evidence budget is
// capped, and the run refuses to let the same agent call loop silently.

/**
 * Default-on no-progress guard. An agent that settles successfully with zero
 * work evidence (no tool events / edit results — a pure "ok" with nothing
 * done, or a README-less pass-through) is flagged. Escalates only when the
 * SAME label keeps producing zero-evidence successes up to the cap.
 */
export const DEFAULT_NO_PROGRESS_GUARD = true;

/**
 * Consecutive zero-work-evidence successes per agent call site (label) before
 * the guard refuses the next one (the "attempt budget"). Once the run's
 * re-plan signal has fired (tokenBudget × rePlanThreshold crossed), the cap
 * tightens to 1 — budget burn plus no evidence is never tolerated silently.
 */
export const NO_PROGRESS_ZERO_EVIDENCE_CAP = 3;
