# Runtime authoring

Use this page for routine scripts. Open the generated capability index only when a signature, default, support boundary, or installed-version fact is missing here.

## Script envelope

Start with the only legal export: `export const meta = { name, description, phases?: [{ title, detail?, model? }] }`. Values are nonblank literals; declare only used phases and call `phase()` before each phase's work. The remaining body already runs inside an async function: write helpers as ordinary declarations; `export default` and other exports are invalid. Return the result explicitly.

The runtime supplies `agent`, `parallel`, `pipeline`, `workflow`, quality/control helpers, `phase`, `log`, `ctx`, `args`, `cwd`, restricted `process.cwd()`, and `budget`. Imports, `require()`, filesystem modules, `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable. The Node VM realm is implementation substrate, not a security boundary or public API.

## Script source

Pass the script inline as `script`, or point the tool at a file with `scriptPath`. The two are mutually exclusive, and both exclude `name` (saved/built-in) — provide exactly one source. The full input surface (`name`, `args`, `background`, `maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, `failOnExhaustedAgent`, `tokenBudget`, `resumeFromRunId`, `dryRun`) lives in the generated capability index; the defaults that matter while authoring are `background: true`, `maxAgents: 1000` (a safety ceiling, not a target), and `failOnExhaustedAgent: true` (strict completion).

`scriptPath` is for scripts authored in a file first. An absolute path is used as-is; a relative path resolves against the workflow tool's cwd. The file is read once, by the extension process, before the run — the no-fs rule inside the vm governs the script runtime, not the loading of the file itself — and the content is used exactly as if it had been passed inline as `script`: same `meta` contract, same determinism rules, same validation. Inside the vm the script still cannot `import`/`require` or read sibling files at runtime, so keep every helper in the one file.

Syntax-gate a file before handing it over with `npx tsx scripts/check-workflow-script.ts <file>` — it runs the same `parseWorkflowScript` the tool uses (acorn with top-level `await`/`return` allowed, determinism blocklist, `export const meta` first). Plain `node --check` is not a faithful substitute: top-level `return` is legal inside the workflow vm sandbox but a hard syntax error in plain ESM, so node would reject valid scripts.

## Topology

- `parallel()` takes thunks, runs independent work, and preserves input order. Await the whole array before whole-set synthesis.
- `pipeline()` runs stages sequentially per item while items proceed concurrently. Each stage receives `(previousValue, originalItem, index)` and forwards `null` to the next stage, so guard missing coverage first.
- `workflow(name, childArgs?)` runs a context-supplied saved workflow. Nesting is one level and shares limits, counters, tokens, and store; `childArgs` are passed through as-is. Typed-parameter coercion and validation happen on the host-side `name` launch (the `workflow` tool's `name` input or a saved-workflow command), not inside scripts.

## Data and failure

Call `agent(prompt, { label, schema? })`; it returns text, a schema-validated value, or recoverable `null`. Nonrecoverable limit, validation, and budget failures throw. Record each intended work ID before filtering. A `null` means missing coverage, never a negative finding.

When JavaScript reads fields, pass a small plain JSON Schema. Schema noncompliance after repair throws and bypasses agent retries. Catch it only to return an explicit incomplete outcome without reading missing fields. Return objects, arrays, strings, numbers, booleans, and `null`—not functions, promises, cycles, `BigInt`, or runtime handles.

## Shared context

Fan-out scripts (reviewers, finders, gatherers, per-step verifiers) used to
re-embed the same task/scope/objective text into every `agent()` prompt. Use
`ctx(text)` instead: call it ONCE, keep the returned pointer, and embed the
pointer in every prompt that needs the text.

- **Dedupe guarantee:** each distinct text is stored exactly once per run; a
  repeated `ctx()` with the same text returns the same pointer and never
  re-stores. The full blob is emitted into the first agent's instructions;
  every later agent gets a store-key note and reads the text with
  `store_get("wf:ctx:0")` (store tools are injected into every agent).
- **Resume safety:** the blob is part of the resume identity hash (like model,
  phase, and agentType). Editing the shared text invalidates cached replays of
  calls downstream of the `ctx()` registration; an unchanged script replays
  byte-identically.
- **Degradation:** empty/absent text returns `""` (no-op); non-string values
  are JSON-stringified; an oversized blob or the distinct-blob cap returns the
  raw text so the script keeps working exactly as it would without `ctx()`.

## Routing and support

Selector priority is explicit `model` > `agentType` model > `tier` > phase model > metadata model > implicit `medium` > session default. An unavailable EXPLICIT selector (`model`, `agentType` model, `tier`, or phase model) throws instead of falling back — catch it if the script needs to degrade gracefully. Only the implicit default `medium` tier an untagged agent falls into degrades to the session default when unavailable, with a one-time warning logged into the run. Use exact `model`, nonstandard `tier`, or `agentType` only when context supplies its name and purpose. Worktree isolation is best-effort. See [registry ownership](registry-ownership.md).

Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only. VM realm facilities are internal. Active model routes and agent types are dynamic. Use `log()` in new scripts.
