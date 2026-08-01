/**
 * Wayfinder Decision Mapping Module (Phase 0).
 *
 * Realigned to the Matt Pocock wayfinder spec:
 * - Fog-or-ticket gate driven by STATABLE QUESTIONS, not a 0-100 clarity score.
 * - The map persists as a MARKDOWN index (map.md) with a JSON sidecar (map.json)
 *   for machine reload.
 * - Full ticket lifecycle: claims (what must be true), blocking (parent/child),
 *   frontier-model mapping, one ticket per session, and parallel research
 *   dispatch through the workflow runtime's agent()/parallel() primitives.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export enum TicketType {
  /** AFK documentation lookup. */
  RESEARCH = "research",
  /** Human-in-the-loop UI/stub build. */
  PROTOTYPE = "prototype",
  /** Human-in-the-loop interviews that dissolve fog. */
  GRILLING = "grilling",
  /** Concrete prerequisite or implementation work. */
  TASK = "task",
}

export type TicketStatus = "open" | "in-progress" | "resolved" | "blocked";

export type ClaimSource = "grilling" | "research" | "assumption";

/** A concrete statement that must be true for a ticket's resolution to hold. */
export interface TicketClaim {
  statement: string;
  source: ClaimSource;
}

/** A concrete question whose answer dissolves one piece of the fog. */
export interface StatableQuestion {
  id: string;
  question: string;
  /** Which ticket type should pursue the answer. */
  ticketType: TicketType.RESEARCH | TicketType.GRILLING;
  /** Why this question matters — the fog it clears. */
  context: string;
}

/** Result of the statable-question gate: foggy iff questions are needed. */
export interface FogAssessment {
  isFoggy: boolean;
  questions: StatableQuestion[];
}

export interface DecisionTicket {
  id: string;
  type: TicketType;
  title: string;
  description: string;
  status: TicketStatus;
  /** The statable question driving this ticket (grilling/research). */
  question?: string;
  /** What must be true for this ticket to be correctly resolved. */
  claims: TicketClaim[];
  /** Child ticket ids gated by this ticket's resolution. */
  blocks: string[];
  /** Parent ticket ids that gate this ticket. */
  blockedBy: string[];
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionMap {
  tickets: DecisionTicket[];
  rootQuestion: string;
  /** Id of the single ticket reserved for the current session (1/session). */
  activeTicket?: string;
  /** Next actionable ticket id (active session ticket, else first open). */
  nextTicket?: string;
  updatedAt: string;
}

/** Ticket shape produced by a frontier-model mapper; ids may be minted by the mapper. */
export interface FrontierMappedTicket {
  id?: string;
  type: TicketType;
  title: string;
  description: string;
  question?: string;
  claims?: Array<TicketClaim | string>;
  blocks?: string[];
  blockedBy?: string[];
}

/** Full map content produced by a frontier-model mapper. */
export interface FrontierMapping {
  rootQuestion: string;
  tickets: FrontierMappedTicket[];
}

/**
 * The frontier-model seam: production wiring points the frontier model tier at
 * this callback to map fog -> tickets. The default is a deterministic stub that
 * derives statable questions from the prompt text (no model call).
 */
export type FrontierMapper = (prompt: string) => FrontierMapping | Promise<FrontierMapping>;

/**
 * Structural subset of the workflow runtime's agent()/parallel() primitives
 * (workflow.ts:730 / workflow.ts:1136) — a workflow that owns the live runtime
 * can pass its real functions straight in; otherwise the seam stays a stub.
 */
export interface WayfinderRuntime {
  agent: (prompt: string, options?: { label?: string; tier?: string; model?: string }) => Promise<unknown>;
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
}

export type ResearchDispatch =
  | { dispatched: true; ticketId: string; findings: unknown[] }
  | { dispatched: false; ticketId: string; reason: "no-runtime" };

export interface CreateDecisionMapOptions {
  /** Frontier-model mapper; defaults to the deterministic statable-question stub. */
  mapper?: FrontierMapper;
}

const MAP_FILE_NAME = "map.md";
const SIDECAR_FILE_NAME = "map.json";

const STATUS_BADGES: Record<TicketStatus, string> = {
  open: "⏳ open",
  "in-progress": "🔨 in-progress",
  resolved: "✅ resolved",
  blocked: "🔒 blocked",
};

/** Hedge language that cannot be stated as a concrete requirement -> grilling. */
const HEDGE_QUESTIONS: ReadonlyArray<readonly [term: string, question: string]> = [
  ["somehow", "What exact mechanism or approach should accomplish this?"],
  ["maybe", "Is that a firm requirement or an option?"],
  ["might", "Is that a firm requirement or an option?"],
  ["could be", "What is the definitive behavior — what must hold?"],
  ["perhaps", "Is that a firm requirement or an option?"],
  ["not sure", "What is the concrete decision here?"],
  ["kind of", "What must be true exactly — what does this mean concretely?"],
  ["sort of", "What must be true exactly — what does this mean concretely?"],
  ["whatever", "What specific choice replaces \u201cwhatever\u201d?"],
  ["something like", "What specific option does \u201csomething like\u201d refer to?"],
  ["i think", "What is the confirmed requirement, not a guess?"],
  ["etc", "What are all the items — list them concretely."],
  ["and so on", "What are all the items — list them concretely."],
  ["stuff like that", "What specific items are included?"],
  ["whatever else", "What specific items are included?"],
  ["whether", "Which branch of the decision is required?"],
  ["such as", "What exact set of options is required?"],
  ["something", "What specific thing is being referred to?"],
];

/** Documentation-lookup language -> research tickets (AFK doc reading). */
const RESEARCH_PATTERNS: ReadonlyArray<readonly [pattern: RegExp, question: string]> = [
  [/\bdocumentation\b|\bdocs\b/i, "What do the documentation and current references say about this?"],
  [/\bhow\s+to\b/i, "What is the documented way to do this?"],
  [/\b(specification|spec)\b/i, "What does the specification require?"],
  [/\bguide\b/i, "What does the relevant guide specify?"],
  [/\b(sdk|library)\b/i, "What does the current SDK/library documentation say?"],
  [/\b(latest|current)\s+(version|release)\b/i, "What is the current version and its behavior?"],
  [/\bmigrat(e|ion)\b/i, "What does the migration path require?"],
  [/\bdeprecat(ed|ion)\b/i, "What is deprecated and what replaces it?"],
  [/\bbrowser\s+support\b/i, "Which browsers and versions must be supported?"],
];

const SHORT_PROMPT_WORDS = 10;

/**
 * Statable-question gate: decides whether a request is foggy by producing the
 * concrete questions that must be answered before it can be mapped to work.
 * Replaces the old numeric keyword-penalty clarity score.
 */
export function assessPrompt(prompt: string): FogAssessment {
  const text = prompt.trim();
  const questions: StatableQuestion[] = [];
  const seen = new Set<string>();
  const lower = text.toLowerCase();

  const push = (question: string, ticketType: StatableQuestion["ticketType"], context: string) => {
    if (seen.has(question)) return;
    seen.add(question);
    questions.push({ id: randomUUID(), question, ticketType, context });
  };

  if (!text) {
    push("What is the task?", TicketType.GRILLING, "No task was stated.");
    return { isFoggy: true, questions };
  }

  // Explicit questions in the prompt must be answered before work starts.
  const explicitParts = text.split(/[?？]/);
  for (const raw of explicitParts.slice(0, -1)) {
    const sentence = raw.trim();
    if (sentence) push(`${sentence}?`, TicketType.GRILLING, "The prompt asks this explicitly.");
  }

  for (const [term, question] of HEDGE_QUESTIONS) {
    if (lower.includes(term)) push(question, TicketType.GRILLING, `The prompt hedges with \u201c${term}\u201d.`);
  }

  for (const [pattern, question] of RESEARCH_PATTERNS) {
    if (pattern.test(text)) {
      push(
        question,
        TicketType.RESEARCH,
        `The prompt asks for information found in \u201c${pattern.source}\u201d context.`,
      );
    }
  }

  // Underspecified: too short to state any concrete requirement.
  if (questions.length === 0 && text.split(/\s+/).length < SHORT_PROMPT_WORDS) {
    push(
      `What concrete outcome should \u201c${truncate(text, 60)}\u201d produce?`,
      TicketType.GRILLING,
      "The prompt is too short to state a concrete requirement.",
    );
  }

  return { isFoggy: questions.length > 0, questions };
}

/**
 * Create (or re-map) a decision map. Uses the frontier-model mapper seam when
 * supplied; otherwise the deterministic statable-question stub.
 */
export async function createDecisionMap(prompt: string, options: CreateDecisionMapOptions = {}): Promise<DecisionMap> {
  const mapping = options.mapper ? await options.mapper(prompt) : stubMapping(prompt);
  return materializeMap(mapping);
}

/** Deterministic default mapper: fog -> question tickets + a gated task child. */
function stubMapping(prompt: string): FrontierMapping {
  const assessment = assessPrompt(prompt);

  if (!assessment.isFoggy) {
    return {
      rootQuestion: prompt,
      tickets: [
        {
          type: TicketType.TASK,
          title: `Implement: ${truncate(prompt, 60)}`,
          description: prompt,
          claims: [{ statement: prompt, source: "assumption" }],
        },
      ],
    };
  }

  const questionTickets: FrontierMappedTicket[] = assessment.questions.map((q) => ({
    id: randomUUID(),
    type: q.ticketType,
    title: q.question,
    description: q.context,
    question: q.question,
    claims: [
      {
        statement: `\u201c${q.question}\u201d is answered and confirmed.`,
        source: q.ticketType === TicketType.GRILLING ? "grilling" : "research",
      },
    ],
  }));

  const taskId = randomUUID();
  for (const ticket of questionTickets) ticket.blocks = [taskId];

  return {
    rootQuestion: prompt,
    tickets: [
      ...questionTickets,
      {
        id: taskId,
        type: TicketType.TASK,
        title: `Execute resolved requirement: ${truncate(prompt, 60)}`,
        description: prompt,
        blockedBy: questionTickets.map((t) => t.id as string),
        claims: [{ statement: "Every parent question above is answered.", source: "assumption" }],
      },
    ],
  };
}

/** Stamp ids/timestamps/claims and compute initial blocked statuses. */
function materializeMap(mapping: FrontierMapping): DecisionMap {
  const now = new Date().toISOString();
  const knownIds = new Set(mapping.tickets.map((t) => t.id).filter(Boolean));
  const tickets: DecisionTicket[] = mapping.tickets.map((raw) => {
    const ticket: DecisionTicket = {
      id: raw.id ?? randomUUID(),
      type: raw.type,
      title: raw.title,
      description: raw.description,
      status: "open",
      claims: normalizeClaims(raw.claims),
      blocks: (raw.blocks ?? []).filter((id) => knownIds.has(id)),
      blockedBy: (raw.blockedBy ?? []).filter((id) => knownIds.has(id)),
      createdAt: now,
      updatedAt: now,
    };
    if (raw.question !== undefined) ticket.question = raw.question;
    return ticket;
  });
  // Reconcile edges so a mapper declaring only one direction still yields a
  // fully linked parent/child graph (blocks <=> blockedBy stay in sync).
  const byId = new Map(tickets.map((t) => [t.id, t]));
  for (const ticket of tickets) {
    for (const parentId of ticket.blockedBy) {
      const parent = byId.get(parentId);
      if (parent && !parent.blocks.includes(ticket.id)) parent.blocks.push(ticket.id);
    }
    for (const childId of ticket.blocks) {
      const child = byId.get(childId);
      if (child && !child.blockedBy.includes(ticket.id)) child.blockedBy.push(ticket.id);
    }
  }
  const map: DecisionMap = { tickets, rootQuestion: mapping.rootQuestion, updatedAt: now };
  recomputeStatuses(map);
  return finalize(map);
}

/**
 * Mark a ticket resolved (optionally with claims gathered while answering it),
 * unblock any children whose parents are all resolved, and propagate the
 * resolved ticket's claims into those children. Returns the same map unchanged
 * for an unknown ticket id.
 */
export function resolveTicket(
  map: DecisionMap,
  ticketId: string,
  resolution: string,
  extraClaims: Array<TicketClaim | string> = [],
): DecisionMap {
  const result = cloneMap(map);
  const ticket = result.tickets.find((t) => t.id === ticketId);
  if (!ticket) return map;

  ticket.status = "resolved";
  ticket.resolution = resolution;
  ticket.claims = dedupeClaims([...ticket.claims, ...normalizeClaims(extraClaims)]);
  ticket.updatedAt = new Date().toISOString();
  if (result.activeTicket === ticketId) delete result.activeTicket;

  recomputeStatuses(result);
  propagateClaims(result, ticket);
  return finalize(result);
}

/** Add a parent/child blocking edge (blocked waits on blocker). */
export function blockTicket(map: DecisionMap, blockerId: string, blockedId: string): DecisionMap {
  const result = cloneMap(map);
  const blocker = result.tickets.find((t) => t.id === blockerId);
  const blocked = result.tickets.find((t) => t.id === blockedId);
  if (!blocker || !blocked || blocker.id === blocked.id) return map;
  if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
  if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
  recomputeStatuses(result);
  return finalize(result);
}

/** Remove a parent/child blocking edge. */
export function unblockTicket(map: DecisionMap, blockerId: string, blockedId: string): DecisionMap {
  const result = cloneMap(map);
  const blocker = result.tickets.find((t) => t.id === blockerId);
  const blocked = result.tickets.find((t) => t.id === blockedId);
  if (!blocker || !blocked) return map;
  blocker.blocks = blocker.blocks.filter((id) => id !== blockedId);
  blocked.blockedBy = blocked.blockedBy.filter((id) => id !== blockerId);
  recomputeStatuses(result);
  return finalize(result);
}

/**
 * 1/session constraint: returns the single ticket for the current session.
 * Idempotent — a second call while one ticket is in-progress returns the same
 * ticket; the next ticket only becomes available once the active one resolves.
 */
export function beginSession(map: DecisionMap): { map: DecisionMap; ticket?: DecisionTicket } {
  const result = cloneMap(map);
  const active = result.tickets.find((t) => t.id === result.activeTicket && t.status === "in-progress");
  if (active) return { map: finalize(result), ticket: active };

  const next = result.tickets.find((t) => t.status === "open");
  if (!next) return { map: finalize(result) };

  next.status = "in-progress";
  next.updatedAt = new Date().toISOString();
  result.activeTicket = next.id;
  return { map: finalize(result), ticket: next };
}

/** The ticket currently reserved for the active session, if any. */
export function getSessionTicket(map: DecisionMap): DecisionTicket | undefined {
  return map.tickets.find((t) => t.id === map.activeTicket && t.status === "in-progress");
}

/** Next actionable step: the session ticket, else first open, else blocked/proceed. */
export function getNextAction(map: DecisionMap): { action: string; ticketId?: string } {
  const active = getSessionTicket(map);
  if (active) return { action: "in-session", ticketId: active.id };

  const open = map.tickets.find((t) => t.status === "open");
  if (open) return { action: `resolve-${open.type}`, ticketId: open.id };

  if (map.tickets.some((t) => t.status === "blocked")) return { action: "blocked" };
  return { action: "proceed" };
}

/** Stub prompt for dispatching a ticket's research to a subagent. */
export function buildResearchPrompt(ticket: DecisionTicket): string {
  const question = ticket.question ? `Question to answer: ${ticket.question}` : `Resolve: ${ticket.title}`;
  const claims =
    ticket.claims.length > 0
      ? `Claims that must hold after your research:\n${ticket.claims.map((c) => `- ${c.statement}`).join("\n")}`
      : "";
  return `[wayfinder research dispatch]\n${question}\n${claims}`.trim();
}

/**
 * Parallel research dispatch seam. Without a runtime this returns a
 * not-dispatched stub; with one it fans the ticket's research prompt out
 * through the workflow runtime's parallel()/agent() primitives.
 */
export async function dispatchTicketResearch(
  ticket: DecisionTicket,
  runtime?: WayfinderRuntime,
): Promise<ResearchDispatch> {
  if (!runtime) return { dispatched: false, ticketId: ticket.id, reason: "no-runtime" };
  const findings = await runtime.parallel([
    () => runtime.agent(buildResearchPrompt(ticket), { label: `wayfinder-research:${ticket.id}`, tier: "small" }),
  ]);
  return { dispatched: true, ticketId: ticket.id, findings };
}

/** Render the decision map as a MARKDOWN index (headings + ticket statuses). */
export function renderMarkdownMap(map: DecisionMap): string {
  const lines: string[] = [];
  const indexById = new Map(map.tickets.map((t, i) => [t.id, i + 1]));

  lines.push("# Wayfinder Map", "");
  lines.push(`> Root question: ${map.rootQuestion}`);
  lines.push(`> Updated: ${map.updatedAt}`, "");

  lines.push("## Ticket Index", "");
  lines.push("| # | Type | Title | Status |");
  lines.push("|---|------|-------|--------|");
  for (const [index, ticket] of map.tickets.entries()) {
    lines.push(`| ${index + 1} | ${ticket.type} | ${ticket.title} | ${STATUS_BADGES[ticket.status]} |`);
  }
  lines.push("", "## Tickets", "");

  for (const [index, ticket] of map.tickets.entries()) {
    lines.push(`### #${index + 1} — ${ticket.type}: ${ticket.title}`, "");
    lines.push(`- **Status:** ${STATUS_BADGES[ticket.status]}`);
    if (ticket.question) lines.push(`- **Question:** ${ticket.question}`);
    if (ticket.claims.length > 0) {
      lines.push("- **Claims:**");
      for (const claim of ticket.claims) lines.push(`  - [${claim.source}] ${claim.statement}`);
    }
    const blocks = ticket.blocks.map((id) => `#${indexById.get(id)}`).join(", ");
    const blockedBy = ticket.blockedBy.map((id) => `#${indexById.get(id)}`).join(", ");
    lines.push(`- **Blocks:** ${blocks || "—"}`);
    lines.push(`- **Blocked by:** ${blockedBy || "—"}`);
    if (ticket.resolution) lines.push(`- **Resolution:** ${ticket.resolution}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Persist the map: map.md is the human-facing MARKDOWN index; map.json is the
 * machine sidecar that loadDecisionMap reads back.
 */
export async function saveDecisionMap(map: DecisionMap, dir: string): Promise<void> {
  const mapDir = join(dir, ".pi", "workflows");
  await mkdir(mapDir, { recursive: true });
  await writeFile(join(mapDir, MAP_FILE_NAME), renderMarkdownMap(map), "utf-8");
  await writeFile(join(mapDir, SIDECAR_FILE_NAME), JSON.stringify(map, null, 2), "utf-8");
}

/** Load a previously saved decision map from the JSON sidecar. */
export async function loadDecisionMap(dir: string): Promise<DecisionMap | null> {
  try {
    const data = await readFile(join(dir, ".pi", "workflows", SIDECAR_FILE_NAME), "utf-8");
    return JSON.parse(data) as DecisionMap;
  } catch {
    return null;
  }
}

function cloneMap(map: DecisionMap): DecisionMap {
  return {
    ...map,
    tickets: map.tickets.map((t) => ({
      ...t,
      claims: [...t.claims],
      blocks: [...t.blocks],
      blockedBy: [...t.blockedBy],
    })),
  };
}

function normalizeClaims(claims: Array<TicketClaim | string> = []): TicketClaim[] {
  return dedupeClaims(claims.map((c) => (typeof c === "string" ? { statement: c, source: "assumption" as const } : c)));
}

function dedupeClaims(claims: TicketClaim[]): TicketClaim[] {
  const seen = new Set<string>();
  const result: TicketClaim[] = [];
  for (const claim of claims) {
    if (seen.has(claim.statement)) continue;
    seen.add(claim.statement);
    result.push(claim);
  }
  return result;
}

/** Flip tickets to blocked (any unresolved parent) or back to open. */
function recomputeStatuses(map: DecisionMap): DecisionMap {
  const byId = new Map(map.tickets.map((t) => [t.id, t]));
  const now = new Date().toISOString();
  for (const ticket of map.tickets) {
    const hasUnresolvedBlocker = ticket.blockedBy.some((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && blocker.status !== "resolved";
    });
    if (hasUnresolvedBlocker) {
      if (ticket.status !== "blocked") {
        ticket.status = "blocked";
        ticket.updatedAt = now;
      }
    } else if (ticket.status === "blocked") {
      ticket.status = "open";
      ticket.updatedAt = now;
    }
  }
  return map;
}

/** Inherit a parent's claims into children it has just unblocked. */
function propagateClaims(map: DecisionMap, resolvedTicket: DecisionTicket): void {
  const now = new Date().toISOString();
  for (const child of map.tickets) {
    if (!child.blockedBy.includes(resolvedTicket.id)) continue;
    if (child.status !== "open" && child.status !== "blocked") continue;
    const existing = new Set(child.claims.map((c) => c.statement));
    const inherited = resolvedTicket.claims.filter((c) => !existing.has(c.statement));
    if (inherited.length > 0) {
      child.claims = [...child.claims, ...inherited];
      child.updatedAt = now;
    }
  }
}

/** Recompute nextTicket and stamp the map's updatedAt. */
function finalize(map: DecisionMap): DecisionMap {
  const active = map.tickets.find((t) => t.id === map.activeTicket && t.status === "in-progress");
  const next = active?.id ?? map.tickets.find((t) => t.status === "open")?.id;
  if (next !== undefined) {
    map.nextTicket = next;
  } else {
    delete map.nextTicket;
  }
  map.updatedAt = new Date().toISOString();
  return map;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
