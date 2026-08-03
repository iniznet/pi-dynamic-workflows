# Workflow authoring

Workflows are JavaScript orchestration programs executed by the `workflow` tool. The table below is generated from the extension's executable capability contract, so its names, signatures, options, and defaults match the installed runtime.

Use the packaged `workflow-authoring` skill for pattern selection, lifecycle rules, review and debugging guidance, and adaptable examples. Those explanations remain hand-written. Configured model routes and agent types are dynamic references; obtain their names and purposes from the active user or project context rather than this static page.

See [Workflow prompt guidance rationale](workflow-prompt-guidance-rationale.md) for the decision-by-decision record of prompt insertions, removals, and compactions. See [Workflow authoring evidence](workflow-authoring-evidence.md) for context measurements and the non-gating model-comprehension comparison.

## Supported capabilities

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`: string (optional; default: derived from phase and call count)<br>`phase`: string (optional; default: current phase)<br>`schema`: plain JSON Schema (optional)<br>`model`: string (optional)<br>`tier`: string (optional)<br>`isolation`: "worktree" (optional)<br>`agentType`: string (optional)<br>`timeoutMs`: number \| null (optional; default: run timeout; null disables)<br>`retries`: number (optional; default: run retry count) |
| parallel | runtime-global | `parallel(thunks) => Promise<Array<unknown \| null>>` | — |
| pipeline | runtime-global | `pipeline(items, ...stages) => Promise<Array<unknown \| null>>` | — |
| workflow | runtime-global | `workflow(savedName, childArgs?) => Promise<unknown>` | — |
| verify | runtime-global | `verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>` | `reviewers`: number (optional; default: 2)<br>`threshold`: number (optional; default: 0.5)<br>`lens`: string \| string[] (optional) |
| judgePanel | runtime-global | `judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } \| undefined>` | `judges`: number (optional; default: 3)<br>`rubric`: string (optional; default: "overall quality and correctness") |
| loopUntilDry | runtime-global | `loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<{ items: unknown[]; termination: "dry" \| "maxRounds" \| "capacity" \| "failed"; failedRounds: number }>` | `round`: (roundIndex: number) => unknown[] \| Promise<unknown[]> (required)<br>`key`: (item: unknown) => string (optional; default: JSON.stringify)<br>`consecutiveEmpty`: number (optional; default: 2)<br>`maxRounds`: number (optional; default: 50) |
| completenessCheck | runtime-global | `completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>` | — |
| chunked | runtime-global | `chunked(items: unknown[], options: { chunkSize: number; mapper: (chunk: unknown[], chunkIndex: number) => unknown \| Promise<unknown>; synthesizer?: (results: Array<unknown \| null>, meta: { failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number; items: unknown[] }) => unknown \| Promise<unknown> }) => Promise<{ results: Array<unknown \| null>; failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number } \| unknown>` | `chunkSize`: number (required)<br>`mapper`: (chunk: unknown[], chunkIndex: number) => unknown \| Promise<unknown> (required)<br>`synthesizer`: (results, meta) => unknown \| Promise<unknown> (optional) |
| route | runtime-global | `route(value: unknown, options: { cases: Array<{ key: string; when?: (value: unknown) => boolean \| Promise<boolean>; run: (value: unknown) => unknown \| Promise<unknown> }>; fallback: (value: unknown, context: { reason: "no-eligible-case" \| "classification-failed" \| "unknown"; classification: string \| null }) => unknown \| Promise<unknown> }) => Promise<{ key: string \| null; result: unknown; fallback: boolean; reason: "none" \| "no-eligible-case" \| "classification-failed" \| "unknown" }>` | `cases`: Array<{ key: string; when?: (value) => boolean \| Promise<boolean>; run: (value) => unknown \| Promise<unknown> } (required)<br>`fallback`: (value, context) => unknown \| Promise<unknown> (required) |
| timeboxed | runtime-global | `timeboxed(fn: (context: { elapsed(): number; remaining(): number; expired(): boolean }) => unknown \| Promise<unknown>, options: { maxElapsedMs: number }) => Promise<{ result: unknown; timedOut: boolean; elapsedMs: number; maxElapsedMs: number }>` | `maxElapsedMs`: number (required) |
| elapsedMs | runtime-global | `elapsedMs() => number` | — |
| consensus | runtime-global | `consensus(question: string, options?: { panelists?: number; rounds?: number; agreeThreshold?: number; arbitrator?: (context: { question: string; votes: Array<{ verdict: boolean; reasoning?: string } \| null>; rounds: number }) => unknown \| Promise<unknown> }) => Promise<{ agreed: boolean; verdict: boolean \| null; count: number; total: number; votes: Array<{ verdict: boolean; reasoning?: string } \| null>; rounds: number; omitted: number; arbitration?: unknown }>` | `panelists`: number (optional; default: 3)<br>`rounds`: number (optional; default: 2)<br>`agreeThreshold`: number (optional; default: 0.66)<br>`arbitrator`: (context) => unknown \| Promise<unknown> (optional) |
| retry | runtime-global | `retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>` | `attempts`: number (optional; default: 3)<br>`until`: (result: unknown) => boolean (optional; default: accept first result when omitted) |
| gate | runtime-global | `gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>` | `attempts`: number (optional; default: 3) |
| checkpoint | runtime-global | `checkpoint(prompt, options?) => Promise<unknown>` | `default`: unknown (optional; default: true when no UI and omitted)<br>`headless`: "default" \| "abort" (optional; default: "default")<br>`kind`: "confirm" \| "input" \| "select" (optional; default: "confirm")<br>`choices`: string[] (optional)<br>`timeoutMs`: number (optional) |
| log | runtime-global | `log(message) => void` | — |
| phase | runtime-global | `phase(title, options?) => void` | `budget`: number (optional)<br>`stage`: 0 \| 1 \| 2 \| 3 (optional) |
| args | runtime-global | `args: unknown` | — |
| cwd | runtime-global | `cwd: string` | — |
| process | runtime-global | `process: { cwd(): string }` | — |
| budget | runtime-global | `budget: { total, spent(), remaining() }` | — |
| script | workflow-tool-input | `script?: string` | — |
| name | workflow-tool-input | `name?: string` | — |
| args | workflow-tool-input | `args?: unknown` | — |
| background | workflow-tool-input | `background?: boolean = true` | — |
| maxAgents | workflow-tool-input | `maxAgents?: number = 1000` | — |
| concurrency | workflow-tool-input | `concurrency?: number` | — |
| agentRetries | workflow-tool-input | `agentRetries?: number = configured value or 0` | — |
| agentTimeoutMs | workflow-tool-input | `agentTimeoutMs?: number = configured default or unbounded` | — |
| tokenBudget | workflow-tool-input | `tokenBudget?: number = configured default or unlimited` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
| dryRun | workflow-tool-input | `dryRun?: boolean = false` | — |
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->

## Run options outside the tool schema

These options are SDK-level (`runWorkflow` / `WorkflowManager.exec`), not tool inputs or globals:

- `drainTimeoutMs` (default 60 s): after the script finishes, the run waits up to this for un-awaited `agent()` calls, then aborts them.
- `maxNestedWorkflowDepth` (default 1, clamped 1–8): recursion ceiling for nested `workflow()` calls.
- `preRunTypecheck` (default off): soft-fail `tsc --noEmit` on the script before launch.
- `compactJournal` (default off): resolved journal segments are replaced by a lossless summary only if reconstruction reproduces the original byte-identically; the option is frozen at run start and carried across resume.
- `checkpointGate` / `phaseState`: `checkpoint()` publishes and waits for a verdict — approve → `true` (or the declared default for input/select), deny/timeout → `false`; journaled replies replay on resume without re-contacting the gate. `phase(title, {stage})` queues forward-only transitions; gated `agent()` throws `SUBAGENT_SPAWN_BLOCKED` before Phase 3 + human approval.
- `onRetrySpend(spend)`: receives a full `AgentUsage` breakdown on each retry spend.

The terminating structured-output tool renders its call and captured payload in the TUI (`renderCall`/`renderResult`).

Agent option not in the contract table: `keepWorktree` — edits are always finalized (`git add -A` + `commit --allow-empty`); with it the branch+path are retained, otherwise discarded. Worktrees live at `<repoRoot>/.pi/worktrees/<id>` (branch `pi/wf/<id>`); leftovers from crashed runs are swept at startup.

## Persistence

Persisted runs keep `checkpoints[]` separate from the operation journal (legacy journal-shaped checkpoints are read back transparently). The journal is capped (50,000 entries / 32 MiB budget; oldest dropped and re-run live on resume), and persisted run JSON is scrubbed of secrets.

## Error codes

`WorkflowError.code` is inspectable: `PHASE_TRANSITION_INVALID` (-31001), `SUBAGENT_SPAWN_BLOCKED` (-31002, recoverable: false — thrown by a gated `agent()` spawn, not `UNKNOWN`), `APPROVAL_REQUIRED` (-31003).

## Phase modules (library surface)

Beyond the phase gates above, the package ships the Phase 0–2 planning modules as exported library APIs:

- **Wayfinder (Phase 0)** — `assessPrompt()` replaces a numeric clarity score with a statable-question fog gate (`{ isFoggy, questions[] }`); decision maps persist to `.pi/workflows/map.md` (markdown index) with a `map.json` sidecar, and the ticket lifecycle (`beginSession`, `resolveTicket`/`blockTicket`/`unblockTicket`, one ticket per session) refuses cycle-closing blocking edges and never lets a resolved ticket revert to blocked.
- **Prewalk (Phase 1)** — `generateBlueprint(codebaseSummary, task)` produces a validated execution blueprint (preconditions / steps / fail-safe procedures / verification tests, capped at 6/8/4/4 items) saved to `.pi/workflows/blueprints/<id>.json`; `loadBlueprint` picks the newest.
- **Plannotator bridge (Phase 2)** — `createPlannotatorBridge(...)` serves the human approval gate over HTTP (`/sse` updates with heartbeat, `/reviewed` on settle); see the README's runtime reference for usage.
