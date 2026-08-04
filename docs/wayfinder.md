# Wayfinder — Phase 0 decision tickets

Wayfinder is the Phase 0 fog-clearing stage of the four-phase workflow engine. For
a vague or large prompt it turns the request into a decision map of tickets that
must be resolved — **session by session** — before any code blueprinting begins.

This page documents how decision tickets are stored (and why that satisfies the
product requirement), the ticket lifecycle, and the optional future GitHub Issues
branch. It is the conformance record for the PRD's "GitHub Issues **or** local"
storage clause.

## Storage: the local map satisfies the PRD "or" clause

The PRD (Task 4) requires decision tickets to be stored on **"GitHub Issues or
locally in `.pi/workflows/map.md`"**. The local branch is the one implemented, so
the clause is fully satisfied — no GitHub Issues integration is required for
conformance.

Decision maps persist to two files under the project directory:

| File | Purpose |
| --- | --- |
| `.pi/workflows/map.md` | Human-facing markdown index (headings + per-ticket status) |
| `.pi/workflows/map.json` | Structured machine-readable sidecar (full ticket graph) |

Only the local branch exists today. There is deliberately **no GitHub client** in
the codebase (no octokit, no token handling, no `create-issue` path): the local
map works offline, keeps ticket data inside the project, and avoids any network or
credential dependency. GitHub Issues is the optional future remote-collaboration
branch, not a gap (see [below](#github-issues-the-optional-future-branch)).

## Ticket types

Wayfinder creates four ticket types (the `TicketType` enum), mapped from the
Wayfinder specification:

| Type | Meaning | Who resolves it |
| --- | --- | --- |
| `research` | AFK documentation lookup | A subagent (doc reading), offline |
| `prototype` | HITL UI/stub code | Human-in-the-loop (frontier model builds a stub, human reacts) |
| `grilling` | HITL interviews | Human-in-the-loop (questions answered by a human) |
| `task` | Pre-requisite setup | The implementation itself — never blocks wayfinder completion |

`research` and `grilling` tickets carry a *statable question* plus optional claims
that must hold after resolution. `task` tickets carry the implementation work and
are the leaf of a clear prompt's map.

## Ticket lifecycle

Each ticket moves through `open → in-progress → resolved`, with `blocked` as an
edge-driven state:

- **Creation** — `assessPrompt` runs a statable-question fog gate (`{ isFoggy,
  questions[] }`); a foggy prompt produces question tickets plus a gated `task`
  child, a clear prompt maps to a single `task` ticket.
- **One ticket per session** — `beginSession` reserves exactly one ticket for the
  active session (idempotent: a second call while one is in-progress returns the
  same ticket; the next ticket becomes available only when the active one
  resolves). `getSessionTicket` / `getNextAction` drive what happens next.
- **Resolution** — `resolveTicket(map, id, resolution, extraClaims)` records the
  resolution, dedupes and **propagates claims** into blocked children, and
  unblocks children whose blockers are all resolved.
- **Blocking** — `blockTicket`/`unblockTicket` add/remove parent→child edges. The
  blocking graph stays **acyclic**: a cycle-closing edge is refused, and a
  resolved ticket never reverts to blocked.
- **Completion** — fog is dissolved when every *decision* ticket
  (`research` / `prototype` / `grilling`) is `resolved` (`isMapFogResolved`).
  `task` tickets never gate wayfinder completion, so a clear prompt completes
  immediately with its single-task map.

## Session-by-session resolution

Resolution is deliberately spread across sessions, and progress survives between
them: the run-entry stage (`runWayfinderStage`) loads the existing map and keeps
it while its `rootQuestion` still matches the current prompt — a previous
session's ticket statuses carry over. A missing map, or one for a different
prompt, is (re)created through the mapper seam (deterministic stub by default,
`FrontierMapper` for frontier-model mapping).

Once every decision ticket is resolved, the stage flips the persisted
`wayfinderComplete` flag in the state machine (`.pi/workflows/active-state.json`);
that flag is the declared prerequisite for Phase 1 (prewalk), so a foggy prompt
**blocks prewalk** until its tickets are resolved. A clear prompt's map completes
immediately and prewalk proceeds.

## GitHub Issues: the optional future branch

GitHub Issues is the remote-collaboration branch of the PRD's "or" clause and is
**not implemented**. It is intentionally deferred, because:

- the local `.pi/workflows/map.md` branch fully satisfies the requirement, and
- a remote branch adds auth, network, and sync complexity no current user flow
  needs.

If remote collaboration is ever actually required (multiple people resolving
tickets against one shared map), a GitHub Issues storage adapter can be added
behind the same decision-map persistence seam (`saveDecisionMap` /
`loadDecisionMap` / `renderMarkdownMap`) — the ticket model, lifecycle, and
session semantics are storage-agnostic and would not change.

## PRD conformance record

| PRD requirement (Task 4) | Status | Where |
| --- | --- | --- |
| Decision maps with 4 ticket types | Implemented | `src/phases/wayfinder.ts` (`TicketType`) |
| Vague prompts generate a ticket list before blueprinting | Implemented | `assessPrompt` fog gate; `runWayfinderStage` gates prewalk |
| Tickets on GitHub Issues **or** `.pi/workflows/map.md` | Local branch implemented (clause satisfied) | `.pi/workflows/map.md` + `map.json` |
| Resolve tickets session-by-session until questions are clear | Implemented | `beginSession` / `resolveTicket`; map reuse across sessions |

## Related documentation

- [Workflow authoring](workflow-authoring.md) — the full runtime contract and
  phase gates (including the single enforced subagent-spawn gate).
- [Workflow authoring evidence](workflow-authoring-evidence.md) — context
  measurements and model-comprehension comparisons.
