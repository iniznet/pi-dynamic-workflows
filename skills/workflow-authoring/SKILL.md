---
name: workflow-authoring
description: Guidance for writing, editing, reviewing, and debugging JavaScript workflow code for pi-dynamic-workflows. Use when authoring or changing workflow scripts; not for merely running an existing workflow.
metadata:
  version: "3.6.0"
---

# Workflow authoring

Load this skill when workflow JavaScript changes. Running an existing workflow needs no authoring reference.

## Choose a branch

Read only what the task needs:

- **Write or edit:** start with [runtime](references/runtime.md). Add [pattern selection](references/pattern-selection.md) for topology, [lifecycle](references/lifecycle.md) for limits or resume, and [focused recipes](references/focused-recipes.md) for the matching concern.
- **Helper task:** read [quality helpers](references/quality-helpers.md) only for `verify` or `judgePanel`, the [retry helper](references/retry-helper.md) only for `retry`, [specialized helpers](references/specialized-helpers.md) only for `completenessCheck`, `loopUntilDry`, `gate`, or `checkpoint`, and [authoring helpers](references/authoring-helpers.md) for `chunked`, `route`, `timeboxed`/`elapsedMs`, `ctx`, or `consensus`.
- **Review:** use the [review checklist](references/review.md), plus only the matching [quality](references/quality-helpers.md) or [specialized](references/specialized-helpers.md) helper contracts.
- **Debug:** use the [debugging map](references/debugging.md).
- **Routing:** read [registry ownership](references/registry-ownership.md) before using `model`, `tier`, phase models, or `agentType`; use environment-specific names only when context supplies them.
- **Exact lookup or portability:** start with the generated [capability index](references/capabilities.md). Follow its exhaustive-facts pointer only for constraints or support boundaries. Use [versions](references/versions.md) when moving scripts between installations.

## Invariants

- Start with literal `export const meta = { name, description }`; declare phases as an array of used `{ title }` objects and enter each named phase.
- Call `agent()` at least once, give every call a short unique `label`, and return plain JSON data explicitly.
- Pair ordered results with stable work IDs before filtering. When one agent consumes another's selected result, include both its stable ID and actual data in the downstream prompt. Treat recoverable `null` as missing coverage and report it.
- Bound fan-out, loops, retries, agents, and concurrency to the task. Treat invocation-level token and time caps as opt-in user constraints, not defaults.
- Bound long-running bash steps with an explicit `timeout` and progress-emitting output. The settings-gated idle watchdog (off by default) kills a subagent bash command that emits no output for `commandIdleTimeoutMs` and returns its partial output + a `[killed: idle …]` marker as a normal tool result, and the run-level watcher aborts an agent call silent for `agentIdleTimeoutMs` and auto-resumes it once. Both are pure runtime envelopes — never part of any `agent()` resume hash.
- Use `log()` for new code; `console` is compatibility-only.
- Dedupe shared task/scope/objective text with `ctx(text)`: call it once, embed the returned pointer (e.g. `[[ctx:0]]`) in every agent prompt that needs the text, and let the runtime emit the full blob once. `ctx()` stores each distinct blob exactly once per run (the same text always returns the same pointer — the dedupe guarantee) and the blob is part of the resume identity hash, so editing the shared text invalidates cached replays; agents after the first read the blob from the store with `store_get` when their prompt references a pointer. See the [authoring helpers](references/authoring-helpers.md) reference for the full contract.
- Write plain JavaScript without imports or filesystem modules. Pass nondeterminism through `args`; `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable.
- Never branch on `timeboxed()`/`elapsedMs()` output: the `timedOut` flag and elapsed values are wall-clock, never journaled, and never part of any resume hash — a resumed run can report different timing than the original. Pass timing bounds through `args` and treat a timebox expiry as a reported outcome, never a decision input (see [runtime](references/runtime.md)).
- Subagent tool availability is settings-gated, never script-declared — including host-captured extension tools (`subagentExtensionTools`; e.g. pi-vision-handoff's `describe_image`), which default to `off` and must be opted into.

## Running the suite

Verify workflow changes with the full unit suite through the runner — never a raw uncapped invocation:

```bash
npm run test:unit        # or: node scripts/run-tests.mjs
```

`npm run test:unit` caps file-level concurrency (`min(availableParallelism() - 1, 2)`), serializes concurrent invocations via the cross-process suite lock, and honours `PI_TEST_CONCURRENCY` / `PI_TEST_TIMEOUT_MS`. Running `npx tsx --test` or `node --test` directly at default concurrency spawns `availableParallelism() - 1` file workers per invocation and pegs the box.

A workflow `testCommand` override naming a directory or glob runs uncapped (node's default `availableParallelism() - 1` workers per task) — keep overrides to a single test file.
