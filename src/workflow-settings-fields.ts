/**
 * Declarative field registry for WorkflowSettings — the single source of
 * truth for the interactive settings surface (rows, types, bounds, options,
 * defaults, env-var locks) shared by the TUI form, the dialog tier, and the
 * print tier.
 *
 * Pure TS: no pi-tui, no file IO, no host imports. Every entry derives from
 * the verified load-path semantics in `workflow-settings.ts` (normalizeSettings)
 * and `config.ts` (env parsing + constants); nothing here invents bounds.
 */

import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_KEYWORD_TRIGGER_WORD,
  DEFAULT_SUBAGENT_EXTENSION_TOOLS,
  DEFAULT_TOKEN_BUDGET,
  FAN_OUT_APPROVAL_THRESHOLD_DEFAULT,
  MAX_AGENT_RETRIES,
  MAX_CONCURRENCY,
  normalizeKeywordTriggerWord,
  WORKFLOW_ENV_VARS,
  workflowSettingsFromEnv,
} from "./config.js";
import type { ProviderPoolConfig, ProviderPoolEntry } from "./gateway/provider-pool.js";
import type {
  ProviderPoolEntryInput,
  ProviderPoolModelInput,
  ProviderPoolSettingsInput,
} from "./gateway/provider-pool-config.js";
import {
  DEFAULT_PROVIDER_CONCURRENCY,
  DEFAULT_PROVIDER_WEIGHT,
  DEFAULT_SATURATION_WAIT_TIMEOUT_MS,
  DEFAULT_TPM_WINDOW_MS,
  DEFAULT_WHEN_SATURATED,
  normalizeProviderPoolConfig,
} from "./gateway/provider-pool-config.js";
import type { WorkflowSettings } from "./workflow-settings.js";

/** UI grouping for the settings form rows, in render order. */
export type WorkflowSettingsFieldGroup = "Trigger" | "Execution" | "Progress" | "Advanced";

/** How a settings row is edited/parsed. */
export type WorkflowSettingsFieldType = "boolean" | "number" | "string" | "enum" | "string[]" | "providerPool";

/** Where the interactive editor writes a partial save. */
export type SettingsScope = "global" | "project";

/** One declarative row for one WorkflowSettings key (see FIELD_REGISTRY). */
export interface WorkflowSettingsField {
  key: keyof WorkflowSettings;
  type: WorkflowSettingsFieldType;
  label: string;
  help: string;
  /** Inclusive lower bound for number fields (mirrors normalizeInteger/drop-on-violation). */
  min?: number;
  /** Inclusive upper bound for number fields (mirrors normalizeInteger/clamp). */
  max?: number;
  /** Cycler values (boolean + enum rows); round-trip losslessly through parseFieldInput. */
  options?: readonly string[];
  group: WorkflowSettingsFieldGroup;
  /** Shown when the key is unset in the merged effective settings view. */
  defaultDisplay: string;
  /** The PI_WORKFLOW_* env var that overrides this key at load (cfg WORKFLOW_ENV_VARS). */
  envVar: string;
  /** number|null pair (defaultAgentTimeoutMs, defaultTokenBudget): ""/"null"/0 parse to the null side. */
  nullable?: boolean;
}

/**
 * The settings rows, in UI render order. Bounds/options/defaults are the
 * verified load-path semantics: normalizeSettings (ws:233-298), the cfg env
 * clamps (cfg:130-166), and the documented runtime fallbacks.
 */
export const FIELD_REGISTRY: readonly WorkflowSettingsField[] = [
  {
    key: "keywordTriggerEnabled",
    type: "boolean",
    label: "Keyword trigger enabled",
    help: "Arms workflows mode when the trigger keyword appears in interactive input.",
    options: ["true", "false"],
    group: "Trigger",
    defaultDisplay: "true",
    envVar: WORKFLOW_ENV_VARS.keywordTriggerEnabled,
  },
  {
    key: "keywordTriggerWord",
    type: "string",
    label: "Keyword trigger word",
    help: "Literal keyword that arms workflows mode. Normalized: trimmed, non-empty, no leading /, no whitespace.",
    group: "Trigger",
    defaultDisplay: DEFAULT_KEYWORD_TRIGGER_WORD,
    envVar: WORKFLOW_ENV_VARS.keywordTriggerWord,
  },
  {
    key: "defaultAgentTimeoutMs",
    type: "number",
    label: "Agent timeout (ms)",
    help: "Per-agent hard timeout in milliseconds; null/empty means no timeout.",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    group: "Execution",
    defaultDisplay: `${DEFAULT_AGENT_TIMEOUT_MS} (none)`,
    envVar: WORKFLOW_ENV_VARS.defaultAgentTimeoutMs,
    nullable: true,
  },
  {
    key: "defaultTokenBudget",
    type: "number",
    label: "Token budget",
    help: "Default hard token budget per run; null/empty means no budget. 0 saves as the null tombstone; a project override of null cancels a global budget.",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    group: "Execution",
    defaultDisplay: `${DEFAULT_TOKEN_BUDGET} (none)`,
    envVar: WORKFLOW_ENV_VARS.defaultTokenBudget,
    nullable: true,
  },
  {
    key: "tokenBudgetCountsCacheRead",
    type: "boolean",
    label: "Token budget counts cache reads",
    help: "Whether the token budget counts cheap cache-read traffic (default true = current behavior). Off (false) gates the budget on FRESH spend only (input+output), so a warm-provider run's ~96% cached traffic no longer exhausts the cap; persisted aggregates are unchanged in both modes.",
    options: ["true", "false"],
    group: "Execution",
    defaultDisplay: "true",
    envVar: WORKFLOW_ENV_VARS.tokenBudgetCountsCacheRead,
  },
  {
    key: "defaultConcurrency",
    type: "number",
    label: "Max concurrent agents",
    help: `Default max concurrent agents per run, clamped to [1, ${MAX_CONCURRENCY}]. Unset uses the manager default.`,
    min: 1,
    max: MAX_CONCURRENCY,
    group: "Execution",
    defaultDisplay: "(manager default)",
    envVar: WORKFLOW_ENV_VARS.defaultConcurrency,
  },
  {
    key: "defaultAgentRetries",
    type: "number",
    label: "Agent retries",
    help: `Default retry attempts after a recoverable agent failure, clamped to [0, ${MAX_AGENT_RETRIES}].`,
    min: 0,
    max: MAX_AGENT_RETRIES,
    group: "Execution",
    defaultDisplay: "0",
    envVar: WORKFLOW_ENV_VARS.defaultAgentRetries,
  },
  {
    key: "progressPanelMode",
    type: "enum",
    label: "Panel mode",
    help: "Bottom task-panel display mode: compact (one line per run) or detailed.",
    options: ["compact", "detailed"],
    group: "Progress",
    defaultDisplay: "compact",
    envVar: WORKFLOW_ENV_VARS.progressPanelMode,
  },
  {
    key: "progressPanelMaxAgents",
    type: "number",
    label: "Max agents per phase",
    help: "Max agents shown per phase in detailed mode, clamped to [1, 1000] and floored.",
    min: 1,
    max: 1000,
    group: "Progress",
    defaultDisplay: "8",
    envVar: WORKFLOW_ENV_VARS.progressPanelMaxAgents,
  },
  {
    key: "persistAgentSessions",
    type: "boolean",
    label: "Persist agent sessions",
    help: "Persist each subagent transcript as a real pi session file.",
    options: ["true", "false"],
    group: "Advanced",
    defaultDisplay: "false",
    envVar: WORKFLOW_ENV_VARS.persistAgentSessions,
  },
  {
    key: "deliveredResultMaxChars",
    type: "number",
    label: "Result preview length",
    help: "Char cap on the delivered-result preview, clamped to [1, 1,000,000]. Full string results and verdict/report/summary/synthesis fields are never truncated.",
    min: 1,
    max: 1_000_000,
    group: "Advanced",
    defaultDisplay: "400",
    envVar: WORKFLOW_ENV_VARS.deliveredResultMaxChars,
  },
  {
    // P05: per-agent result cap — the runtime default for agent() results
    // (unstructured text only). Bounds what a single agent can deliver to the
    // script and into synthesis context; the full text is written to an
    // artifact path under .pi/workflows/artifacts when truncated, and the
    // capped output counts against the run budget. null/empty = no default
    // cap (a project override can cancel a global cap). Mirrors
    // normalizeSettings (workflow-settings.ts) + the env clamp (config.ts).
    key: "maxAgentResultChars",
    type: "number",
    label: "Max agent result chars",
    help: "Char cap on a single agent() result (unstructured text only), clamped to [1, 2^53-1]. Larger results are tail-preservingly truncated and the full text is written to an artifact path; capped output counts against the run budget. null/empty disables the default cap (50000). Per-call agent({ maxResultChars }) wins.",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    group: "Advanced",
    defaultDisplay: "50000",
    envVar: WORKFLOW_ENV_VARS.maxAgentResultChars,
    nullable: true,
  },
  {
    // V2-QW3: run-level total-output ceiling. Caps the sum of FINAL agent()
    // result chars (post-P05-cap) across the whole run tree; the next agent()
    // call throws OUTPUT_BUDGET_EXCEEDED once the total crosses the ceiling.
    // null/empty = no default ceiling (opt-in like the token budget). Mirrors
    // normalizeSettings (workflow-settings.ts) + the env clamp (config.ts).
    key: "maxTotalOutputChars",
    type: "number",
    label: "Max total output chars",
    help: "Run-level ceiling on the sum of agent() result chars (post per-agent cap), clamped to [1, 2^53-1]. Once the run's total output crosses it, the next agent() throws OUTPUT_BUDGET_EXCEEDED (non-recoverable, catchable). null/empty disables the default ceiling; per-run runWorkflow({ maxTotalOutputChars }) wins. Never part of any resume hash.",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    group: "Advanced",
    defaultDisplay: "none",
    envVar: WORKFLOW_ENV_VARS.maxTotalOutputChars,
    nullable: true,
  },
  {
    key: "excludeSubagentTools",
    type: "string[]",
    label: "Exclude subagent tools",
    help: "Extra tool names denied in subagent sessions (comma-separated). []/null clears; a project override can wipe a global list.",
    group: "Advanced",
    defaultDisplay: "[] (none)",
    envVar: WORKFLOW_ENV_VARS.excludeSubagentTools,
  },
  {
    // P12: fan-out approval gate knob. null disables the gate entirely (a
    // project override can wipe a global threshold); a positive integer is
    // the fan-out size above which parallel()/pipeline() pause for human
    // approval (TUI) or abort WORKFLOW_ABORTED headless unless the script
    // passes autoApproved: true. Mirrors the plan-approval step limit so the
    // two "big plan" rules read consistently.
    key: "fanOutApprovalThreshold",
    type: "number",
    label: "Fan-out approval threshold",
    help: "parallel()/pipeline() fan-outs beyond this many items require human approval: TUI runs pause via a checkpoint confirm; headless runs throw WORKFLOW_ABORTED unless the script passes autoApproved: true. null disables the gate.",
    min: 1,
    group: "Advanced",
    defaultDisplay: FAN_OUT_APPROVAL_THRESHOLD_DEFAULT.toString(),
    envVar: WORKFLOW_ENV_VARS.fanOutApprovalThreshold,
    nullable: true,
  },
  {
    key: "subagentHostTools",
    type: "enum",
    label: "Subagent host tools",
    help: 'Subagent access to host coding/web tools: auto (default, lazy auto-start + merged tools), on (eager start at load), off (legacy opt-in via toolset "host-tools" + manual gateway start).',
    options: ["auto", "on", "off"],
    group: "Advanced",
    defaultDisplay: "auto",
    envVar: WORKFLOW_ENV_VARS.subagentHostTools,
  },
  {
    key: "subagentTools",
    type: "string[]",
    label: "Subagent MCP tools",
    help: 'MCP tools for subagents: "all" (default, every HTTP MCP server in mcp.json as mcp_<server>_<tool> tools) or a comma-separated allowlist of exact mcp_* tool names. An empty list disables MCP tools for subagents. MCP defs are billed every turn — add per-server `tools` filters in mcp.json to keep the set small (see /workflows-subagent-tools for the live toolset and size).',
    group: "Advanced",
    defaultDisplay: "all",
    envVar: WORKFLOW_ENV_VARS.subagentTools,
  },
  {
    key: "subagentChromeTools",
    type: "enum",
    label: "Subagent chrome tools",
    help: 'Vendored pi-chrome chrome_* tools for subagents: on (available per-task via the "chrome-tools" toolset tag while the host holds a /chrome authorize grant — NOT merged into the default toolset, so untagged runs skip the ~5.5 ktok/turn chrome defs) or off (default, subagents stay browser-free). Reuses the host session\'s bridge and grant — no separate setup.',
    options: ["off", "on"],
    group: "Advanced",
    defaultDisplay: "off",
    envVar: WORKFLOW_ENV_VARS.subagentChromeTools,
  },
  {
    key: "subagentExtensionTools",
    type: "string[]",
    label: "Subagent extension tools",
    help: `Host-captured third-party extension tools for subagents: on (default, captures tools from every installed source — supi-web, pi-codegraph, pi-vision-handoff), a comma-separated allowlist of exact source ids, or off. Empty clears. See /workflows-subagent-tools for the live toolset.`,
    group: "Advanced",
    // P04 default flip: fresh installs get codegraph_*/web/vision in subagents
    // (untagged default merge + every pattern's task-fit toolset + the
    // "code-dev" superset). Off restores the pre-flip behavior (no defs).
    defaultDisplay: DEFAULT_SUBAGENT_EXTENSION_TOOLS,
    envVar: WORKFLOW_ENV_VARS.subagentExtensionTools,
  },
  {
    key: "subagentDamageControlTools",
    type: "enum",
    label: "Subagent damage control tools",
    help: "workflow_damage_control for subagents: off (default, no defs anywhere), readonly (inspection verbs only — list/status/agents), or on (full verb set: pause/resume/stop/kill-agent/recover). Deniable per-run via settings.excludeSubagentTools. A separate gate from subagentExtensionTools — kill/pause/recover power is not research-tool access.",
    options: ["off", "readonly", "on"],
    group: "Advanced",
    defaultDisplay: "off",
    envVar: WORKFLOW_ENV_VARS.subagentDamageControlTools,
  },
  {
    // Nested config consumed by the provider pool (see provider-pool-config.ts), edited
    // VISUALLY as form rows (PROVIDER_POOL_SCALARS + ProviderPoolEditorModel) in the
    // TUI/dialog tiers — never as a raw JSON blob. The PI_WORKFLOW_PROVIDER_POOL env
    // var remains the full-JSON headless/CI override and env-locks the whole key.
    key: "providerPool",
    type: "providerPool",
    label: "Provider pool",
    help: "Per-model provider routing for parallel subagents: pool scalars, per-model provider lists, and per-provider concurrency/weight/TPM/cooldown rows. Edited visually; PI_WORKFLOW_PROVIDER_POOL is the headless JSON override.",
    group: "Advanced",
    defaultDisplay: "(unset)",
    envVar: WORKFLOW_ENV_VARS.providerPool,
  },
  {
    // V2-P12: session-scoped host-event actors gate. Default off — no manager,
    // no observers, zero cost (subagentDamageControlTools precedent). When on,
    // the extension registers before_agent_start / context / session_compact
    // observers and loads actor defs from getAgentDir()/workflows/actors/.
    key: "hostActors",
    type: "enum",
    label: "Host-event actors",
    help: "Session-scoped host-event actors (V2-P12): watchdog (goal-drift detector), advisor (decision-point reviewer), spec (acceptance ledger), supervisor (directive steer) subscribed to before_agent_start/context/session_compact. on (opt-in) registers the observers and loads actor defs + persisted state from ~/.pi/agent/workflows/actors/; off (default) keeps them inert. SESSION-scoped — cross-process residency is a documented gap.",
    options: ["off", "on"],
    group: "Advanced",
    defaultDisplay: "off",
    envVar: WORKFLOW_ENV_VARS.hostActors,
  },
];

/** The four groups in render order, derived from the registry so they can never drift. */
export const FIELD_GROUPS: readonly WorkflowSettingsFieldGroup[] = [
  ...new Set(FIELD_REGISTRY.map((field) => field.group)),
];

/** Look up a field by its settings key. */
export function getField(key: keyof WorkflowSettings): WorkflowSettingsField | undefined {
  return FIELD_REGISTRY.find((field) => field.key === key);
}

// ─── Provider pool visual editor ────────────────────────────────────────────

/**
 * The four top-level provider-pool scalars, edited as rows inside the visual
 * provider-pool submenu (TUI) and prompted one-by-one (dialog tier). Bounds and
 * options mirror normalizeProviderPoolConfig (provider-pool-config.ts).
 */
export type ProviderPoolScalarKey = "enabled" | "whenSaturated" | "saturationWaitTimeoutMs" | "defaultTpmWindowMs";

/** Entry scalar keys editable inside the per-provider submenu. */
export type ProviderPoolEntryScalarKey = "modelId" | "concurrency" | "weight" | "tpm" | "cooldownMs";

/**
 * One declarative row for one per-provider scalar (see PROVIDER_POOL_ENTRY_SCALARS).
 * String rows edit the modelId alias; number rows floor and reject below-min
 * input; nullable number rows map empty/"null" input to null (unset). All
 * bounds mirror setEntryScalar (workflow-settings-fields.ts) and
 * normalizeProviderPoolConfig.
 */
export interface ProviderPoolEntryScalarField {
  key: ProviderPoolEntryScalarKey;
  type: "string" | "number";
  label: string;
  help: string;
  /** Inclusive lower bound for number rows (mirrors normalizeInteger). */
  min?: number;
  /** null = unset (delete the key) for optional number rows. */
  nullable?: boolean;
}

/** The five per-provider scalar rows, in render order. */
export const PROVIDER_POOL_ENTRY_SCALARS: readonly ProviderPoolEntryScalarField[] = [
  {
    key: "modelId",
    type: "string",
    label: "Model alias",
    help: "Provider-side model id when it differs from the logical model; empty uses the logical model id.",
  },
  {
    key: "concurrency",
    type: "number",
    label: "Concurrency",
    help: "Max parallel subagents this provider may serve (default 1).",
    min: 1,
  },
  {
    key: "weight",
    type: "number",
    label: "Weight",
    help: "Relative routing weight vs other providers of the same model (default 1).",
    min: 1,
  },
  {
    key: "tpm",
    type: "number",
    label: "TPM cap",
    help: "Max output tokens per minute this provider may serve; empty clears the cap.",
    min: 1,
    nullable: true,
  },
  {
    key: "cooldownMs",
    type: "number",
    label: "Cooldown (ms)",
    help: "Rest period after this provider errors before it is eligible again; empty clears it.",
    min: 1,
    nullable: true,
  },
];

/** Look up a per-provider scalar by key. */
export function getProviderPoolEntryScalar(key: ProviderPoolEntryScalarKey): ProviderPoolEntryScalarField | undefined {
  return PROVIDER_POOL_ENTRY_SCALARS.find((scalar) => scalar.key === key);
}

/**
 * Compact row display for one provider entry: "conc 2 · w 1 · tpm 100k · cd 30s".
 * Alias is shown first only when it differs from the logical model id; optional
 * caps are omitted when unset; a missing entry renders as "(missing)".
 */
export function providerPoolEntryDisplay(modelId: string, entry: ProviderPoolEntry | undefined): string {
  if (!entry) return "(missing)";
  const parts: string[] = [];
  if (entry.modelId !== modelId) parts.push(`alias ${entry.modelId}`);
  parts.push(`conc ${entry.concurrency}`);
  parts.push(`w ${entry.weight}`);
  if (entry.tpm !== undefined) parts.push(`tpm ${entry.tpm}`);
  if (entry.cooldownMs !== undefined) parts.push(`cd ${Math.round(entry.cooldownMs / 1000)}s`);
  return parts.join(" · ");
}

/**
 * Typed parse for one per-provider scalar row. Mirrors the settings-row rules:
 * strings trim and reject empty input, numbers floor and reject below-min
 * input, nullable numbers map empty/"null" to null (delete the key).
 */
export function parseProviderPoolEntryScalar(
  scalar: ProviderPoolEntryScalarField,
  raw: string,
): { ok: true; value: string | number | null } | { ok: false; error: string } {
  if (scalar.type === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? { ok: true, value: trimmed } : { ok: false, error: "must not be empty" };
  }
  return parseIntegerInput(raw, { min: scalar.min, nullable: scalar.nullable === true });
}

/** One declarative row for one provider-pool scalar (see PROVIDER_POOL_SCALARS). */
export interface ProviderPoolScalarField {
  key: ProviderPoolScalarKey;
  type: "boolean" | "enum" | "number";
  label: string;
  help: string;
  /** Inclusive lower bound for number scalars (mirrors normalizeInteger). */
  min?: number;
  /** Cycler values (boolean + enum scalars). */
  options?: readonly string[];
}

/** The four provider-pool scalar rows, in render order. */
export const PROVIDER_POOL_SCALARS: readonly ProviderPoolScalarField[] = [
  {
    key: "enabled",
    type: "boolean",
    label: "Enabled",
    help: "Pool on/off. Off keeps the legacy single-resolution behavior (no routing).",
    options: ["true", "false"],
  },
  {
    key: "whenSaturated",
    type: "enum",
    label: "When saturated",
    help: 'Saturation behavior: "wait" (FIFO queue, abort-aware) or "fail" (immediate error to the run).',
    options: ["wait", "fail"],
  },
  {
    key: "saturationWaitTimeoutMs",
    type: "number",
    label: "Saturation wait (ms)",
    help: "Max wait for a saturated acquire before the pool fails it; 0 waits forever.",
    min: 0,
  },
  {
    key: "defaultTpmWindowMs",
    type: "number",
    label: "TPM window (ms)",
    help: "Rolling window over which output-TPM is measured and the TPM cap gate applies.",
    min: 1_000,
  },
];

/** Look up a provider-pool scalar by key. */
export function getProviderPoolScalar(key: ProviderPoolScalarKey): ProviderPoolScalarField | undefined {
  return PROVIDER_POOL_SCALARS.find((scalar) => scalar.key === key);
}

/**
 * Compact row display for the provider-pool value: "on · wait · 2 model(s)".
 * Unset renders as "(unset)" (matches the registry defaultDisplay).
 */
export function providerPoolSummary(value: unknown): string {
  if (value === undefined) return "(unset)";
  const config = normalizeProviderPoolConfig(value);
  const modelCount = Object.keys(config.models).length;
  return `${config.enabled ? "on" : "off"} · ${config.whenSaturated} · ${modelCount} model(s)`;
}

/**
 * Map a fully-shaped ProviderPoolConfig back to the minimal raw settings input
 * shape: fields equal to their normalized defaults are dropped, so the visual
 * editor writes only what the user changed. Idempotent under
 * normalizeProviderPoolConfig (defaults re-fill on the next read).
 */
export function providerPoolInputOf(config: ProviderPoolConfig): ProviderPoolSettingsInput {
  const input: ProviderPoolSettingsInput = {};
  if (config.enabled !== true) input.enabled = config.enabled;
  if (config.whenSaturated !== DEFAULT_WHEN_SATURATED) input.whenSaturated = config.whenSaturated;
  if (config.saturationWaitTimeoutMs !== DEFAULT_SATURATION_WAIT_TIMEOUT_MS)
    input.saturationWaitTimeoutMs = config.saturationWaitTimeoutMs;
  if (config.defaultTpmWindowMs !== DEFAULT_TPM_WINDOW_MS) input.defaultTpmWindowMs = config.defaultTpmWindowMs;
  const models: Record<string, ProviderPoolModelInput> = {};
  for (const [logicalModel, entries] of Object.entries(config.models)) {
    const providers: Record<string, ProviderPoolEntryInput> = {};
    for (const [providerId, entry] of Object.entries(entries)) {
      const raw: ProviderPoolEntryInput = {};
      if (entry.modelId !== logicalModel) raw.modelId = entry.modelId;
      if (entry.concurrency !== DEFAULT_PROVIDER_CONCURRENCY) raw.concurrency = entry.concurrency;
      if (entry.weight !== DEFAULT_PROVIDER_WEIGHT) raw.weight = entry.weight;
      if (entry.tpm !== undefined) raw.tpm = entry.tpm;
      if (entry.cooldownMs !== undefined) raw.cooldownMs = entry.cooldownMs;
      providers[providerId] = raw;
    }
    // Keep empty model maps: normalizeModels preserves them too, so a model
    // added in the visual editor survives the save → load round-trip.
    models[logicalModel] = providers;
  }
  if (Object.keys(models).length > 0) input.models = models;
  return input;
}

/**
 * Display string for a row's currentValue. Lossless for cycler rows (the
 * result is always one of `options`), `null` renders as the parseable "null"
 * marker for nullable fields, and an unset key falls back to `defaultDisplay`.
 */
export function fieldDisplayValue(field: WorkflowSettingsField, value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return field.defaultDisplay;
  switch (field.type) {
    case "boolean":
      return value ? "true" : "false";
    case "enum":
      return String(value);
    case "number":
      return String(value);
    case "string":
      return String(value);
    case "string[]":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "providerPool":
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
  }
}

function parseNumber(
  field: WorkflowSettingsField,
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  // Null tombstone: an exact "0" on the token budget is the "clear it" marker
  // (normalizeSettingsForSave rewrites defaultTokenBudget 0 → null), so pass it
  // through untouched instead of coercing it to the minimum. Other nullable
  // fields have no save-path tombstone — a "0" there is a silent no-op edit
  // (normalize drops below-min values), so reject it like any other below-min.
  if (field.key === "defaultTokenBudget" && trimmed === "0") return { ok: true, value: 0 };
  return parseIntegerInput(raw, { min: field.min, max: field.max, nullable: field.nullable });
}

/**
 * Shared integer parsing for settings rows and provider-pool scalars: empty/
 * "null" on a nullable field maps to null, input must be a finite number at or
 * above `min`, fractional input floors, and values above `max` clamp to it
 * (mirrors normalizeInteger).
 */
function parseIntegerInput(
  raw: string,
  bounds: { min?: number; max?: number; nullable?: boolean },
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (bounds.nullable && (trimmed === "" || trimmed.toLowerCase() === "null")) return { ok: true, value: null };
  if (trimmed === "") return { ok: false, error: "must be a number" };
  const number = Number(trimmed);
  if (!Number.isFinite(number)) return { ok: false, error: "must be a finite number" };
  if (bounds.min !== undefined && number < bounds.min) return { ok: false, error: `must be at least ${bounds.min}` };
  const floored = Math.floor(number);
  return { ok: true, value: bounds.max !== undefined ? Math.min(bounds.max, floored) : floored };
}

/**
 * Typed parse + bounds/enum/keyword-word validation — the ONLY validation
 * entry point the UI tiers use. Rules mirror the verified load-path semantics:
 * booleans accept "true"/"false", enums must be a listed option, numbers floor
 * and clamp to [min, max] (below-min is an error), nullable numbers map
 * ""/"null" → null (and keep 0 as the save-path tombstone), the keyword word is
 * run through normalizeKeywordTriggerWord, and string[] splits on commas with
 * trim + empty-drop.
 */
export function parseFieldInput(
  field: WorkflowSettingsField,
  raw: string,
): { ok: true; value: WorkflowSettings[keyof WorkflowSettings] } | { ok: false; error: string } {
  switch (field.type) {
    case "boolean": {
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, error: "must be true or false" };
    }
    case "enum": {
      if (field.options?.includes(raw)) return { ok: true, value: raw };
      return { ok: false, error: `must be one of: ${field.options?.join(", ") ?? ""}` };
    }
    case "number":
      return parseNumber(field, raw);
    case "string": {
      const word = normalizeKeywordTriggerWord(raw);
      if (word === undefined) return { ok: false, error: "keyword must be a single word, no leading / or whitespace" };
      return { ok: true, value: word };
    }
    case "string[]": {
      // The subagentTools row accepts the special literal "all" (its "expose
      // every MCP tool" mode) before the comma-split allowlist path; the saved
      // value is the string "all", which is what normalizeSettings accepts
      // (workflow-settings.ts). Empty input means "no MCP tools" ([]), the
      // "none" side of the all | allowlist setting.
      if (field.key === "subagentTools" && raw.trim() === "all") return { ok: true, value: "all" };
      if (field.key === "subagentTools" && raw.trim() === "") return { ok: true, value: [] };
      // The subagentExtensionTools row accepts the special literals "on" and
      // "off" (its capture modes) before the comma-split source-id allowlist
      // path; empty input means "no sources" ([]), the "off" side.
      if (field.key === "subagentExtensionTools" && (raw.trim() === "on" || raw.trim() === "off")) {
        return { ok: true, value: raw.trim() };
      }
      if (field.key === "subagentExtensionTools" && raw.trim() === "") return { ok: true, value: [] };
      const names = raw
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      return { ok: true, value: names };
    }
    case "providerPool": {
      // The provider pool is edited visually (nested form rows via
      // ProviderPoolEditorModel), never as a raw JSON blob — reject blob input
      // so a stale JSON paste cannot silently bypass the structured validation.
      return { ok: false, error: "edit via the visual form, not raw JSON" };
    }
  }
}

/**
 * Typed parse for a provider-pool scalar (TUI scalar rows + dialog prompts).
 * Mirrors the settings-row rules: booleans accept "true"/"false", enums must
 * be a listed option, numbers floor and reject below-min input.
 */
export function parseProviderPoolScalar(
  scalar: ProviderPoolScalarField,
  raw: string,
): { ok: true; value: boolean | "wait" | "fail" | number } | { ok: false; error: string } {
  switch (scalar.type) {
    case "boolean": {
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, error: "must be true or false" };
    }
    case "enum": {
      if (scalar.options?.includes(raw)) return { ok: true, value: raw as "wait" | "fail" };
      return { ok: false, error: `must be one of: ${scalar.options?.join(", ") ?? ""}` };
    }
    case "number": {
      const parsed = parseIntegerInput(raw, { min: scalar.min });
      // Bounds pass no `nullable`, so a successful parse is never null.
      return parsed.ok ? { ok: true, value: parsed.value as number } : parsed;
    }
  }
}

/**
 * Pure working copy for the provider-pool visual editor: wraps a normalized
 * ProviderPoolConfig and exposes small mutations. The TUI/dialog tiers mutate
 * this and stage `toInput()` (a minimal raw input) into the settings model;
 * the normalization at construction fills defaults so rows always show the
 * effective values.
 */
export class ProviderPoolEditorModel {
  private readonly _config: ProviderPoolConfig;

  constructor(value: unknown) {
    this._config = normalizeProviderPoolConfig(value);
  }

  /** The normalized working copy (defaults filled in). */
  get config(): ProviderPoolConfig {
    return this._config;
  }

  /** Compact display string for the row ("on · wait · 2 model(s)"). */
  summary(): string {
    return providerPoolSummary(this._config);
  }

  /** Minimal raw settings input for saving; defaults dropped. */
  toInput(): ProviderPoolSettingsInput {
    return providerPoolInputOf(this._config);
  }

  /** Set one of the four top-level scalars. */
  setScalar(key: ProviderPoolScalarKey, value: boolean | "wait" | "fail" | number): void {
    if (key === "enabled") this._config.enabled = Boolean(value);
    else if (key === "whenSaturated") this._config.whenSaturated = value as "wait" | "fail";
    else if (key === "saturationWaitTimeoutMs") this._config.saturationWaitTimeoutMs = value as number;
    else this._config.defaultTpmWindowMs = value as number;
  }

  /** Logical model ids in insertion order. */
  modelIds(): string[] {
    return Object.keys(this._config.models);
  }

  /** Provider ids for one logical model, in insertion order. */
  providerIds(modelId: string): string[] {
    return Object.keys(this._config.models[modelId] ?? {});
  }

  /** One provider entry (undefined when the model/provider does not exist). */
  entry(modelId: string, providerId: string): ProviderPoolEntry | undefined {
    return this._config.models[modelId]?.[providerId];
  }

  /** Create the model's provider map when absent (no-op on empty id). */
  upsertModel(modelId: string): void {
    const key = modelId.trim();
    if (key.length === 0) return;
    if (!this._config.models[key]) this._config.models[key] = {};
  }

  removeModel(modelId: string): void {
    delete this._config.models[modelId];
  }

  /**
   * Seed the provider entry for a registry spec picked in the "Add model"
   * flow: creates the logical model map when absent AND the provider entry
   * with defaults, recording the registry model id explicitly. For every
   * canonical registry spec (`provider/modelId`, the form the picker lists)
   * the registry model id equals the logical id — logicalModelKey strips only
   * the provider prefix (agent.ts) — so callers can pass the spec's remainder
   * for both; the explicit parameter keeps a future non-canonical alias
   * representable without touching routing. No-op on an empty provider id;
   * an existing entry is left untouched (idempotent, same as upsertProvider).
   */
  seedProvider(logicalId: string, provider: string, modelId: string): void {
    const key = provider.trim();
    if (key.length === 0) return;
    let model = this._config.models[logicalId];
    if (!model) {
      model = {};
      this._config.models[logicalId] = model;
    }
    if (!model[key]) {
      const alias = modelId.trim();
      model[key] = {
        provider: key,
        modelId: alias.length > 0 ? alias : logicalId,
        concurrency: DEFAULT_PROVIDER_CONCURRENCY,
        weight: DEFAULT_PROVIDER_WEIGHT,
      };
    }
  }

  /** Create the provider entry with defaults when absent (no-op on empty id). */
  upsertProvider(modelId: string, providerId: string): void {
    // Delegates to seedProvider with the logical id as the model id: the two
    // are equal for every registry spec (the canonical spec IS provider + the
    // registry model id), so the legacy free-text add-provider path keeps its
    // exact shape while sharing one entry-creation implementation.
    this.seedProvider(modelId, providerId, modelId);
  }

  removeProvider(modelId: string, providerId: string): void {
    delete this._config.models[modelId]?.[providerId];
  }

  /**
   * Set one provider-entry scalar. modelId: non-empty string sets the alias,
   * empty clears it back to the logical model. concurrency/weight: number >= 1
   * (floored). tpm/cooldownMs: number >= 1 sets, null clears (unset).
   */
  setEntryScalar(
    modelId: string,
    providerId: string,
    key: ProviderPoolEntryScalarKey,
    value: string | number | null,
  ): void {
    const entry = this._config.models[modelId]?.[providerId];
    if (!entry) return;
    if (key === "modelId") {
      const trimmed = typeof value === "string" ? value.trim() : "";
      entry.modelId = trimmed.length > 0 ? trimmed : modelId;
    } else if (key === "concurrency") {
      entry.concurrency = typeof value === "number" && value >= 1 ? Math.floor(value) : entry.concurrency;
    } else if (key === "weight") {
      entry.weight = typeof value === "number" && value >= 1 ? Math.floor(value) : entry.weight;
    } else if (key === "tpm") {
      if (value === null) delete entry.tpm;
      else if (typeof value === "number" && value >= 1) entry.tpm = Math.floor(value);
    } else if (key === "cooldownMs") {
      if (value === null) delete entry.cooldownMs;
      else if (typeof value === "number" && value >= 1) entry.cooldownMs = Math.floor(value);
    }
  }
}

/**
 * Keys whose PI_WORKFLOW_* env var parsed to a value in the given env
 * snapshot. Mirrors the load-path lock definition — a key is env-locked iff it
 * appears in the workflowSettingsFromEnv output (cfg:130-166), so garbage or
 * out-of-range env values never lock a key: at load they are silently ignored
 * and the file value still applies.
 */
export function getEnvLockedKeys(env: Record<string, string | undefined> = process.env): Set<keyof WorkflowSettings> {
  return new Set(Object.keys(workflowSettingsFromEnv(env)) as (keyof WorkflowSettings)[]);
}

/**
 * Pure in-memory state for the interactive editor: staged draft values, the
 * dirty set, and the env-lock set. No TUI imports; the UI tiers drive it.
 */
export class SettingsFormModel {
  private readonly _draft: WorkflowSettings;
  private readonly _lockedKeys: Set<keyof WorkflowSettings>;
  private readonly _dirty: Set<keyof WorkflowSettings>;
  private _scope: SettingsScope;

  constructor(effective: WorkflowSettings, envLocks: WorkflowSettings, scope: SettingsScope) {
    this._draft = { ...effective };
    this._lockedKeys = new Set(Object.keys(envLocks) as (keyof WorkflowSettings)[]);
    this._dirty = new Set();
    this._scope = scope;
  }

  /** Staged working copy of the effective settings (unset keys stay unset). */
  get draft(): WorkflowSettings {
    return this._draft;
  }

  /** Target write scope for a save. */
  get scope(): SettingsScope {
    return this._scope;
  }

  /** Keys locked by a parsed PI_WORKFLOW_* env var; staging/saving is a no-op for them. */
  get lockedKeys(): Set<keyof WorkflowSettings> {
    return this._lockedKeys;
  }

  /** Number of dirty (staged, unsaved) keys. */
  get dirtyCount(): number {
    return this._dirty.size;
  }

  setScope(scope: SettingsScope): void {
    this._scope = scope;
  }

  /**
   * Stage a parsed value for a key: writes the draft and marks the key dirty.
   * Env-locked keys are no-ops — the env value always wins at load and never
   * writes back to disk, so a staged file value would be dead weight.
   */
  stage(key: keyof WorkflowSettings, value: unknown): void {
    if (this._lockedKeys.has(key)) return;
    (this._draft as Record<keyof WorkflowSettings, WorkflowSettings[keyof WorkflowSettings]>)[key] =
      value as WorkflowSettings[keyof WorkflowSettings];
    this._dirty.add(key);
  }

  isDirty(): boolean {
    return this._dirty.size > 0;
  }

  /** The partial settings to persist: only dirty keys, never env-locked ones. */
  dirtyPayload(): WorkflowSettings {
    return Object.fromEntries(
      [...this._dirty].filter((key) => !this._lockedKeys.has(key)).map((key) => [key, this._draft[key]] as const),
    ) as WorkflowSettings;
  }
}

/** Result of the interactive editor session, resolved when the form closes. */
export interface FormResult {
  cancelled: boolean;
  /** The dirty payload when saved; {} otherwise. */
  settings: WorkflowSettings;
  scope: SettingsScope;
}
