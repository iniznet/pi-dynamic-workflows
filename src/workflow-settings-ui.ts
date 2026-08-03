/**
 * `/workflows-settings` TUI renderer (implementation slice S2).
 *
 * Renders the interactive settings form from S1's `SettingsFormModel` as a
 * pi-tui component tree: a framed header, a `SettingsList` with one row per
 * `FIELD_REGISTRY` entry plus the special scope + save rows, per-type submenu
 * editors, and an inline discard-confirm view for Esc-on-dirty.
 *
 * This module is I/O-free and makes no `pi.*` calls: it only renders state and
 * resolves `FormResult` through the `done` callback, so all persistence stays
 * in the command layer (S3) after the form closes.
 *
 * Input wiring note (verified against installed pi-tui 0.80.10): `Container`
 * does not forward keyboard input (dist/tui.d.ts), so every root/submenu
 * component here forwards `handleInput` explicitly to the focused child and
 * then calls `tui.requestRender()` — the same pattern the `/workflows-models`
 * command uses (src/workflows-models-command.ts:162-199). SettingsList owns
 * its keys (up/down/enter/space/esc/search) and delegates all input to an
 * active submenu (dist/components/settings-list.js:108-139).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getKeybindings,
  Input,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  FIELD_REGISTRY,
  type FormResult,
  fieldDisplayValue,
  parseFieldInput,
  type SettingsFormModel,
  type WorkflowSettingsField,
} from "./workflow-settings-fields.js";

const MAX_VISIBLE_ROWS = 10;
const SCOPE_ROW_ID = "scope";
const SAVE_ROW_ID = "save";
const SCOPE_GLOBAL = "Global";
const SCOPE_PROJECT = "Project";
const FOOTER_HINT = "↑↓ navigate · enter cycle/edit · / search · esc cancel";
const LOCK_NOTE = "🔒 set by env ";

/** Exact file paths shown in the scope-row description (display only). */
export interface SettingsScopePaths {
  globalPath: string;
  projectPath?: string;
}

/** Extra rendering options for the form. */
export interface WorkflowSettingsFormOptions {
  /** Offer the "Project" scope option only when the project is trusted. */
  trustedProject?: boolean;
  /** Exact file paths shown in the scope-row description (display only). */
  scopePaths?: SettingsScopePaths;
  /**
   * Override the SettingsList theme. Defaults to the host
   * `getSettingsListTheme()`, which requires an initialized host theme; tests
   * inject a plain fake here.
   */
  settingsListTheme?: SettingsListTheme;
}

/** Submenu factories injected so `buildSettingItems` stays I/O-free and testable. */
export interface WorkflowSettingsSubmenuBuilders {
  fieldSubmenu: (field: WorkflowSettingsField, model: SettingsFormModel, done: (value?: string) => void) => Component;
  saveSubmenu: (currentValue: string, done: (value?: string) => void) => Component;
}

function isCyclerField(field: WorkflowSettingsField): boolean {
  return field.type === "boolean" || field.type === "enum";
}

/** Cyclable display strings; chosen to round-trip losslessly through parseFieldInput. */
function cyclerValues(field: WorkflowSettingsField): string[] {
  if (field.type === "boolean") return ["true", "false"];
  return [...(field.options ?? [])];
}

/** Display string for a field, falling back to the registry default when unset. */
function fieldDisplay(field: WorkflowSettingsField, model: SettingsFormModel): string {
  const raw = model.draft[field.key];
  return raw === undefined ? field.defaultDisplay : fieldDisplayValue(field, raw);
}

function saveRowLabel(model: SettingsFormModel): string {
  if (model.lockedKeys.size === FIELD_REGISTRY.length) return "no editable keys";
  return model.dirtyCount > 0 ? `${model.dirtyCount} change(s)` : "no changes";
}

function summaryLine(model: SettingsFormModel): string {
  const scopeName = model.scope === "project" ? SCOPE_PROJECT : SCOPE_GLOBAL;
  const locked = model.lockedKeys.size;
  return locked > 0 ? `Scope: ${scopeName} · ${locked} key(s) locked by PI_WORKFLOW_* env` : `Scope: ${scopeName}`;
}

function buildScopeRow(model: SettingsFormModel, options: WorkflowSettingsFormOptions): SettingItem {
  const showProject = options.trustedProject === true;
  const values = showProject ? [SCOPE_GLOBAL, SCOPE_PROJECT] : [SCOPE_GLOBAL];
  const globalPath = options.scopePaths?.globalPath ?? "global settings file";
  const projectPath = options.scopePaths?.projectPath ?? "project settings file";
  const description = showProject ? `Global: ${globalPath} · Project: ${projectPath}` : `Global: ${globalPath}`;
  return {
    id: SCOPE_ROW_ID,
    label: "Save to",
    currentValue: model.scope === "project" ? SCOPE_PROJECT : SCOPE_GLOBAL,
    values,
    description,
  };
}

/**
 * Pure row list for the settings form: one `SettingItem` per FIELD_REGISTRY
 * entry (cyclers for boolean/enum, submenu rows otherwise) plus the scope and
 * save rows. Env-locked rows are inert (no values, no submenu) and carry a
 * lock note. Editor-row submenus are attached only when `submenus` is
 * provided; buildFormComponent always passes themed factories.
 */
export function buildSettingItems(
  model: SettingsFormModel,
  options: WorkflowSettingsFormOptions = {},
  submenus?: WorkflowSettingsSubmenuBuilders,
): SettingItem[] {
  const items: SettingItem[] = [];
  for (const field of FIELD_REGISTRY) {
    const locked = model.lockedKeys.has(field.key);
    const item: SettingItem = {
      id: field.key,
      label: field.label,
      currentValue: fieldDisplay(field, model),
      description: locked ? `${field.help} ${LOCK_NOTE}${field.envVar} — edit the env var, not the file` : field.help,
    };
    if (locked) {
      // Inert row: no values and no submenu, so Enter does nothing
      // (verified settings-list.js activateItem).
    } else if (isCyclerField(field)) {
      item.values = cyclerValues(field);
    } else if (submenus) {
      item.submenu = (_currentValue, done) => submenus.fieldSubmenu(field, model, done);
    }
    items.push(item);
  }
  items.push(buildScopeRow(model, options));
  const saveItem: SettingItem = { id: SAVE_ROW_ID, label: "Save & exit", currentValue: saveRowLabel(model) };
  if (submenus) saveItem.submenu = (currentValue, done) => submenus.saveSubmenu(currentValue, done);
  items.push(saveItem);
  return items;
}

/** Raw edit prefill for the submenu Input (display strings are not parseable). */
function prefillValue(field: WorkflowSettingsField, model: SettingsFormModel): string {
  const raw = model.draft[field.key];
  if (raw === undefined || raw === null) return "";
  if (field.type === "string[]") return (raw as string[]).join(", ");
  return String(raw);
}

function submenuHint(field: WorkflowSettingsField): string {
  if (field.type === "string") return "single word, no leading / or spaces";
  if (field.type === "string[]") return "comma-separated tool names";
  const range =
    field.min !== undefined && field.max !== undefined
      ? ` between ${field.min} and ${field.max}`
      : field.min !== undefined
        ? ` >= ${field.min}`
        : field.max !== undefined
          ? ` <= ${field.max}`
          : "";
  const none = field.nullable ? " (empty = none)" : "";
  return `integer${range}${none}`;
}

/**
 * Submenu editor for number / number|null / string / string[] fields.
 * Enter validates via S1's parseFieldInput: invalid input keeps the submenu
 * open with an inline error; valid input stages the parsed value and closes
 * with the lossless display string. Esc closes without changing anything.
 */
function buildFieldSubmenu(
  tui: TUI,
  theme: Theme,
  field: WorkflowSettingsField,
  model: SettingsFormModel,
  done: (value?: string) => void,
): Component {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", field.label), 1, 0));
  container.addChild(new Spacer(1));
  const input = new Input();
  input.setValue(prefillValue(field, model));
  input.focused = true;
  const errorText = new Text("", 1, 0);
  const hintText = new Text(theme.fg("dim", `${submenuHint(field)} · Enter=apply · Esc=cancel`), 1, 0);
  input.onSubmit = (value: string) => {
    const parsed = parseFieldInput(field, value);
    if (parsed.ok) {
      model.stage(field.key, parsed.value);
      done(fieldDisplayValue(field, parsed.value));
      return;
    }
    errorText.setText(theme.fg("warning", parsed.error));
    tui.requestRender();
  };
  input.onEscape = () => done(undefined);
  container.addChild(input);
  container.addChild(new Spacer(1));
  container.addChild(hintText);
  container.addChild(errorText);
  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      input.handleInput(data);
      tui.requestRender();
    },
  };
}

/**
 * Confirm view for the save row. Enter resolves "save" (which fires the
 * SettingsList onChange and triggers the save flow); Esc stays in the list.
 */
function buildSaveConfirm(tui: TUI, theme: Theme, model: SettingsFormModel, done: (value?: string) => void): Component {
  const scopeName = model.scope === "project" ? SCOPE_PROJECT : SCOPE_GLOBAL;
  const count = model.dirtyCount;
  const title = count > 0 ? `Save ${count} change(s) to ${scopeName} file?` : "No changes to save";
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", title), 1, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("dim", "Enter=save · Esc=cancel"), 1, 0));
  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      const kb = getKeybindings();
      if (kb.matches(data, "tui.select.confirm") || data === " ") {
        done("save");
      } else if (kb.matches(data, "tui.select.cancel")) {
        done(undefined);
      }
      tui.requestRender();
    },
  };
}

/**
 * Inline discard-confirm view reached when Esc is pressed with dirty changes.
 * `y` discards (resolves the form); `n`/Esc returns to the list.
 */
function buildDiscardConfirm(
  tui: TUI,
  theme: Theme,
  model: SettingsFormModel,
  done: (result: FormResult) => void,
  onStay: () => void,
): Component {
  const container = new Container();
  container.addChild(new Text(theme.fg("warning", `Discard ${model.dirtyCount} change(s)? y=discard · n=stay`), 1, 0));
  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      const kb = getKeybindings();
      if (data === "y" || data === "Y") {
        done({ cancelled: true, settings: {}, scope: model.scope });
      } else if (data === "n" || data === "N" || kb.matches(data, "tui.select.cancel")) {
        onStay();
      }
      tui.requestRender();
    },
  };
}

/**
 * Full form root: framed header, scope/env summary, the SettingsList and the
 * footer hint, with view switching to the inline discard-confirm when the
 * model is dirty. Pure in-memory: no file IO, no `pi.*` calls.
 */
export function buildFormComponent(
  tui: TUI,
  theme: Theme,
  model: SettingsFormModel,
  done: (result: FormResult) => void,
  options: WorkflowSettingsFormOptions = {},
): Component {
  const submenus: WorkflowSettingsSubmenuBuilders = {
    fieldSubmenu: (field, _model, doneSubmenu) => buildFieldSubmenu(tui, theme, field, model, doneSubmenu),
    saveSubmenu: (_currentValue, doneSubmenu) => buildSaveConfirm(tui, theme, model, doneSubmenu),
  };

  let current: Component | null = null;
  let settingsList: SettingsList | null = null;
  let summaryText: Text | null = null;

  const updateSaveRow = (): void => {
    settingsList?.updateValue(SAVE_ROW_ID, saveRowLabel(model));
  };

  const onChange = (id: string, newValue: string): void => {
    if (id === SCOPE_ROW_ID) {
      model.setScope(newValue === SCOPE_PROJECT ? "project" : "global");
      summaryText?.setText(summaryLine(model));
      updateSaveRow();
      tui.requestRender();
      return;
    }
    if (id === SAVE_ROW_ID) {
      done(
        model.dirtyCount === 0
          ? { cancelled: false, settings: {}, scope: model.scope }
          : { cancelled: false, settings: model.dirtyPayload(), scope: model.scope },
      );
      return;
    }
    const field = FIELD_REGISTRY.find((f) => f.key === id);
    if (!field) return;
    // Cyclers always parse; submenu input was already validated and staged.
    const parsed = parseFieldInput(field, newValue);
    if (!parsed.ok) return;
    model.stage(field.key, parsed.value);
    settingsList?.updateValue(id, fieldDisplayValue(field, parsed.value));
    updateSaveRow();
    tui.requestRender();
  };

  const onCancelRequested = (): void => {
    if (model.dirtyCount === 0) {
      done({ cancelled: true, settings: {}, scope: model.scope });
      return;
    }
    current = buildDiscardConfirm(tui, theme, model, done, () => {
      current = buildListRoot();
      tui.requestRender();
    });
    tui.requestRender();
  };

  const buildListRoot = (): Component => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Workflow Settings")), 1, 0));
    container.addChild(new Spacer(1));
    summaryText = new Text(theme.fg("muted", summaryLine(model)), 1, 0);
    container.addChild(summaryText);
    container.addChild(new Spacer(1));
    const items = buildSettingItems(model, options, submenus);
    settingsList = new SettingsList(
      items,
      MAX_VISIBLE_ROWS,
      options.settingsListTheme ?? getSettingsListTheme(),
      onChange,
      onCancelRequested,
      { enableSearch: true },
    );
    container.addChild(settingsList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", FOOTER_HINT), 1, 0));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList?.handleInput(data);
        tui.requestRender();
      },
    };
  };

  current = buildListRoot();
  return {
    render: (width: number) => (current ? current.render(width) : []),
    invalidate: () => current?.invalidate(),
    handleInput: (data: string) => current?.handleInput?.(data),
  };
}

/**
 * Full TUI form tier: wraps `ctx.ui.custom` and resolves the FormResult.
 * All file IO stays in the caller, after `done` resolves.
 */
export function openWorkflowSettingsForm(
  ctx: ExtensionCommandContext,
  model: SettingsFormModel,
  options: WorkflowSettingsFormOptions = {},
): Promise<FormResult> {
  const trustedProject = options.trustedProject ?? ctx.isProjectTrusted();
  return ctx.ui.custom<FormResult>((tui, theme, _keybindings, done) =>
    buildFormComponent(tui, theme, model, done, { ...options, trustedProject }),
  );
}
