/**
 * Vendored chrome toolset for workflow subagents (design:
 * tasks/subagent-chrome-tools/DESIGN.md).
 *
 * Re-creates pi-chrome's `chrome_*` tools (v0.15.46) as in-process
 * ToolDefinitions handed to subagents via customTools. The names, parameter
 * schemas, descriptions, and bridge wire actions mirror pi-chrome's
 * chrome-profile-bridge extension exactly, so subagent tool calls behave like
 * host chrome_* calls — the difference is only WHERE the definition lives and
 * WHICH session key tags the automation target.
 *
 * Wire model: every execute is a thin POST to pi-chrome's localhost bridge
 * (see ChromeBridgeClient). Auth is the host's shared `/chrome authorize`
 * grant on globalThis — never minted here. Automation targets join the HOST
 * session's tab group (the sessionKey/groupTitle providers are wired to the
 * host session id at session_start), so N subagents share one automation
 * window instead of churning one tab group each.
 *
 * Provenance: adapted from pi-chrome v0.15.46 (MIT) —
 * https://github.com/tianrendong/pi-chrome — tool definitions, formatters, and
 * wire conversion are retained with only the pi-extension plumbing (register,
 * bridge server, /chrome command) replaced by a client-only bridge + shared
 * auth. Drift note: if pi-chrome bumps a tool's parameters/descriptions, this
 * file should be re-synced (see tasks/subagent-chrome-tools/handoff.md).
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChromeBridgeClient, requireChromeAuthorized } from "./chrome-bridge-client.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  // Required by the SDK's AgentToolResult<TDetails>.
  details: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 30_000;
const MAX_ELEMENTS = 80;

const snapshotModeValues = ["auto", "interactive", "forms", "pageMap", "text", "changes", "full"] as const;
const tabActionValues = ["list", "new", "activate", "close", "group", "ungroup", "version"] as const;
const imageFormatValues = ["png", "jpeg"] as const;
const waitForValues = ["selector", "expression"] as const;

function StringEnum<T extends readonly [string, ...string[]]>(values: T) {
  return Type.Union(
    values.map((value) => Type.Literal(value)) as [
      ReturnType<typeof Type.Literal>,
      ...ReturnType<typeof Type.Literal>[],
    ],
  );
}

function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function compactLine(value: unknown, max = 140): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function rectText(rect: any): string {
  if (!rect) return "?";
  return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function formatChromeSnapshot(snapshot: any): string {
  if (!snapshot || typeof snapshot !== "object") return safeJson(snapshot);
  if (snapshot.mode === "full") return truncateText(safeJson(snapshot));
  const lines: string[] = [];
  lines.push(`# Chrome snapshot${snapshot.mode ? ` (${snapshot.mode})` : ""}`);
  lines.push(`${snapshot.title || "(untitled)"}`);
  if (snapshot.url) lines.push(`${snapshot.url}`);
  if (snapshot.viewport)
    lines.push(
      `viewport=${snapshot.viewport.width}x${snapshot.viewport.height} scroll=${snapshot.viewport.scrollX || 0},${snapshot.viewport.scrollY || 0}`,
    );
  if (snapshot.summary?.modal)
    lines.push(`modal: ${snapshot.summary.modal.uid} ${compactLine(snapshot.summary.modal.label)}`);
  if (snapshot.summary?.focused)
    lines.push(
      `focused: ${snapshot.summary.focused.uid} ${snapshot.summary.focused.role || ""} ${compactLine(snapshot.summary.focused.label)}`,
    );
  if (Array.isArray(snapshot.summary?.hints) && snapshot.summary.hints.length) {
    lines.push("\n## Hints");
    for (const hint of snapshot.summary.hints.slice(0, 6)) lines.push(`- ${hint}`);
  }
  if (snapshot.diff && !snapshot.diff.firstSnapshot) {
    const changed = [
      ...(snapshot.diff.changes || []).map((c: any) =>
        c.kind === "textChanged"
          ? "text changed"
          : `${c.kind}: ${compactLine(c.before, 50)} → ${compactLine(c.after, 50)}`,
      ),
      ...(snapshot.diff.added || [])
        .slice(0, 4)
        .map((e: any) => `added ${e.uid} ${e.role || ""} ${compactLine(e.label)}`),
      ...(snapshot.diff.updated || [])
        .slice(0, 4)
        .map((u: any) => `updated ${u.uid} ${compactLine(u.after?.label || u.before?.label)}`),
    ];
    if (changed.length) {
      lines.push("\n## Changed since last snapshot");
      for (const item of changed.slice(0, 10)) lines.push(`- ${item}`);
    }
  }
  if (Array.isArray(snapshot.matches) && snapshot.matches.length) {
    lines.push(`\n## Matches for "${snapshot.query}"`);
    for (const match of snapshot.matches.slice(0, 12)) {
      if (match.kind === "text") lines.push(`- ${match.uid} text ${compactLine(match.text)} @ ${rectText(match.rect)}`);
      else if (match.kind === "region")
        lines.push(
          `- ${match.uid} region ${compactLine(match.label)} headings=${(match.headings || []).map((h: string) => compactLine(h, 50)).join(" | ")}`,
        );
      else
        lines.push(
          `- ${match.uid} ${match.role || match.tag || "element"}${match.disabled ? " disabled" : ""} ${compactLine(match.label || match.selector)} @ ${rectText(match.rect)}`,
        );
    }
  }
  if (snapshot.mode === "pageMap" && snapshot.pageMap) {
    lines.push("\n## Page map");
    for (const region of (snapshot.pageMap.regions || []).slice(0, 18)) {
      lines.push(`- ${region.uid} ${region.kind}: ${compactLine(region.label)}`);
      for (const action of (region.actions || []).slice(0, 5))
        lines.push(
          `  - ${action.uid} ${action.role || ""}${action.disabled ? " disabled" : ""} ${compactLine(action.label)}`,
        );
    }
    if (snapshot.pageMap.headings?.length) {
      lines.push("\nHeadings:");
      for (const h of snapshot.pageMap.headings.slice(0, 20))
        lines.push(`- ${h.uid} h${h.level || ""} ${compactLine(h.text)}`);
    }
  }
  if (Array.isArray(snapshot.layout) && snapshot.layout.length && snapshot.mode !== "changes") {
    lines.push("\n## Layout / context");
    for (const section of snapshot.layout.slice(0, snapshot.mode === "pageMap" ? 18 : 8)) {
      const bits = [
        `${section.uid}`,
        section.role || section.tag,
        compactLine(section.label || section.text || "(unnamed section)", 110),
        `@ ${rectText(section.rect)}`,
      ];
      lines.push(`- ${bits.filter(Boolean).join(" ")}`);
      const fieldLabels = (section.fields || [])
        .slice(0, 4)
        .map((f: any) => `${f.uid} ${compactLine(f.label || f.role, 40)}`);
      const actionLabels = (section.actions || [])
        .slice(0, 5)
        .map((a: any) => `${a.uid}${a.disabled ? " disabled" : ""} ${compactLine(a.label || a.role, 40)}`);
      if (fieldLabels.length) lines.push(`  fields: ${fieldLabels.join("; ")}`);
      if (actionLabels.length) lines.push(`  actions: ${actionLabels.join("; ")}`);
    }
  }
  if ((snapshot.mode === "forms" || snapshot.forms?.fields?.length) && snapshot.mode !== "pageMap") {
    const fields = snapshot.forms?.fields || [];
    const submits = snapshot.forms?.submits || [];
    if (fields.length || submits.length) lines.push("\n## Forms");
    for (const field of fields.slice(0, snapshot.mode === "forms" ? 40 : 12)) {
      const bits = [
        field.uid,
        field.role || field.tag,
        field.required ? "required" : "",
        field.invalid ? "invalid" : "",
        field.disabled ? "disabled" : "",
        compactLine(field.label || field.selector, 90),
      ];
      if (field.value) bits.push(`value=${compactLine(field.value, 50)}`);
      else if (field.valueRedacted) bits.push("value=[redacted]");
      lines.push(`- ${bits.filter(Boolean).join(" ")} @ ${rectText(field.rect)}`);
    }
    for (const submit of submits.slice(0, 8))
      lines.push(
        `- ${submit.uid} submit/action${submit.disabled ? " disabled" : ""} ${compactLine(submit.label || submit.selector)} @ ${rectText(submit.rect)}`,
      );
  }
  if (Array.isArray(snapshot.elements) && snapshot.mode !== "pageMap") {
    lines.push("\n## Visible actions");
    for (const el of snapshot.elements.slice(0, snapshot.mode === "interactive" ? 60 : 25)) {
      const flags = [el.disabled ? "disabled" : "", el.occluded ? `occluded-by-${el.occluded.tag}` : ""]
        .filter(Boolean)
        .join(",");
      const context = el.context?.label ? ` in ${el.context.uid} ${compactLine(el.context.label, 60)}` : "";
      lines.push(
        `- ${el.uid} ${el.role || el.tag}${flags ? ` [${flags}]` : ""} ${compactLine(el.label || el.selector)}${context} @ ${rectText(el.rect)}`,
      );
    }
    if (snapshot.elements.length > (snapshot.mode === "interactive" ? 60 : 25))
      lines.push(
        `- … ${snapshot.elements.length - (snapshot.mode === "interactive" ? 60 : 25)} more; retry with maxElements or mode=interactive`,
      );
  }
  if (
    (snapshot.mode === "text" || snapshot.mode === "auto") &&
    Array.isArray(snapshot.textSnippets) &&
    snapshot.textSnippets.length
  ) {
    lines.push("\n## Text snippets");
    for (const snip of snapshot.textSnippets.slice(0, snapshot.mode === "text" ? 40 : 14))
      lines.push(`- ${snip.uid} ${compactLine(snip.text, snapshot.mode === "text" ? 240 : 160)}`);
    if (snapshot.textTruncated) lines.push("- … page text truncated; retry with mode=text or maxTextChars for more");
  }
  lines.push(
    "\nTip: use chrome_snapshot({query:'...', mode:'interactive|forms|pageMap|text|changes|full'}) or nearUid to zoom in.",
  );
  return truncateText(lines.join("\n"));
}

function formatIncludedSnapshotText(raw: unknown, text: string): string {
  const snapshot = raw && typeof raw === "object" ? (raw as { snapshot?: unknown }).snapshot : undefined;
  return snapshot ? `${text}\n\n${formatChromeSnapshot(snapshot)}` : text;
}

function formatChromeInspect(inspect: any): string {
  if (!inspect || typeof inspect !== "object") return safeJson(inspect);
  const t = inspect.target || {};
  const lines: string[] = [];
  lines.push(`# Chrome inspect ${t.uid || ""}`.trim());
  lines.push(
    `${t.role || t.tag || "element"}${t.disabled ? " disabled" : ""}${t.occluded ? ` occluded-by-${t.occluded.tag}` : ""} ${compactLine(t.label || t.selector)}`,
  );
  if (t.selector) lines.push(`selector: ${t.selector}`);
  if (t.rect) lines.push(`rect: ${rectText(t.rect)}`);
  if (inspect.clickSuggestion)
    lines.push(
      `suggested click: chrome_click({ uid: "${inspect.clickSuggestion.uid}" }) or x=${inspect.clickSuggestion.x}, y=${inspect.clickSuggestion.y}`,
    );
  if (Array.isArray(inspect.nearbyText) && inspect.nearbyText.length) {
    lines.push("\n## Nearby text");
    for (const item of inspect.nearbyText.slice(0, 12)) lines.push(`- ${item.uid} ${compactLine(item.text, 180)}`);
  }
  if (inspect.formContext) {
    lines.push("\n## Form context");
    for (const field of (inspect.formContext.fields || []).slice(0, 20))
      lines.push(
        `- ${field.uid} ${field.role || field.tag}${field.disabled ? " disabled" : ""} ${compactLine(field.label || field.selector)}${field.value ? ` value=${compactLine(field.value, 60)}` : field.valueRedacted ? " value=[redacted]" : ""}`,
      );
    for (const action of (inspect.formContext.actions || []).slice(0, 10))
      lines.push(
        `- ${action.uid} action${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)}`,
      );
  }
  if (Array.isArray(inspect.nearbyActions) && inspect.nearbyActions.length) {
    lines.push("\n## Nearby actions");
    for (const action of inspect.nearbyActions.slice(0, 18))
      lines.push(
        `- ${action.uid} ${action.role || action.tag}${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)} @ ${rectText(action.rect)}`,
      );
  }
  if (Array.isArray(inspect.ancestors) && inspect.ancestors.length) {
    lines.push("\n## Ancestors");
    for (const a of inspect.ancestors.slice(0, 6))
      lines.push(`- ${a.uid} ${a.role || a.tag} ${compactLine(a.label || a.selector, 120)}`);
  }
  return truncateText(lines.join("\n"));
}

function summarizeActionResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  // pageMutated is a coarse heuristic (hash over body text + input values + node
  // count). A false value is NOT proof the action did nothing — surfaced only as a
  // soft hint, never as a failure on its own (retained from pi-chrome).
  if (r.pageMutated === false)
    parts.push("no coarse DOM change detected (may still have taken effect — verify with includeSnapshot)");
  if (r.defaultPrevented === true) parts.push("defaultPrevented=true");
  if (r.elementVisible === false) parts.push("element NOT visible");
  if (r.occludedBy) {
    const o = r.occludedBy as { tag?: string; id?: string };
    parts.push(`occluded by <${o.tag ?? "?"}${o.id ? `#${o.id}` : ""}>`);
  }
  if (r.valueMatches === false) parts.push("input value did not stick");
  if (r.autoplayHint) parts.push("autoplay-gated affordance");
  return parts.length ? parts.join("; ") : undefined;
}

function workspaceCwd(ctx: ExtensionContext): string {
  for (const candidate of [ctx.cwd, process.cwd()]) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return process.cwd();
}

/**
 * Options for {@link createVendoredChromeTools}.
 */
export interface VendoredChromeToolsOptions {
  /**
   * The HOST session key ("session:<hostId>") tagging every bridge action.
   * Wired to the host session id at session_start so all subagent chrome
   * automation joins the main session's tab group (never one group per
   * subagent). Resolved per send, so it adopts the real host session once
   * session_start fires.
   */
  sessionKey?: () => string | undefined;
  /** The session group title ("Pi Session: <name-or-id>") for tab.new/group. */
  sessionGroupTitle?: () => string | undefined;
  /** Injectable bridge client (test seam); defaults to the real localhost client. */
  client?: ChromeBridgeClient;
}

/**
 * Translate the public `background` parameter (default on = silent/background)
 * into the service worker's wire-level `foreground` flag — identical to
 * pi-chrome's withBackground.
 */
function withBackground<T extends Record<string, unknown>>(params: T): T {
  const typed = params as { background?: boolean; foreground?: boolean };
  const explicit =
    typed.background !== undefined ? typed.background : typed.foreground !== undefined ? !typed.foreground : undefined;
  const background = explicit ?? true;
  return { ...params, foreground: !background } as T;
}

/** Shared execute-time auth gate + bridge send with host-session tagging. */
function createBridge(options: VendoredChromeToolsOptions) {
  const client = options.client ?? new ChromeBridgeClient();
  return async (
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    // Auth is the HOST's shared grant; a subagent never mints its own (design §auth).
    requireChromeAuthorized();
    const sessionKey = options.sessionKey?.();
    let wireParams: Record<string, unknown> =
      sessionKey !== undefined && params.sessionKey === undefined ? { ...params, sessionKey } : { ...params };
    const sessionTitle = options.sessionGroupTitle?.();
    // Any tab opened/grouped must use THIS session's group (mirrors pi-chrome's
    // central guard in authorizedBridgeSend).
    if ((action === "tab.new" || action === "tab.group") && sessionTitle !== undefined) {
      wireParams = { ...wireParams, groupTitle: sessionTitle };
    }
    // page.* interactions join the session group; tab.* actions never group.
    const shouldJoinGroup =
      action.startsWith("page.") && sessionTitle !== undefined && params.sessionGroupTitle === undefined;
    if (shouldJoinGroup) {
      wireParams = { ...wireParams, sessionGroupTitle: sessionTitle, joinSessionGroup: true };
    }
    return client.send(action, wireParams, timeoutMs, signal);
  };
}

/**
 * The vendored `chrome_*` toolset for subagents. Mirrors pi-chrome v0.15.46's
 * tool contract (names, parameters, descriptions, bridge actions). The set is
 * built fresh per call so sessionKey/groupTitle providers stay live; the defs
 * themselves are stateless.
 */
export function createVendoredChromeTools(options: VendoredChromeToolsOptions = {}): ToolDefinition[] {
  const bridge = createBridge(options);
  return [
    defineTool({
      name: "chrome_launch",
      label: "Chrome Bridge Setup",
      description:
        "Start/check the local bridge used by the companion Chrome extension. This does not launch a separate Chrome profile; install the unpacked Chrome extension in your existing Chrome profile to connect.",
      promptSnippet:
        "Show instructions for connecting Pi to the user's existing Chrome profile via the companion extension.",
      parameters: Type.Object({
        port: Type.Optional(
          Type.Number({ description: "Ignored. The bundled Chrome extension polls 127.0.0.1:17318." }),
        ),
        url: Type.Optional(
          Type.String({
            description: "Optional URL to open in the existing Chrome profile after the extension is connected.",
          }),
        ),
        userDataDir: Type.Optional(
          Type.String({
            description:
              "Ignored. This bridge intentionally uses the user's existing Chrome profile through the companion extension.",
          }),
        ),
        useDefaultProfile: Type.Optional(
          Type.Boolean({ description: "Ignored; existing-profile access comes from the companion Chrome extension." }),
        ),
        headless: Type.Optional(Type.Boolean({ description: "Ignored." })),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        // No auth gate on the instruction path (mirrors pi-chrome: chrome_launch
        // is the onboarding tool); only an actual tab.new needs the grant.
        if (params.url) {
          const result = await bridge("tab.new", { url: params.url }, DEFAULT_TIMEOUT_MS, signal);
          return {
            content: [{ type: "text", text: `Chrome bridge connected; opened ${params.url}` }],
            details: { result: result as Json },
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                "Chrome profile bridge is managed by the host pi-chrome extension.\n\n" +
                "Subagent chrome_* tools talk to the same localhost bridge the host session uses. To make them work:\n" +
                "1. The host pi session must have pi-chrome installed and the companion Chrome extension loaded (run /chrome onboard there).\n" +
                "2. The host session must hold an active /chrome authorize grant — subagents reuse that grant.\n\n" +
                `Bridge URL: ${options.client?.url ?? "http://127.0.0.1:17318"}.`,
            },
          ],
          details: { bridgeUrl: options.client?.url ?? "http://127.0.0.1:17318" },
        };
      },
    }),
    defineTool({
      name: "chrome_tab",
      label: "Chrome Tab",
      description:
        "List, create, activate, close, group, ungroup, or inspect tabs in the user's existing Chrome profile via the companion extension. New/grouped tabs always use this session's Pi tab group. activate/close/group/ungroup require a target (targetId/urlIncludes/titleIncludes); with no target they act on this session's pi-chrome automation tab if one exists, and otherwise error rather than touching the user's active tab.",
      promptSnippet: "List/open/activate/close/group existing Chrome tabs through the companion extension.",
      parameters: Type.Object({
        action: StringEnum(tabActionValues),
        url: Type.Optional(Type.String({ description: "URL for action=new." })),
        targetId: Type.Optional(Type.String({ description: "Chrome tab id for activate/close/group/ungroup." })),
        urlIncludes: Type.Optional(
          Type.String({ description: "Match the target tab by URL substring for activate/close/group/ungroup." }),
        ),
        titleIncludes: Type.Optional(
          Type.String({ description: "Match the target tab by title substring for activate/close/group/ungroup." }),
        ),
        group: Type.Optional(
          Type.Boolean({
            description: "Deprecated; ignored. Pi-created tabs always join this session's own tab group.",
          }),
        ),
        groupTitle: Type.Optional(
          Type.String({
            description:
              "Deprecated for action=new/group; ignored so one Pi session uses one tab group ('Pi Session: <name-or-id>').",
          }),
        ),
        groupColor: Type.Optional(
          Type.String({
            description:
              "Tab group color for action=group/new: grey, blue, red, yellow, green, pink, purple, cyan, or orange. Defaults to blue.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const forwarded = { ...params } as typeof params & { groupTitle?: string };
        if (params.action === "new" || params.action === "group") {
          forwarded.groupTitle = options.sessionGroupTitle?.() ?? params.groupTitle;
        }
        const result = await bridge(`tab.${params.action}`, forwarded, DEFAULT_TIMEOUT_MS, signal);
        if (params.action === "list") {
          const tabs = result as Array<{
            id: number;
            title: string;
            url: string;
            active: boolean;
            windowId: number;
            group?: { title?: string } | null;
          }>;
          const text =
            tabs
              .map(
                (tab) =>
                  `${tab.id}\t${tab.active ? "*" : " "}\t${tab.group?.title ? `[${tab.group.title}] ` : ""}${tab.title || "(untitled)"}\t${tab.url}`,
              )
              .join("\n") || "No tabs.";
          return { content: [{ type: "text", text }], details: { tabs } };
        }
        return { content: [{ type: "text", text: safeJson(result) }], details: { result: result as Json } };
      },
    }),
    defineTool({
      name: "chrome_snapshot",
      label: "Chrome Snapshot",
      description:
        "Inspect a page in the user's existing Chrome profile. Default output is a concise, agent-friendly observation with structural layout/context, stable uids, visible actions, form fields, page hints, and changes since the previous snapshot. Use mode/query/nearUid to zoom instead of dumping the whole page. Runs in the background by default; pass background=false to bring Chrome to the foreground so the user can watch.",
      promptSnippet:
        "Observe the current Chrome page: concise summary, structural layout, visible actions, forms, page map, query matches, and stable uids.",
      parameters: Type.Object({
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
        mode: Type.Optional(StringEnum(snapshotModeValues)),
        query: Type.Optional(
          Type.String({
            description:
              "Find/rank elements, regions, and text matching this phrase, e.g. 'merge button', 'email error', 'approve PR'.",
          }),
        ),
        maxTextChars: Type.Optional(
          Type.Number({
            description:
              "Max body text chars included in the underlying snapshot. Defaults are smaller for concise modes.",
          }),
        ),
        containingText: Type.Optional(
          Type.String({
            description:
              "Only return elements whose label/text contains this string (case-insensitive). Useful when the page has many controls.",
          }),
        ),
        roleFilter: Type.Optional(
          Type.String({
            description:
              "Only return elements matching this ARIA role or tag name (case-insensitive). e.g. 'button', 'link', 'textbox'.",
          }),
        ),
        nearUid: Type.Optional(
          Type.String({
            description:
              "Sort elements by proximity to this snapshot uid. Useful for finding controls near a known anchor.",
          }),
        ),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const snapshot = await bridge(
          "page.snapshot",
          withBackground({ ...params, maxElements: params.maxElements ?? MAX_ELEMENTS }),
          DEFAULT_TIMEOUT_MS,
          signal,
        );
        return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
      },
    }),
    defineTool({
      name: "chrome_find",
      label: "Chrome Find",
      description:
        "Find elements, page regions, or text on the current Chrome page by query. Returns ranked matches with stable uids and coordinates. This is a focused wrapper around chrome_snapshot({ query }).",
      promptSnippet: "Find matching controls/text/regions in Chrome by natural-language query and return stable uids.",
      parameters: Type.Object({
        query: Type.String({
          description: "What to find, e.g. 'merge button', 'email error', 'approve PR', 'search box'.",
        }),
        mode: Type.Optional(StringEnum(snapshotModeValues)),
        maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const snapshot = await bridge(
          "page.snapshot",
          withBackground({ ...params, mode: params.mode || "auto", maxElements: params.maxElements ?? MAX_ELEMENTS }),
          DEFAULT_TIMEOUT_MS,
          signal,
        );
        return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
      },
    }),
    defineTool({
      name: "chrome_inspect",
      label: "Chrome Inspect Element",
      description:
        "Inspect one snapshot uid or selector deeply: nearby text, nearby actions, form context, ancestors, and suggested click target. Use after chrome_snapshot/chrome_find when you need context around one element.",
      promptSnippet: "Inspect a Chrome snapshot uid deeply for nearby text, form context, and suggested actions.",
      parameters: Type.Object({
        uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot/chrome_find." })),
        selector: Type.Optional(Type.String({ description: "CSS selector if uid is unavailable." })),
        scrollIntoView: Type.Optional(
          Type.Boolean({
            description:
              "If true, scroll the target into view before inspecting. Default false to avoid changing page state.",
          }),
        ),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        try {
          const inspect = await bridge("page.inspect", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
          return { content: [{ type: "text", text: formatChromeInspect(inspect) }], details: { inspect } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Unknown action: page\.inspect/i.test(message)) throw error;
          // Compatibility fallback for a companion extension that predates
          // page.inspect (retained from pi-chrome).
          const snapshot = await bridge(
            "page.snapshot",
            withBackground({
              ...params,
              mode: "interactive",
              maxElements: MAX_ELEMENTS,
              nearUid: params.uid,
              query: params.selector,
            }),
            DEFAULT_TIMEOUT_MS,
            signal,
          );
          const text = `chrome_inspect fallback: loaded Chrome extension does not yet support page.inspect; reload it at chrome://extensions for deep inspect.\n\n${formatChromeSnapshot(snapshot)}`;
          return { content: [{ type: "text", text }], details: { snapshot, fallback: "page.snapshot" } };
        }
      },
    }),
    defineTool({
      name: "chrome_navigate",
      label: "Chrome Navigate",
      description:
        "Navigate a Chrome tab to a URL via the companion extension. With no target, navigation goes to pi-chrome's own dedicated automation window/tab — it never replaces the user's active tab. Pass targetId/urlIncludes/titleIncludes only to act on a specific existing tab. Runs in the background by default; pass background=false to focus Chrome and activate the tab so the user can watch. Optionally waits for load completion.",
      promptSnippet: "Navigate a Chrome tab in the user's existing profile.",
      parameters: Type.Object({
        url: Type.String(),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        waitUntilLoad: Type.Optional(Type.Boolean({ default: true })),
        timeoutMs: Type.Optional(Type.Number({ default: 15_000 })),
        initScript: Type.Optional(
          Type.String({
            description:
              "Optional JavaScript source to run in MAIN world at document_start of the next navigation. Useful for seeding localStorage, stubbing Date.now(), or defining navigator.webdriver=undefined. Requires the companion extension's webNavigation permission.",
          }),
        ),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, navigate silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge(
          "page.navigate",
          withBackground(params),
          (params.timeoutMs ?? 15_000) + 2_000,
          signal,
        );
        return {
          content: [
            { type: "text", text: `Navigated to ${params.url}${params.initScript ? " (with initScript)" : ""}` },
          ],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_evaluate",
      label: "Chrome Evaluate",
      description:
        "Evaluate JavaScript in an existing Chrome tab through the companion extension. Runs in the page context and returns JSON-serializable values when possible. Runs in the background by default; pass background=false to focus Chrome and activate the tab.",
      promptSnippet: "Evaluate JavaScript in the active Chrome tab through the companion extension.",
      parameters: Type.Object({
        expression: Type.String(),
        awaitPromise: Type.Optional(Type.Boolean({ default: true })),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, evaluate silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const value = await bridge("page.evaluate", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        const text =
          value === undefined ? "undefined" : typeof value === "string" ? value : (safeJson(value) ?? "undefined");
        return { content: [{ type: "text", text: truncateText(text) }], details: { value: value as Json } };
      },
    }),
    defineTool({
      name: "chrome_click",
      label: "Chrome Click",
      description:
        "Click a snapshot uid, CSS selector, or viewport coordinate using Chrome's real input layer. Pass includeSnapshot=true to return a fresh snapshot after the click.",
      promptSnippet: "Click page elements in Chrome by snapshot uid, selector, or viewport coordinate.",
      parameters: Type.Object({
        uid: Type.Optional(
          Type.String({
            description: "Stable element uid from chrome_snapshot. Prefer uid over selector after taking a snapshot.",
          }),
        ),
        selector: Type.Optional(
          Type.String({ description: "CSS selector to click. Prefer uid from chrome_snapshot when available." }),
        ),
        x: Type.Optional(Type.Number({ description: "Viewport x coordinate if uid/selector is omitted." })),
        y: Type.Optional(Type.Number({ description: "Viewport y coordinate if uid/selector is omitted." })),
        domFallback: Type.Optional(
          Type.Boolean({
            description:
              "If true (default), fall back to DOM-dispatched click if Chrome's CDP input path is blocked by another extension overlay or debugger failure.",
          }),
        ),
        includeSnapshot: Type.Optional(
          Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the click." }),
        ),
        maxElements: Type.Optional(
          Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." }),
        ),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, click silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const raw = await bridge("page.click", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
        const summary = summarizeActionResult(result);
        const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
        const text = summary ? `Clicked ${target} — ${summary}` : `Clicked ${target}`;
        return {
          content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }],
          details: { result: raw as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_type",
      label: "Chrome Type",
      description:
        "Focus an optional snapshot uid or CSS selector, then type text using Chrome's real keyboard input. Pass includeSnapshot=true to return a fresh snapshot after typing.",
      promptSnippet: "Type text into Chrome, optionally focusing a snapshot uid or selector first.",
      parameters: Type.Object({
        text: Type.String(),
        uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
        selector: Type.Optional(Type.String({ description: "CSS selector to focus before typing." })),
        includeSnapshot: Type.Optional(
          Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after typing." }),
        ),
        maxElements: Type.Optional(
          Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." }),
        ),
        pressEnter: Type.Optional(Type.Boolean()),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, type silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const raw = await bridge("page.type", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
        const summary = summarizeActionResult(result);
        const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
        const base = `Typed ${params.text.length} character(s)${into}.`;
        const text = summary ? `${base} (${summary})` : base;
        return {
          content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }],
          details: { result: raw as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_fill",
      label: "Chrome Fill",
      description:
        "Set the full value of a text input, textarea, or contenteditable element using Chrome click/select/delete/type input. Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after filling.",
      promptSnippet: "Fill a Chrome form field by snapshot uid or selector, optionally returning a fresh snapshot.",
      parameters: Type.Object({
        text: Type.String(),
        uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
        selector: Type.Optional(Type.String({ description: "CSS selector to fill if uid is omitted." })),
        submit: Type.Optional(Type.Boolean({ description: "If true, press Enter after filling." })),
        domFallback: Type.Optional(
          Type.Boolean({
            description:
              "If true (default), fall back to DOM value-setting if Chrome's CDP input path is blocked by another extension overlay or debugger failure.",
          }),
        ),
        includeSnapshot: Type.Optional(
          Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after filling." }),
        ),
        maxElements: Type.Optional(
          Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." }),
        ),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, fill silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const raw = await bridge("page.fill", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
        const summary = summarizeActionResult(result);
        const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
        const base = `Filled ${params.text.length} character(s)${into}.`;
        const text = summary ? `${base} (${summary})` : base;
        return {
          content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }],
          details: { result: raw as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_key",
      label: "Chrome Key",
      description:
        "Send a keyboard key to an existing Chrome tab (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, or one character). Runs in the background by default; pass background=false to focus Chrome and activate the tab so the user can watch. Pass includeSnapshot=true to verify after the keypress.",
      promptSnippet: "Press keys in Chrome through the companion extension.",
      parameters: Type.Object({
        key: Type.String(),
        modifiers: Type.Optional(
          Type.Object(
            {
              shiftKey: Type.Optional(Type.Boolean()),
              ctrlKey: Type.Optional(Type.Boolean()),
              altKey: Type.Optional(Type.Boolean()),
              metaKey: Type.Optional(Type.Boolean()),
            },
            { description: "Modifier keys to hold while pressing the key (chord)." },
          ),
        ),
        includeSnapshot: Type.Optional(
          Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the keypress." }),
        ),
        maxElements: Type.Optional(
          Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." }),
        ),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, send the key silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const raw = await bridge("page.key", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
        const summary = summarizeActionResult(result);
        const base = `Pressed ${params.key}.`;
        const text = summary ? `${base} (${summary})` : base;
        return {
          content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }],
          details: { result: raw as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_wait_for",
      label: "Chrome Wait For",
      description: "Poll an existing Chrome tab until a selector exists or a JavaScript expression returns truthy.",
      promptSnippet: "Wait for page state in Chrome before further automation.",
      parameters: Type.Object({
        kind: StringEnum(waitForValues),
        value: Type.String({
          description: "CSS selector when kind=selector; JavaScript expression when kind=expression.",
        }),
        timeoutMs: Type.Optional(Type.Number({ default: 10_000 })),
        intervalMs: Type.Optional(Type.Number({ default: 250 })),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.waitFor", params, (params.timeoutMs ?? 10_000) + 2_000, signal);
        return {
          content: [{ type: "text", text: `Observed ${params.kind}: ${params.value}` }],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_list_console_messages",
      label: "Chrome Console Messages",
      description:
        "List console messages captured in the page by the companion extension. Capture starts after any chrome_snapshot, chrome_evaluate, chrome_list_console_messages, or chrome_list_network_requests call installs page instrumentation.",
      promptSnippet: "List captured console messages from the active Chrome page.",
      parameters: Type.Object({
        clear: Type.Optional(Type.Boolean({ description: "Clear the captured console log after reading." })),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.console.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        return {
          content: [{ type: "text", text: truncateText(safeJson(result)) }],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_list_network_requests",
      label: "Chrome Network Requests",
      description:
        "List fetch/XMLHttpRequest activity captured in the page by the companion extension. Capture starts after instrumentation is installed by snapshot/evaluate/network/console tools; browser document/static asset requests are not captured. Use includePreservedRequests=true to keep requests from earlier same-tab navigations that were captured before navigation.",
      promptSnippet: "List captured XHR/fetch requests from the active Chrome page before doing DOM-heavy debugging.",
      parameters: Type.Object({
        includePreservedRequests: Type.Optional(
          Type.Boolean({ description: "Include captured requests from earlier locations in the same tab/session." }),
        ),
        clear: Type.Optional(Type.Boolean({ description: "Clear the captured request log after reading." })),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.network.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        return {
          content: [{ type: "text", text: truncateText(safeJson(result)) }],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_get_network_request",
      label: "Chrome Network Request",
      description:
        "Retrieve one captured fetch/XMLHttpRequest entry, including response body when available, by requestId from chrome_list_network_requests.",
      promptSnippet: "Fetch captured request details and response body by requestId.",
      parameters: Type.Object({
        requestId: Type.String({ description: "Request id returned by chrome_list_network_requests." }),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.network.get", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        return {
          content: [{ type: "text", text: truncateText(safeJson(result)) }],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_screenshot",
      label: "Chrome Screenshot",
      description:
        "Capture a screenshot of an existing Chrome tab via the companion extension and save it to disk. Chrome's extension screenshot API requires the target tab to be the active tab in its window. Runs in the background by default (the tab is briefly activated within its window for the capture, then the previous active tab is restored); pass background=false to focus Chrome so the user can watch.",
      promptSnippet: "Capture Chrome screenshots and save them under .pi/chrome-screenshots by default.",
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({ description: "Output path. Defaults to .pi/chrome-screenshots/<timestamp>.<format>." }),
        ),
        format: Type.Optional(StringEnum(imageFormatValues)),
        quality: Type.Optional(Type.Number({ description: "JPEG quality 0-100." })),
        fullPage: Type.Optional(
          Type.Boolean({
            description: "Not supported by the extension bridge yet; viewport screenshots are captured.",
          }),
        ),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(
          Type.Boolean({
            description:
              "If true (the default), capture silently without focusing the Chrome window (the target tab is briefly activated within its window for the capture, then restored); pass false to focus Chrome.",
          }),
        ),
        host: Type.Optional(Type.String()),
        port: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
        const format = params.format ?? "png";
        const cwd = workspaceCwd(ctx);
        const defaultPath = join(
          cwd,
          ".pi",
          "chrome-screenshots",
          `${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`,
        );
        const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
        const result = (await bridge(
          "page.screenshot",
          withBackground(params),
          params.fullPage ? 120_000 : DEFAULT_TIMEOUT_MS,
          signal,
        )) as {
          dataUrl?: string;
          tab?: unknown;
          fullPage?: boolean;
          dimensions?: { width: number; height: number; viewportHeight: number; dpr: number };
          tiles?: Array<{ y: number; dataUrl: string }>;
        };
        await mkdir(dirname(outputPath), { recursive: true });
        if (result.fullPage && result.tiles && result.dimensions) {
          // Stitch via tile files + a manifest (no image library — mirrors pi-chrome).
          const { width, height, viewportHeight, dpr } = result.dimensions;
          const manifest: Array<{ path: string; y: number }> = [];
          for (let i = 0; i < result.tiles.length; i++) {
            const tile = result.tiles[i];
            const tilePath = outputPath.replace(/(\.[^.]+)$/, `-tile${i}$1`);
            const base64 = tile.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
            await writeFile(tilePath, Buffer.from(base64, "base64"));
            manifest.push({ path: tilePath, y: tile.y });
          }
          await writeFile(
            `${outputPath}.json`,
            JSON.stringify({ width, height, viewportHeight, dpr, tiles: manifest }, null, 2),
          );
          return {
            content: [
              {
                type: "text",
                text: `Saved ${result.tiles.length} full-page tile(s) for ${width}×${height}px page. Manifest: ${outputPath}.json`,
              },
            ],
            details: {
              manifest: `${outputPath}.json`,
              tiles: manifest,
              dimensions: result.dimensions,
              tab: result.tab,
            } as unknown as Record<string, unknown>,
          };
        }
        if (!result.dataUrl) throw new Error("Screenshot returned no dataUrl");
        const base64 = result.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
        await writeFile(outputPath, Buffer.from(base64, "base64"));
        return {
          content: [{ type: "text", text: `Saved Chrome screenshot to ${outputPath}` }],
          details: { path: outputPath, format, tab: result.tab },
        };
      },
    }),
    defineTool({
      name: "chrome_hover",
      label: "Chrome Hover",
      description: "Hover over an element by uid, selector, or x/y using Chrome pointer movement.",
      promptSnippet: "Hover a Chrome element to trigger :hover / mouseover handlers.",
      parameters: Type.Object({
        uid: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.hover", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        return {
          content: [{ type: "text", text: `Hovered ${params.uid ?? params.selector ?? `${params.x},${params.y}`}` }],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_drag",
      label: "Chrome Drag",
      description: "Drag from one uid/selector/point to another using Chrome pointer input.",
      promptSnippet: "Drag a Chrome element from one point to another.",
      parameters: Type.Object({
        fromUid: Type.Optional(Type.String()),
        fromSelector: Type.Optional(Type.String()),
        fromX: Type.Optional(Type.Number()),
        fromY: Type.Optional(Type.Number()),
        toUid: Type.Optional(Type.String()),
        toSelector: Type.Optional(Type.String()),
        toX: Type.Optional(Type.Number()),
        toY: Type.Optional(Type.Number()),
        steps: Type.Optional(Type.Number({ default: 12 })),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.drag", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        return {
          content: [
            {
              type: "text",
              text: `Dragged from ${params.fromUid ?? params.fromSelector} to ${params.toUid ?? params.toSelector}`,
            },
          ],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_tap",
      label: "Chrome Tap (Touch)",
      description:
        "Dispatch a real touchstart/touchend tap through Chrome's input layer. Use for sites that gate on TouchEvent rather than MouseEvent (mobile-first PWAs, swipe carousels). Chrome may show its debugging banner while attached.",
      promptSnippet: "Tap (real touch) a Chrome element by snapshot uid, selector, or coordinate.",
      parameters: Type.Object({
        uid: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.tap", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
        return { content: [{ type: "text", text: `Tapped ${target} (touch)` }], details: { result: result as Json } };
      },
    }),
    defineTool({
      name: "chrome_scroll",
      label: "Chrome Scroll",
      description:
        "Scroll the page or a specific scrollable element by dispatching real wheel events with momentum-shaped deltas, then applying the scroll. Positive deltaY scrolls down. Pass uid/selector to scroll within a container, otherwise the document scrolls.",
      promptSnippet: "Scroll a Chrome page or container via wheel events (not raw scrollTop).",
      parameters: Type.Object({
        uid: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        deltaY: Type.Optional(Type.Number({ description: "Pixels to scroll vertically. Positive = down." })),
        deltaX: Type.Optional(Type.Number({ description: "Pixels to scroll horizontally. Positive = right." })),
        steps: Type.Optional(
          Type.Number({ description: "Number of wheel events to dispatch. Defaults to ceil(|deltaY|/100)." }),
        ),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal): Promise<ToolTextResult> {
        const result = await bridge("page.scroll", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
        return {
          content: [{ type: "text", text: `Scrolled dy=${params.deltaY ?? 0} dx=${params.deltaX ?? 0}` }],
          details: { result: result as Json },
        };
      },
    }),
    defineTool({
      name: "chrome_upload_file",
      label: "Chrome Upload File",
      description:
        "Attach local files to an <input type=file> element using Chrome DevTools file-input control. Does NOT open the native file picker; works with React/Vue/Angular controlled inputs.",
      promptSnippet: "Attach local files to a Chrome <input type=file> without opening the native file picker.",
      parameters: Type.Object({
        uid: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        paths: Type.Array(Type.String(), { description: "Local absolute file paths to upload." }),
        targetId: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        titleIncludes: Type.Optional(Type.String()),
        background: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
        const cwd = workspaceCwd(ctx);
        const paths = params.paths.map((p) => resolve(cwd, p));
        const result = await bridge("page.upload", withBackground({ ...params, paths }), DEFAULT_TIMEOUT_MS, signal);
        return {
          content: [{ type: "text", text: `Uploaded ${paths.length} file(s) to ${params.uid ?? params.selector}` }],
          details: { result: result as Json },
        };
      },
    }),
  ];
}
