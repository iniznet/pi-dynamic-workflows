import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { lazyPeerImport, MissingPeerError, PEER_DEPENDENCIES } from "./peer-deps.js";

// Lazy pi-tui load (H4): this module is part of the runtime core (agent.ts
// imports createStructuredOutputTool), so its module scope must stay pi-tui-free
// — the render closures below only ever run inside a TUI host. The MissingPeerError
// is raised at render time; pi-tui is a hard dependency of pi-coding-agent in any
// working pi, so the holder is populated in practice.
let tuiText: typeof import("@earendil-works/pi-tui")["Text"] | undefined;
try {
  ({ Text: tuiText } = await lazyPeerImport<typeof import("@earendil-works/pi-tui")>("@earendil-works/pi-tui"));
} catch {
  // Deferred to the render closures.
}

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
}

export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
  schema: TSchemaDef;
  capture: StructuredOutputCapture<Static<TSchemaDef>>;
  name?: string;
}

/**
 * Create a terminating tool that captures validated params as the subagent result.
 *
 * Pi validates `params` against `schema` before execute() is called. Returning
 * `terminate: true` lets the subagent finish on this tool call without paying for
 * an extra assistant follow-up turn.
 */
export function createStructuredOutputTool<TSchemaDef extends TSchema>({
  schema,
  capture,
  name = "structured_output",
}: StructuredOutputToolOptions<TSchemaDef>): ReturnType<typeof defineTool<TSchemaDef, Static<TSchemaDef>>> {
  return defineTool({
    name,
    label: "Structured Output",
    description: "Return the final machine-readable result for this subagent task.",
    promptSnippet: "Return final machine-readable output",
    promptGuidelines: [
      `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
      `Do not write a prose final answer after calling ${name}.`,
    ],
    parameters: schema,
    async execute(_toolCallId, params) {
      // L16: a second call to the terminating output channel must never
      // silently overwrite the first captured value (the agent's result).
      // Reject it with a guiding error and keep the FIRST call's capture; no
      // terminate flag, so the agent can correct course within this turn.
      if (capture.called) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${name} was already called and the result was already captured — it is the single final answer channel for this task; do not call it again.`,
            },
          ],
          details: params,
        };
      }
      capture.value = params;
      capture.called = true;
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
    renderCall(_args, theme) {
      if (!tuiText) throw new MissingPeerError("@earendil-works/pi-tui", PEER_DEPENDENCIES["@earendil-works/pi-tui"]);
      return new tuiText(theme.fg("toolTitle", theme.bold(name)), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (!tuiText) throw new MissingPeerError("@earendil-works/pi-tui", PEER_DEPENDENCIES["@earendil-works/pi-tui"]);
      if (isPartial) return new tuiText(theme.fg("muted", "Structured output…"), 0, 0);
      const summary = JSON.stringify(result.details ?? {});
      return new tuiText(theme.fg("toolOutput", truncate(summary, 200)), 0, 0);
    },
  });
}

/** Keep the TUI summary bounded for large machine-readable payloads. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
