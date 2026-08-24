/**
 * T-02 search-first read guidance for subagent tool defs.
 *
 * Issue-9 lesson #2 (read bloat): the biggest lever is whole-file reads —
 * fabric hid the read tool's bounded-read guidance and its subagents went to
 * 78.5% whole-file reads. The stock SDK read description already carries the
 * bounded-read contract ("Use offset/limit for large files...") and survives
 * toolset assembly verbatim; the genuinely missing piece is the SEARCH-FIRST
 * nudge, so this module appends it to the read def description at every
 * subagent-facing toolset choke point.
 *
 * Idempotent by construction: appending is skipped when the hint is already
 * present, so a def that flows through two choke points (assembler -> agent
 * baseTools) never gains a doubled sentence.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** The search-first hint appended to the subagent read tool description (T-02). */
export const SUBAGENT_READ_SEARCH_FIRST_HINT =
  "Search first with grep/find before reading; prefer targeted offset/limit ranges over whole-file reads.";

/** Append the search-first hint to a `read` def's description (idempotent). */
export function withSubagentReadGuidance(defs: readonly ToolDefinition[]): ToolDefinition[] {
  return defs.map((def) => {
    if (def.name !== "read" || def.description.includes(SUBAGENT_READ_SEARCH_FIRST_HINT)) return def;
    return { ...def, description: `${def.description} ${SUBAGENT_READ_SEARCH_FIRST_HINT}` };
  });
}
