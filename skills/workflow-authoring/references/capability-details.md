<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# Exhaustive workflow capability facts

Contract format: `1.0.0`<br>
Contract content / skill / extension: `3.6.0`

Every exact fact below is projected from the installed extension's capability contract. Explanatory judgment belongs in the hand-written references next to this file.

<a id="agent"></a>
## agent

- Classification: `runtime-global`
- Support: `supported`
- Signature: `agent(prompt, options?) => Promise<string \| structured value \| null>`
- Option shape: `agent-options`
- `label`: string (optional; default: derived from phase and call count)
- `phase`: string (optional; default: current phase)
- `schema`: plain JSON Schema (optional)
- `model`: string (optional; highest-priority exact model selector)
- `tier`: "small" | "medium" | "big" (optional; standard vocabulary is the closed union 'small' | 'medium' | 'big'; a user-configured route outside it is honored only when context supplies its name and purpose; dynamic reference: model-routes)
- `isolation`: "worktree" (optional)
- `agentType`: string (optional; must come from provided context; dynamic reference: agent-types)
- `toolNames`: string[] (optional; default: full toolset; restrict this agent's coding tools to these names; an empty array restricts to the schema/structured_output tool only (auto-added))
- `timeoutMs`: number | null (optional; default: run timeout; null disables)
- `retries`: number (optional; default: run retry count; finite values are floored and clamped to 0..3)
- `retryOnlyIfSpendUnder`: number (optional; default: run-level default; skip auto-retry when the failed attempt's recorded spend exceeds this many tokens; the agent settles exhausted instead)
- Constraint: recoverable failures return null after retries; nonrecoverable failures throw
- Constraint: schema noncompliance after bounded structured-output repair is nonrecoverable and bypasses agent retries
- Constraint: per-agent retries override invocation retries; retries are floored and clamped to 0..3
- Constraint: resume replays only the longest unchanged prefix; the first miss and every later call execute live
- Constraint: selector priority is explicit model > agentType model > tier > phase model > metadata model > implicit medium > session default
- Constraint: an explicit model, agentType model, tier, or phase model that resolves to an unavailable model throws MODEL_NOT_FOUND naming the source (e.g. the tier and what it resolved to) instead of falling back
- Constraint: only the implicit default medium tier (no explicit model, tier, agentType, or phase model requested) degrades to the session default when unavailable, logging a one-time run-visible warning instead of throwing
- Constraint: worktree isolation is best-effort; failure logs that isolation was ignored and continues without an isolated working directory

<a id="parallel"></a>
## parallel

- Classification: `runtime-global`
- Support: `supported`
- Signature: `parallel(thunks, options?) => Promise<Array<unknown \| null>>`
- Option shape: `fan-out-options`
- `concurrency`: number (optional; default: 16 (MAX_CONCURRENCY); scheduling-only: bounds how many thunks are invoked at once; the run limiter (max 16) still caps real agent parallelism; NEVER part of an agent() call's resume identity — a resumed run replays cached calls identically; finite values are floored; absent/non-finite/below 1 fall back to MAX_CONCURRENCY)
- `autoApproved`: boolean (optional; default: false; P12: skips the large fan-out approval gate (TUI pause / headless abort) for deliberate headless automations; small fan-outs (at or under the threshold) never pause regardless of this flag)
- Constraint: requires functions rather than promises
- Constraint: result order matches input order
- Constraint: recoverable thunk failures become null; nonrecoverable failures throw
- Constraint: concurrency bounds how many thunks are invoked at once (scheduling-only; the run limiter still caps real parallelism) and is NEVER part of any agent() call's resume identity
- Constraint: fan-outs beyond the configured approval threshold pause for human approval (TUI confirm / checkpointGate) or abort headless with WORKFLOW_ABORTED unless autoApproved: true (P12)

<a id="pipeline"></a>
## pipeline

- Classification: `runtime-global`
- Support: `supported`
- Signature: `pipeline(items, ...stages[, options]) => Promise<Array<unknown \| null>>`
- Option shape: `fan-out-options`
- `concurrency`: number (optional; default: 16 (MAX_CONCURRENCY); scheduling-only: bounds how many thunks are invoked at once; the run limiter (max 16) still caps real agent parallelism; NEVER part of an agent() call's resume identity — a resumed run replays cached calls identically; finite values are floored; absent/non-finite/below 1 fall back to MAX_CONCURRENCY)
- `autoApproved`: boolean (optional; default: false; P12: skips the large fan-out approval gate (TUI pause / headless abort) for deliberate headless automations; small fan-outs (at or under the threshold) never pause regardless of this flag)
- Constraint: items run concurrently while stages per item run sequentially
- Constraint: each stage receives previousValue, originalItem, and zero-based index
- Constraint: a null stage result is passed to the next stage; authors must guard missing coverage explicitly
- Constraint: recoverable stage failures become null; nonrecoverable failures throw
- Constraint: a trailing plain object is the options bag ({ concurrency, autoApproved }); concurrency is scheduling-only and never part of any agent() call's resume identity
- Constraint: fan-outs beyond the configured approval threshold pause for human approval (TUI confirm / checkpointGate) or abort headless with WORKFLOW_ABORTED unless autoApproved: true (P12)

<a id="subagenttools"></a>
## subagentTools

- Classification: `runtime-global`
- Support: `supported`
- Signature: `subagentTools.search(query?) / describe(name) / select(capability) / capabilities() => capability discovery over the run's captured subagent tool registry`
- Constraint: queries the run's captured registry (host bundle + MCP + captured extension + chrome + damage control) — NOT getAllTools(), which is metadata-only on 0.83.0
- Constraint: select() returns only names the current run's toolset can actually resolve, so agent({ toolNames }) never silently drops a selected tool; non-resolvable registry tools are reported as missing
- Constraint: results are a deterministic pure function of the captured defs + the run's resolved tool names; suppliers materialize lazily once per run frame
- Constraint: settings gates still decide what the run CAN resolve: subagentTools / subagentHostTools / subagentExtensionTools (extension-tools, chrome-tools, mcp-tools toolsets apply per-task)

<a id="durablestore"></a>
## durableStore

- Classification: `runtime-global`
- Support: `supported`
- Signature: `durableStore.get(key) / has(key) / keys() / put(key, value) / putOnce(id, key, value) / compareAndSwap(key, expected, next) / record(entry) / snapshot() => cross-run project-scoped KV + provenance ledger (async writes; await them)`
- Constraint: survives run end/restart: persisted under getAgentDir()/durable-store/<projectKey>.json with atomic write + lock (mesh-lite cross-run memory)
- Constraint: replay-idempotent: put is a no-op on an unchanged value, putOnce dedupes by id, compareAndSwap never re-writes after its original write, record dedupes by id/content — cached-prefix replay leaves the store byte-identical
- Constraint: deterministic timestamps: ledger timestamps are injected (constant epoch + write seq), never the wall clock
- Constraint: NEVER part of an agent() call's resume identity: durableStore is excluded from hashAgentCall by contract
- Constraint: the store is a data plane — script control flow branching on a write result is subject to the same determinism rules as the rest of the script

<a id="supervisedrun"></a>
## supervisedRun

- Classification: `runtime-global`
- Support: `supported`
- Signature: `supervisedRun({ task, criterion, maxRounds?, taskLabel?, taskTier?, taskPhase?, supervisorTier?, supervisorTools?, correctionTier? }) => Promise<{ result, supervisor: { rounds, declaredDone, termination, finalVerdict, verdicts, corrections, observations } }>`
- Option shape: `supervised-run-options`
- `task`: string (required; required; the work to complete (fed to the task agent and every supervisor prompt))
- `criterion`: string (required; required; the concrete measurable completion criterion the supervisor verifies against)
- `maxRounds`: number (optional; default: 5; bounded supervisor turns; finite values are floored and clamped to 1..12)
- `taskLabel`: string (optional; default: "task")
- `taskTier`: string (optional; default: run default)
- `taskPhase`: string (optional; default: current phase)
- `supervisorTier`: string (optional; default: "small" (economy helper tier))
- `supervisorTools`: string[] (optional; default: [] (pure-reasoning); an empty array restricts the supervisor vote to the schema/structured_output tool only; read-only tools (read/grep) are opt-in)
- `correctionTier`: string (optional; default: taskTier, else run default)
- Constraint: run-scoped supervisor (P02): after the task agent settles, an ECONOMY supervisor agent (pure-reasoning toolNames:[] + structured verdict schema, tier 'small') checks progress against the concrete measurable completion criterion using the run's own settle events (onAgentStart/onAgentEnd with phase/result/error)
- Constraint: on drift/stall it injects EXACTLY ONE corrective agent per continue-with-correction turn; on a 'done' verdict it declares completion and stops — bounded by maxRounds
- Constraint: every supervisor turn and corrective agent is a journaled POSITIONAL agent() call; the supervisor prompt is a pure function of (task, criterion, deterministic observations), so cached-prefix resume replays every turn identically (RUN RESUME INVARIANT: no new AgentOptions fields, hashAgentCall untouched)
- Constraint: supervisor turns count against the run token budget like any agent(); when the budget is spent the loop stops with termination 'budget-exhausted' (budget knob is read-only, never mutated)
- Constraint: the supervisor prompt embeds only deterministic observation fields (call/label/phase/result/error) — tokens and model labels are recorded but never embedded, so live and replayed settles hash identically
- Constraint: a supervisor vote failing SCHEMA_NONCOMPLIANCE / AGENT_EXECUTION_ERROR degrades to an empty continue round (logged); budget/limit/abort still fail the run
- Constraint: v1 is in-run only: durable cross-process residency would need an RpcClient-spawned pi child (feasibility gap on 0.83.0)

<a id="getrunreport"></a>
## getRunReport

- Classification: `runtime-global`
- Support: `supported`
- Signature: `getRunReport(runId?) / getRunReport() / getRunReport({ limit? }) => Promise<RunReport \| null \| RunReportSummary[]>: read a prior run's report artifact (`<runsDir>/reports/<runId>.json`) or list recent reports newest-first`
- Constraint: READ-ONLY by construction: reads the report artifact written at run completion/resume, never mutates the run, the journal, or the durable store
- Constraint: missing-file safe: an unknown/malformed runId resolves to null, and the listing skips malformed artifacts instead of throwing
- Constraint: lets a script seed context from a prior run's roster/phases/budget/truncations before launching new work
- Constraint: NEVER part of an agent() call's resume identity: getRunReport is excluded from hashAgentCall by contract (a cache-hit replay never re-reads a report)
- Constraint: report path resolution matches the manager's own writer (workflowProjectPaths(cwd).runsDir/reports/<runId>.json)

<a id="recall"></a>
## recall

- Classification: `runtime-global`
- Support: `supported`
- Signature: `recall({ query?, keywords?, phase?, pattern?, limit? }) => Promise<{ hits, context }>: rank prior cross-run task knowledge (KB entries distilled at run completion + run-report artifacts) into a privacy-safe context block`
- Constraint: cross-run knowledge (V2-P02): the project KB under getAgentDir()/task-knowledge/<projectKey>.json is distilled at run completion from findings/decisions/constraints; recall searches KB entries AND run-report artifacts
- Constraint: keyword/phase/pattern search with deterministic ranking (score desc, recency desc, id tiebreak) — a pure function of the persisted KB/reports, never wall-clock
- Constraint: PRIVACY-GATED by construction: distilled entries exclude agent results, thinking, tool output, and raw logs (structured metadata + machine-gate ledger payloads only)
- Constraint: READ-ONLY: recall never mutates the run, the journal, the durable store, or the KB; a cache-hit replay never re-reads the KB
- Constraint: NEVER part of an agent() call's resume identity: recall is excluded from hashAgentCall by contract (seeding flows through the ctx() blob fingerprint instead)
- Constraint: opt-in future-run seeding via the run's seedKnowledge option (default OFF) registers the recalled context as a shared ctx() blob at run start — fresh per run, never replay identity

<a id="lineage"></a>
## lineage

- Classification: `runtime-global`
- Support: `supported`
- Signature: `lineage({ runId?, source?, file?, phase?, agent?, pattern?, limit?, verify?, ttlMs? }) => Promise<{ entries, runs, decay, verification? }>: cross-run provenance-ledger query with deterministic evidence freshness/decay`
- Constraint: cross-run lineage (V2-P04): reads the project's shared durable-store ledger + report artifacts; entries are attributed to runs via report `durable.ledger` snapshots
- Constraint: filters by runId/source/file/phase/agent/pattern; results sorted by the ledger's DETERMINISTIC timestamps (never wall-clock)
- Constraint: decay policy: an entry's age is its write-sequence distance (ms over the durable-store deterministic clock) behind the newest entry in the result set; fresh = age <= ttlMs (default 1000 writes)
- Constraint: verify: true re-verifies STALE claim-verify evidence by re-fetching the cited URLs through journaled agent() steps (N02 mechanics) and diffing the FNV-1a evidence hash — fail-closed on fetch failure, resume-replayable
- Constraint: READ-ONLY except for the verify path's journaled re-fetch agents; lineage itself NEVER joins any agent() resume identity (a cache-hit replay re-reads the same persisted ledger)

<a id="workflow"></a>
## workflow

- Classification: `runtime-global`
- Support: `supported`
- Signature: `workflow(savedName, childArgs?) => Promise<unknown>`
- Constraint: one nested level
- Constraint: shares limiter, counters, token accounting, and store
- Constraint: nested workflows do not reuse the parent resume journal

<a id="verify"></a>
## verify

- Classification: `runtime-global`
- Support: `supported`
- Signature: `verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[]; maxChars?: number; tier?: string; distinctModel?: string }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }>; crossCheck?: { model: string; verdict: boolean; agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } } }>`
- Option shape: `verify-options`
- `reviewers`: number (optional; default: 2; authors should provide a finite integer; runtime clamps below 1)
- `threshold`: number (optional; default: 0.5)
- `lens`: string | string[] (optional)
- `maxChars`: number (optional; default: 4000; embedded claim payload cap (ellipsis marker + log line when trimmed))
- `tier`: "small" | "medium" | "big" (optional; default: "small"; standard vocabulary is the closed union 'small' | 'medium' | 'big')
- `distinctModel`: string (optional; P09: second-logical-model cross-check spec (provider/modelId); a judge pass on disagreement is pinned to this model; the cross-check is a direct ModelRuntime call outside the run's agent accounting; the judge pass is one agent() call on the distinct model (hashAgentCall model/tierModel fields); an unavailable second model degrades gracefully to the primary verdict (logged, never silent); the judge prompt embeds the live cross-check verdict: a resumed run whose re-ask differs re-executes the judge call and everything downstream live (documented first-miss semantics))
- Constraint: reviewer failures are omitted; successful votes form the denominator in realCount / total
- Constraint: threshold comparison is inclusive and real is false when no reviewer succeeds
- Constraint: multiple lenses cycle across reviewers
- Constraint: distinctModel cross-checks the primary verdict on a SECOND logical model: the cross-check is a direct ModelRuntime call outside the run's agent accounting (no agent slot, no token charge — the economy-tier primary votes are never double-charged), and on disagreement a judge pass (one agent() call pinned to the distinct model) adjudicates — its verdict becomes real and crossCheck.judged is true
- Constraint: an unavailable second model degrades gracefully to the primary verdict with a logged skip (never silent), and the crossCheck block is absent entirely
- Constraint: the judge pass carries the distinct model in its resume identity (hashAgentCall model/tierModel fields); its prompt embeds the live cross-check verdict, so a resumed run whose re-ask differs re-executes the judge call and everything downstream live (documented first-miss semantics)

<a id="judgepanel"></a>
## judgePanel

- Classification: `runtime-global`
- Support: `supported`
- Signature: `judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string; distinctModel?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }>; crossCheck?: { model: string; verdict: boolean; agreement: boolean; judged: boolean; judge?: { verdict: boolean; reason?: string } } } \| undefined>`
- Option shape: `judge-panel-options`
- `judges`: number (optional; default: 3; authors should provide a finite integer; runtime clamps below 1)
- `rubric`: string (optional; default: "overall quality and correctness")
- `distinctModel`: string (optional; P09: second-logical-model cross-check of the panel's winning pick (provider/modelId); a top-2 judge pass on disagreement may override the winner; active only when at least two candidates were scored; unavailable second model degrades gracefully to the panel's pick)
- Constraint: failed judgments are omitted and each candidate score averages successful judgments only
- Constraint: a candidate with no successful judgments scores 0
- Constraint: highest mean score wins with stable input index as the tie-break; empty input returns undefined
- Constraint: distinctModel cross-checks the panel's winning pick on a second logical model (direct ModelRuntime call, outside the run's accounting) and, on disagreement, a top-2 judge pass on the distinct model may override the winner (crossCheck.judged true; judge.verdict false means the alternative won)
- Constraint: active only when at least two candidates were scored; an unavailable second model degrades gracefully to the panel's pick

<a id="gate"></a>
## gate

- Classification: `runtime-global`
- Support: `supported`
- Signature: `gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>`
- Option shape: `gate-options`
- `attempts`: number (optional; default: 3; authors must provide a finite integer; runtime clamps values below 1 to 1)
- Constraint: feedback is undefined on the first thunk call and then receives the previous validator feedback string
- Constraint: attempt is zero-based for the thunk while the returned attempts count is one-based
- Constraint: a value is accepted when the validator returns an object with a truthy ok property; a bare boolean is not accepted
- Constraint: exhaustion returns ok false with the last value and the bounded attempts count
- Constraint: authors must supply a finite attempts bound when overriding the default

<a id="testgate"></a>
## testGate

- Classification: `runtime-global`
- Support: `supported`
- Signature: `testGate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, options: { tests: Array<{ command: string; assert?: { exitCode?: number; outputContains?: string; outputMatches?: string; fileContains?: string } }>; postconditions?: string[]; attempts?: number; tool?: 'bash' \| 'grep' }) => Promise<{ ok: boolean; value: unknown; attempts: number; tests: Array<{ command: string; passed: boolean; detail: string; exitCode: number \| null; output: string }> }>`
- Option shape: `test-gate-options`
- `tests`: Array<{ command: string; assert?: { exitCode?: number; outputContains?: string; outputMatches?: string; fileContains?: string } }> (required; required and non-empty: every test runs as one subagent step (bash/grep tool) whose structured capture is machine-validated; assert predicates are machine-checked pure-JS over the captured output, never an LLM verdict; an absent assert defaults to { exitCode: 0 }; fileContains checks the captured output (cat/grep), the vm-safe way to assert file content without host fs access; assert.exitCode requires the bash tool (the grep tool reports matches, not an exit status); DS-7: prefer `grep -n <pattern> <file>` over `cat <file>` for fileContains — grep prints only the matching lines, so the capture stays small and the assertion is robust against unrelated output bloat)
- `postconditions`: string[] (optional; prose descriptions of the required postconditions, embedded into rework feedback)
- `attempts`: number (optional; default: 3; bounded rework mirroring gate(): authors must provide a finite integer; runtime clamps values below 1 to 1)
- `tool`: "bash" | "grep" (optional; default: "bash")
- Constraint: machine-checked postcondition gate: each test runs as a SUBAGENT STEP (agent({ toolNames: ['bash'] | ['grep'], schema })) whose structured capture is machine-validated by pure-JS predicates — acceptance is evidence-backed machine-validated subagent evidence, never an LLM verdict
- Constraint: the vm context injects no host fs/exec, so machine postconditions cannot run host-side from a vm global; file content is asserted through the captured command output (cat/grep), the vm-safe mechanism
- Constraint: feedback is undefined on the first thunk call and then receives the previous attempt's machine failure details plus the postconditions prose; every failure is logged (never silent)
- Constraint: exhaustion fails CLOSED with ok false and the captured per-test evidence (exitCode/output/detail); an absent assert defaults to { exitCode: 0 }
- Constraint: tests are required and non-empty; malformed commands/asserts throw a TypeError (loud script bug, never silent)
- Constraint: resume-safe: every test is a real agent() call under a stable callSeq whose toolNames + schema are hashAgentCall fields, so completed attempts replay from the journal like gate()'s

<a id="loopuntildry"></a>
## loopUntilDry

- Classification: `runtime-global`
- Support: `supported`
- Signature: `loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number; maxRoundCost?: number }) => Promise<{ items: unknown[]; termination: "dry" \| "maxRounds" \| "capacity" \| "failed" \| "costSaturated"; failedRounds: number }>`
- Option shape: `loop-until-dry-options`
- `round`: (roundIndex: number) => unknown[] | Promise<unknown[]> (required)
- `key`: (item: unknown) => string (optional; default: JSON.stringify)
- `consecutiveEmpty`: number (optional; default: 2; authors should provide a finite integer; runtime clamps below 1)
- `maxRounds`: number (optional; default: 50; authors should provide a finite positive integer)
- `maxRoundCost`: number (optional; default: no cap; N03: a zero-new-items round whose recorded spend exceeds the cap terminates the loop costSaturated; round spend is the run-wide shared.spent delta across the awaited round (journaled facts, deterministic); a round that produced new items never saturates; non-finite values throw a TypeError)
- Constraint: roundIndex is zero-based; only a successful round that yields no fresh items counts as dry
- Constraint: a round returning null/undefined is a FAILED round (termination: "failed", failedRounds incremented), never dry
- Constraint: token-budget or agent-limit capacity exhaustion returns the accumulated partial items with termination: "capacity"
- Constraint: a zero-new-items round whose recorded spend (the run-wide shared.spent delta across the awaited round) exceeds maxRoundCost terminates with "costSaturated" instead of grinding to maxRounds/consecutiveEmpty
- Constraint: the result reports its termination reason (dry | maxRounds | capacity | failed | costSaturated) and the failed-round count
- Constraint: non-finite maxRounds/consecutiveEmpty/maxRoundCost throw a TypeError; finite values are floored and clamped to at least 1
- Constraint: maxRoundCost is loop control only — NEVER part of any agent() call's resume identity (replayed rounds bill zero spend, the same replay-is-free divergence the run budget documents)

<a id="completenesscheck"></a>
## completenessCheck

- Classification: `runtime-global`
- Support: `supported`
- Signature: `completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>`
- Constraint: only the first 4,000 characters of serialized result evidence are sent to the critic
- Constraint: missing is optional and recoverable critic failure returns null
- Constraint: large evidence sets must be chunked or summarized before relying on the advisory verdict

<a id="chunked"></a>
## chunked

- Classification: `runtime-global`
- Support: `supported`
- Signature: `chunked(items: unknown[], options: { chunkSize: number; mapper: (chunk: unknown[], chunkIndex: number) => unknown \| Promise<unknown>; synthesizer?: (results: Array<unknown \| null>, meta: { failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number; items: unknown[] }) => unknown \| Promise<unknown> }) => Promise<{ results: Array<unknown \| null>; failed: Array<{ index: number; chunk: unknown[] }>; chunkCount: number } \| unknown>`
- Option shape: `chunked-options`
- `chunkSize`: number (required; finite values are floored and clamped to at least 1)
- `mapper`: (chunk: unknown[], chunkIndex: number) => unknown | Promise<unknown> (required)
- `synthesizer`: (results, meta) => unknown | Promise<unknown> (optional)
- Constraint: chunk boundaries depend only on item order and chunkSize, so agent() calls inside mapper keep stable resume hashes when the prompt embeds chunk content + chunkIndex
- Constraint: a recoverable-null chunk result stays null in results and is recorded in failed with its stable index and chunk
- Constraint: non-recoverable failures (token budget, agent limit, abort) and plain mapper errors rethrow
- Constraint: with synthesizer the helper returns the synthesizer output; else it returns { results, failed, chunkCount }

<a id="recursive"></a>
## recursive

- Classification: `runtime-global`
- Support: `supported`
- Signature: `recursive(items: unknown[], options: { split: (items: unknown[], depth: number) => unknown[][] \| Promise<unknown[][]>; solve: (items: unknown[], depth: number, meta: { path: string; branchBudget: number; depth: number }) => unknown \| Promise<unknown>; merge?: (results: Array<unknown \| null>, meta: { depth: number; path: string; branchBudget: number; failed: Array<{ path: string; depth: number }>; items: unknown[] }) => unknown \| Promise<unknown>; maxDepth?: number; maxRecursiveRoots?: number; concurrency?: number; autoApproved?: boolean }) => Promise<{ result: unknown; depth: number; completedBranches: number; failedBranches: number; totalBranches: number }>`
- Option shape: `recursive-options`
- `split`: (items: unknown[], depth: number) => unknown[][] | Promise<unknown[][]> (required; must be deterministic — the recursion tree (and thus the positional agent() call sequence) is a pure function of (items, maxDepth, split); an empty split, or a single deep-equal part, is treated as a leaf (solved directly instead of recursing))
- `solve`: (items, depth, meta) => unknown | Promise<unknown> (required; leaf solver — usually one or more agent() calls; recoverable null fails the leaf branch; meta carries the branch's positional path and its inherited (shrinking) token-budget share)
- `merge`: (results, meta) => unknown | Promise<unknown> (optional; default passes the child results through; meta includes the branch's failed children)
- `maxDepth`: number (optional; default: 2; per-branch recursion depth; clamped to 1..MAX_RECURSIVE_DEPTH)
- `maxRecursiveRoots`: number (optional; default: 16; per-level fan-out wave width; larger partitions are processed in deterministic waves)
- `concurrency`: number (optional; default: run concurrency; scheduling-only (fan-out wave width); never part of any agent() call's resume identity)
- `autoApproved`: boolean (optional; default: false; skip the P12 fan-out approval gate for the recursion's fan-outs)
- Constraint: the recursion tree is a pure function of (items, maxDepth, split) — recursive calls are journaled positional agent() calls at deterministic indices, so resume replays the same tree
- Constraint: per-branch maxDepth is clamped to 1..MAX_RECURSIVE_DEPTH and a live nested-recursive() counter enforces the hard ceiling (its own depth counter — it never routes through workflow() nesting)
- Constraint: the per-level fan-out is processed in deterministic waves of maxRecursiveRoots width; an empty split or a single deep-equal part is a leaf (solved directly)
- Constraint: budget inheritance: each branch receives branchBudget = tokenBudget * 2^-depth (data, never a split gate — the tree stays deterministic)
- Constraint: an all-failed batch stops the branch wholesale (null result, recorded failure) — never silently retried
- Constraint: durable bindings persist the root partition spec + per-branch completed coverage (recursive:root/recursive:branches keys); replay-idempotent, never part of any agent() resume identity

<a id="replansignal"></a>
## replanSignal

- Classification: `runtime-global`
- Support: `supported`
- Signature: `replanSignal() => { triggered: boolean; events: number; forecast: { spent: number; plannedRemaining: number; projectedTotal: number; budget: number \| null; threshold: number; overBudget: boolean } }`
- Constraint: deterministic read derived from journal-derived state (seeded/live spend + declared phase budgets) — a resumed run computes a consistent value
- Constraint: triggered when spent + unspent phase budgets reaches tokenBudget * rePlanThreshold BEFORE the hard caps trip; scripts re-scope remaining phases via phase() re-declaration
- Constraint: the runtime emits a replan runtime event once per run on the live crossing edge; observation only — never a VM mutation
- Constraint: never part of any agent() resume identity

<a id="spendanalytics"></a>
## spendAnalytics

- Classification: `runtime-global`
- Support: `supported`
- Signature: `spendAnalytics(options?: { limit?: number }) => { runCount: number; totals: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number; freshSpend: number; agents: number }; perPhase: Array<{ name: string; spend: number; runs: number }>; perPattern: Array<{ name: string; spend: number; runs: number }>; perProvider: Array<{ name: string; spend: number; runs: number }>; trend: Array<{ runId: string; workflowName: string; status: string; total: number; agents: number; at: string }>; runs: Array<SpendLedgerEntry> }`
- Constraint: reads the project's durable spend ledger (spendLedger:<runId> entries written at run end) — per-phase / per-pattern (workflow name) / per-provider totals + a deterministic per-run trend
- Constraint: fully deterministic (numeric sums + sorted keys; deterministic stamps + runId tiebreak) — never wall clock, never RNG
- Constraint: replay-idempotent ledger writes (deep-equal no-op; resume-correct per-runId replacement)
- Constraint: read-only — never part of any agent() resume identity

<a id="steerplan"></a>
## steerPlan

- Classification: `runtime-global`
- Support: `supported`
- Signature: `steerPlan.read() => { runId: string; currentPhase: string \| null; phases: Array<{ title: string; budget: number \| null; spend: number }>; agentCount: number; callSeq: number; budget: { limit: number \| null; spent: number; remaining: number }; forecast: { spent: number; plannedRemaining: number; projectedTotal: number; budget: number \| null; threshold: number; overBudget: boolean }; revisions: Array<{ phases?: Array<{ title: string; budget?: number }>; currentPhase?: string; note?: string; reason?: string }> }; steerPlan.submit(revision: { phases?: Array<{ title: string; budget?: number }>; currentPhase?: string; note?: string; reason?: string }) => the applied (normalized) revision`
- Constraint: verbs schema: read() = the current plan/phase state snapshot (declared phases with budgets + phase spend, current phase, agent count, run budget, the shared re-plan forecast, and the applied revisions); submit(revision) = a journaled plan-rescope whose applied revision is recorded in order
- Constraint: the revision rescope mirrors phase() re-declaration (a positive finite budget re-bases the phase ceiling, which the phase gate honors immediately; new phase titles pre-declare; currentPhase sets the steering target phase)
- Constraint: journaled + replayed deterministically on resume: submit() takes a callIndex, hashes the revision (fixed-field canonical JSON), and a resume-journal cache hit re-applies the SAME journaled revision (stage 'replay' steer event) — a changed revision is a journal miss and re-submits live (stage 'submit'), exactly the checkpoint() replay contract
- Constraint: persisted as steerRevisions:<runId> in the run's durable store (replay-idempotent, resume-correct) and surfaced in the run report's additive steerRevisions block
- Constraint: deterministic: steer revisions are journaled deltas — NEVER part of any agent()/checkpoint() resume identity (hashAgentCall's field set is untouched); never wall clock, never RNG
- Constraint: the in-flight cooperative interrupt half is EXPLICITLY DEFERRED: agent sessions expose only an AbortSignal channel (no interrupt-check hook), so steering happens at the next script call boundary — no mid-flight VM mutation ever
- Constraint: roadmap §4 V2-P08(a) reconciliation: the original file-target (a steer verb on the workflow_control/damage-control tool surface) is formally RE-TARGETED to this script-side surface — the journaled plan-rescope contract (submit at the next script call boundary, replayed deterministically on resume) is inherently script-visible, and a host-side steer verb would need new manager→run request plumbing that the deferred in-flight interrupt half already parks for the same reason

<a id="route"></a>
## route

- Classification: `runtime-global`
- Support: `supported`
- Signature: `route(value: unknown, options: { cases: Array<{ key: string; when?: (value: unknown) => boolean \| Promise<boolean>; run: (value: unknown) => unknown \| Promise<unknown> }>; fallback: (value: unknown, context: { reason: "no-eligible-case" \| "classification-failed" \| "unknown"; classification: string \| null }) => unknown \| Promise<unknown> }) => Promise<{ key: string \| null; result: unknown; fallback: boolean; reason: "none" \| "no-eligible-case" \| "classification-failed" \| "unknown" }>`
- Option shape: `route-options`
- `cases`: Array<{ key: string; when?: (value) => boolean | Promise<boolean>; run: (value) => unknown | Promise<unknown> } (required; keys must be nonblank and unique)
- `fallback`: (value, context) => unknown | Promise<unknown> (required)
- Constraint: one schema'd classification agent picks among the enum of eligible case keys; the classification prompt embeds the value and the eligible key list, so the resume hash is stable per value + case list
- Constraint: a case whose when(value) guard fails never reaches the classification enum; when no case is eligible the fallback runs with reason no-eligible-case and no agent() is called
- Constraint: a recoverable-null classification routes to fallback with reason classification-failed; an out-of-enum key routes to fallback with reason unknown
- Constraint: the matched case's run(value) executes in pure JavaScript and may call agent()
- Constraint: budget, agent-limit, and abort failures rethrow

<a id="timeboxed"></a>
## timeboxed

- Classification: `runtime-global`
- Support: `supported`
- Signature: `timeboxed(fn: (context: { elapsed(): number; remaining(): number; expired(): boolean }) => unknown \| Promise<unknown>, options: { maxElapsedMs: number }) => Promise<{ result: unknown; timedOut: boolean; elapsedMs: number; maxElapsedMs: number }>`
- Option shape: `timeboxed-options`
- `maxElapsedMs`: number (required; finite values are floored and clamped to at least 0)
- Constraint: cooperative: fn must check context.expired()/remaining() at its own decision points and return early with partial results; timeboxed never interrupts a running fn
- Constraint: after fn settles, timedOut reports whether the deadline was exceeded
- Constraint: elapsedMs() and context.elapsed() are wall-clock values that must NEVER appear in prompts or hashes — use an args-seeded counter instead (the determinism prelude blocks clocks; a resumed run replays cached calls fast and observes different elapsed values)
- Constraint: non-finite maxElapsedMs throws a TypeError; finite values are floored and clamped to at least 0

<a id="elapsedms"></a>
## elapsedMs

- Classification: `runtime-global`
- Support: `supported`
- Signature: `elapsedMs() => number`
- Constraint: monotonic non-negative milliseconds since the top-level run start, shared across nested workflow() frames
- Constraint: NEVER inside prompts or hashes: wall-clock values are not resume-stable; use a counter seeded from args

<a id="ctx"></a>
## ctx

- Classification: `runtime-global`
- Support: `supported`
- Signature: `ctx(sharedText: string \| unknown) => string`
- Constraint: registers sharedText ONCE per run (written to the run's shared store) and returns a compact pointer to embed in agent() prompts instead of re-embedding the full text into every fan-out call
- Constraint: repeated ctx() with the same text returns the same pointer without re-storing — one blob per run (dedupe guarantee)
- Constraint: the full blob text is emitted into the FIRST agent's instructions once per run; every later agent gets a store-key note — agents whose prompts reference a pointer can read the text with store_get (injected into every agent)
- Constraint: the blob fingerprint is a resume-hash identity input: editing the shared text invalidates cached replays of calls downstream of the ctx() registration
- Constraint: empty/absent text returns '' (no-op); non-string values are JSON-stringified; an oversized blob or the distinct-blob cap degrades to returning the raw text

<a id="consensus"></a>
## consensus

- Classification: `runtime-global`
- Support: `supported`
- Signature: `consensus(question: string, options?: { panelists?: number; rounds?: number; agreeThreshold?: number; arbitrator?: (context: { question: string; votes: Array<{ verdict: boolean; reasoning?: string } \| null>; rounds: number }) => unknown \| Promise<unknown> }) => Promise<{ agreed: boolean; verdict: boolean \| null; count: number; total: number; votes: Array<{ verdict: boolean; reasoning?: string } \| null>; rounds: number; omitted: number; arbitration?: unknown }>`
- Option shape: `consensus-options`
- `panelists`: number (optional; default: 3; finite values are floored and clamped to at least 1)
- `rounds`: number (optional; default: 2; finite values are floored and clamped to at least 1)
- `agreeThreshold`: number (optional; default: 0.66; finite values are clamped to [0, 1])
- `arbitrator`: (context) => unknown | Promise<unknown> (optional)
- `distinctModel`: string (optional; P09: second-logical-model cross-check of the panel's final side (provider/modelId); a judge pass on disagreement adjudicates the split (agreed becomes true with the judge's ruling); the primary side compared is the agreed verdict, else the arbitrator's boolean ruling, else the last round's majority; no valid votes → no cross-check; unavailable second model degrades gracefully to the panel's outcome (logged))
- Constraint: each round polls panelists independently with a structured verdict schema; per-vote recoverable nulls are omitted and shrink the denominator (logged)
- Constraint: the pairwise agreement gate passes when the largest mutually-agreeing group covers at least agreeThreshold of valid votes
- Constraint: rounds are bounded; after the budget an optional arbitrator (typically one structured agent() call) decides, else the disagreement is returned with agreed false
- Constraint: non-finite panelists/rounds throw a TypeError; finite values are floored and clamped to at least 1; agreeThreshold is clamped to [0, 1]

<a id="retry"></a>
## retry

- Classification: `runtime-global`
- Support: `supported`
- Signature: `retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>`
- Option shape: `retry-options`
- `attempts`: number (optional; default: 3; authors must provide a finite integer; runtime clamps values below 1 to 1)
- `until`: (result: unknown) => boolean (optional; default: accept first result when omitted; must be synchronous; use gate for asynchronous validation)
- Constraint: attempt is zero-based and attempts counts total thunk calls
- Constraint: until is synchronous; returning a Promise is truthy and accepts the first result
- Constraint: omitting until accepts the first result regardless of attempts
- Constraint: stops when until(result) is true; exhaustion returns only the last result without attempt metadata
- Constraint: authors must supply a finite attempts bound when overriding the default

<a id="checkpoint"></a>
## checkpoint

- Classification: `runtime-global`
- Support: `supported`
- Signature: `checkpoint(prompt, options?) => Promise<unknown>`
- Option shape: `checkpoint-options`
- `default`: unknown (optional; default: true when no UI and omitted)
- `headless`: "default" | "abort" (optional; default: "default")
- `kind`: "confirm" | "input" | "select" (optional; default: "confirm")
- `choices`: string[] (optional)
- `timeoutMs`: number (optional)
- Constraint: foreground confirm, headless behavior, and the visual approve/deny gate (checkpointGate) are implemented
- Constraint: input/select resolve through the visual gate's approve/deny verdict when a gate is configured, else they take the declared default headless
- Constraint: consumes one agent slot and no tokens
- Constraint: journaled answers replay only within an unchanged resume prefix

<a id="log"></a>
## log

- Classification: `runtime-global`
- Support: `supported`
- Signature: `log(message) => void`

<a id="phase"></a>
## phase

- Classification: `runtime-global`
- Support: `supported`
- Signature: `phase(title, options?) => void`
- Option shape: `phase-options`
- `budget`: number (optional; positive soft pre-call token gate)
- `stage`: 0 | 1 | 2 | 3 (optional; drives the persisted phase state machine when configured; forward-only (backward declarations fail at the next flush point))
- Constraint: phase budgets are soft pre-call gates

<a id="args"></a>
## args

- Classification: `runtime-global`
- Support: `supported`
- Signature: `args: unknown`

<a id="cwd"></a>
## cwd

- Classification: `runtime-global`
- Support: `supported`
- Signature: `cwd: string`

<a id="process"></a>
## process

- Classification: `runtime-global`
- Support: `supported`
- Signature: `process: { cwd(): string }`

<a id="budget"></a>
## budget

- Classification: `runtime-global`
- Support: `supported`
- Signature: `budget: { total, spent(), remaining(), wouldExceed(estimatedTokens) }`
- Constraint: frozen view over shared soft token accounting
- Constraint: spend accrues after agents finish, so in-flight work can overshoot
- Constraint: nested workflows share the same accounting
- Constraint: wouldExceed(estimatedTokens) is advisory: true when the estimated extra spend would trip the ceiling — use it to gate cheap/optional work before spawning agents

<a id="console"></a>
## console

- Classification: `runtime-global`
- Support: `compatibility`
- Signature: `console: { log, info, warn, error }`
- Constraint: new workflows should use log()

<a id="tool-input-script"></a>
## script

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `script?: string`
- Constraint: required raw JavaScript workflow source unless `name` or `scriptPath` is given

<a id="tool-input-scriptpath"></a>
## scriptPath

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `scriptPath?: string`
- Constraint: path to a file whose content is used exactly as if passed inline as `script`
- Constraint: resolved against the workflow tool's cwd when not absolute
- Constraint: read by the extension process (not the script runtime), so authoring to a file avoids inline quote/backtick escaping
- Constraint: mutually exclusive with `script` and `name`

<a id="tool-input-name"></a>
## name

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `name?: string`
- Constraint: resolves a project/user saved workflow first, then one of the 10 built-in patterns
- Constraint: mutually exclusive with resumeFromRunId

<a id="tool-input-args"></a>
## args

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `args?: unknown`

<a id="tool-input-background"></a>
## background

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `background?: boolean = true`
- Constraint: background workflows are headless; use background false when checkpoint must show foreground confirmation

<a id="tool-input-maxagents"></a>
## maxAgents

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `maxAgents?: number = 1000`
- Constraint: default, not a hard product maximum

<a id="tool-input-concurrency"></a>
## concurrency

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `concurrency?: number`
- Constraint: runtime clamps to 1..16

<a id="tool-input-agentretries"></a>
## agentRetries

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `agentRetries?: number = configured value or 0`
- Constraint: floored and clamped to 0..3
- Constraint: a subagent that still fails after retries is exhausted

<a id="tool-input-retryonlyifspendunder"></a>
## retryOnlyIfSpendUnder

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `retryOnlyIfSpendUnder?: number`
- Constraint: run-level default for the per-agent retry spend guard: skip auto-retry when the failed attempt already burned more than this many tokens
- Constraint: skipped retries settle the agent exhausted (AGENT_EXHAUSTED) exactly like retry exhaustion — failOnExhaustedAgent semantics unchanged
- Constraint: opt-in; absent preserves current retry behavior

<a id="tool-input-agenttimeoutms"></a>
## agentTimeoutMs

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `agentTimeoutMs?: number = configured default or unbounded`

<a id="tool-input-failonexhaustedagent"></a>
## failOnExhaustedAgent

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `failOnExhaustedAgent?: boolean = true`
- Constraint: strict completion: an exhausted subagent (retries exhausted, context-window overflow) settles the run FAILED
- Constraint: a failed run is resumable via resumeFromRunId; completed agents replay from cache, only the failed call re-runs
- Constraint: false = best-effort: the run completes and reports failed agents in the result instead of failing

<a id="tool-input-tokenbudget"></a>
## tokenBudget

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `tokenBudget?: number = configured default or unlimited`
- Constraint: soft pre-call gate; in-flight work can overshoot

<a id="tool-input-resumefromrunid"></a>
## resumeFromRunId

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `resumeFromRunId?: string`
- Constraint: resumes a prior incomplete run with an edited script
- Constraint: unchanged positional agent calls replay from cache until the first changed or inserted call
- Constraint: always runs in the background
- Constraint: use for any failed or paused run (retries exhausted, context overflow, provider limit) — never start a new run to recover

<a id="tool-input-dryrun"></a>
## dryRun

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `dryRun?: boolean = false`
- Constraint: validates the script or named workflow without launching a run
- Constraint: parses and checks the script, then returns its meta with no subagents launched
- Constraint: with replayFromRunId or replayFixture, executes the FULL script body against the recorded run's cached agent results instead — still no launch, no spend, no persistence
- Constraint: mutually exclusive with resumeFromRunId

<a id="tool-input-estimate"></a>
## estimate

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `estimate?: boolean (requires dryRun: true)`
- Constraint: V2-N4 pre-flight: turns the dryRun meta-only check into a static cost & duration forecast (agent count, token spend, duration, checkpoints, fan-out sizes, per-phase budgets) with an exceedsBudget/nearBudget warning against tokenBudget
- Constraint: the script is parsed and its call graph scanned — never executed; nothing is written and no run is started
- Constraint: best-effort static scan (see the workflow_estimate extension tool for the same forecast on a standalone surface)
- Constraint: mutually exclusive with replayFromRunId and replayFixture

<a id="tool-input-replayfromrunid"></a>
## replayFromRunId

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `replayFromRunId?: string (requires dryRun: true)`
- Constraint: V2-P10 recorded-replay: replays THIS script against the persisted run's canned agent() results (read from its journal)
- Constraint: unchanged agent() calls whose identity hash matches replay the recorded result byte-identically; the first changed/new call throws REPLAY_MISS instead of launching a subagent
- Constraint: no subagent is launched, nothing is spent, nothing is persisted
- Constraint: mutually exclusive with replayFixture and resumeFromRunId

<a id="tool-input-replayfixture"></a>
## replayFixture

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `replayFixture?: object (requires dryRun: true)`
- Constraint: V2-P10 recorded-replay: an inline canned fixture (schemaVersion 1 JSON) the script body executes against
- Constraint: same semantics as replayFromRunId: cache hits replay, diverging calls miss loudly (REPLAY_MISS), nothing launches
- Constraint: mutually exclusive with replayFromRunId and resumeFromRunId

<a id="metadata"></a>
## export const meta

- Classification: `script-contract`
- Support: `supported`
- Signature: `export const meta = { name: string, description: string, phases?: Array<{ title: string; detail?: string; model?: string }>, gate?: "approve", model?: string }`
- Constraint: must be the first statement
- Constraint: name and description must be nonblank strings
- Constraint: metadata must use literal values; expressions such as string concatenation and template interpolation are rejected
- Constraint: meta.gate: "approve" publishes the plan to the plannotator bridge and pauses the run for a human verdict before any agent work (the shipped plan-then-execute builtin declares it)
- Constraint: the meta declaration is the only legal export because the remaining body executes inside an async function

<a id="return-value"></a>
## workflow return value

- Classification: `script-contract`
- Support: `supported`
- Signature: `return JSON-serializable data`
- Constraint: do not return functions, promises, cyclic objects, BigInt, or runtime handles

<a id="determinism"></a>
## deterministic script execution

- Classification: `script-contract`
- Support: `supported`
- Signature: —
- Constraint: Date.now(), Math.random(), and no-argument new Date() are unavailable
- Constraint: pass timestamps and randomness through args

<a id="compatibility"></a>
## whole-script Markdown fence stripping

- Classification: `compatibility-behavior`
- Support: `compatibility`
- Signature: —
- Constraint: accepted for compatibility but not recommended

<a id="model-routes"></a>
## model routes

- Classification: `dynamic-reference`
- Support: `supported`
- Signature: —
- Constraint: live values must not be copied into static contract data
- Dynamic reference owner: `model-tier-config`
- Item shape: `{ name: string; description?: string }`
- Future lookup connection: `loadModelTierConfig`
- Live values are intentionally absent from this static reference.

<a id="agent-types"></a>
## agent types

- Classification: `dynamic-reference`
- Support: `supported`
- Signature: —
- Constraint: live values must not be copied into static contract data
- Dynamic reference owner: `agent-registry`
- Item shape: `{ name: string; description?: string }`
- Future lookup connection: `loadAgentRegistry`
- Live values are intentionally absent from this static reference.
