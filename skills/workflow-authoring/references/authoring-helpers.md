# Authoring helpers

Deterministic, resume-safe combinators for the workflows the basic `agent()` /
`parallel()` surface leaves hand-rolled: long-input chunking, classify-and-act
routing, cooperative time bounds, and panel consensus with arbitration. All of
them are built purely on `agent()`/`parallel()`, so every agent call they make
journals under a stable call index and resume keeps working.

## Helpers

| Helper | Authoring contract |
| --- | --- |
| `chunked(items, { chunkSize, mapper, synthesizer? })` | Splits the input into deterministic `chunkSize` slices and runs `mapper(chunk, chunkIndex)` once per chunk through `parallel()`. Chunk boundaries depend only on item order and `chunkSize`, so `agent()` calls inside `mapper` keep stable resume hashes when the prompt embeds the chunk content and `chunkIndex`. A recoverable-null chunk result stays `null` in `results` AND is recorded in `failed` with its stable index and chunk. Non-recoverable failures (token budget, agent limit, abort) and plain mapper errors rethrow. With `synthesizer` the helper returns the synthesizer output; else it returns `{ results, failed, chunkCount }`. |
| `route(value, { cases, fallback })` | One schema'd classification agent picks among the enum of eligible case keys, then pure-JS dispatch runs the matched case. A case whose `when(value)` guard fails never reaches the classification enum; when no case is eligible the `fallback` runs with reason `"no-eligible-case"` and no `agent()` is called. A recoverable-null classification routes to `fallback` with reason `"classification-failed"`; an out-of-enum key routes with reason `"unknown"`. Returns `{ key, result, fallback, reason }`. The classification prompt embeds the value and the eligible key list, so the resume hash is stable per value + case list. |
| `timeboxed(fn, { maxElapsedMs })` | Cooperative wall-clock bound: `fn(context)` checks `context.expired()` / `context.remaining()` at its own decision points and returns early with partial results. `timeboxed` never interrupts a running fn. After fn settles it returns `{ result, timedOut, elapsedMs, maxElapsedMs }` — `timedOut` truthfully reports whether the deadline was exceeded. Non-finite `maxElapsedMs` throws a `TypeError`; finite values are floored and clamped to at least 0. |
| `elapsedMs()` | Monotonic non-negative milliseconds since the top-level run start, shared across nested `workflow()` frames. **Never** embed its value in prompts or hashes: wall-clock values are not resume-stable (the determinism prelude blocks clocks, and a resumed run replays cached calls fast and observes different elapsed values). Use a counter seeded from `args` for anything that must be stable across resume. |
| `consensus(question, { panelists, rounds, agreeThreshold, arbitrator? })` | N independent schema'd verdicts per round via `parallel()` + `tolerantVote`. Each round polls `panelists` (default 3) with a structured `{ verdict: boolean, reasoning? }` schema. Per-vote recoverable nulls are omitted and shrink the denominator (logged) — a failed panelist never vetoes or dilutes surviving votes. The pairwise agreement gate passes when the largest mutually-agreeing group covers at least `agreeThreshold` (default 0.66) of valid votes. Rounds are bounded (default 2). After the round budget, an optional `arbitrator` — typically one structured `agent()` call — may run; its output is returned verbatim in the `arbitration` field while `agreed` stays `false` and `verdict` stays `null` (arbitration never rewrites them). Without an arbitrator the disagreement is returned honestly with `agreed: false`. Returns `{ agreed, verdict, count, total, votes, rounds, omitted, arbitration? }`. Non-finite `panelists`/`rounds` throw a `TypeError`; finite values are floored and clamped to at least 1; `agreeThreshold` is clamped to `[0, 1]`. |

## Semantics

- **Chunking is deterministic by construction.** `chunked` partitions with
  `items.slice(i, i + chunkSize)` in item order; the same input array and
  `chunkSize` always produce the same `(chunk, chunkIndex)` pairs. Keep item
  order stable (seed it from `args` when the input comes from a nondeterministic
  source) so resume hashes stay stable. Prefer chunk prompts that embed the
  chunk content and `chunkIndex` over global counters — a changed item makes
  only the affected chunk(s) cache-miss on resume, not the whole fan-out.
- **Classification is value + case-list keyed.** `route` stringifies `value`
  into the classification prompt together with the eligible key list. Editing
  `cases` (adding, removing, or reordering keys) or changing `value` changes the
  prompt, which changes the resume hash — the cached classification correctly
  misses. `when` guards run before any agent call, so a fully-unguarded
  (`when: () => false`) value costs zero tokens and always falls back.
- **Time bounds are cooperative, not preemptive.** A racing `timeboxed` that
  abandoned `fn` would leave the script's continuation executing after the run
  returned — possibly calling `agent()` past the drain. Instead `fn` owns its
  exit: check `context.expired()` before starting expensive work and between
  chunks, return the partials you have, and let `timedOut: true` record the
  outcome. `context.elapsed()` and the global `elapsedMs()` are monotonic
  (non-decreasing, floored at 0) host-clock values.
- **Consensus shrinks, never dilutes.** A panelist whose vote is a recoverable
  `null` (schema noncompliance, execution failure, or exhausted retries) is
  omitted from the denominator and logged; the surviving votes decide. Rounds
  are bounded, so a noisy panel cannot burn the whole token budget — and the
  optional `arbitrator` gives the run a single decisive (typically structured)
  verdict instead of forcing a bare majority or a failed run.

## Error behavior

| Helper | Recoverable failure | Non-recoverable failure | Author errors |
| --- | --- | --- | --- |
| `chunked` | mapper result `null` → kept in `results` in place + listed in `failed` | budget/agent-limit/abort and plain mapper errors rethrow | non-array `items`, non-function `mapper`, non-finite `chunkSize` → `TypeError` |
| `route` | `null` classification (exhausted agent or tolerated schema/execution failure) → `fallback`, reason `"classification-failed"` | budget/agent-limit/abort rethrow | empty/duplicate `cases`, non-function `fallback`/`run` → `TypeError` |
| `timeboxed` | n/a (no agent call inside the helper itself) | n/a | non-finite `maxElapsedMs` → `TypeError` |
| `consensus` | per-vote `null` → omitted, denominator shrinks, logged | budget/agent-limit/abort rethrow | nonblank question required; non-finite `panelists`/`rounds`/`agreeThreshold` → `TypeError` |

## Resume safety

Every agent call these helpers make goes through `agent()`/`parallel()`, so it
journals under a stable call index exactly like any hand-written call:

- `chunked` hashes depend only on chunk content + stable chunk index (see
  above); reordering items re-chunks and re-runs only the affected chunks.
- `route` classification hashes depend on `value` + the eligible key list; the
  dispatched `run(value)` is whatever the author's case does (typically its own
  `agent()` call, journaled normally).
- `timeboxed`/`elapsedMs()` values are **never** part of a resume hash and must
  never be embedded in prompts. The `timedOut` flag is timing-dependent and
  unjournaled: a resumed run replays cached calls fast, so the same `timeboxed`
  call may not time out where the original run did. Treat it as steering (stop
  adding more chunks), never as part of the run's identity.
- `consensus` votes journal per panelist per round; a changed question or
  panelist count invalidates exactly the affected calls. The `arbitrator`'s own
  `agent()` call journals normally too.
