/**
 * Tests for workflow-settings-ui.ts (S2) — the TUI form renderer.
 *
 * Structure tests drive the pure `buildSettingItems` row factory; interaction
 * tests drive the real component through its `handleInput` seam with a fake
 * TUI and injected theme (no real terminal — same pattern the repo's other
 * component tests use). Key strings match the installed pi-tui keybindings:
 * down = "\x1b[B", confirm = " " (SettingsList accepts space explicitly),
 * cancel = "\x1b", input submit = "\n" (Input accepts "\n" explicitly).
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem, SettingsListTheme, TUI } from "@earendil-works/pi-tui";
import type { WorkflowSettings } from "../src/workflow-settings.js";
import { FIELD_REGISTRY, type FormResult, SettingsFormModel } from "../src/workflow-settings-fields.js";
import {
  buildFormComponent,
  buildSettingItems,
  type WorkflowSettingsFormOptions,
} from "../src/workflow-settings-ui.js";

const KEY_DOWN = "\x1b[B";
const KEY_CONFIRM = " ";
const KEY_CANCEL = "\x1b";
const KEY_SUBMIT = "\n";

function makeFakeTui(): TUI {
  return { requestRender: () => {} } as unknown as TUI;
}

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const fakeSettingsListTheme: SettingsListTheme = {
  label: (text) => text,
  value: (text) => text,
  description: (text) => text,
  cursor: ">",
  hint: (text) => text,
};

function makeModel(
  effective: WorkflowSettings = {},
  envLocks: WorkflowSettings = {},
  scope: "global" | "project" = "global",
): SettingsFormModel {
  return new SettingsFormModel(effective, envLocks, scope);
}

/** Build the real form with a fake tui/theme and a captured done callback. */
function buildForm(model: SettingsFormModel, options: WorkflowSettingsFormOptions = {}) {
  const done = mock.fn((_result: FormResult) => {});
  const root = buildFormComponent(makeFakeTui(), fakeTheme, model, done, {
    settingsListTheme: fakeSettingsListTheme,
    ...options,
  });
  return { root, done, model };
}

function navigateTo(root: Component, rowIndex: number): void {
  for (let i = 0; i < rowIndex; i++) root.handleInput?.(KEY_DOWN);
}

function itemById(items: SettingItem[], id: string): SettingItem {
  const item = items.find((candidate) => candidate.id === id);
  assert.ok(item, `expected a row with id ${id}`);
  return item;
}

describe("row structure (buildSettingItems)", () => {
  it("renders every registry row plus the scope and save rows", () => {
    const items = buildSettingItems(makeModel());
    assert.equal(items.length, FIELD_REGISTRY.length + 2);
    for (const field of FIELD_REGISTRY) {
      const item = itemById(items, field.key);
      assert.equal(item.label, field.label, `label for ${field.key}`);
    }
    const scopeRow = itemById(items, "scope");
    assert.equal(scopeRow.label, "Save to");
    const saveRow = itemById(items, "save");
    assert.equal(saveRow.label, "Save & exit");
    assert.equal(saveRow.currentValue, "no changes");
  });

  it("offers Project scope only when the project is trusted", () => {
    const model = makeModel();
    assert.deepEqual(itemById(buildSettingItems(model, { trustedProject: false }), "scope").values, ["Global"]);
    assert.deepEqual(itemById(buildSettingItems(model, { trustedProject: true }), "scope").values, [
      "Global",
      "Project",
    ]);
  });

  it("wires cyclers for boolean/enum rows and submenu rows otherwise", () => {
    const submenus = {
      fieldSubmenu: () => ({ render: () => [] as string[], invalidate: () => {} }),
      saveSubmenu: () => ({ render: () => [] as string[], invalidate: () => {} }),
    };
    const items = buildSettingItems(makeModel(), {}, submenus);
    assert.deepEqual(itemById(items, "keywordTriggerEnabled").values, ["true", "false"]);
    assert.deepEqual(itemById(items, "progressPanelMode").values, ["compact", "detailed"]);
    assert.equal(typeof itemById(items, "defaultConcurrency").submenu, "function");
    assert.equal(typeof itemById(items, "keywordTriggerWord").submenu, "function");
    assert.equal(typeof itemById(items, "excludeSubagentTools").submenu, "function");
    assert.equal(typeof itemById(items, "save").submenu, "function");

    // Without injected builders the editor rows stay submenu-less.
    const plain = buildSettingItems(makeModel());
    assert.equal(itemById(plain, "defaultConcurrency").submenu, undefined);
    assert.equal(itemById(plain, "save").submenu, undefined);
  });

  it("renders env-locked rows inert with a lock note", () => {
    const model = makeModel({ defaultConcurrency: 16 }, { defaultConcurrency: 16 });
    const locked = itemById(buildSettingItems(model), "defaultConcurrency");
    assert.equal(locked.currentValue, "16", "locked rows show the effective (env) value");
    assert.equal(locked.values, undefined, "locked rows must not cycle");
    assert.equal(locked.submenu, undefined, "locked rows must not open a submenu");
    assert.match(locked.description ?? "", /PI_WORKFLOW_DEFAULT_CONCURRENCY/);
    assert.match(locked.description ?? "", /edit the env var, not the file/);
  });

  it("save row tracks the dirty count and the all-locked state", () => {
    const model = makeModel();
    assert.equal(itemById(buildSettingItems(model), "save").currentValue, "no changes");
    model.stage("defaultConcurrency", 8);
    assert.equal(itemById(buildSettingItems(model), "save").currentValue, "1 change(s)");
    model.stage("progressPanelMode", "detailed");
    assert.equal(itemById(buildSettingItems(model), "save").currentValue, "2 change(s)");
  });

  it("save row reports no editable keys when every key is env-locked", () => {
    const allLocks = Object.fromEntries(FIELD_REGISTRY.map((field) => [field.key, 0])) as unknown as WorkflowSettings;
    const model = makeModel({}, allLocks);
    assert.equal(itemById(buildSettingItems(model), "save").currentValue, "no editable keys");
  });
});

describe("form interactions (buildFormComponent)", () => {
  it("cycling the first row stages the parsed value", () => {
    const model = makeModel();
    const { root } = buildForm(model);
    root.handleInput?.(KEY_CONFIRM); // keywordTriggerEnabled "true" → "false"
    assert.equal(model.draft.keywordTriggerEnabled, false);
    assert.equal(model.dirtyCount, 1);
  });

  it("scope row cycles into the project scope only when trusted", () => {
    const untrusted = makeModel();
    const trusted = makeModel();
    const untrustedForm = buildForm(untrusted);
    const trustedForm = buildForm(trusted, { trustedProject: true });
    navigateTo(untrustedForm.root, 11); // scope row (11 fields, then scope, then save)
    navigateTo(trustedForm.root, 11);
    untrustedForm.root.handleInput?.(KEY_CONFIRM);
    trustedForm.root.handleInput?.(KEY_CONFIRM);
    assert.equal(untrusted.scope, "global");
    assert.equal(trusted.scope, "project");
  });

  it("number submenu stages valid input and closes", () => {
    const model = makeModel();
    const { root } = buildForm(model);
    navigateTo(root, 4); // defaultConcurrency
    root.handleInput?.(KEY_CONFIRM); // open the submenu
    for (const char of "12") root.handleInput?.(char);
    root.handleInput?.(KEY_SUBMIT);
    assert.equal(model.draft.defaultConcurrency, 12);
    assert.equal(model.dirtyCount, 1);
  });

  it("number submenu keeps the form open on invalid input", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    navigateTo(root, 4);
    root.handleInput?.(KEY_CONFIRM);
    for (const char of "abc") root.handleInput?.(char);
    root.handleInput?.(KEY_SUBMIT);
    assert.equal(model.dirtyCount, 0, "invalid input must not stage");
    // The submenu is still open: Esc closes it instead of cancelling the form.
    root.handleInput?.(KEY_CANCEL);
    assert.equal(done.mock.callCount(), 0, "Esc in an open submenu must not cancel the form");
  });

  it("escaping the submenu leaves the draft unchanged", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    navigateTo(root, 4);
    root.handleInput?.(KEY_CONFIRM);
    for (const char of "7") root.handleInput?.(char);
    root.handleInput?.(KEY_CANCEL);
    assert.equal(model.draft.defaultConcurrency, undefined);
    assert.equal(model.dirtyCount, 0);
    assert.equal(done.mock.callCount(), 0);
  });

  it("cancelling a clean form resolves cancelled without a confirm view", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    root.handleInput?.(KEY_CANCEL);
    assert.deepEqual(done.mock.calls[0]?.arguments[0], { cancelled: true, settings: {}, scope: "global" });
  });

  it("discard confirm y resolves cancelled for dirty changes", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    root.handleInput?.(KEY_CONFIRM); // stage a change
    assert.equal(model.dirtyCount, 1);
    root.handleInput?.(KEY_CANCEL); // Esc → inline discard confirm
    assert.equal(done.mock.callCount(), 0, "confirm view must not resolve yet");
    root.handleInput?.("y");
    assert.deepEqual(done.mock.calls[0]?.arguments[0], { cancelled: true, settings: {}, scope: "global" });
  });

  it("discard confirm n returns to the list without resolving", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CANCEL); // → discard view
    root.handleInput?.("n"); // stay
    assert.equal(done.mock.callCount(), 0);
    // The list is back: Esc re-enters the discard confirm instead of resolving.
    root.handleInput?.(KEY_CANCEL);
    assert.equal(done.mock.callCount(), 0);
  });

  it("save row resolves the dirty payload for the chosen scope", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    root.handleInput?.(KEY_CONFIRM); // stage keywordTriggerEnabled=false
    navigateTo(root, 12); // save row
    root.handleInput?.(KEY_CONFIRM); // open save confirm
    root.handleInput?.(KEY_CONFIRM); // confirm
    assert.deepEqual(done.mock.calls[0]?.arguments[0], {
      cancelled: false,
      settings: { keywordTriggerEnabled: false },
      scope: "global",
    });
  });

  it("save row with no changes resolves an empty payload", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    navigateTo(root, 12);
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM);
    assert.deepEqual(done.mock.calls[0]?.arguments[0], { cancelled: false, settings: {}, scope: "global" });
  });
});
