/**
 * Unit tests for the Wayfinder decision-mapping module (Phase 0).
 *
 * Covers the Matt Pocock realignment: statable-question gate (no numeric
 * clarity), markdown map index, and the full ticket lifecycle (claims,
 * blocking, 1/session, next-action, parallel research dispatch seam).
 */

import assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assessPrompt,
  beginSession,
  blockTicket,
  buildResearchPrompt,
  createDecisionMap,
  type DecisionMap,
  dispatchTicketResearch,
  type FrontierMapper,
  findCycle,
  getNextAction,
  getSessionTicket,
  loadDecisionMap,
  renderMarkdownMap,
  resolveTicket,
  saveDecisionMap,
  TicketType,
  unblockTicket,
  type WayfinderRuntime,
} from "../src/phases/wayfinder.js";

const CLEAR_PROMPT = "Add a /health endpoint returning JSON status with uptime and latency metrics";

describe("assessPrompt (statable-question gate)", () => {
  it("does not flag a concrete, statable prompt", () => {
    const assessment = assessPrompt(CLEAR_PROMPT);
    assert.equal(assessment.isFoggy, false);
    assert.deepEqual(assessment.questions, []);
  });

  it("flags hedged language with concrete grilling questions, not a score", () => {
    const assessment = assessPrompt("Implement the feature somehow, maybe with some kind of handler");
    assert.equal(assessment.isFoggy, true);
    assert.ok(assessment.questions.length >= 2);
    for (const q of assessment.questions) {
      assert.ok(q.question.length > 0);
      assert.ok(q.question.length < 200, `question should be statable, not a score: ${q.question}`);
      assert.ok([TicketType.GRILLING, TicketType.RESEARCH].includes(q.ticketType));
      assert.ok(q.context.length > 0);
    }
  });

  it("dedupes repeated hedges into one question", () => {
    const assessment = assessPrompt("maybe do X, or maybe not, perhaps both");
    const questions = assessment.questions.map((q) => q.question);
    assert.equal(new Set(questions).size, questions.length);
  });

  it("turns explicit prompt questions into grilling tickets", () => {
    const assessment = assessPrompt("How should we handle retries? Which cache do you want?");
    assert.equal(assessment.isFoggy, true);
    assert.deepEqual(
      assessment.questions.map((q) => q.question),
      ["How should we handle retries?", "Which cache do you want?"],
    );
    assert.ok(assessment.questions.every((q) => q.ticketType === TicketType.GRILLING));
  });

  it("maps documentation-lookup language to research tickets", () => {
    const assessment = assessPrompt(
      "Check the documentation for the latest version of the SDK and how to migrate to it",
    );
    assert.equal(assessment.isFoggy, true);
    assert.equal(assessment.questions.length, 5);
    assert.ok(assessment.questions.every((q) => q.ticketType === TicketType.RESEARCH));
  });

  it("flags an empty prompt with a single grilling question", () => {
    const assessment = assessPrompt("");
    assert.equal(assessment.isFoggy, true);
    assert.deepEqual(
      assessment.questions.map((q) => q.question),
      ["What is the task?"],
    );
  });

  it("flags underspecified short prompts", () => {
    const assessment = assessPrompt("Do stuff");
    assert.equal(assessment.isFoggy, true);
    assert.equal(assessment.questions.length, 1);
    assert.match(assessment.questions[0].question, /Do stuff/);
  });
});

describe("createDecisionMap", () => {
  it("maps a foggy prompt to open question tickets and a blocked task child", async () => {
    const map = await createDecisionMap("maybe implement something with the docs");
    const questionTickets = map.tickets.filter((t) => t.type !== TicketType.TASK);
    const task = map.tickets.find((t) => t.type === TicketType.TASK);
    assert.ok(task, "foggy prompt must gate a task behind its questions");
    assert.equal(task.status, "blocked");
    assert.equal(task.blockedBy.length, questionTickets.length);
    assert.equal(task.blocks.length, 0);
    for (const q of questionTickets) {
      assert.equal(q.status, "open");
      assert.ok(q.question, "question tickets carry the statable question");
      assert.ok(q.claims.length >= 1, "every ticket states what must be true");
      assert.ok(q.blocks.includes(task.id), "question tickets block their task child");
    }
    assert.equal(map.nextTicket, questionTickets[0].id);
  });

  it("maps a clear prompt to a single open task ticket", async () => {
    const map = await createDecisionMap(CLEAR_PROMPT);
    assert.equal(map.tickets.length, 1);
    assert.equal(map.tickets[0].type, TicketType.TASK);
    assert.equal(map.tickets[0].status, "open");
    assert.deepEqual(map.tickets[0].blockedBy, []);
    assert.deepEqual(map.tickets[0].claims, [{ statement: CLEAR_PROMPT, source: "assumption" }]);
  });

  it("uses the frontier-model mapper seam when supplied (async)", async () => {
    const mapper: FrontierMapper = async (prompt) => ({
      rootQuestion: prompt,
      tickets: [
        {
          id: "r1",
          type: TicketType.RESEARCH,
          title: "Read the docs",
          description: "AFK lookup",
          question: "What do the docs say?",
          claims: ["docs must specify the retry policy"],
        },
        { id: "t1", type: TicketType.TASK, title: "Build it", description: "impl", blockedBy: ["r1"] },
      ],
    });
    const map = await createDecisionMap("foggy task", { mapper });
    assert.equal(map.tickets.length, 2);
    const research = map.tickets.find((t) => t.id === "r1");
    const task = map.tickets.find((t) => t.id === "t1");
    assert.ok(research && task);
    assert.equal(research.status, "open");
    assert.deepEqual(research.blocks, ["t1"]);
    assert.equal(task.status, "blocked");
    assert.deepEqual(task.blockedBy, ["r1"]);
    // string claims normalize to assumption-sourced claims
    assert.deepEqual(research.claims, [{ statement: "docs must specify the retry policy", source: "assumption" }]);
    assert.ok(!Number.isNaN(Date.parse(research.createdAt)));
  });

  it("accepts a synchronous mapper", async () => {
    const mapper: FrontierMapper = () => ({
      rootQuestion: "x",
      tickets: [{ id: "a", type: TicketType.TASK, title: "A", description: "a" }],
    });
    const map = await createDecisionMap("x", { mapper });
    assert.equal(map.tickets[0].id, "a");
  });

  it("drops dangling blocking edges from a mapper", async () => {
    const mapper: FrontierMapper = () => ({
      rootQuestion: "x",
      tickets: [{ id: "a", type: TicketType.TASK, title: "A", description: "a", blockedBy: ["ghost"] }],
    });
    const map = await createDecisionMap("x", { mapper });
    assert.deepEqual(map.tickets[0].blockedBy, []);
    assert.equal(map.tickets[0].status, "open");
  });
});

describe("ticket lifecycle: blocking, resolve, next-action", () => {
  async function foggyMap(): Promise<DecisionMap> {
    return createDecisionMap("maybe implement something with the docs");
  }

  it("keeps the task blocked until every parent question resolves", async () => {
    const map = await foggyMap();
    const parents = map.tickets.filter((t) => t.type !== TicketType.TASK);
    const task = map.tickets.find((t) => t.type === TicketType.TASK);
    assert.ok(task && parents.length >= 2);

    let current = map;
    for (const parent of parents.slice(0, -1)) {
      current = resolveTicket(current, parent.id, "answered", [{ statement: "OAuth2 required", source: "grilling" }]);
    }
    // claims propagate into the still-blocked child
    assert.ok(current.tickets.find((t) => t.id === task.id)?.claims.some((c) => c.statement === "OAuth2 required"));
    assert.equal(current.tickets.find((t) => t.id === task.id)?.status, "blocked");

    current = resolveTicket(current, parents[parents.length - 1].id, "answered");
    assert.equal(current.tickets.find((t) => t.id === task.id)?.status, "open");
  });

  it("getNextAction reports the first open question, then blocked, then proceed", async () => {
    const map = await foggyMap();
    const first = map.tickets[0];
    assert.deepEqual(getNextAction(map), { action: `resolve-${first.type}`, ticketId: first.id });
    assert.equal(map.nextTicket, first.id);

    const oneResolved = resolveTicket(map, first.id, "answered");
    assert.equal(getNextAction(oneResolved).action, `resolve-${oneResolved.tickets[1].type}`);

    const allResolved = oneResolved.tickets.reduce(
      (acc, t) => (t.status === "resolved" ? acc : resolveTicket(acc, t.id, "done")),
      oneResolved,
    );
    assert.deepEqual(getNextAction(allResolved), { action: "proceed" });

    // Invariant enforcement: a back-edge that would close a cycle is refused,
    // so the graph can never self-lock into an all-blocked dead end.
    const mapper: FrontierMapper = () => ({
      rootQuestion: "x",
      tickets: [
        { id: "t1", type: TicketType.TASK, title: "A", description: "a" },
        { id: "t2", type: TicketType.TASK, title: "B", description: "b" },
      ],
    });
    const mapped = await createDecisionMap("x", { mapper });
    const linked = blockTicket(mapped, "t1", "t2");
    const refused = blockTicket(linked, "t2", "t1");
    assert.equal(findCycle(refused), null, "the graph stays acyclic after the refused back-edge");
    assert.deepEqual(refused.tickets.find((t) => t.id === "t1")?.blocks, ["t2"]);
    assert.deepEqual(refused.tickets.find((t) => t.id === "t2")?.blocks, []);
    assert.deepEqual(getNextAction(refused), { action: "resolve-task", ticketId: "t1" });
  });

  it("blockTicket/unblockTicket add and remove parent-child edges", async () => {
    const mapper: FrontierMapper = () => ({
      rootQuestion: "x",
      tickets: [
        { id: "a", type: TicketType.RESEARCH, title: "A", description: "a" },
        { id: "b", type: TicketType.TASK, title: "B", description: "b" },
      ],
    });
    const map = await createDecisionMap("x", { mapper });

    const blocked = blockTicket(map, "a", "b");
    assert.equal(blocked.tickets.find((t) => t.id === "a")?.status, "open");
    assert.equal(blocked.tickets.find((t) => t.id === "b")?.status, "blocked");
    assert.deepEqual(blocked.tickets.find((t) => t.id === "a")?.blocks, ["b"]);
    assert.deepEqual(blocked.tickets.find((t) => t.id === "b")?.blockedBy, ["a"]);

    const unblocked = unblockTicket(blocked, "a", "b");
    assert.equal(unblocked.tickets.find((t) => t.id === "b")?.status, "open");
    assert.deepEqual(unblocked.tickets.find((t) => t.id === "b")?.blockedBy, []);
  });

  it("resolveTicket attaches claims and is a no-op for unknown ids", async () => {
    const map = await createDecisionMap(CLEAR_PROMPT);
    const resolved = resolveTicket(map, map.tickets[0].id, "Done", [
      { statement: "endpoint returns 200", source: "research" },
      "typed handler",
    ]);
    assert.equal(resolved.tickets[0].status, "resolved");
    assert.equal(resolved.tickets[0].resolution, "Done");
    assert.deepEqual(resolved.tickets[0].claims, [
      { statement: CLEAR_PROMPT, source: "assumption" },
      { statement: "endpoint returns 200", source: "research" },
      { statement: "typed handler", source: "assumption" },
    ]);
    assert.deepEqual(resolveTicket(map, "does-not-exist", "x"), map);
  });
});

describe("ticket lifecycle: one ticket per session", () => {
  it("reserves exactly one ticket per session and advances only after resolve", async () => {
    const map = await createDecisionMap("maybe implement something");
    const session1 = beginSession(map);
    assert.ok(session1.ticket, "a foggy map must have an actionable session ticket");
    assert.equal(session1.ticket.status, "in-progress");
    assert.equal(session1.map.activeTicket, session1.ticket.id);
    assert.equal(getSessionTicket(session1.map)?.id, session1.ticket.id);

    // 1/session: a second begin while in-progress returns the SAME ticket
    const session2 = beginSession(session1.map);
    assert.ok(session2.ticket);
    assert.equal(session2.ticket.id, session1.ticket.id);

    // the session ticket is the next action until resolved
    assert.deepEqual(getNextAction(session1.map), { action: "in-session", ticketId: session1.ticket.id });

    const resolved = resolveTicket(session1.map, session1.ticket.id, "answered");
    assert.equal(getSessionTicket(resolved), undefined);

    const session3 = beginSession(resolved);
    assert.ok(session3.ticket, "the next open ticket becomes the next session's ticket");
    assert.notEqual(session3.ticket.id, session1.ticket.id);
  });

  it("returns no ticket when nothing is left to work", async () => {
    const map = await createDecisionMap(CLEAR_PROMPT);
    const first = beginSession(map);
    assert.ok(first.ticket);
    const done = resolveTicket(first.map, first.ticket.id, "Done");
    const empty = beginSession(done);
    assert.equal(empty.ticket, undefined);
    assert.deepEqual(getNextAction(empty.map), { action: "proceed" });
  });
});

describe("markdown map output", () => {
  it("renders a markdown index with headings, tickets and statuses", async () => {
    const map = await createDecisionMap("maybe implement something with the docs");
    const task = map.tickets.find((t) => t.type === TicketType.TASK);
    assert.ok(task);
    const resolved = resolveTicket(map, map.tickets[0].id, "User confirmed");

    const md = renderMarkdownMap(resolved);
    assert.ok(md.startsWith("# Wayfinder Map"));
    assert.ok(md.includes("## Ticket Index"));
    assert.ok(md.includes("## Tickets"));
    assert.ok(md.includes(`> Root question: ${map.rootQuestion}`));
    assert.ok(md.includes("✅ resolved"), "index must show ticket statuses");
    assert.ok(md.includes("🔒 blocked"));
    assert.ok(md.includes(`- **Status:** 🔒 blocked`), "blocked ticket body shows its status");
    assert.ok(md.includes("- **Question:**"));
    assert.ok(md.includes("- [grilling]"), "claims render with their source");
    assert.ok(md.includes("- **Blocks:**"), "blocking edges render");
    assert.ok(md.includes("- **Blocked by:**"));
  });

  it("renders resolved tickets with their resolution", async () => {
    const map = await createDecisionMap(CLEAR_PROMPT);
    const resolved = resolveTicket(map, map.tickets[0].id, "shipped");
    const md = renderMarkdownMap(resolved);
    assert.ok(md.includes("- **Resolution:** shipped"));
  });
});

describe("decision map persistence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wayfinder-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes map.md as markdown, not JSON", async () => {
    const map = await createDecisionMap("maybe implement something");
    await saveDecisionMap(map, dir);
    const md = await readFile(join(dir, ".pi", "workflows", "map.md"), "utf-8");
    assert.ok(md.startsWith("# Wayfinder Map"));
    assert.ok(!md.trim().startsWith("{"), "map.md must be a markdown index");
    assert.ok(md.includes("- **Status:** ⏳ open"));
  });

  it("round-trips through the JSON sidecar", async () => {
    const map = await createDecisionMap("maybe implement something with the docs");
    await saveDecisionMap(map, dir);
    const sidecar = JSON.parse(await readFile(join(dir, ".pi", "workflows", "map.json"), "utf-8"));
    assert.deepEqual(sidecar, map);
    assert.deepEqual(await loadDecisionMap(dir), map);
  });

  it("returns null when no map exists", async () => {
    assert.equal(await loadDecisionMap(dir), null);
  });

  it("returns null for a corrupt sidecar", async () => {
    const mapDir = join(dir, ".pi", "workflows");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(mapDir, { recursive: true });
    await writeFile(join(mapDir, "map.json"), "{not json", "utf-8");
    assert.equal(await loadDecisionMap(dir), null);
  });
});

describe("decision map invariants (acyclic blocking graph)", () => {
  async function twoTicketMap(): Promise<DecisionMap> {
    const mapper: FrontierMapper = () => ({
      rootQuestion: "x",
      tickets: [
        { id: "a", type: TicketType.TASK, title: "A", description: "a" },
        { id: "b", type: TicketType.TASK, title: "B", description: "b" },
      ],
    });
    return createDecisionMap("x", { mapper });
  }

  it("findCycle reports null for an acyclic graph", async () => {
    const map = await twoTicketMap();
    assert.equal(findCycle(map), null);
    const linked = blockTicket(map, "a", "b");
    assert.equal(findCycle(linked), null);
  });

  it("findCycle detects a hand-built blocking cycle (t1 -> t2 -> t1)", () => {
    const cycle: DecisionMap = {
      rootQuestion: "x",
      tickets: [
        { id: "t1", type: TicketType.TASK, title: "A", description: "a", blocks: ["t2"] },
        { id: "t2", type: TicketType.TASK, title: "B", description: "b", blocks: ["t1"] },
      ],
    };
    assert.deepEqual(findCycle(cycle), ["t1", "t2", "t1"]);
  });

  it("findCycle detects a self-blocking ticket", () => {
    const selfBlocked: DecisionMap = {
      rootQuestion: "x",
      tickets: [{ id: "t1", type: TicketType.TASK, title: "A", description: "a", blocks: ["t1"] }],
    };
    assert.deepEqual(findCycle(selfBlocked), ["t1", "t1"]);
  });

  it("blockTicket refuses an edge that would close a cycle", async () => {
    const map = await twoTicketMap();
    const linked = blockTicket(map, "a", "b");
    const refused = blockTicket(linked, "b", "a");
    assert.deepEqual(refused, linked, "the cycle-closing edge is a no-op");
    assert.equal(findCycle(refused), null);
  });

  it("materializeMap breaks a mapper-supplied cycle by cutting one back-edge", async () => {
    const mapper: FrontierMapper = () => ({
      rootQuestion: "x",
      tickets: [
        { id: "a", type: TicketType.TASK, title: "A", description: "a", blocks: ["b"], blockedBy: ["b"] },
        { id: "b", type: TicketType.TASK, title: "B", description: "b", blocks: ["a"], blockedBy: ["a"] },
      ],
    });
    const map = await createDecisionMap("x", { mapper });
    assert.equal(findCycle(map), null, "the materialized map must be acyclic");
    const a = map.tickets.find((t) => t.id === "a");
    const b = map.tickets.find((t) => t.id === "b");
    assert.ok(a && b);
    assert.ok(a.blocks.includes("b") !== b.blocks.includes("a"), "exactly one direction of the broken cycle survives");
    assert.ok(
      a.blocks.includes("b") === a.blockedBy.includes("b") || a.blockedBy.length === 0,
      "edges stay reconciled after cycle breaking",
    );
  });

  it("recomputeStatuses never reverts a resolved ticket to blocked (f4)", async () => {
    const map = await twoTicketMap();
    const resolved = resolveTicket(map, "a", "shipped");
    assert.equal(resolved.tickets.find((t) => t.id === "a")?.status, "resolved");

    // A NEW blocker appearing after the resolution must not re-block it.
    const reblocked = blockTicket(resolved, "b", "a");
    assert.equal(
      reblocked.tickets.find((t) => t.id === "a")?.status,
      "resolved",
      "a resolved ticket survives a new blocker",
    );

    // Resolving a ticket whose blocker is unresolved must not be reverted
    // by the status recomputation that follows.
    const blocked = blockTicket(map, "b", "a");
    const forced = resolveTicket(blocked, "a", "done");
    assert.equal(
      forced.tickets.find((t) => t.id === "a")?.status,
      "resolved",
      "resolveTicket's resolution is preserved by recomputeStatuses",
    );
  });
});

describe("sidecar normalization (i4)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wayfinder-sidecar-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("degrades a hand-edited sidecar to defaults instead of throwing", async () => {
    const mapDir = join(dir, ".pi", "workflows");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(mapDir, { recursive: true });
    await writeFile(
      join(mapDir, "map.json"),
      JSON.stringify({
        rootQuestion: "x",
        tickets: [
          {
            id: "a",
            title: "A",
            description: "d",
            type: "bogus",
            status: "bogus",
            claims: "not-an-array",
            blocks: "x",
            blockedBy: { nope: true },
            createdAt: "not-a-date",
            updatedAt: "also-bad",
          },
          {
            id: "b",
            type: "task",
            title: "B",
            description: "d",
            status: "resolved",
            resolution: "done",
            claims: [{ statement: "s", source: "bogus" }],
          },
        ],
        updatedAt: "garbage",
      }),
      "utf-8",
    );
    const map = await loadDecisionMap(dir);
    assert.ok(map, "a structurally valid but garbage-typed sidecar loads");

    const a = map.tickets.find((t) => t.id === "a");
    assert.ok(a);
    assert.equal(a.type, TicketType.TASK, "invalid type degrades to TASK");
    assert.equal(a.status, "open", "invalid status degrades to open");
    assert.deepEqual(a.claims, [], "non-array claims degrade to []");
    assert.deepEqual(a.blocks, [], "non-array blocks degrade to []");
    assert.deepEqual(a.blockedBy, [], "non-array blockedBy degrades to []");
    assert.ok(!Number.isNaN(Date.parse(a.createdAt)), "garbage timestamps degrade to parseable ones");

    const b = map.tickets.find((t) => t.id === "b");
    assert.ok(b);
    assert.equal(b.status, "resolved", "a valid resolved status is preserved");
    assert.deepEqual(b.claims, [{ statement: "s", source: "assumption" }], "invalid claim source degrades");
    assert.ok(!Number.isNaN(Date.parse(map.updatedAt)));
  });

  it("breaks a blocking cycle in a hand-edited sidecar", async () => {
    const mapDir = join(dir, ".pi", "workflows");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(mapDir, { recursive: true });
    await writeFile(
      join(mapDir, "map.json"),
      JSON.stringify({
        rootQuestion: "x",
        tickets: [
          { id: "t1", type: "task", title: "A", description: "a", blocks: ["t2"], blockedBy: ["t2"] },
          { id: "t2", type: "task", title: "B", description: "b", blocks: ["t1"], blockedBy: ["t1"] },
        ],
      }),
      "utf-8",
    );
    const map = await loadDecisionMap(dir);
    assert.ok(map);
    assert.equal(findCycle(map), null, "a hand-edited cycle cannot survive loading");
  });

  it("drops dangling edges and duplicate ids from a hand-edited sidecar", async () => {
    const mapDir = join(dir, ".pi", "workflows");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(mapDir, { recursive: true });
    await writeFile(
      join(mapDir, "map.json"),
      JSON.stringify({
        rootQuestion: "x",
        tickets: [
          { id: "t1", type: "task", title: "A", description: "a", blocks: ["ghost"], blockedBy: ["ghost"] },
          { id: "t1", type: "task", title: "duplicate", description: "dropped" },
          { id: "t2", type: "task", title: "B", description: "b", blockedBy: ["t1"] },
        ],
      }),
      "utf-8",
    );
    const map = await loadDecisionMap(dir);
    assert.ok(map);
    assert.deepEqual(
      map.tickets.map((t) => t.id),
      ["t1", "t2"],
      "duplicate id is dropped",
    );
    const t1 = map.tickets.find((t) => t.id === "t1");
    assert.ok(t1);
    assert.deepEqual(t1.blocks, ["t2"], "dangling ghost edge is dropped; mirror edge is reconciled");
    assert.deepEqual(t1.blockedBy, []);
    const t2 = map.tickets.find((t) => t.id === "t2");
    assert.ok(t2);
    assert.deepEqual(t2.blockedBy, ["t1"], "edges to surviving tickets are kept");
  });

  it("returns null for a sidecar whose tickets are not an array", async () => {
    const mapDir = join(dir, ".pi", "workflows");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(mapDir, { recursive: true });
    await writeFile(join(mapDir, "map.json"), JSON.stringify({ rootQuestion: "x", tickets: "nope" }), "utf-8");
    assert.equal(await loadDecisionMap(dir), null);
  });
});

describe("parallel research dispatch", () => {
  it("returns a not-dispatched stub when no runtime is wired", async () => {
    const map = await createDecisionMap("maybe implement something with the docs");
    const research = map.tickets.find((t) => t.type === TicketType.RESEARCH);
    assert.ok(research);
    assert.deepEqual(await dispatchTicketResearch(research), {
      dispatched: false,
      ticketId: research.id,
      reason: "no-runtime",
    });
  });

  it("fans research out through the runtime agent()/parallel() primitives", async () => {
    const map = await createDecisionMap("maybe implement something with the docs");
    const research = map.tickets.find((t) => t.type === TicketType.RESEARCH);
    assert.ok(research);

    const agentCalls: string[] = [];
    const runtime: WayfinderRuntime = {
      agent: async (prompt) => {
        agentCalls.push(prompt);
        return `answer: ${prompt}`;
      },
      parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    };

    const dispatch = await dispatchTicketResearch(research, runtime);
    assert.equal(dispatch.dispatched, true);
    if (dispatch.dispatched) {
      assert.equal(dispatch.ticketId, research.id);
      assert.equal(dispatch.findings.length, 1);
      assert.match(String(dispatch.findings[0]), /^answer: /);
    }
    assert.equal(agentCalls.length, 1);
    assert.match(agentCalls[0], new RegExp(research.question));
  });

  it("builds a research prompt from the ticket question and claims", async () => {
    const map = await createDecisionMap("maybe implement something with the docs");
    const research = map.tickets.find((t) => t.type === TicketType.RESEARCH);
    assert.ok(research);
    const prompt = buildResearchPrompt(research);
    assert.ok(prompt.startsWith("[wayfinder research dispatch]"));
    assert.ok(prompt.includes(`Question to answer: ${research.question}`));
    assert.ok(prompt.includes("Claims that must hold"));
    assert.ok(prompt.includes(research.claims[0].statement));
  });
});
