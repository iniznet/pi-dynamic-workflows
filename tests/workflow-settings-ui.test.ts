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
  type AvailableModelSpec,
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
      providerPoolSubmenu: () => ({ render: () => [] as string[], invalidate: () => {} }),
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
    navigateTo(untrustedForm.root, 28); // scope row (28 fields, then scope, then save)
    navigateTo(trustedForm.root, 28);
    untrustedForm.root.handleInput?.(KEY_CONFIRM);
    trustedForm.root.handleInput?.(KEY_CONFIRM);
    assert.equal(untrusted.scope, "global");
    assert.equal(trusted.scope, "project");
  });

  it("number submenu stages valid input and closes", () => {
    const model = makeModel();
    const { root } = buildForm(model);
    navigateTo(root, 5); // defaultConcurrency (tokenBudgetCountsCacheRead is row 4)
    root.handleInput?.(KEY_CONFIRM); // open the submenu
    for (const char of "12") root.handleInput?.(char);
    root.handleInput?.(KEY_SUBMIT);
    assert.equal(model.draft.defaultConcurrency, 12);
    assert.equal(model.dirtyCount, 1);
  });

  it("number submenu keeps the form open on invalid input", () => {
    const model = makeModel();
    const { root, done } = buildForm(model);
    navigateTo(root, 5);
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
    navigateTo(root, 5);
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
    navigateTo(root, 29); // save row (28 fields, scope, then save)
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
    navigateTo(root, 29);
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM);
    assert.deepEqual(done.mock.calls[0]?.arguments[0], { cancelled: false, settings: {}, scope: "global" });
  });
});

describe("provider pool visual editor", () => {
  const POOL_ROW = 26; // providerPool is the 27th registry row (0-based)
  const modelPool = (models: Record<string, Record<string, unknown>>) =>
    ({ models }) as WorkflowSettings["providerPool"];
  // Two providers for the same logical model (gpt-5.5) + one fresh model: the
  // fixture that proves multi-provider routing stays reachable through the UI.
  const MULTI_AVAILABLE: AvailableModelSpec[] = [
    { spec: "openai-codex/gpt-5.5", logicalId: "gpt-5.5" },
    { spec: "openrouter/gpt-5.5", logicalId: "gpt-5.5" },
    { spec: "anthropic/claude-sonnet-4", logicalId: "claude-sonnet-4" },
  ];

  it("opens a nested row editor and Esc discards without staging", () => {
    const model = makeModel({ providerPool: modelPool({ "claude-sonnet-4": { "anthropic-direct": {} } }) });
    const { root, done } = buildForm(model);
    navigateTo(root, POOL_ROW);
    root.handleInput?.(KEY_CONFIRM); // open the pool editor
    const lines = root.render(80);
    assert.ok(
      lines.some((l) => l.includes("Provider pool")),
      "pool editor header",
    );
    assert.ok(
      lines.some((l) => l.includes("Enabled")),
      "scalar row",
    );
    assert.ok(lines.some((l) => l.includes("When saturated")));
    assert.ok(
      lines.some((l) => l.includes("claude-sonnet-4")),
      "model row",
    );
    assert.ok(
      lines.some((l) => l.includes("1 provider(s)")),
      "model row summary",
    );
    assert.ok(lines.some((l) => l.includes("＋ Add model")));
    assert.ok(lines.some((l) => l.includes("Done")));
    root.handleInput?.(KEY_CANCEL); // Esc at the pool root discards the session
    assert.deepEqual(model.draft.providerPool, { models: { "claude-sonnet-4": { "anthropic-direct": {} } } });
    assert.equal(model.dirtyCount, 0, "no edits staged on discard");
    assert.equal(done.mock.callCount(), 0, "Esc in the pool editor must not cancel the whole form");
  });

  it("cycles the Enabled scalar and Done commits the minimal input", () => {
    const model = makeModel();
    const { root } = buildForm(model);
    navigateTo(root, POOL_ROW);
    root.handleInput?.(KEY_CONFIRM); // open pool editor (selection on Enabled)
    root.handleInput?.(KEY_CONFIRM); // cycle true → false
    assert.ok(
      root.render(80).some((l) => l.includes("false")),
      "row shows the cycled value",
    );
    navigateTo(root, 5); // Done (4 scalars + Add model + Done)
    root.handleInput?.(KEY_CONFIRM); // open Done confirm
    root.handleInput?.(KEY_CONFIRM); // apply
    assert.deepEqual(model.draft.providerPool, { enabled: false });
    assert.equal(model.dirtyCount, 1);
    assert.equal(
      root.render(80).some((l) => l.includes("off · wait · 0 model(s)")),
      true,
      "form row summary",
    );
  });

  it("adds a model via the custom-id text input and commits it", () => {
    const model = makeModel();
    const { root } = buildForm(model);
    navigateTo(root, POOL_ROW);
    root.handleInput?.(KEY_CONFIRM);
    navigateTo(root, 4); // ＋ Add model (4 scalars then Add)
    root.handleInput?.(KEY_CONFIRM);
    // No availableModels supplied → the picker shows only the custom-id row.
    root.handleInput?.(KEY_CONFIRM); // open the free-text input
    for (const char of "gpt-5") root.handleInput?.(char);
    root.handleInput?.(KEY_SUBMIT);
    assert.ok(
      root.render(80).some((l) => l.includes("gpt-5")),
      "new model row appears",
    );
    navigateTo(root, 2); // Done (selection is preserved on the new model row: 4 scalars + gpt-5 + Add + Done)
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM);
    assert.deepEqual(model.draft.providerPool, { models: { "gpt-5": {} } });
  });

  describe("add-model picker (registry-backed availableModels)", () => {
    const AVAILABLE: AvailableModelSpec[] = [
      { spec: "openai-codex/gpt-5.5", logicalId: "gpt-5.5" },
      { spec: "anthropic/claude-sonnet-4", logicalId: "claude-sonnet-4" },
    ];

    it("lists every supplied spec with the provider name visible", () => {
      const model = makeModel();
      const { root } = buildForm(model, { availableModels: AVAILABLE });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM); // open the pool editor
      navigateTo(root, 4); // ＋ Add model
      root.handleInput?.(KEY_CONFIRM); // open the picker
      const lines = root.render(80);
      assert.ok(
        lines.some((l) => l.includes("openai-codex/gpt-5.5")),
        "provider-qualified spec row",
      );
      assert.ok(
        lines.some((l) => l.includes("anthropic/claude-sonnet-4")),
        "second spec row",
      );
      assert.ok(
        lines.some((l) => l.includes("✎ Type custom model id")),
        "custom fallback row is always present",
      );
    });

    it("typing fuzzy-filters the list by spec label", () => {
      const model = makeModel();
      const { root } = buildForm(model, { availableModels: AVAILABLE });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM);
      navigateTo(root, 4);
      root.handleInput?.(KEY_CONFIRM); // open the picker
      for (const char of "claude") root.handleInput?.(char);
      const lines = root.render(80);
      assert.ok(
        lines.some((l) => l.includes("anthropic/claude-sonnet-4")),
        "matching spec stays listed",
      );
      assert.ok(!lines.some((l) => l.includes("openai-codex/gpt-5.5")), "non-matching spec filtered out");
    });

    it("picking a spec confirms, seeds its provider entry, and commits it", () => {
      const model = makeModel();
      const { root } = buildForm(model, { availableModels: AVAILABLE });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM); // open the pool editor
      navigateTo(root, 4); // ＋ Add model
      root.handleInput?.(KEY_CONFIRM); // open the picker (selection on first spec)
      root.handleInput?.(KEY_CONFIRM); // open the confirm for openai-codex/gpt-5.5
      assert.ok(
        root.render(80).some((l) => l.includes("Add provider openai-codex → model gpt-5.5?")),
        "confirm names the provider and the logical model",
      );
      root.handleInput?.(KEY_CONFIRM); // confirm → picker closes, pool root refreshes
      const lines = root.render(80);
      assert.ok(
        lines.some((l) => l.includes("openai-codex/gpt-5.5")),
        "pool root row keeps the provider-qualified spec label",
      );
      assert.ok(
        lines.some((l) => l.includes("1 provider(s)")),
        "picked spec seeds its provider entry (not 0 provider(s))",
      );
      navigateTo(root, 2); // Done (4 scalars + gpt-5.5 + Add + Done; selection restored on the new model row)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM);
      assert.deepEqual(model.draft.providerPool, { models: { "gpt-5.5": { "openai-codex": {} } } });
      assert.equal(model.dirtyCount, 1);
    });

    it("hides only specs whose (model, provider) pair is already present — a second provider stays pickable", () => {
      const model = makeModel({ providerPool: modelPool({ "gpt-5.5": { "openai-codex": {} } }) });
      const { root } = buildForm(model, { availableModels: MULTI_AVAILABLE });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM); // open the pool editor
      assert.ok(
        root.render(80).some((l) => l.includes("openai-codex/gpt-5.5")),
        "already-added model row shows its provider-qualified spec at the pool root",
      );
      navigateTo(root, 5); // ＋ Add model (4 scalars + gpt-5.5 row + Add)
      root.handleInput?.(KEY_CONFIRM); // open the picker
      const lines = root.render(80);
      assert.ok(
        !lines.some((l) => l.includes("openai-codex/gpt-5.5")),
        "already-present (model, provider) pair hidden from the picker",
      );
      assert.ok(
        lines.some((l) => l.includes("openrouter/gpt-5.5")),
        "a SECOND provider for the same logical id stays pickable (multi-provider)",
      );
      assert.ok(
        lines.some((l) => l.includes("anthropic/claude-sonnet-4")),
        "fresh logical id still listed",
      );
    });

    it("picks a second provider for an existing logical model and commits both entries", () => {
      const model = makeModel({ providerPool: modelPool({ "gpt-5.5": { "openai-codex": {} } }) });
      const { root } = buildForm(model, { availableModels: MULTI_AVAILABLE });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM); // open the pool editor
      navigateTo(root, 5); // ＋ Add model (4 scalars + gpt-5.5 + Add)
      root.handleInput?.(KEY_CONFIRM); // open the picker (selection on openrouter/gpt-5.5)
      root.handleInput?.(KEY_CONFIRM); // open the confirm
      root.handleInput?.(KEY_CONFIRM); // confirm → pool root refreshes
      assert.ok(
        root.render(80).some((l) => l.includes("2 provider(s)")),
        "the model row now routes two providers",
      );
      navigateTo(root, 1); // Done (4 scalars + gpt-5.5 + Add + Done; selection restored on Add at 5)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM);
      assert.deepEqual(model.draft.providerPool, {
        models: { "gpt-5.5": { "openai-codex": {}, openrouter: {} } },
      });
      assert.equal(model.dirtyCount, 1);
    });

    it("degrades to the custom path when the list is empty", () => {
      const model = makeModel();
      const { root } = buildForm(model, { availableModels: [] });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM);
      navigateTo(root, 4);
      root.handleInput?.(KEY_CONFIRM); // open the picker
      assert.ok(
        root.render(80).some((l) => l.includes("no models available in this session")),
        "empty list shows the inert hint row",
      );
      root.handleInput?.(KEY_DOWN); // hint row is inert → move to the custom row
      root.handleInput?.(KEY_CONFIRM); // open the free-text input
      for (const char of "custom-1") root.handleInput?.(char);
      root.handleInput?.(KEY_SUBMIT);
      assert.ok(
        root.render(80).some((l) => l.includes("custom-1")),
        "custom model row appears",
      );
      navigateTo(root, 2); // Done (4 scalars + custom-1 + Add + Done; selection preserved on Add)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM);
      assert.deepEqual(model.draft.providerPool, { models: { "custom-1": {} } });
      assert.equal(model.dirtyCount, 1);
    });
  });

  describe("add-provider picker (registry-backed availableModels)", () => {
    it("lists matching provider specs, filters, confirms one, and commits both entries", () => {
      const model = makeModel({ providerPool: modelPool({ "gpt-5.5": { "openai-codex": {} } }) });
      const { root } = buildForm(model, { availableModels: MULTI_AVAILABLE });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM); // open the pool editor
      navigateTo(root, 4); // model row gpt-5.5
      root.handleInput?.(KEY_CONFIRM); // open the model editor
      assert.ok(
        root.render(80).some((l) => l.includes("Model · gpt-5.5")),
        "per-model editor",
      );
      navigateTo(root, 1); // ＋ Add provider (openai-codex row at 0)
      root.handleInput?.(KEY_CONFIRM); // open the picker
      const initial = root.render(80);
      assert.ok(
        initial.some((l) => l.includes("openrouter/gpt-5.5")),
        "matching provider spec listed",
      );
      assert.ok(!initial.some((l) => l.includes("openai-codex/gpt-5.5")), "already-added provider hidden");
      assert.ok(
        !initial.some((l) => l.includes("anthropic/claude-sonnet-4")),
        "specs for other logical models excluded",
      );
      for (const char of "openrouter") root.handleInput?.(char);
      const filtered = root.render(80);
      assert.ok(
        filtered.some((l) => l.includes("openrouter/gpt-5.5")),
        "matching spec stays under the filter",
      );
      assert.ok(!filtered.some((l) => l.includes("✎ Type custom provider id")), "custom fallback row filtered out");
      root.handleInput?.(KEY_CONFIRM); // open the confirm
      assert.ok(
        root.render(80).some((l) => l.includes("Add provider openrouter?")),
        "confirm names the bare provider id",
      );
      root.handleInput?.(KEY_CONFIRM); // confirm → model editor refreshes
      assert.ok(
        root.render(80).some((l) => l.includes("openrouter")),
        "provider row appears under the model",
      );
      navigateTo(root, 3); // Done (openai-codex + openrouter + Add + Remove + Done; selection restored on openrouter at 1)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM); // back to the pool root
      assert.ok(
        root.render(80).some((l) => l.includes("2 provider(s)")),
        "model row count updated",
      );
      assert.ok(
        root.render(80).some((l) => l.includes("gpt-5.5")),
        "multi-provider model row labels the logical id (no single spec represents it)",
      );
      assert.ok(
        !root.render(80).some((l) => l.includes("openai-codex/gpt-5.5")),
        "the single-spec label is not shown for a 2-provider model",
      );
      navigateTo(root, 2); // Done (4 scalars + gpt-5.5 + Add + Done; selection restored on gpt-5.5 at 4)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM);
      assert.deepEqual(model.draft.providerPool, {
        models: { "gpt-5.5": { "openai-codex": {}, openrouter: {} } },
      });
      assert.equal(model.dirtyCount, 1);
    });

    it("degrades to the free-text fallback when no specs match the model", () => {
      const model = makeModel({ providerPool: modelPool({ m: {} }) });
      const { root } = buildForm(model, { availableModels: [] });
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM); // open the pool editor
      navigateTo(root, 4); // model row m
      root.handleInput?.(KEY_CONFIRM); // open the model editor
      root.handleInput?.(KEY_CONFIRM); // ＋ Add provider (first row, selection at 0)
      assert.ok(
        root.render(80).some((l) => l.includes("no providers available for this model")),
        "empty candidate list shows the inert hint row",
      );
      root.handleInput?.(KEY_DOWN); // hint row is inert → move to the custom row
      root.handleInput?.(KEY_CONFIRM); // open the free-text input
      for (const char of "p1") root.handleInput?.(char);
      root.handleInput?.(KEY_SUBMIT);
      assert.ok(
        root.render(80).some((l) => l.includes("p1")),
        "provider row appears under the model",
      );
      navigateTo(root, 3); // Done (p1 + Add + Remove + Done; selection restored on p1 at 0)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM); // back to the pool root
      assert.ok(
        root.render(80).some((l) => l.includes("1 provider(s)")),
        "model row count updated",
      );
      navigateTo(root, 2); // Done (4 scalars + m + Add + Done; selection restored on m at 4)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM);
      assert.deepEqual(model.draft.providerPool, { models: { m: { p1: {} } } });
      assert.equal(model.dirtyCount, 1);
    });

    it("degrades to the free-text input only when no registry list is supplied", () => {
      const model = makeModel({ providerPool: modelPool({ m: {} }) });
      const { root } = buildForm(model); // no availableModels
      navigateTo(root, POOL_ROW);
      root.handleInput?.(KEY_CONFIRM);
      navigateTo(root, 4); // model row m
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM); // ＋ Add provider → picker shows only the custom row
      assert.ok(
        !root.render(80).some((l) => l.includes("no providers available")),
        "no hint row when no registry list is wired",
      );
      root.handleInput?.(KEY_CONFIRM); // open the free-text input
      for (const char of "p1") root.handleInput?.(char);
      root.handleInput?.(KEY_SUBMIT);
      assert.ok(
        root.render(80).some((l) => l.includes("p1")),
        "provider row appears",
      );
      navigateTo(root, 3); // Done (p1 + Add + Remove + Done; selection restored on p1 at 0)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM);
      navigateTo(root, 2); // Done (4 scalars + m + Add + Done; selection restored on m at 4)
      root.handleInput?.(KEY_CONFIRM);
      root.handleInput?.(KEY_CONFIRM);
      assert.deepEqual(model.draft.providerPool, { models: { m: { p1: {} } } });
      assert.equal(model.dirtyCount, 1);
    });
  });

  it("edits a per-provider scalar through the nested editors", () => {
    const model = makeModel({ providerPool: modelPool({ m: { p1: {} } }) });
    const { root } = buildForm(model);
    navigateTo(root, POOL_ROW);
    root.handleInput?.(KEY_CONFIRM);
    navigateTo(root, 4); // model row m
    root.handleInput?.(KEY_CONFIRM);
    assert.ok(
      root.render(80).some((l) => l.includes("Model · m")),
      "per-model editor",
    );
    root.handleInput?.(KEY_CONFIRM); // open provider p1 (first row)
    assert.ok(
      root.render(80).some((l) => l.includes("m · p1")),
      "per-provider editor",
    );
    navigateTo(root, 3); // TPM cap (unset → empty prefill, typed input is not prefixed)
    root.handleInput?.(KEY_CONFIRM);
    for (const char of "100000") root.handleInput?.(char);
    root.handleInput?.(KEY_SUBMIT);
    assert.ok(
      root.render(80).some((l) => l.includes("TPM cap") && l.includes("100000")),
      "row shows 100000",
    );
    navigateTo(root, 3); // Done (5 scalars + Remove + Done; selection preserved on TPM)
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM); // back to the model editor
    navigateTo(root, 3); // Done (p1 + Add + Remove + Done; selection preserved on p1)
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM); // back to the pool editor
    navigateTo(root, 2); // Done (4 scalars + m + Add + Done; selection preserved on m)
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM);
    assert.deepEqual(model.draft.providerPool, { models: { m: { p1: { tpm: 100000 } } } });
    assert.equal(model.dirtyCount, 1);
  });

  it("removes a provider through the confirm row", () => {
    const model = makeModel({ providerPool: modelPool({ m: { p1: {}, p2: {} } }) });
    const { root } = buildForm(model);
    navigateTo(root, POOL_ROW);
    root.handleInput?.(KEY_CONFIRM);
    navigateTo(root, 4); // model m
    root.handleInput?.(KEY_CONFIRM);
    navigateTo(root, 1); // provider p2
    root.handleInput?.(KEY_CONFIRM);
    navigateTo(root, 5); // － Remove provider (5 scalars + Remove + Done)
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM); // confirm removal → back to model editor
    assert.ok(
      root.render(80).some((l) => l.includes("p1")),
      "p1 remains",
    );
    assert.ok(!root.render(80).some((l) => l.includes("p2")), "p2 row is gone");
    navigateTo(root, 2); // Done (p1 + Add + Remove + Done; selection preserved on Add)
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM);
    navigateTo(root, 2); // Done (4 scalars + m + Add + Done; selection preserved on m)
    root.handleInput?.(KEY_CONFIRM);
    root.handleInput?.(KEY_CONFIRM);
    assert.deepEqual(model.draft.providerPool, { models: { m: { p1: {} } } });
  });

  it("stays inside the editor when scalar input is invalid", () => {
    const model = makeModel();
    const { root } = buildForm(model);
    navigateTo(root, POOL_ROW);
    root.handleInput?.(KEY_CONFIRM);
    navigateTo(root, 2); // Saturation wait (ms)
    root.handleInput?.(KEY_CONFIRM);
    for (const char of "abc") root.handleInput?.(char);
    root.handleInput?.(KEY_SUBMIT);
    assert.equal(model.dirtyCount, 0, "invalid input must not stage");
    assert.ok(
      root.render(80).some((l) => l.includes("must be a finite number")),
      "inline error shown",
    );
    root.handleInput?.(KEY_CANCEL); // Esc closes the input, back to the pool editor
    assert.equal(model.dirtyCount, 0);
  });
});
