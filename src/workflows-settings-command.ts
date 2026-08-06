/**
 * `/workflows-settings` command: interactive workflow settings editor.
 *
 * Three tiers, selected by the host context:
 * - TUI form tier (`ctx.mode === "tui"` + `ctx.hasUI`): a custom component
 *   form (see workflow-settings-ui.ts) with staged edits and explicit save.
 * - Dialog tier (`ctx.hasUI`, e.g. RPC): sequential `ctx.ui.select`/`input`
 *   prompts over the field registry.
 * - Print tier (headless / json / print): a markdown status dump via
 *   `pi.sendMessage`.
 *
 * `status`/`print` args force the print tier in any mode; `paths` prints only
 * the two settings file locations.
 *
 * This module transitively imports `@earendil-works/pi-tui` (via the renderer),
 * so it must be loaded lazily through the headless-safe facade
 * (src/peer-facades.ts) — never re-exported statically from src/index.ts.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listAvailableModelSpecs, logicalModelKey } from "./agent.js";
import { applyEnvSettingsOverride, workflowSettingsFromEnv } from "./config.js";
import {
  ConfigError,
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
} from "./workflow-settings.js";
import {
  FIELD_REGISTRY,
  type FormResult,
  fieldDisplayValue,
  getEnvLockedKeys,
  parseFieldInput,
  SettingsFormModel,
  type SettingsScope,
  type WorkflowSettingsField,
} from "./workflow-settings-fields.js";
import { openWorkflowSettingsForm } from "./workflow-settings-ui.js";

const COMMAND_NAME = "workflows-settings";

const COMMAND_DESCRIPTION =
  "Interactive workflow settings editor — no args (editor) | status/print (effective settings + paths) | paths (file locations)";

const ARGUMENT_OPTIONS = ["status", "paths", "print"] as const;

const BOOLEAN_DISPLAYS = ["true", "false"] as const;

/** Empty-input prefill for nullable number rows: empty string means "null". */
const NULLABLE_NUMBER_PREFILL = "";

export interface WorkflowSettingsCommandOptions {
  /** Overrides for tests; default = ctx.cwd. Maps to WorkflowSettingsOptions. */
  cwd?: string;
  /** Global settings file override (tests). */
  settingsPath?: string;
  /** Project settings file override (tests). */
  projectSettingsPath?: string;
  /** Env source override (tests); default = process.env. */
  env?: Record<string, string | undefined>;
}

interface ResolvedPaths {
  cwd: string;
  globalPath: string;
  projectPath: string;
}

/**
 * Register the `/workflows-settings` command. Idempotent: a host that already
 * knows the name (another registration, or the extension re-registering after
 * a reload) is left untouched — there is no unregister API.
 */
export function registerWorkflowSettingsCommand(pi: ExtensionAPI, options: WorkflowSettingsCommandOptions = {}): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === COMMAND_NAME);
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix: string) =>
      ARGUMENT_OPTIONS.filter((candidate) => candidate.startsWith(prefix)).map((candidate) => ({
        value: candidate,
        label: candidate,
      })),
    handler: (args: string, ctx: ExtensionCommandContext) => runWorkflowSettingsCommand(pi, ctx, args, options),
  });
}

/**
 * Full command body: resolves the effective settings (env-overridden merged
 * global+project view, the same view the extension applies at boot), routes
 * the args, and dispatches to the mode-appropriate tier.
 */
export async function runWorkflowSettingsCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  options: WorkflowSettingsCommandOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? ctx.cwd;
  const env = options.env ?? process.env;
  const paths: ResolvedPaths = {
    cwd,
    globalPath: options.settingsPath ?? getWorkflowSettingsPath(),
    projectPath: options.projectSettingsPath ?? getWorkflowProjectSettingsPath(cwd),
  };

  // A malformed/mistyped/unknown-key settings file fails loudly with the named
  // ConfigError (message embeds the offending path) — surface it verbatim with
  // both known file paths instead of letting the editor run against garbage.
  let effective: WorkflowSettings;
  try {
    effective = applyEnvSettingsOverride(
      loadWorkflowSettings({ cwd, settingsPath: paths.globalPath, projectSettingsPath: paths.projectPath }),
      env,
    );
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    ctx.ui.notify(error.message, "error");
    pi.sendMessage({
      customType: "workflows-settings",
      content: `${error.message}\n\n${formatPathsMarkdown(paths)}`,
      display: true,
    });
    return;
  }

  // Env-locked keys: a PI_WORKFLOW_* env var that parsed successfully wins at
  // load (applyEnvSettingsOverride) and must never be written back to disk.
  const envLocks = workflowSettingsFromEnv(env);
  const lockedKeys = getEnvLockedKeys(env);

  const arg = args.trim();
  if (arg === "status" || arg === "print") {
    printStatus(pi, effective, envLocks, paths);
    return;
  }
  if (arg === "paths") {
    pi.sendMessage({ customType: "workflows-settings", content: formatPathsMarkdown(paths), display: true });
    return;
  }

  if (ctx.mode === "tui" && ctx.hasUI) {
    const model = new SettingsFormModel(effective, envLocks, "global");
    // Pass the registry-backed available-model list into the form so the pool
    // editor's "Add model" step can offer a filterable picker (provider names
    // visible). Each spec maps to the logical id the pool is keyed by — the
    // same derivation routing uses (logicalModelKey), so a picked spec is
    // stored under an id the pool's acquire() will actually hit.
    const availableModels = listAvailableModelSpecs(ctx.modelRegistry).map((spec) => ({
      spec,
      logicalId: logicalModelKey(spec, ctx.modelRegistry),
    }));
    const result = await openWorkflowSettingsForm(ctx, model, {
      scopePaths: { globalPath: paths.globalPath, projectPath: paths.projectPath },
      availableModels,
    });
    await applyFormResult(ctx, result, model.dirtyCount, paths);
    return;
  }
  if (ctx.hasUI) {
    await runDialogTier(ctx, effective, lockedKeys, paths);
    return;
  }
  printStatus(pi, effective, envLocks, paths);
}

/**
 * Print tier: effective settings per key (defaults marked, env-locked keys
 * flagged), followed by the two file paths. Pure for unit tests.
 */
export function buildSettingsStatusMarkdown(
  effective: WorkflowSettings,
  envLocks: WorkflowSettings,
  paths: { globalPath: string; projectPath?: string },
): string {
  const locked = new Set(Object.keys(envLocks));
  const lines = ["## Effective workflow settings"];
  for (const field of FIELD_REGISTRY) {
    const value = effective[field.key];
    const display = value === undefined ? `${field.defaultDisplay} (default)` : fieldDisplayValue(field, value);
    const suffix = locked.has(field.key) ? " 🔒 env" : "";
    lines.push(`- ${field.label}: ${display}${suffix}`);
  }
  lines.push("");
  lines.push(`Global file: ${paths.globalPath}`);
  if (paths.projectPath) lines.push(`Project file: ${paths.projectPath}`);
  lines.push("");
  lines.push("Edit the JSON files directly, or run /workflows-settings in a TUI session for the interactive editor.");
  return lines.join("\n");
}

function printStatus(
  pi: ExtensionAPI,
  effective: WorkflowSettings,
  envLocks: WorkflowSettings,
  paths: ResolvedPaths,
): void {
  pi.sendMessage({
    customType: "workflows-settings",
    content: buildSettingsStatusMarkdown(effective, envLocks, {
      globalPath: paths.globalPath,
      projectPath: existsSync(paths.projectPath) ? paths.projectPath : undefined,
    }),
    display: true,
  });
}

/**
 * TUI form tier result handling (all file IO happens here, outside the custom
 * component factory): cancelled → "No changes saved" only when edits were
 * staged; empty payload → "No changes to save"; else merge-write the dirty
 * payload to the chosen scope.
 */
async function applyFormResult(
  ctx: ExtensionCommandContext,
  result: FormResult,
  dirtyCount: number,
  paths: ResolvedPaths,
): Promise<void> {
  if (result.cancelled) {
    if (dirtyCount > 0) ctx.ui.notify("No changes saved", "info");
    return;
  }
  if (Object.keys(result.settings).length === 0) {
    ctx.ui.notify("No changes to save", "info");
    return;
  }
  savePartialAndNotify(ctx, result.settings, result.scope, paths);
}

/**
 * Dialog tier (RPC/`hasUI` without TUI): sequential prompts over the field
 * registry, in registry order. Env-locked rows are skipped entirely; invalid
 * text input is surfaced with a warning and re-prompted once before the key is
 * skipped. Edits are collected and saved once at the end.
 */
async function runDialogTier(
  ctx: ExtensionCommandContext,
  effective: WorkflowSettings,
  lockedKeys: Set<keyof WorkflowSettings>,
  paths: ResolvedPaths,
): Promise<void> {
  const scopeOptions = ["Global", ...(ctx.isProjectTrusted() ? ["Project"] : [])];
  const scopeChoice = await ctx.ui.select("Save scope", scopeOptions);
  if (!scopeChoice) {
    ctx.ui.notify("Workflow settings: no scope selected, nothing changed.", "warning");
    return;
  }
  const scope: SettingsScope = scopeChoice === "Project" ? "project" : "global";

  const skippedLocked = FIELD_REGISTRY.filter((field) => lockedKeys.has(field.key));
  if (skippedLocked.length > 0) {
    ctx.ui.notify(
      `${skippedLocked.length} key(s) locked by PI_WORKFLOW_* env var(s) and skipped: ${skippedLocked
        .map((field) => field.key)
        .join(", ")}`,
      "warning",
    );
  }
  const partial: Record<string, unknown> = {};
  for (const field of FIELD_REGISTRY) {
    if (lockedKeys.has(field.key)) continue;
    const value = await promptFieldValue(ctx, field, effective[field.key]);
    if (value !== undefined) partial[field.key] = value;
  }

  if (Object.keys(partial).length === 0) {
    ctx.ui.notify("No changes to save", "info");
    return;
  }
  savePartialAndNotify(ctx, partial as WorkflowSettings, scope, paths);
}

async function promptFieldValue(
  ctx: ExtensionCommandContext,
  field: WorkflowSettingsField,
  current: unknown,
): Promise<unknown | undefined> {
  // Cyclers: display strings round-trip losslessly through parseFieldInput.
  if (field.type === "boolean" || field.type === "enum") {
    const options = field.type === "boolean" ? [...BOOLEAN_DISPLAYS] : [...(field.options ?? [])];
    const currentDisplay = current === undefined ? field.defaultDisplay : fieldDisplayValue(field, current);
    const choice = await ctx.ui.select(`${field.label} (current: ${currentDisplay})`, options);
    if (choice === undefined) return undefined;
    const parsed = parseFieldInput(field, choice);
    return parsed.ok ? parsed.value : undefined;
  }

  // Free-text rows: the host discards the input placeholder, so the current
  // value goes in the prompt title (same convention as the cycler rows). One
  // re-prompt on invalid input, then skip.
  const currentLabel =
    current === undefined || current === null ? field.defaultDisplay : fieldDisplayValue(field, current);
  const raw = await ctx.ui.input(`${field.label} (current: ${currentLabel})`, prefillFor(field, current));
  if (raw === undefined) return undefined;
  const parsed = parseFieldInput(field, raw);
  if (parsed.ok) return parsed.value;
  ctx.ui.notify(parsed.error, "warning");
  const retried = await ctx.ui.input(`${field.label} (current: ${currentLabel})`, raw);
  if (retried === undefined) return undefined;
  const reparsed = parseFieldInput(field, retried);
  if (reparsed.ok) return reparsed.value;
  ctx.ui.notify(reparsed.error, "warning");
  return undefined;
}

function prefillFor(field: WorkflowSettingsField, current: unknown): string {
  if (current === undefined || current === null) return NULLABLE_NUMBER_PREFILL;
  if (field.type === "string[]") return (current as readonly string[]).join(", ");
  if (field.type === "providerPool") return JSON.stringify(current);
  return String(current);
}

/** Merge-write the partial to the chosen scope file; notify success/failure. */
function savePartialAndNotify(
  ctx: ExtensionCommandContext,
  partial: WorkflowSettings,
  scope: SettingsScope,
  paths: ResolvedPaths,
): void {
  try {
    saveWorkflowSettings(partial, {
      cwd: paths.cwd,
      scope,
      settingsPath: paths.globalPath,
      projectSettingsPath: paths.projectPath,
    });
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const savedPath = scope === "project" ? paths.projectPath : paths.globalPath;
  ctx.ui.notify(`Workflow settings saved (${scope}): ${savedPath}`, "info");
}

function formatPathsMarkdown(paths: ResolvedPaths): string {
  return `Global file: ${paths.globalPath}\nProject file: ${paths.projectPath}`;
}
