# Workflow authoring

Workflows are JavaScript orchestration programs executed by the `workflow` tool. The table below is generated from the extension's executable capability contract, so its names, signatures, options, and defaults match the installed runtime.

Use the packaged `workflow-authoring` skill for pattern selection, lifecycle rules, review and debugging guidance, and adaptable examples. Those explanations remain hand-written. Configured model routes and agent types are dynamic references; obtain their names and purposes from the active user or project context rather than this static page.

See [Workflow prompt guidance rationale](workflow-prompt-guidance-rationale.md) for the decision-by-decision record of prompt insertions, removals, and compactions. See [Workflow authoring evidence](workflow-authoring-evidence.md) for context measurements and the non-gating model-comprehension comparison.

## Supported capabilities

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`: string (optional; default: derived from phase and call count)<br>`phase`: string (optional; default: current phase)<br>`schema`: plain JSON Schema (optional)<br>`model`: string (optional)<br>`tier`: "small" \| "medium" \| "big" (optional)<br>`isolation`: "worktree" (optional)<br>`agentType`: string (optional)<br>`toolNames`: string[] (optional; default: full toolset)<br>`timeoutMs`: number \| null (optional; default: run timeout; null disables)<br>`retries`: number (optional; default: run retry count)<br>`retryOnlyIfSpendUnder`: number (optional; default: run-level default) |
| parallel | runtime-global | `parallel(thunks, options?) => Promise<Array<unknown \| null>>` | `concurrency`: number (optional; default: 16 (MAX_CONCURRENCY))<br>`autoApproved`: boolean (optional; default: false) |
| pipeline | runtime-global | `pipeline(items, ...stages[, options]) => Promise<Array<unknown \| null>>` | `concurrency`: number (optional; default: 16 (MAX_CONCURRENCY))<br>`autoApproved`: boolean (optional; default: false) |
| subagentTools | runtime-global | `subagentTools.search(query?) / describe(name) / select(capability) / capabilities() => capability discovery over the run's captured subagent tool registry` | — |
| durableStore | runtime-global | `durableStore.get(key) / has(key) / keys() / put(key, value) / putOnce(id, key, value) / compareAndSwap(key, expected, next) / record(entry) / snapshot() => cross-run project-scoped KV + provenance ledger (async writes; await them)` | — |
| supervisedRun | runtime-global | `supervisedRun({ task, criterion, maxRounds?, taskLabel?, taskTier?, taskPhase?, supervisorTier?, supervisorTools?, correctionTier? }) => Promise<{ result, supervisor: { rounds, declaredDone, termination, finalVerdict, verdicts, corrections, observations } }>` | `task`: string (required)<br>`criterion`: string (required)<br>`maxRounds`: number (optional; default: 5)<br>`taskLabel`: string (optional; default: "task")<br>`taskTier`: string (optional; default: run default)<br>`taskPhase`: string (optional; default: current phase)<br>`supervisorTier`: string (optional; default: "small" (economy helper tier))<br>`supervisorTools`: string[] (optional; default: [] (pure-reasoning))<br>`correctionTier`: string (optional; default: taskTier, else run default) |
| getRunReport | runtime-global | `getRunReport(runId?) / getRunReport() / getRunReport({ limit? }) => Promise<RunReport \| null \| RunReportSummary[]>: read a prior run's report artifact (`<runsDir>/reports/<runId>.json`) or list recent reports newest-first` | — |
| recall | runtime-global | `recall({ query?, keywords?, phase?, pattern?, limit? }) => Promise<{ hits, context }>: rank prior cross-run task knowledge (KB entries distilled at run completion + run-report artifacts) into a privacy-safe context block` | — |
| lineage | runtime-global | `lineage({ runId?, source?, file?, phase?, agent?, pattern?, limit?, verify?, ttlMs? }) => Promise<{ entries, runs, decay, verification? }>: cross-run provenance-ledger query with deterministic evidence freshness/decay` | — |
| workflow | runtime-global | `workflow(savedName, childArgs?) => Promise<unknown>` | — |
| verify | runtime-global | `verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[]; maxChars?: number; tier?: string; distinctModel?: string }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }>; crossCheck?: { model: string; verdict: boolean; agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } } }>` | `reviewers`: number (optional; default: 2)<br>`threshold`: number (optional; default: 0.5)<br>`lens`: string \| string[] (optional)<br>`maxChars`: number (optional; default: 4000)<br>`tier`: "small" \| "medium" \| "big" (optional; default: "small")<br>`distinctModel`: string (optional) |
| judgePanel | runtime-global | `judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string; distinctModel?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }>; crossCheck?: { model: string; verdict: boolean; agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } } } \| undefined>` | `judges`: number (optional; default: 3)<br>`rubric`: string (optional; default: "overall quality and correctness")<br>`distinctModel`: string (optional) |
| gate | runtime-global | `gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>` | `attempts`: number (optional; default: 3) |
| testGate | runtime-global | `testGate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, options: { tests: Array<{ command: string; assert?: { exitCode?: number; outputContains?: string; outputMatches?: string; fileContains?: string } }>; postconditions?: string[]; attempts?: number; tool?: 'bash' \| 'grep' }) => Promise<{ ok: boolean; value: unknown; attempts: number; tests: Array<{ command: string; passed: boolean; detail: string; exitCode: number \| null; output: string }> }>` | `tests`: Array<{ command: string; assert?: { exitCode?: number; outputContains?: string; outputMatches?: string; fileContains?: string } }> (required)<br>`postconditions`: string[] (optional)<br>`attempts`: number (optional; default: 3)<br>`tool`: "bash" \| "grep" (optional; default: "bash") |
| loopUntilDry | runtime-global | `loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number; maxRoundCost?: number }) => Promise<{ items: unknown[]; termination: "dry" \| "maxRounds" \| "capacity" \| "failed" \| "costSaturated"; failedRounds: number }>` | `round`: (roundIndex: number) => unknown[] \| Promise<unknown[]> (required)<br>`key`: (item: unknown) => string (optional; default: JSON.stringify)<br>`consecutiveEmpty`: number (optional; default: 2)<br>`maxRounds`: number (optional; default: 50)<br>`maxRoundCost`: number (optional; default: no cap) |
| completenessCheck | runtime-global | `completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>` | — |
| chunked | runtime-global | `chunked(items: unknown[], options: { chunkSize: number; mapper: (chunk: unknown[], chunkIndex: number) => unknown \| Promise<unknown>; synthesizer?: (results: Array<unknown \| null>, meta: { failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number; items: unknown[] }) => unknown \| Promise<unknown> }) => Promise<{ results: Array<unknown \| null>; failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number } \| unknown>` | `chunkSize`: number (required)<br>`mapper`: (chunk: unknown[], chunkIndex: number) => unknown \| Promise<unknown> (required)<br>`synthesizer`: (results, meta) => unknown \| Promise<unknown> (optional) |
| recursive | runtime-global | `recursive(items: unknown[], options: { split: (items: unknown[], depth: number) => unknown[][] \| Promise<unknown[][]>; solve: (items: unknown[], depth: number, meta: { path: string; branchBudget: number; depth: number }) => unknown \| Promise<unknown>; merge?: (results: Array<unknown \| null>, meta: { depth: number; path: string; branchBudget: number; failed: Array<{ path: string; depth: number }>; items: unknown[] }) => unknown \| Promise<unknown>; maxDepth?: number; maxRecursiveRoots?: number; concurrency?: number; autoApproved?: boolean }) => Promise<{ result: unknown; depth: number; completedBranches: number; failedBranches: number; totalBranches: number }>` | `split`: (items: unknown[], depth: number) => unknown[][] \| Promise<unknown[][]> (required)<br>`solve`: (items, depth, meta) => unknown \| Promise<unknown> (required)<br>`merge`: (results, meta) => unknown \| Promise<unknown> (optional)<br>`maxDepth`: number (optional; default: 2)<br>`maxRecursiveRoots`: number (optional; default: 16)<br>`concurrency`: number (optional; default: run concurrency)<br>`autoApproved`: boolean (optional; default: false) |
| replanSignal | runtime-global | `replanSignal() => { triggered: boolean; events: number; forecast: { spent: number; plannedRemaining: number; projectedTotal: number; budget: number \| null; threshold: number; overBudget: boolean } }` | — |
| spendAnalytics | runtime-global | `spendAnalytics(options?: { limit?: number }) => { runCount: number; totals: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number; freshSpend: number; agents: number }; perPhase: Array<{ name: string; spend: number; runs: number }>; perPattern: Array<{ name: string; spend: number; runs: number }>; perProvider: Array<{ name: string; spend: number; runs: number }>; trend: Array<{ runId: string; workflowName: string; status: string; total: number; agents: number; at: string }>; runs: Array<SpendLedgerEntry> }` | — |
| steerPlan | runtime-global | `steerPlan.read() => { runId: string; currentPhase: string \| null; phases: Array<{ title: string; budget: number \| null; spend: number }>; agentCount: number; callSeq: number; budget: { limit: number \| null; spent: number; remaining: number }; forecast: { spent: number; plannedRemaining: number; projectedTotal: number; budget: number \| null; threshold: number; overBudget: boolean }; revisions: Array<{ phases?: Array<{ title: string; budget?: number }>; currentPhase?: string; note?: string; reason?: string }> }; steerPlan.submit(revision: { phases?: Array<{ title: string; budget?: number }>; currentPhase?: string; note?: string; reason?: string }) => the applied (normalized) revision` | — |
| route | runtime-global | `route(value: unknown, options: { cases: Array<{ key: string; when?: (value: unknown) => boolean \| Promise<boolean>; run: (value: unknown) => unknown \| Promise<unknown> }>; fallback: (value: unknown, context: { reason: "no-eligible-case" \| "classification-failed" \| "unknown"; classification: string \| null }) => unknown \| Promise<unknown> }) => Promise<{ key: string \| null; result: unknown; fallback: boolean; reason: "none" \| "no-eligible-case" \| "classification-failed" \| "unknown" }>` | `cases`: Array<{ key: string; when?: (value) => boolean \| Promise<boolean>; run: (value) => unknown \| Promise<unknown> } (required)<br>`fallback`: (value, context) => unknown \| Promise<unknown> (required) |
| timeboxed | runtime-global | `timeboxed(fn: (context: { elapsed(): number; remaining(): number; expired(): boolean }) => unknown \| Promise<unknown>, options: { maxElapsedMs: number }) => Promise<{ result: unknown; timedOut: boolean; elapsedMs: number; maxElapsedMs: number }>` | `maxElapsedMs`: number (required) |
| elapsedMs | runtime-global | `elapsedMs() => number` | — |
| ctx | runtime-global | `ctx(sharedText: string \| unknown) => string` | — |
| consensus | runtime-global | `consensus(question: string, options?: { panelists?: number; rounds?: number; agreeThreshold?: number; arbitrator?: (context: { question: string; votes: Array<{ verdict: boolean; reasoning?: string } \| null>; rounds: number }) => unknown \| Promise<unknown> }) => Promise<{ agreed: boolean; verdict: boolean \| null; count: number; total: number; votes: Array<{ verdict: boolean; reasoning?: string } \| null>; rounds: number; omitted: number; arbitration?: unknown }>` | `panelists`: number (optional; default: 3)<br>`rounds`: number (optional; default: 2)<br>`agreeThreshold`: number (optional; default: 0.66)<br>`arbitrator`: (context) => unknown \| Promise<unknown> (optional)<br>`distinctModel`: string (optional) |
| retry | runtime-global | `retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>` | `attempts`: number (optional; default: 3)<br>`until`: (result: unknown) => boolean (optional; default: accept first result when omitted) |
| checkpoint | runtime-global | `checkpoint(prompt, options?) => Promise<unknown>` | `default`: unknown (optional; default: true when no UI and omitted)<br>`headless`: "default" \| "abort" (optional; default: "default")<br>`kind`: "confirm" \| "input" \| "select" (optional; default: "confirm")<br>`choices`: string[] (optional)<br>`timeoutMs`: number (optional) |
| log | runtime-global | `log(message) => void` | — |
| phase | runtime-global | `phase(title, options?) => void` | `budget`: number (optional)<br>`stage`: 0 \| 1 \| 2 \| 3 (optional) |
| args | runtime-global | `args: unknown` | — |
| cwd | runtime-global | `cwd: string` | — |
| process | runtime-global | `process: { cwd(): string }` | — |
| budget | runtime-global | `budget: { total, spent(), remaining(), wouldExceed(estimatedTokens) }` | — |
| script | workflow-tool-input | `script?: string` | — |
| scriptPath | workflow-tool-input | `scriptPath?: string` | — |
| name | workflow-tool-input | `name?: string` | — |
| args | workflow-tool-input | `args?: unknown` | — |
| background | workflow-tool-input | `background?: boolean = true` | — |
| maxAgents | workflow-tool-input | `maxAgents?: number = 1000` | — |
| concurrency | workflow-tool-input | `concurrency?: number` | — |
| agentRetries | workflow-tool-input | `agentRetries?: number = configured value or 0` | — |
| retryOnlyIfSpendUnder | workflow-tool-input | `retryOnlyIfSpendUnder?: number` | — |
| agentTimeoutMs | workflow-tool-input | `agentTimeoutMs?: number = configured default or unbounded` | — |
| failOnExhaustedAgent | workflow-tool-input | `failOnExhaustedAgent?: boolean = true` | — |
| tokenBudget | workflow-tool-input | `tokenBudget?: number = configured default or unlimited` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
| dryRun | workflow-tool-input | `dryRun?: boolean = false` | — |
| estimate | workflow-tool-input | `estimate?: boolean (requires dryRun: true)` | — |
| replayFromRunId | workflow-tool-input | `replayFromRunId?: string (requires dryRun: true)` | — |
| replayFixture | workflow-tool-input | `replayFixture?: object (requires dryRun: true)` | — |
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

## Idle detection (settings-gated, off by default)

Two runtime envelopes catch subagents that stop producing work without failing. Both are configured under `~/.pi/workflows/settings.json` (or their `PI_WORKFLOW_*` env overrides) and are pure runtime behavior — never part of any `agent()` resume hash, so journal replay is byte-identical regardless of the knobs.

- `commandIdleTimeoutMs` (ms) — the command watchdog kills a subagent `bash` command that emits no output for this long. The partial output returns to the same agent session as a normal tool result with a deterministic `[killed: idle Ns — no output within the watchdog budget; process tree aborted]` marker, and the agent continues its turn; after the first kill in one attempt the marker also names the running kill count and the configured knobs. No command-level auto-retry — the AI decides next steps.
- `commandHardTimeoutMs` (ms) — run-level default bash timeout forwarded to the bash tool as seconds when the model passes no explicit per-call `timeout` (the model's timeout always wins; clamped to the SDK ceiling).
- `agentIdleTimeoutMs` (ms) — a run-level watcher aborts an in-flight agent call with no tool-result/token/activity movement for this long and auto-resumes it via the journaled retry machinery. Prefer a value above the 30 s soft idle hint and below `agentTimeoutMs` when both are configured.
- `agentIdleRetries` — the auto-retry budget for agent-idle aborts (unset → 1 when the timeout is enabled, else 0; explicit `0` exhausts on the first abort). Independent of `agentRetries`.

Three consecutive command-idle kills within one attempt mark the attempt stalling and the run-level watcher aborts it on its next tick — a hard bound on the kill/rerun churn loop.

## Workspace change-scope enforcement (phase-gated runs)

When a `phaseState` integration is wired, every phase boundary captures a workspace fingerprint (read-only `git rev-parse HEAD^{tree}` + `status --porcelain -uall`) and the run asserts that only intended files changed since the previous boundary. The intended set is the workflow system's own artifact dirs (everything under `.pi/`) plus the script's **declared outputs**: `export const meta = { name, description, outputs: ['docs/report.md', 'src/gen/'] }` — exact paths or `/`-suffixed dirs, relative to the run's cwd. The execute phase's agent work is asserted at the run's terminal settle (the last boundary snapshot fires at approval, before execute agents run), and a violation is recorded forward-only with the phase state (`scopeViolations`, like `fingerprints`).

The enforcement policy is documented in the manager: `flag` (default) records the violation and logs it without failing the run; `reject` fails the run closed with `WORKSPACE_SCOPE_VIOLATION` (deterministic across resume — the persisted boundary baseline is stable, so the same out-of-scope change re-rejects until the script's outputs or the files change); `confirm` routes the violation through the run's `confirm` handler (approval proceeds and is recorded as `approved`, denial rejects); `off` disables the assertion while the capture keeps persisting. Configure it with `WorkflowManagerOptions.workspaceScopeEnforce`, per-run `ExecOptions.workspaceScopeEnforce`, or the headless/CI env var `PI_WORKFLOW_WORKSPACE_SCOPE_ENFORCE` (`flag` | `reject` | `confirm` | `off`; precedence: per-run override > manager option > env > default `flag`). The snapshots and violation records are host-side observability — never part of any `agent()` resume hash.

## Subagent tool availability

What tools a subagent session gets is settings-gated, not script-declared: MCP tools via `subagentTools` (`all` default), host tools via `subagentHostTools`, vendored chrome via `subagentChromeTools`, and host-captured third-party extension tools via `subagentExtensionTools` — supi-web's `web_fetch_md`/`web_docs_*`, pi-codegraph's `codegraph_*`, and pi-vision-handoff's `describe_image` (captured in-process from the installed package/checkout; the setting defaults to `on`, so fresh installs get the captured research defs in subagents — flip it to `off` to restore no-defs-anywhere). The captured defs append to every built-in pattern's task-fit toolset and to the `toolset: "code-dev"` superset (all pattern subsets ∪ captured defs). Per-run exclusion and per-task toolsets (`toolset: "extension-tools"`) apply on top. Scripts can also query the run's captured registry at runtime with the `subagentTools` global (`search` / `describe` / `select` / `capabilities`): `select("web")` returns only tool names the current run can resolve, so `agent(prompt, { toolNames })` never silently drops a selected tool. `/workflows-subagent-tools` lists each tool's truthful status (`allowed` / `available-if-enabled` with the recovery step / `unavailable` with the one-line capture failure).

## Persistence

Persisted runs keep `checkpoints[]` separate from the operation journal (legacy journal-shaped checkpoints are read back transparently). The journal is capped (50,000 entries / 32 MiB budget; oldest dropped and re-run live on resume), and persisted run JSON is scrubbed of secrets.

## Error codes

`WorkflowError.code` is inspectable: `PHASE_TRANSITION_INVALID` (-31001), `SUBAGENT_SPAWN_BLOCKED` (-31002, recoverable: false — thrown by a gated `agent()` spawn, not `UNKNOWN`), `APPROVAL_REQUIRED` (-31003).

## Phase modules (library surface)

Beyond the phase gates above, the package ships the Phase 0–2 planning modules as exported library APIs:

- **Wayfinder (Phase 0)** — `assessPrompt()` replaces a numeric clarity score with a statable-question fog gate (`{ isFoggy, questions[] }`); decision maps persist to `.pi/workflows/map.md` (markdown index) with a `map.json` sidecar, and the ticket lifecycle (`beginSession`, `resolveTicket`/`blockTicket`/`unblockTicket`, one ticket per session) refuses cycle-closing blocking edges and never lets a resolved ticket revert to blocked. See [Wayfinder — Phase 0 decision tickets](wayfinder.md) for the storage story (the local map satisfies the PRD's "GitHub Issues **or** local" clause), the full lifecycle, and the optional future GitHub Issues branch.
- **Prewalk (Phase 1)** — `generateBlueprint(codebaseSummary, task)` produces a validated execution blueprint (preconditions / steps / fail-safe procedures / verification tests, capped at 6/8/4/4 items) saved to `.pi/workflows/blueprints/<id>.json`; `loadBlueprint` picks the newest.
- **Plannotator bridge (Phase 2)** — `createPlannotatorBridge(...)` serves the human approval gate over HTTP (`/sse` updates with heartbeat, `/reviewed` on settle); see the README's runtime reference for usage.

## Phase gating and model-tier contracts

Two PRD-level contracts are worth stating explicitly, because they are easy to read wrong from the capability table alone.

### The single enforced phase gate

Subagent spawning is gated in exactly one place: `assertPhaseGateOpen` inside `agent()`. When a `phaseState` integration is wired, the persisted state machine must be at stage 3 (Phase 3) **and** `humanApproved: true` before any `agent()` call may spawn a subagent; otherwise the call throws `SUBAGENT_SPAWN_BLOCKED` (-31002). The check runs inside the run's limiter so it stays atomic with the agent-count/budget gate, and a journaled cache hit bypasses it (replay never re-spawns). `gateAgentCalls` defaults to `true` whenever a `phaseState` integration is present; without one there is no gate (legacy behavior, covered by a test).

`PhaseGuard.wrapTool` exposes the same check as an internal module-level wrapper for embedders that spawn subagents outside `agent()` — it is **not** part of the package's public barrel exports, and the extension itself does **not** wrap its registered tools with it. The single enforced gate in the product is the one inside `agent()`; the wrapper exists so a third-party caller can reuse the exact same predicate without re-implementing it.

### Tier unions: closed at the routing layer, open at the script boundary

The internal routing contracts are closed unions — `tierNameForTask` / `tierNameForClassification` return exactly `'small' | 'medium' | 'big'`, the worktree runner types its agent tier the same way, and the capability contract's `tier` option declares that same closed standard vocabulary (audit G10 remediated). The runtime, however, remains deliberately permissive so user-configured routes keep working: the script-facing `tier` option is an open string resolved by *existence in the configured model tiers* — a user-configured route is honored only when context supplies its name and purpose, and an unknown tier name throws `MODEL_NOT_FOUND` naming the source (the tier and what it resolved to) instead of silently falling back. Typos therefore fail loudly rather than silently degrading routing, while the authoring schema documents the closed standard vocabulary.
