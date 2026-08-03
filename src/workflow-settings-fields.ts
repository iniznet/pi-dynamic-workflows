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
  DEFAULT_TOKEN_BUDGET,
  MAX_AGENT_RETRIES,
  MAX_CONCURRENCY,
  normalizeKeywordTriggerWord,
  WORKFLOW_ENV_VARS,
  workflowSettingsFromEnv,
} from "./config.js";
import type { WorkflowSettings } from "./workflow-settings.js";

/** UI grouping for the settings form rows, in render order. */
export type WorkflowSettingsFieldGroup = "Trigger" | "Execution" | "Progress" | "Advanced";

/** How a settings row is edited/parsed. */
export type WorkflowSettingsFieldType = "boolean" | "number" | "string" | "enum" | "string[]";

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
 * The 11 settings rows, in UI render order. Bounds/options/defaults are the
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
    label: "Delivered result max chars",
    help: "Char cap on the background-run JSON-dump fallback, clamped to [1, 1,000,000]. String results and verdict/report/summary/synthesis fields are never truncated.",
    min: 1,
    max: 1_000_000,
    group: "Advanced",
    defaultDisplay: "400",
    envVar: WORKFLOW_ENV_VARS.deliveredResultMaxChars,
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
];

/** The four groups in render order, derived from the registry so they can never drift. */
export const FIELD_GROUPS: readonly WorkflowSettingsFieldGroup[] = [
  ...new Set(FIELD_REGISTRY.map((field) => field.group)),
];

/** Look up a field by its settings key. */
export function getField(key: keyof WorkflowSettings): WorkflowSettingsField | undefined {
  return FIELD_REGISTRY.find((field) => field.key === key);
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
  }
}

function parseNumber(
  field: WorkflowSettingsField,
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (field.nullable && (trimmed === "" || trimmed.toLowerCase() === "null")) return { ok: true, value: null };
  if (trimmed === "") return { ok: false, error: "must be a number" };
  // Null tombstone: an exact "0" on the token budget is the "clear it" marker
  // (normalizeSettingsForSave rewrites defaultTokenBudget 0 → null), so pass it
  // through untouched instead of coercing it to the minimum. Other nullable
  // fields have no save-path tombstone — a "0" there is a silent no-op edit
  // (normalize drops below-min values), so reject it like any other below-min.
  if (field.key === "defaultTokenBudget" && trimmed === "0") return { ok: true, value: 0 };
  const number = Number(trimmed);
  if (!Number.isFinite(number)) return { ok: false, error: "must be a finite number" };
  // Mirror normalizeInteger (ws): below-min values are dropped at load, so the
  // editor rejects them; above-max values clamp to max; fractional values floor.
  if (field.min !== undefined && number < field.min) {
    return { ok: false, error: `must be at least ${field.min}` };
  }
  const floored = Math.floor(number);
  return { ok: true, value: field.max !== undefined ? Math.min(field.max, floored) : floored };
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
      const names = raw
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      return { ok: true, value: names };
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
