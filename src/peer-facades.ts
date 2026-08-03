/**
 * Headless-safe facade over the modules that still import
 * `@earendil-works/pi-tui` at module scope (task-panel, workflow-ui,
 * workflows-models-command, workflow-commands via workflow-ui, and
 * workflows-settings-command via workflow-settings-ui).
 *
 * WHY this indirection exists: ESM has no lazy named re-export, so the flat
 * barrel (src/index.ts) would statically evaluate those modules — and their
 * module-scope pi-tui import — the moment the barrel is imported. Loading them
 * here with a guarded top-level await keeps the entrypoint's own module body
 * pi-tui-free: when pi-tui is absent or incompatible, the TUI surface degrades
 * to `undefined` (the extension null-guards and notifies) instead of failing
 * the whole extension load, while the headless-safe pieces (workflow tool,
 * manager, storage, scheduler) keep working. When pi-tui is present — it is a
 * hard dependency of pi-coding-agent — the exports populate normally.
 */

/** Try a lazy module load; swallow failures so the facade stays importable. */
async function tryLoad<T>(loader: () => Promise<T>): Promise<T | undefined> {
  try {
    return await loader();
  } catch {
    return undefined;
  }
}

type TaskPanelModule = typeof import("./task-panel.js");
type WorkflowUiModule = typeof import("./workflow-ui.js");
type ModelsCommandModule = typeof import("./workflows-models-command.js");
type WorkflowCommandsModule = typeof import("./workflow-commands.js");
type SettingsCommandModule = typeof import("./workflows-settings-command.js");

const taskPanel = await tryLoad<TaskPanelModule>(() => import("./task-panel.js"));
const workflowUi = await tryLoad<WorkflowUiModule>(() => import("./workflow-ui.js"));
const modelsCommand = await tryLoad<ModelsCommandModule>(() => import("./workflows-models-command.js"));
const workflowCommands = await tryLoad<WorkflowCommandsModule>(() => import("./workflow-commands.js"));
const settingsCommand = await tryLoad<SettingsCommandModule>(() => import("./workflows-settings-command.js"));

export const deliverText = taskPanel?.deliverText;
export const installResultDelivery = taskPanel?.installResultDelivery;
export const installTaskPanel = taskPanel?.installTaskPanel;

export const keyToAction = workflowUi?.keyToAction;
export const NavigatorModel = workflowUi?.NavigatorModel;
export const NavigatorState = workflowUi?.NavigatorState;
export const openWorkflowNavigator = workflowUi?.openWorkflowNavigator;
export const renderNavigator = workflowUi?.renderNavigator;

export const registerWorkflowModelsCommand = modelsCommand?.registerWorkflowModelsCommand;

export const registerWorkflowCommands = workflowCommands?.registerWorkflowCommands;

export const registerWorkflowSettingsCommand = settingsCommand?.registerWorkflowSettingsCommand;
