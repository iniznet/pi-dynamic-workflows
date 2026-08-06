/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */

import { createCodingTools, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { backgroundStartedNotify } from "./workflow-notify.js";
import type { SavedWorkflow, WorkflowParameterSpec, WorkflowParameters, WorkflowStorage } from "./workflow-saved.js";

/** Argument tokens that ask for help instead of running the workflow. */
const HELP_TOKENS = new Set(["--help", "-h", "help"]);

function isRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result as { report?: unknown } | undefined;
  if (r && typeof r.report === "string" && r.report.trim()) return r.report;
  return JSON.stringify(result.result, null, 2);
}

/** Coerce one raw value to a parameter's declared type; throws on mismatch. */
function coerceParameterValue(key: string, value: unknown, spec: WorkflowParameterSpec): unknown {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        throw new Error(`args.${key} must be a string, got ${typeof value}`);
      }
      return value;
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) {
        throw new Error(`args.${key} must be a number, got ${JSON.stringify(value)}`);
      }
      return n;
    }
    case "integer": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error(`args.${key} must be an integer, got ${JSON.stringify(value)}`);
      }
      return n;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const token = String(value).trim().toLowerCase();
      if (token === "true" || token === "1") return true;
      if (token === "false" || token === "0") return false;
      throw new Error(`args.${key} must be a boolean, got ${JSON.stringify(value)}`);
    }
    default:
      // "array" (or any undeclared type) has no CLI representation; pass through.
      return value;
  }
}

/**
 * Validate + coerce an args object against a declared parameter schema.
 * Missing required params (with no default) throw; provided values are coerced
 * to their declared type (a failed coercion throws a descriptive error);
 * defaults fill missing optional params. Undeclared keys pass through.
 */
export function coerceArgs(args: unknown, parameters?: WorkflowParameters): Record<string, unknown> {
  const out: Record<string, unknown> =
    args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined) {
      if (spec.required && spec.default === undefined) {
        throw new Error(`Missing required argument: ${key}`);
      }
      if (spec.default !== undefined) out[key] = spec.default;
    } else if (spec.type) {
      out[key] = coerceParameterValue(key, out[key], spec);
    }
  }
  return out;
}

/**
 * Parse a command argument string into an `args` object for the script.
 * Supports `key=value` tokens; everything else collects into `_` (and `_raw`).
 * Positional tokens are bound to DECLARED parameters in declaration order
 * (skipping parameters already satisfied by `key=value` tokens) BEFORE
 * defaults are applied — a declared key passed positionally keeps the user's
 * value instead of being silently discarded into `_` and replaced by its
 * default (M11). Remaining positional tokens stay in `_`; still-missing
 * declared keys are then filled by their defaults and coerced via coerceArgs
 * (which also throws for missing required params and failed coercions).
 */
export function parseCommandArgs(raw: string, parameters?: WorkflowParameters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else positional.push(tok);
  }

  // Bind positionals to still-missing declared params, in declaration order.
  let positionalIndex = 0;
  for (const key of Object.keys(parameters ?? {})) {
    if (out[key] !== undefined || positionalIndex >= positional.length) continue;
    out[key] = positional[positionalIndex];
    positionalIndex++;
  }

  out._ = positional.slice(positionalIndex).join(" ");
  out._raw = raw.trim();
  return coerceArgs(out, parameters);
}

/** Infer a parameter spec's type from a runtime value (for /workflows save). */
function inferParameterType(value: unknown): string {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "string";
}

/**
 * Derive a declared parameter schema from a run's args object, so a saved
 * workflow replays the same invocation by default. `_`/`_raw` are parse
 * artifacts, not real arguments. Returns undefined when there is nothing to
 * declare.
 */
export function parametersFromArgs(args: unknown): WorkflowParameters | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const entries = Object.entries(record).filter(([key]) => key !== "_" && key !== "_raw");
  if (!entries.length) return undefined;
  const parameters: WorkflowParameters = {};
  for (const [key, value] of entries) {
    parameters[key] = {
      type: inferParameterType(value),
      default: value,
      description: `Saved from the originating run's args.${key}.`,
    };
  }
  return parameters;
}

/** Render the declared argument schema as a `--help` text block. */
export function formatParameterHelp(name: string, description: string, parameters?: WorkflowParameters): string {
  const lines = [`/${name} — ${description}`];
  const specs = Object.entries(parameters ?? {});
  if (!specs.length) {
    lines.push("No arguments.");
    return lines.join("\n");
  }
  lines.push("Arguments:");
  for (const [key, spec] of specs) {
    const required = spec.required ? "required" : "optional";
    const defaultValue = spec.default !== undefined ? `, default: ${JSON.stringify(spec.default)}` : "";
    const detail = spec.description ? ` — ${spec.description}` : "";
    lines.push(`  ${key} (${spec.type}, ${required}${defaultValue})${detail}`);
  }
  return lines.join("\n");
}

/**
 * Argument completions for a saved-workflow command: one `key=` suggestion per
 * DECLARED parameter key not already satisfied in the typed argument text, so
 * the popup doubles as an argument hint (pi 0.83.0 has no argumentHint field
 * on RegisteredCommand — per-item `description` is the only hint channel).
 *
 * The host's pi-tui applyCompletion swaps the WHOLE argument span it handed us
 * (the `prefix` in { items, prefix }) for item.value — so each value must
 * reproduce the already-typed completed tokens verbatim. For a workflow with
 * `scope` + `depth`, typing `scope=src d` yields value `scope=src depth=`;
 * a bare `depth=` would clobber the committed `scope=src `. The label stays
 * the short `key=` form; the description carries type/required/default.
 */
export function savedWorkflowArgumentCompletions(
  argumentText: string,
  parameters?: WorkflowParameters,
): Array<{ value: string; label: string; description: string }> {
  const specs = parameters ?? {};
  const keys = Object.keys(specs);
  if (keys.length === 0) return [];

  // Tokenize exactly like parseCommandArgs: whitespace-separated tokens; a
  // `key=value` token carries a key, anything else is positional free text.
  const tokens = argumentText.split(/\s+/).filter(Boolean);
  const endsWithSpace = argumentText.length === 0 || /\s$/.test(argumentText);
  const currentToken = endsWithSpace ? "" : (tokens.at(-1) ?? "");
  // Everything before the token being typed is committed text the replacement
  // value must preserve (see the applyCompletion note above).
  const completedText = endsWithSpace ? argumentText : argumentText.slice(0, argumentText.length - currentToken.length);

  // A key= token in a completed position satisfies its parameter; the key is
  // not suggested again even while a value after it is still being typed.
  const satisfied = new Set<string>();
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0) satisfied.add(tok.slice(0, eq));
  }

  return keys
    .filter((key) => !satisfied.has(key))
    .filter((key) => `${key}=`.startsWith(currentToken))
    .map((key) => {
      const spec = specs[key];
      const required = spec.required ? "required" : "optional";
      const defaultPart = spec.default !== undefined ? `, default ${JSON.stringify(spec.default)}` : "";
      const detail = spec.description ? ` — ${spec.description}` : "";
      return {
        value: `${completedText}${key}=`,
        label: `${key}=`,
        description: `${spec.type ?? "string"}, ${required}${defaultPart}${detail}`,
      };
    });
}

/** Register one saved workflow as a `/<name>` command (idempotent).
 * When a WorkflowManager is provided, the workflow runs through it (visible in
 * /workflows TUI, background execution, task panel). Otherwise falls back to
 * the inline runWorkflow() (foreground, no TUI tracking).
 *
 * Pi has no `unregisterCommand`, so a command cannot be removed mid-session
 * after its workflow is deleted (it is correctly gone on next launch, since
 * registerAllSavedWorkflows only registers what's in storage). The optional
 * `exists` predicate lets the handler detect that case at invocation time and
 * tell the user to reload rather than silently re-running a deleted workflow. */
export function registerSavedWorkflow(
  pi: ExtensionAPI,
  cwd: string,
  wf: SavedWorkflow,
  manager?: WorkflowManager,
  exists?: () => boolean,
): void {
  if (isRegistered(pi, wf.name)) return;
  pi.registerCommand(wf.name, {
    description: wf.description || `Saved workflow: ${wf.name}`,
    getArgumentCompletions: (argumentText: string) => savedWorkflowArgumentCompletions(argumentText, wf.parameters),
    async handler(args: string, ctx: ExtensionCommandContext) {
      if (exists && !exists()) {
        ctx.ui.notify(`/${wf.name} was deleted — reload the session to remove this command.`, "warning");
        return;
      }
      // `--help` (or `help`/`-h`) lists the declared argument schema instead of
      // launching a run — args stay parseable even for parameterized workflows.
      if (HELP_TOKENS.has(args.trim().toLowerCase())) {
        ctx.ui.notify(formatParameterHelp(wf.name, wf.description, wf.parameters), "info");
        return;
      }
      try {
        if (manager) {
          // Run through the WorkflowManager's background path: the handler
          // returns immediately (awaiting the promise here would block the whole
          // session, #104), progress shows in the /workflows TUI and task panel,
          // and installResultDelivery posts the result back into the
          // conversation on completion — sending it here too would duplicate it.
          const { runId } = manager.startInBackground(wf.script, parseCommandArgs(args, wf.parameters));
          ctx.ui.notify(backgroundStartedNotify(wf.name, runId), "info");
          return;
        }
        // Fallback: inline runWorkflow (foreground, no TUI tracking, blocks).
        ctx.ui.notify(`Starting /${wf.name}…`, "info");
        const result = await runWorkflow(wf.script, {
          cwd,
          args: parseCommandArgs(args, wf.parameters),
          tools: createCodingTools(cwd),
          onPhase: (title) => ctx.ui.setStatus(`wf:${wf.name}`, `${wf.name}: ${title}`),
        });
        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        await pi.sendMessage({ customType: `workflow:${wf.name}`, content: reportText(result), display: true });
      } catch (error) {
        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        ctx.ui.notify(`/${wf.name} failed: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
}

/** Register every saved workflow found in storage.
 * When a WorkflowManager is provided, workflows run through it (visible in
 * /workflows TUI, background execution, task panel). */
export function registerAllSavedWorkflows(
  pi: ExtensionAPI,
  cwd: string,
  storage: WorkflowStorage,
  manager?: WorkflowManager,
): void {
  for (const wf of storage.list()) {
    registerSavedWorkflow(pi, cwd, wf, manager, () => storage.list().some((w) => w.name === wf.name));
  }
}
