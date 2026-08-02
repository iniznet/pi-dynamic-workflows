/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_AGENT_RETRIES, MAX_CONCURRENCY, normalizeKeywordTriggerWord } from "./config.js";
import { workflowHomeDir, workflowProjectPaths } from "./workflow-paths.js";

/**
 * Named configuration error: a settings.json that is malformed JSON, has a
 * mistyped/unknown key, or is missing a required key fails at load with this
 * friendly, actionable message instead of surfacing as an opaque downstream
 * TypeError (e.g. `.filter` on a non-array) or a silent `{}` that hides the
 * user's misconfiguration.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface WorkflowSettings {
  keywordTriggerEnabled?: boolean;
  /** Literal keyword that arms workflows mode from interactive input. */
  keywordTriggerWord?: string;
  defaultAgentTimeoutMs?: number | null;
  /**
   * Default hard token budget applied to runs that don't pass their own
   * `tokenBudget` (#68). null explicitly means "no budget" (useful in a
   * project override to cancel a global budget); omitted also means no budget.
   */
  defaultTokenBudget?: number | null;
  /** Default max concurrent agents per run. Clamped to the runtime maximum. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /** Bottom task-panel display mode: "compact" (default, one line per run) | "detailed". */
  progressPanelMode?: "compact" | "detailed";
  /** Max agents shown per phase in detailed progress mode (default 8). */
  progressPanelMaxAgents?: number;
  /**
   * Persist each workflow subagent transcript as a real pi session file under
   * the standard sessions directory (~/.pi/agent/sessions/<encoded-cwd>/),
   * keyed by the project cwd. Default false: subagent sessions stay in-memory
   * and only the compacted history embedded in the run JSON survives.
   */
  persistAgentSessions?: boolean;
  /**
   * Character cap on a delivered background-run result's JSON-dump fallback
   * before truncation (default 400). String results and `verdict`/`report`/
   * `summary`/`synthesis` fields are never truncated.
   */
  deliveredResultMaxChars?: number;
  /**
   * Extra tool names to deny in workflow subagent sessions, on top of the
   * always-on `workflow`/`workflow_control` defaults (#107). Use it to block
   * other recursive-orchestration tools you have installed (e.g. a pi-subagents
   * tool) so a subagent can't fan out through them.
   *
   * Clearing: pass `[]` to saveWorkflowSettings to clear a previously-set list.
   * In settings.json itself, `null` is accepted as a tombstone meaning "cleared"
   * (normalized to an empty list on load) — both let a project override wipe a
   * global exclusion list (M9).
   */
  excludeSubagentTools?: string[];
}

/** A runtime type tag for schema checks (distinguishes array/null from object). */
type SettingsValueType = "string" | "number" | "boolean" | "object" | "array" | "null";

function settingsTypeOf(value: unknown): SettingsValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as SettingsValueType;
}

/**
 * Declared settings.json schema: known keys with their allowed types.
 * Value-level normalization (ranges, enums, element filtering) stays lenient
 * and drop-on-violation (see normalizeSettings); the schema enforces shape:
 * unknown keys, wrong-typed values, and malformed files fail loudly.
 */
const SETTINGS_SCHEMA: Record<string, readonly SettingsValueType[]> = {
  keywordTriggerEnabled: ["boolean"],
  keywordTriggerWord: ["string"],
  defaultAgentTimeoutMs: ["number", "null"],
  defaultTokenBudget: ["number", "null"],
  defaultConcurrency: ["number"],
  defaultAgentRetries: ["number"],
  progressPanelMode: ["string"],
  progressPanelMaxAgents: ["number"],
  persistAgentSessions: ["boolean"],
  deliveredResultMaxChars: ["number"],
  // null is a tombstone for "cleared": loading it normalizes to an empty list
  // (see normalizeSettings) so a project override can wipe a global exclusion
  // list instead of being schema-rejected.
  excludeSubagentTools: ["array", "null"],
};

/**
 * Required settings keys. Every current setting is optional (an empty object
 * is a valid settings file), so this is deliberately empty; it exists so a
 * future required key is enforced here rather than silently defaulted.
 */
const REQUIRED_SETTINGS_KEYS: readonly string[] = [];

/**
 * Parse + validate a settings file against the declared schema. Throws
 * ConfigError (with the file path) on malformed JSON, a non-object root, an
 * unknown key, a missing required key, or a wrong-typed value.
 */
function parseSettingsFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new ConfigError(
      `Workflow settings at ${path} are not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(
      `Workflow settings at ${path} must be a JSON object, got ${Array.isArray(parsed) ? "an array" : String(parsed)}.`,
    );
  }
  const raw = parsed as Record<string, unknown>;
  for (const key of REQUIRED_SETTINGS_KEYS) {
    if (raw[key] === undefined) {
      throw new ConfigError(`Workflow settings at ${path} is missing required key "${key}".`);
    }
  }
  for (const key of Object.keys(raw)) {
    const allowed = SETTINGS_SCHEMA[key];
    if (!allowed) {
      throw new ConfigError(
        `Unknown key "${key}" in workflow settings at ${path}. Known keys: ${Object.keys(SETTINGS_SCHEMA).join(", ")}.`,
      );
    }
    if (!allowed.includes(settingsTypeOf(raw[key]))) {
      throw new ConfigError(
        `Key "${key}" in workflow settings at ${path} must be ${allowed.join(" or ")}, got ${settingsTypeOf(raw[key])}.`,
      );
    }
  }
  return raw;
}

export interface WorkflowSettingsStore {
  load(): WorkflowSettings;
  save(settings: WorkflowSettings): void;
}

export interface WorkflowSettingsOptions {
  /** Explicit settings path, primarily for tests and migrations. */
  settingsPath?: string;
  /** Project cwd whose project-level settings should override global settings. */
  cwd?: string;
  /** Explicit project settings path, primarily for tests. */
  projectSettingsPath?: string;
  /** Save destination when using saveWorkflowSettings with cwd. Default: global. */
  scope?: "global" | "project";
}

/** Path to the user-level workflow settings JSON file (~/.pi/workflows/settings.json). */
export function getWorkflowSettingsPath(): string {
  return join(workflowHomeDir(), "settings.json");
}

/** Path to this project's optional workflow settings override. */
export function getWorkflowProjectSettingsPath(cwd: string): string {
  return workflowProjectPaths(cwd).settingsPath;
}

/**
 * Load settings from disk. Missing files resolve to {}; a present file is
 * validated against the declared schema — malformed JSON, unknown keys,
 * wrong-typed values, or missing required keys throw a named ConfigError
 * with the file path (see parseSettingsFile).
 */
export function loadWorkflowSettings(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettings {
  const options = normalizeOptions(settingsPathOrOptions);
  const globalSettings = readSettings(options.settingsPath ?? getWorkflowSettingsPath());
  const projectPath =
    options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  if (!projectPath) return globalSettings;
  return { ...globalSettings, ...readSettings(projectPath) };
}

/** Merge known settings into the user-level settings file. */
export function saveWorkflowSettings(
  settings: WorkflowSettings,
  settingsPathOrOptions?: string | WorkflowSettingsOptions,
): void {
  const options = normalizeOptions(settingsPathOrOptions);
  const projectPath =
    options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
  const path =
    options.scope === "project" && projectPath ? projectPath : (options.settingsPath ?? getWorkflowSettingsPath());
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readObject(path);
  writeFileSync(path, `${JSON.stringify({ ...existing, ...normalizeSettingsForSave(settings) }, null, 2)}\n`, "utf-8");
}

/** Save a global preference and update an existing project override if one is present. */
export function saveWorkflowSettingsForCwd(settings: WorkflowSettings, cwd: string): void {
  saveWorkflowSettings(settings);
  const projectPath = getWorkflowProjectSettingsPath(cwd);
  if (existsSync(projectPath)) {
    saveWorkflowSettings(settings, { projectSettingsPath: projectPath, scope: "project" });
  }
}

function normalizeOptions(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettingsOptions {
  return typeof settingsPathOrOptions === "string"
    ? { settingsPath: settingsPathOrOptions }
    : (settingsPathOrOptions ?? {});
}

function readSettings(path: string): WorkflowSettings {
  if (!existsSync(path)) return {};
  // A malformed/mistyped/unknown-key settings file fails loudly with a named
  // ConfigError (see parseSettingsFile) instead of silently resolving to {}.
  return normalizeSettings(parseSettingsFile(path));
}

function normalizeSettings(value: unknown): WorkflowSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const settings: WorkflowSettings = {};
  if (typeof raw.keywordTriggerEnabled === "boolean") {
    settings.keywordTriggerEnabled = raw.keywordTriggerEnabled;
  }
  const keywordTriggerWord = normalizeKeywordTriggerWord(raw.keywordTriggerWord);
  if (keywordTriggerWord !== undefined) settings.keywordTriggerWord = keywordTriggerWord;
  if (raw.defaultAgentTimeoutMs === null) {
    settings.defaultAgentTimeoutMs = null;
  } else if (
    typeof raw.defaultAgentTimeoutMs === "number" &&
    Number.isFinite(raw.defaultAgentTimeoutMs) &&
    raw.defaultAgentTimeoutMs > 0
  ) {
    settings.defaultAgentTimeoutMs = raw.defaultAgentTimeoutMs;
  }
  if (raw.defaultTokenBudget === null) {
    settings.defaultTokenBudget = null;
  } else {
    const defaultTokenBudget = normalizeInteger(raw.defaultTokenBudget, 1, Number.MAX_SAFE_INTEGER);
    if (defaultTokenBudget !== undefined) settings.defaultTokenBudget = defaultTokenBudget;
  }
  const defaultConcurrency = normalizeInteger(raw.defaultConcurrency, 1, MAX_CONCURRENCY);
  if (defaultConcurrency !== undefined) settings.defaultConcurrency = defaultConcurrency;
  const defaultAgentRetries = normalizeInteger(raw.defaultAgentRetries, 0, MAX_AGENT_RETRIES);
  if (defaultAgentRetries !== undefined) settings.defaultAgentRetries = defaultAgentRetries;
  if (raw.progressPanelMode === "compact" || raw.progressPanelMode === "detailed") {
    settings.progressPanelMode = raw.progressPanelMode;
  }
  if (
    typeof raw.progressPanelMaxAgents === "number" &&
    Number.isFinite(raw.progressPanelMaxAgents) &&
    raw.progressPanelMaxAgents >= 1
  ) {
    settings.progressPanelMaxAgents = Math.min(1000, Math.floor(raw.progressPanelMaxAgents));
  }
  if (typeof raw.persistAgentSessions === "boolean") {
    settings.persistAgentSessions = raw.persistAgentSessions;
  }
  const deliveredResultMaxChars = normalizeInteger(raw.deliveredResultMaxChars, 1, 1_000_000);
  if (deliveredResultMaxChars !== undefined) settings.deliveredResultMaxChars = deliveredResultMaxChars;
  if (raw.excludeSubagentTools === null) {
    // Tombstone: a project override writes null to clear a global exclusion
    // list. Emitted as an explicit empty list so the spread-merge in
    // loadWorkflowSettings actually overrides the global value (M9).
    settings.excludeSubagentTools = [];
  } else if (Array.isArray(raw.excludeSubagentTools)) {
    if (raw.excludeSubagentTools.length === 0) {
      // Explicit empty array: same "cleared" semantics as the null tombstone.
      settings.excludeSubagentTools = [];
    } else {
      const names = raw.excludeSubagentTools.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
      if (names.length) settings.excludeSubagentTools = names;
    }
  }
  return settings;
}

/**
 * Save-path normalization: identical to {@link normalizeSettings} except an
 * explicit `defaultTokenBudget: 0` is kept as the null tombstone ("no budget")
 * instead of being dropped. The read path drops 0 (there is no budget), but the
 * save path must EMIT a value — otherwise the spread-merge with the previous
 * file contents would leave the old budget in place and "0 clears" would be a
 * no-op, including from a project override that wants to wipe a global budget.
 */
function normalizeSettingsForSave(value: unknown): WorkflowSettings {
  const settings = normalizeSettings(value);
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (raw.defaultTokenBudget === 0) settings.defaultTokenBudget = null;
  return settings;
}

function normalizeInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return undefined;
  return Math.min(max, Math.floor(value));
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
