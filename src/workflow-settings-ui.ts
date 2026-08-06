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
  getProviderPoolScalar,
  PROVIDER_POOL_ENTRY_SCALARS,
  PROVIDER_POOL_SCALARS,
  ProviderPoolEditorModel,
  type ProviderPoolEntryScalarField,
  type ProviderPoolScalarField,
  type ProviderPoolScalarKey,
  parseFieldInput,
  parseProviderPoolEntryScalar,
  parseProviderPoolScalar,
  providerPoolEntryDisplay,
  providerPoolSummary,
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
  /** Visual provider-pool editor (nested form rows) — used for the providerPool row. */
  providerPoolSubmenu: (
    field: WorkflowSettingsField,
    model: SettingsFormModel,
    done: (value?: string) => void,
  ) => Component;
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
  if (raw === undefined) return field.defaultDisplay;
  // The provider pool renders as a compact summary (full JSON stays in the
  // print tier via fieldDisplayValue).
  if (field.type === "providerPool") return providerPoolSummary(raw);
  return fieldDisplayValue(field, raw);
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
      item.submenu = (_currentValue, done) =>
        field.type === "providerPool"
          ? submenus.providerPoolSubmenu(field, model, done)
          : submenus.fieldSubmenu(field, model, done);
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
  if (field.type === "providerPool") return JSON.stringify(raw);
  return String(raw);
}

function submenuHint(field: WorkflowSettingsField): string {
  if (field.type === "string") return "single word, no leading / or spaces";
  if (field.type === "string[]") return "comma-separated tool names";
  if (field.type === "providerPool") return "form rows — see README (Provider pool)";
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

/** Options for the shared text-input submenu (settings rows + provider-pool rows). */
interface TextInputSubmenuOptions {
  title: string;
  hint: string;
  prefill: string;
  /** Validate the raw input; on ok the parsed value is passed to apply. */
  validate: (raw: string) => { ok: true; value: unknown } | { ok: false; error: string };
  /** Side effect with the parsed value (stage/edit) before the submenu closes. */
  apply: (value: unknown) => void;
  /** Display string the parent row shows for a successful submit. */
  display: (value: unknown) => string;
}

/**
 * Shared Input submenu: validates on Enter, shows an inline error on invalid
 * input, applies the parsed value, and closes with the display string. Esc
 * closes without applying. Used by the settings rows and the provider-pool
 * scalar/model/provider rows.
 */
function buildTextInputSubmenu(
  tui: TUI,
  theme: Theme,
  options: TextInputSubmenuOptions,
  done: (value?: string) => void,
): Component {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", options.title), 1, 0));
  container.addChild(new Spacer(1));
  const input = new Input();
  input.setValue(options.prefill);
  input.focused = true;
  const errorText = new Text("", 1, 0);
  const hintText = new Text(theme.fg("dim", `${options.hint} · Enter=apply · Esc=cancel`), 1, 0);
  input.onSubmit = (value: string) => {
    const parsed = options.validate(value);
    if (!parsed.ok) {
      errorText.setText(theme.fg("warning", parsed.error));
      tui.requestRender();
      return;
    }
    options.apply(parsed.value);
    done(options.display(parsed.value));
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
  return buildTextInputSubmenu(
    tui,
    theme,
    {
      title: field.label,
      hint: submenuHint(field),
      prefill: prefillValue(field, model),
      validate: (raw) => parseFieldInput(field, raw),
      apply: (value) => model.stage(field.key, value),
      display: (value) => fieldDisplayValue(field, value),
    },
    done,
  );
}

// ─── Provider pool visual editor (nested form rows) ─────────────────────────
//
// The providerPool key is edited as a three-level row editor instead of a raw
// JSON blob: the pool root lists the four scalars + one row per logical model;
// a model row opens the per-model editor (its providers + add/remove/done); a
// provider row opens the per-provider editor (the five entry scalars +
// remove/done). All levels share one ProviderPoolEditorModel working copy;
// only the pool root's Done row commits (stages toInput() into the settings
// model). Esc at any level navigates back; Esc at the pool root discards the
// whole session (nothing is ever staged until Done).

const PP_DONE_ID = "pp-done";
const PP_MODEL_DONE_ID = "pp-model-done";
const PP_PROVIDER_DONE_ID = "pp-provider-done";
const PP_ADD_MODEL_ID = "pp-add-model";
const PP_ADD_PROVIDER_ID = "pp-add-provider";
const PP_REMOVE_MODEL_ID = "pp-remove-model";
const PP_REMOVE_PROVIDER_ID = "pp-remove-provider";
const PP_FOOTER = "↑↓ navigate · enter cycle/edit · esc back";

/**
 * Swap a SettingsList's rows in place (same instance, selection preserved).
 * The fields are public runtime class fields (settings-list.js) that the .d.ts
 * marks private; the cast mirrors the verified runtime shape so a rebuild here
 * does not reset the selection or disturb the active-submenu state machine.
 */
function swapListItems(list: SettingsList, items: SettingItem[]): void {
  const internals = list as unknown as {
    items: SettingItem[];
    filteredItems: SettingItem[];
    selectedIndex: number;
  };
  internals.items = items;
  internals.filteredItems = items;
  if (internals.selectedIndex >= items.length) internals.selectedIndex = Math.max(0, items.length - 1);
}

/** Generic Enter=apply / Esc=cancel view (Done / Remove / Back rows). */
function buildConfirmSubmenu(
  tui: TUI,
  theme: Theme,
  title: string,
  hint: string,
  done: (value?: string) => void,
): Component {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", title), 1, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("dim", hint), 1, 0));
  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      const kb = getKeybindings();
      if (kb.matches(data, "tui.select.confirm") || data === " ") done("apply");
      else if (kb.matches(data, "tui.select.cancel")) done(undefined);
      tui.requestRender();
    },
  };
}

/** Options shared by the three editor views (pool root / model / provider). */
interface EditorViewOptions {
  title: string;
  buildItems: () => SettingItem[];
  onChange: (id: string, value: string) => void;
  onCancel: () => void;
}

/**
 * Framed list view used by all three provider-pool editor levels. Returns the
 * Component plus the live SettingsList so callers can refresh rows in place
 * (swapListItems) without losing the selection or the submenu state machine.
 */
function buildEditorView(
  tui: TUI,
  theme: Theme,
  listTheme: SettingsListTheme,
  options: EditorViewOptions,
): { component: Component; list: SettingsList } {
  const container = new Container();
  container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
  container.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
  container.addChild(new Spacer(1));
  const list = new SettingsList(options.buildItems(), MAX_VISIBLE_ROWS, listTheme, options.onChange, options.onCancel, {
    enableSearch: false,
  });
  container.addChild(list);
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("dim", PP_FOOTER), 1, 0));
  return {
    list,
    component: {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    },
  };
}

/** Current-value display for one top-level pool scalar row. */
function providerScalarDisplay(editor: ProviderPoolEditorModel, scalar: ProviderPoolScalarField): string {
  switch (scalar.key) {
    case "enabled":
      return editor.config.enabled ? "true" : "false";
    case "whenSaturated":
      return editor.config.whenSaturated;
    case "saturationWaitTimeoutMs":
      return String(editor.config.saturationWaitTimeoutMs);
    case "defaultTpmWindowMs":
      return String(editor.config.defaultTpmWindowMs);
  }
}

/** Current-value display for one per-provider scalar row ("(unset)" for cleared caps). */
function entryScalarDisplay(
  editor: ProviderPoolEditorModel,
  modelId: string,
  providerId: string,
  scalar: ProviderPoolEntryScalarField,
): string {
  const entry = editor.entry(modelId, providerId);
  if (!entry) return "(missing)";
  switch (scalar.key) {
    case "modelId":
      return entry.modelId;
    case "concurrency":
      return String(entry.concurrency);
    case "weight":
      return String(entry.weight);
    case "tpm":
      return entry.tpm !== undefined ? String(entry.tpm) : "(unset)";
    case "cooldownMs":
      return entry.cooldownMs !== undefined ? String(entry.cooldownMs) : "(unset)";
  }
}

/** Number-scalar submenu for the pool root rows (boolean/enum rows are cyclers). */
function buildPoolScalarSubmenu(
  tui: TUI,
  theme: Theme,
  scalar: ProviderPoolScalarField,
  editor: ProviderPoolEditorModel,
  done: (value?: string) => void,
): Component {
  return buildTextInputSubmenu(
    tui,
    theme,
    {
      title: scalar.label,
      hint: scalar.help,
      prefill: providerScalarDisplay(editor, scalar),
      validate: (raw) => parseProviderPoolScalar(scalar, raw),
      apply: (value) => editor.setScalar(scalar.key, value as boolean | "wait" | "fail" | number),
      display: (value) => String(value),
    },
    done,
  );
}

/** Add-model row submenu: validates a fresh logical model id, then upserts. */
function buildAddModelSubmenu(
  tui: TUI,
  theme: Theme,
  editor: ProviderPoolEditorModel,
  done: (value?: string) => void,
): Component {
  return buildTextInputSubmenu(
    tui,
    theme,
    {
      title: "Add model",
      hint: "logical model id (e.g. claude-sonnet-4)",
      prefill: "",
      validate: (raw) => {
        const key = raw.trim();
        if (key.length === 0) return { ok: false, error: "must not be empty" };
        if (editor.config.models[key]) return { ok: false, error: `"${key}" already exists` };
        return { ok: true, value: key };
      },
      apply: (value) => editor.upsertModel(value as string),
      display: () => "",
    },
    done,
  );
}

/** Add-provider row submenu: validates a fresh provider id under the model, then upserts. */
function buildAddProviderSubmenu(
  tui: TUI,
  theme: Theme,
  editor: ProviderPoolEditorModel,
  modelId: string,
  done: (value?: string) => void,
): Component {
  return buildTextInputSubmenu(
    tui,
    theme,
    {
      title: `Add provider to ${modelId}`,
      hint: "provider id (e.g. anthropic-direct, openrouter)",
      prefill: "",
      validate: (raw) => {
        const key = raw.trim();
        if (key.length === 0) return { ok: false, error: "must not be empty" };
        if (editor.entry(modelId, key)) return { ok: false, error: `"${key}" already exists under ${modelId}` };
        return { ok: true, value: key };
      },
      apply: (value) => editor.upsertProvider(modelId, value as string),
      display: () => "",
    },
    done,
  );
}

/** One per-provider scalar row submenu (alias / concurrency / weight / tpm / cooldown). */
function buildEntryScalarSubmenu(
  tui: TUI,
  theme: Theme,
  scalar: ProviderPoolEntryScalarField,
  editor: ProviderPoolEditorModel,
  modelId: string,
  providerId: string,
  done: (value?: string) => void,
): Component {
  const entry = editor.entry(modelId, providerId);
  const prefill =
    scalar.key === "tpm" || scalar.key === "cooldownMs"
      ? entry && entry[scalar.key] !== undefined
        ? String(entry[scalar.key])
        : ""
      : String(entry?.[scalar.key]);
  return buildTextInputSubmenu(
    tui,
    theme,
    {
      title: `${providerId} · ${scalar.label}`,
      hint: scalar.help,
      prefill,
      validate: (raw) => parseProviderPoolEntryScalar(scalar, raw),
      apply: (value) => editor.setEntryScalar(modelId, providerId, scalar.key, value as string | number | null),
      display: (value) => (value === null ? "(unset)" : String(value)),
    },
    done,
  );
}

/**
 * Level 3: per-provider editor (the five entry scalars + remove + done).
 * Scalar rows mutate the shared editor inside their submenu; rows refresh
 * in place (same list instance, selection preserved) after any change.
 */
function buildProviderEditor(
  tui: TUI,
  theme: Theme,
  editor: ProviderPoolEditorModel,
  modelId: string,
  providerId: string,
  done: (value?: string) => void,
  listTheme: SettingsListTheme,
): Component {
  const view = buildEditorView(tui, theme, listTheme, {
    title: `${modelId} · ${providerId}`,
    buildItems,
    onChange,
    onCancel: () => done(undefined),
  });

  function onChange(id: string, _value: string): void {
    if (id === PP_PROVIDER_DONE_ID) {
      done(providerPoolEntryDisplay(modelId, editor.entry(modelId, providerId)));
      return;
    }
    if (id === PP_REMOVE_PROVIDER_ID) {
      done("removed");
      return;
    }
    // Scalar submenu already applied; rebuild to re-derive every row display.
    refresh();
  }

  function refresh(): void {
    swapListItems(view.list, buildItems());
    tui.requestRender();
  }

  function buildItems(): SettingItem[] {
    const items: SettingItem[] = PROVIDER_POOL_ENTRY_SCALARS.map((scalar) => ({
      id: scalar.key,
      label: scalar.label,
      currentValue: entryScalarDisplay(editor, modelId, providerId, scalar),
      description: scalar.help,
      submenu: (_cv, doneSubmenu) =>
        buildEntryScalarSubmenu(tui, theme, scalar, editor, modelId, providerId, doneSubmenu),
    }));
    items.push({
      id: PP_REMOVE_PROVIDER_ID,
      label: "－ Remove provider",
      currentValue: "",
      description: `delete the ${providerId} entry under ${modelId}`,
      submenu: (_cv, doneSubmenu) =>
        buildConfirmSubmenu(tui, theme, `Remove provider ${providerId}?`, "Enter=remove · Esc=cancel", (v) => {
          if (v !== undefined) editor.removeProvider(modelId, providerId);
          doneSubmenu(v);
        }),
    });
    items.push({
      id: PP_PROVIDER_DONE_ID,
      label: "Done",
      currentValue: "back to model",
      description: "return to the provider rows",
      submenu: (_cv, doneSubmenu) =>
        buildConfirmSubmenu(tui, theme, "Back to model?", "Enter=back · Esc=cancel", doneSubmenu),
    });
    return items;
  }

  return view.component;
}

/**
 * Level 2: per-model editor (its providers + add/remove + done). Provider rows
 * open the per-provider editor; add/remove rebuild the row list in place.
 */
function buildModelEditor(
  tui: TUI,
  theme: Theme,
  editor: ProviderPoolEditorModel,
  modelId: string,
  done: (value?: string) => void,
  listTheme: SettingsListTheme,
): Component {
  const view = buildEditorView(tui, theme, listTheme, {
    title: `Model · ${modelId}`,
    buildItems,
    onChange,
    onCancel: () => done(undefined),
  });

  function onChange(id: string, _value: string): void {
    if (id === PP_MODEL_DONE_ID) {
      done(`${editor.providerIds(modelId).length} provider(s)`);
      return;
    }
    if (id === PP_REMOVE_MODEL_ID) {
      done("removed");
      return;
    }
    if (id === PP_ADD_PROVIDER_ID) {
      refresh();
      return;
    }
    // Provider row closed: any nested edit may have changed structure — rebuild.
    refresh();
  }

  function refresh(): void {
    swapListItems(view.list, buildItems());
    tui.requestRender();
  }

  function buildItems(): SettingItem[] {
    const items: SettingItem[] = [];
    for (const providerId of editor.providerIds(modelId)) {
      items.push({
        id: `provider:${providerId}`,
        label: providerId,
        currentValue: providerPoolEntryDisplay(modelId, editor.entry(modelId, providerId)),
        description: "per-provider concurrency/weight/TPM/cooldown rows",
        submenu: (_cv, doneSubmenu) =>
          buildProviderEditor(tui, theme, editor, modelId, providerId, doneSubmenu, listTheme),
      });
    }
    items.push({
      id: PP_ADD_PROVIDER_ID,
      label: "＋ Add provider",
      currentValue: "",
      description: `add a provider entry under ${modelId}`,
      submenu: (_cv, doneSubmenu) => buildAddProviderSubmenu(tui, theme, editor, modelId, doneSubmenu),
    });
    items.push({
      id: PP_REMOVE_MODEL_ID,
      label: "－ Remove model",
      currentValue: "",
      description: `delete ${modelId} and all its providers`,
      submenu: (_cv, doneSubmenu) =>
        buildConfirmSubmenu(tui, theme, `Remove model ${modelId}?`, "Enter=remove · Esc=cancel", (v) => {
          if (v !== undefined) editor.removeModel(modelId);
          doneSubmenu(v);
        }),
    });
    items.push({
      id: PP_MODEL_DONE_ID,
      label: "Done",
      currentValue: "back to pool",
      description: "return to the provider-pool rows",
      submenu: (_cv, doneSubmenu) =>
        buildConfirmSubmenu(tui, theme, "Back to pool?", "Enter=back · Esc=cancel", doneSubmenu),
    });
    return items;
  }

  return view.component;
}

/**
 * Level 1: the provider-pool root editor. Four scalar rows (cyclers for
 * boolean/enum, number submenus otherwise), one row per logical model, plus
 * Add model and Done. Only Done stages `toInput()` into the settings model and
 * closes the whole editor with the row summary; Esc discards the session.
 */
function buildProviderPoolSubmenu(
  tui: TUI,
  theme: Theme,
  field: WorkflowSettingsField,
  model: SettingsFormModel,
  done: (value?: string) => void,
  listTheme: SettingsListTheme,
): Component {
  const editor = new ProviderPoolEditorModel(model.draft[field.key]);
  const view = buildEditorView(tui, theme, listTheme, {
    title: "Provider pool",
    buildItems: buildRootItems,
    onChange: onRootChange,
    onCancel: () => done(undefined),
  });

  function onRootChange(id: string, value: string): void {
    if (id === PP_DONE_ID) {
      // Commit the visual editor into the settings model, then close with the summary.
      model.stage(field.key, editor.toInput());
      done(editor.summary());
      return;
    }
    if (id === PP_ADD_MODEL_ID) {
      refresh();
      return;
    }
    const scalar = getProviderPoolScalar(id as ProviderPoolScalarKey);
    if (scalar) {
      // Cyclers mutate here; number rows already applied inside their submenu.
      if (scalar.type !== "number") {
        const parsed = parseProviderPoolScalar(scalar, value);
        if (parsed.ok) editor.setScalar(scalar.key, parsed.value);
      }
      refresh();
      return;
    }
    // Model row closed: any nested edit may have changed structure — rebuild.
    refresh();
  }

  function refresh(): void {
    swapListItems(view.list, buildRootItems());
    tui.requestRender();
  }

  function buildRootItems(): SettingItem[] {
    const items: SettingItem[] = [];
    for (const scalar of PROVIDER_POOL_SCALARS) {
      const cycler = scalar.type === "boolean" || scalar.type === "enum";
      const item: SettingItem = {
        id: scalar.key,
        label: scalar.label,
        currentValue: providerScalarDisplay(editor, scalar),
        description: scalar.help,
      };
      if (cycler) item.values = [...(scalar.options ?? [])];
      else item.submenu = (_cv, doneSubmenu) => buildPoolScalarSubmenu(tui, theme, scalar, editor, doneSubmenu);
      items.push(item);
    }
    for (const modelId of editor.modelIds()) {
      items.push({
        id: `model:${modelId}`,
        label: modelId,
        currentValue: `${editor.providerIds(modelId).length} provider(s)`,
        description: "provider routing for this logical model",
        submenu: (_cv, doneSubmenu) => buildModelEditor(tui, theme, editor, modelId, doneSubmenu, listTheme),
      });
    }
    items.push({
      id: PP_ADD_MODEL_ID,
      label: "＋ Add model",
      currentValue: "",
      description: "add a logical model id with provider entries",
      submenu: (_cv, doneSubmenu) => buildAddModelSubmenu(tui, theme, editor, doneSubmenu),
    });
    items.push({
      id: PP_DONE_ID,
      label: "Done",
      currentValue: "apply & close",
      description: "write the pool back into the settings and close",
      submenu: (_cv, doneSubmenu) =>
        buildConfirmSubmenu(tui, theme, "Apply provider pool?", "Enter=apply · Esc=cancel", doneSubmenu),
    });
    return items;
  }

  return view.component;
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
    providerPoolSubmenu: (field, _model, doneSubmenu) =>
      buildProviderPoolSubmenu(
        tui,
        theme,
        field,
        model,
        doneSubmenu,
        options.settingsListTheme ?? getSettingsListTheme(),
      ),
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
    if (field.type === "providerPool") {
      // The visual pool editor stages the settings model itself before closing
      // with the summary display; nothing to parse here — just refresh the
      // save row (dirty count may have changed).
      updateSaveRow();
      tui.requestRender();
      return;
    }
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
