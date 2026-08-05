<p align="center">
  <img src="https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/assets/readme/hero.png" width="100%" alt="pi-dynamic-workflows turns one prompt into a routed, resumable, cross-checked fleet of Pi subagents">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows"><img src="https://img.shields.io/npm/v/@quintinshaw/pi-dynamic-workflows?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/for-Pi-7c3aed" alt="Built for Pi"></a>
</p>

<p align="center">
  <a href="https://quintinshaw.github.io/pi-dynamic-workflows/">Documentation</a> ·
  <a href="https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows">npm</a> ·
  <a href="https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows">Pi package</a>
</p>

Turn one request into a JavaScript orchestration script that fans work out across isolated subagents, routes each task to the right model, cross-checks the results, and returns one synthesized answer. Intermediate work stays in script variables instead of filling your chat context.

Built for **codebase-wide audits, multi-perspective review, large refactors, and source-checked research**—the jobs that are too broad for one agent and one context window.

![A real pi-dynamic-workflows run showing parallel agents and live progress](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/demo.gif)

## Start in 30 seconds

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
```

Run `/reload` in Pi, then ask naturally:

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

Pi writes and starts the workflow in the background. A live panel tracks progress while you keep working, and the final result is delivered back into the conversation automatically.

Keyword triggering is on by default: use the bounded word **workflow** or **workflows** in a message to arm workflow mode — the assistant then handles a request by fanning it out across agents, but still answers plainly if you're only asking *about* workflows (the trigger authorizes the tool, it doesn't force it). Or run `/workflows run <prompt>` explicitly. Identifier-like text and paths such as `myworkflow`, `workflow_name`, and `src/workflow-editor.ts` do not trigger. You can change the keyword with `/workflows-trigger set pi-workflow` or disable it with `/workflows-trigger off`.

## How it works

![A prompt becomes deterministic orchestration, parallel routed agents, verification, and one result](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/assets/readme/workflow.png)

1. **Orchestrate** — Pi writes a deterministic JavaScript workflow with `agent()`, `parallel()`, `pipeline()`, and `phase()`.
2. **Fan out** — fresh subagent sessions run concurrently, optionally on different models or isolated git worktrees.
3. **Verify and return** — the workflow cross-checks findings, journals completed work for resume, and delivers one result.

The orchestration itself is plain JavaScript:

```js
export const meta = {
  name: 'auth_audit',
  description: 'Find routes missing auth checks and verify the findings',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
}

phase('Scan')
const files = await agent('List every route file under src/routes/.', { tier: 'small' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, {
      tier: 'medium',
      isolation: 'worktree',
    }),
  ),
)

phase('Verify')
return await agent(
  'Synthesize and double-check these findings:\n' + findings.join('\n\n'),
  { tier: 'big' },
)
```

## Why use it

- **Real parallel orchestration** — fan out up to 16 concurrent and 1000 total subagents from one orchestration script.
- **Per-agent model routing** — use `small`, `medium`, or `big` tiers, or choose an exact provider/model and thinking level.
- **Journaled resume** — replay completed agents after interruption without rerunning them or spending their tokens again. The orchestrator can also resume with an **edited script** (`resumeFromRunId`): unchanged `agent()` calls replay from cache and only edited/new ones re-run — so a single bad prompt no longer means paying to re-run the whole workflow.
- **Git worktree isolation** — let parallel agents edit safely on throwaway branches with `isolation: "worktree"`. Worktrees live at `<repoRoot>/.pi/worktrees/<id>` on branch `pi/wf/<id>`; edits are always finalized (`git add -A` + `git commit --allow-empty`) before teardown, then discarded unless `keepWorktree` is set; leftovers from crashed runs are swept at startup.
- **Measured usage** — report real tokens and cost from each subagent session; add run, phase, or agent budgets only when you want them.
- **Visible background runs** — track phases, agents, models, fresh/cache tokens, cost, and live tok/s from the progress panel or `/workflows` navigator.
- **Quality patterns** — compose `verify()`, `judgePanel()`, `loopUntilDry()`, and `completenessCheck()` instead of rebuilding review loops.
- **Reusable workflows** — save any run as a command and call saved workflows from other workflows.

## Supported workflow capabilities

The installed extension generates this compact index from its executable capability contract. Read the [workflow authoring guide](docs/workflow-authoring.md), the [wayfinder decision-ticket guide](docs/wayfinder.md) (Phase 0 fog clearing and the local `.pi/workflows/map.md` map), or use the packaged `workflow-authoring` skill for constraints, lifecycle guidance, and adaptable examples; configured route and agent-type values remain environment-specific.

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`: string (optional; default: derived from phase and call count)<br>`phase`: string (optional; default: current phase)<br>`schema`: plain JSON Schema (optional)<br>`model`: string (optional)<br>`tier`: "small" \| "medium" \| "big" (optional)<br>`isolation`: "worktree" (optional)<br>`agentType`: string (optional)<br>`timeoutMs`: number \| null (optional; default: run timeout; null disables)<br>`retries`: number (optional; default: run retry count) |
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
| failOnExhaustedAgent | workflow-tool-input | `failOnExhaustedAgent?: boolean = true` | — |
| tokenBudget | workflow-tool-input | `tokenBudget?: number = configured default or unlimited` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
| dryRun | workflow-tool-input | `dryRun?: boolean = false` | — |
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->

## Built-in workflows

```text
/deep-research <question>   source-checked web research with citations
/adversarial-review <task>  findings challenged by skeptical reviewers
/multi-perspective "<topic>" [angle …]
                            independent angles followed by synthesis
/code-review [target]       8 specialized review angles plus verification
/codebase-audit <scope> "<check>" …
                            parallel checks followed by cross-validation
```

`/code-review` defaults to the current working diff. It also accepts a git range, a file, or a GitHub PR number:

```text
/code-review
/code-review HEAD~3..HEAD
/code-review src/foo.ts
/code-review 42
```

Diff fetches for `/code-review` time out after 60 s (hard kill) and surface a clear error instead of hanging.

For an always-on exhaustive mode, use `/ultracode`; `/effort high` is the lighter standing option.

These same 5 patterns — plus the name-only built-ins `plan-then-execute` (decompose an objective into dependency-ordered, verified steps) and `spec-generation` (draft and adversarially review a specification) — are also reachable by name without a slash command. Pi can recognize a decomposable request and run the matching curated pattern directly:

```text
Do a deep-research on whether Bun's test runner is production-ready.
```

is equivalent to `/deep-research "..."`. A saved workflow always wins over a built-in of the same name, on both the slash-command and natural-language paths — so saving your own `code-review` shadows the built-in one everywhere.

## Commands and run control

Pi can manage background runs directly with the `workflow_control` tool instead of asking you to type a command. It supports `list`, `status`, `pause`, `resume`, and `stop`; run-specific actions use the canonical run ID returned when the workflow starts. Status output includes the run state, current phase, agent counts, active labels, and recorded token total.

`list`/`status` read persisted run state, so runs from before a restart (paused/stopped) show correctly.

**Damage-control toolset** — `workflow_damage_control` extends run control to the subagent level and to crash recovery. Verbs: `list` (all session runs), `status` (deep detail: phase, journal, checkpoints, lease, config, agent counts, tokens), `agents` (per-agent inventory; optional `agentId` filter), `pause` / `resume` (session-scoped; `resume` accepts an optional edited `script` for cached-prefix reuse), `stop`, `kill-agent` (terminate ONE subagent by numeric id or callId `runId:callIndex`; never run-fatal by itself — fan-outs absorb the item), `recover` (crash/failed classification → reclaims a stale lease, flips the orphan to `paused` — never `failed` — and resumes via journal-prefix replay; run state is never deleted), and `clean` (orphan sweep: stale leases, orphan runs normalized to `paused`, ghost worktrees, tmp `pi/wf` branches — **dry-run by default**; acts only with `dryRun: false`, and even then never deletes run state). Mutating verbs are session-scoped; read-only `status`/`agents` fall back to all persisted runs. The `/workflows clean` command keeps its original worktree-only semantics — the tool's `clean` verb is a separate surface.

| Command | Purpose |
| --- | --- |
| `/workflows` | Open the interactive run navigator |
| `/workflows run <prompt>` | Arm workflow mode for a prompt even when keyword triggering is off |
| `/workflows status <id>` | Watch a run; the final snapshot reports the truthful state (failed / stopped / paused-resumable) |
| `/workflows pause\|resume\|stop\|rm <id>` | Control a run |
| `/workflows save <name>` | Save the latest script as a reusable command |
| `/workflows-trigger off\|on\|status` | Control automatic keyword triggering |
| `/workflows-trigger set <word>\|reset` | Set or reset the trigger word |
| `/workflows-progress compact\|detailed\|status\|max <N>` | Live-panel detail level (and max agents shown per phase in detailed mode) |
| `/workflows-models` | Map model tiers and thinking levels (with a per-tier cost preview) |
| `/workflows-settings` | Interactive settings editor (TUI) — `status`/`paths` print effective config |
| `/workflows-subagent-tools` | Print which tools each subagent session receives (source, allow status, always-denied, metadata-only host tools) |
| `/workflows-gateway start\|stop\|status` | Lazily start/stop the host tool IPC gateway (MCPBridge) — see below |
| `/ultracode [off]` | Toggle exhaustive automatic workflows |
| `/effort off\|high\|ultra` | Set the standing orchestration effort |

Saved workflows can declare typed parameters (string/number/integer/boolean/array): launching by name coerces and validates args (missing-required and type errors throw), `/<name> --help` prints the schema, and `/workflows save` derives the schema from the run's args.

In the navigator: `↑/↓` select · `enter/→` open · `esc/←` back · `p` pause · `x` stop · `r` restart · `s` save · `q` quit.

### Host tool gateway (automatic host tools for subagents)

Subagents never load host extensions by default (see “Upgrading past 3.2”); that memory-leak mitigation is preserved. Instead, host **coding and web tools** reach subagents through a local IPC gateway: `read`, `bash`, `edit`, `write`, `web_search`, and `web_fetch` are proxied from the host session, so subagents get them **automatically with zero configuration**.

The default mode (`subagentHostTools: "auto"`) lazily starts the gateway on the first run that needs host tools. Untagged runs receive the host coding + web tools merged with the agent coding tools; a run that names `toolset: "host-tools"` gets the proxied host tools on top (and now auto-starts the gateway, instead of silently resolving to an empty list). The gateway stays stopped until a run actually needs it:

```bash
/workflows-gateway status   # STOPPED until a run auto-starts it
/workflows-gateway start    # still works for manual control
/workflows-gateway stop
```

Two escape hatches restore the exact pre-change behavior (no auto-start; untagged runs get coding tools only; `toolset: "host-tools"` is the only proxy path and needs a manual `start`):

- `PI_WORKFLOW_SUBAGENT_HOST_TOOLS=off` (env, CI/headless), or
- `"subagentHostTools": "off"` in `settings.json` (global or project override).

A third value, `"on"`, eagerly starts the gateway at extension load for latency-sensitive users. If the automatic start fails (e.g. the socket is taken), the affected run degrades to coding tools with a logged diagnostic and the next run retries — host tools are never silently advertised-and-dead.

Beyond the executable builtin suite, the proxied bundle is **metadata-synced against the running host** via the public `pi.getAllTools()` API (no pi source changes — everything is built from the extension's own SDK-factory definitions and the host's public extension surface): builtin descriptions follow the live host, and a builtin is only advertised when the host actually registers it. On a future host SDK that exposes full tool definitions (`getAllToolDefinitions()`), every extension-registered tool (MCP servers from pi-mcp-adapter, third-party extensions) is merged in automatically. Two hard exclusions always apply: the extension's own `workflow`/`workflow_control` recursive-orchestration tools are never proxied, and any names listed in `excludeSubagentTools` are filtered out too. On host SDKs without a metadata API, the gateway falls back to the full executable suite (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web_search`, `web_fetch`). Extension/MCP tools that are only visible as metadata (no executable definition) are never advertised — the gap is logged once per gateway start.

The gateway authenticates every IPC connection with a per-bridge token; subagent processes connecting via `MCPProxyClient` must present `gateway.getAuthToken()` in their `auth.handshake` (missing → `AUTH_REQUIRED`, wrong → `AUTH_FAILED`).

### Subagent chrome tools (vendored pi-chrome)

The `chrome_*` tools pi-chrome registers on the host are **metadata-only** on the 0.83.0 `ExtensionAPI` — the extension cannot proxy their executors. Instead it vendors its own definitions of the full v0.15.46 chrome set and executes them through the host session's shared Chrome bridge (`127.0.0.1:17318`), so subagents can drive the same browser the main agent controls — and every action is tagged with the host session key + `Pi Session: <name>` group title, so subagent automation lands in the **same tab group** as the main session's tabs.

Opt in with `"subagentChromeTools": "on"` in `settings.json` (or `PI_WORKFLOW_SUBAGENT_CHROME_TOOLS=on`); the default is `off` (no chrome defs anywhere). Two gates apply on top of the setting: the host session must hold the shared `/chrome authorize` grant (the same authorization the main agent's own chrome tools require), and `excludeSubagentTools` names are filtered out. No grant → the assemble resolves to an empty chrome set and individual `execute` calls throw the standard `Chrome control locked` message — never a silent hang. A script can also request the chrome set alone with `toolset: "chrome-tools"` (auth-gated like the default merge). `/workflows-subagent-tools` now lists each chrome tool's true status: `allowed` when assembled, or `available-if-enabled` with the exact recovery step (setting off, or grant missing) instead of the old misleading `metadata-only` row.

### Subagent extension tools (host-captured third-party)

The `web_fetch_md`/`web_docs_*` tools from the supi-web extension and the `codegraph_*` tools from pi-codegraph are, like chrome, metadata-only on the 0.83.0 `ExtensionAPI` — the extension cannot proxy their executors. Instead it **captures** them: every pi extension entry is `(pi) => void` calling `pi.registerTool(...)`, so the extension runs an installed package's entry against a capture proxy (transpiled with jiti, the same loader pi itself uses) that records the real `ToolDefinition`s and no-ops everything else, then feeds those defs through the existing gateway. Subagents receive thin proxied defs; the host process executes the real closures. Install parity: capture only works when the package is actually installed in `~/.pi/agent/npm/node_modules`; a missing package reports `not-installed` in the listing instead of breaking.

Opt in with `"subagentExtensionTools": "on"` in `settings.json` (or `PI_WORKFLOW_SUBAGENT_EXTENSION_TOOLS=on`); an allowlist form (`["supi-web"]` / `["pi-codegraph"]`) limits capture to the listed sources. The default is `off` (no captured defs anywhere). Two sources are supported today — supi-web (`web_fetch_md`, `web_docs_search`, `web_docs_fetch`) and pi-codegraph (8 × `codegraph_*`) — with a per-source expected-name allowlist that filters anything unexpected. Sources whose executors are host-coupled to main-session state (rpiv-todo's todo store, pi-vcc's session-file search) are intentionally **not** captured. A script can request the captured set alone with `toolset: "extension-tools"` (setting-gated like the default merge). `/workflows-subagent-tools` lists each extension tool's true status: `allowed` when assembled, `available-if-enabled` with the exact recovery step (setting off / source allowlisted out), or `unavailable` with the source's one-line failure.

### Subagent damage-control tools

`workflow_damage_control` (the damage-control + recovery toolset: `list` / `status` / `agents` / `pause` / `resume` / `stop` / `kill-agent` / `recover` / `clean`) is registered on the host for the main agent and can additionally be handed to workflow subagents through a dedicated gate — deliberately **separate** from `subagentExtensionTools`, because damage control is kill/pause/recover power over the active workflow, not research-tool access (the same privilege-separation precedent as chrome tools).

Opt in with `"subagentDamageControlTools": "readonly"` (inspection verbs only: `list`/`status`/`agents`/`clean`; mutating verbs return a capability error) or `"on"` (full verb set) in `settings.json` (or `PI_WORKFLOW_SUBAGENT_DAMAGE_CONTROL_TOOLS=readonly` / `=on`). The default is `off` (no defs anywhere — the supplier stays undefined, zero runtime cost, lazy guarantee intact). The tool name `workflow_damage_control` can always be denied per-run via `excludeSubagentTools`. Because the def closes over the live `WorkflowManager`, subagent calls act on the **current active workflow**; mutating verbs stay session-scoped and `clean` stays dry-run by default. A script can request the set alone with `toolset: "damage-control-tools"` (setting-gated like the chrome/extension toolsets). `/workflows-subagent-tools` lists the tool's true status: `allowed` when assembled, or `available-if-enabled` with the exact recovery step (setting off).

Agent details use a compact summary by default: completed agents show their final result, while active agents show the prompt and two latest history events. Press `enter` to open the full syntax-highlighted pager. In the pager, use `j/k` or `↑/↓` for lines, `PgUp/PgDn` for pages, `g/G` for the ends, and `t` to toggle live tail mode.

The detailed panel adds a live per-run `~$/s` estimate (output price × token rate), a spend-vs-budget bar when `tokenBudget` is set, and a session-aggregate 'estimated spend across N active runs' line. The `/workflows status` final snapshot reports the truthful state — 'Workflow failed' / 'Workflow stopped' / 'Workflow paused (resumable)' — never a generic 'completed'. Navigator delete/stop/overwrite actions confirm via `ui.confirm`.

## Runtime reference

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent; optionally validate its result with JSON Schema |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently and preserve input order |
| `pipeline(items, ...stages)` | Fan items through sequential stages |
| `phase(title, { budget? })` | Group work in the live view and optionally set a phase budget |
| `verify` / `judgePanel` | Cross-check a result or choose the best candidate |
| `loopUntilDry` / `completenessCheck` | Repeat discovery until no new findings remain |
| `workflow(name, args)` | Run a saved workflow inline |
| `checkpoint(prompt, opts)` | Add a journaled human-approval gate |
| `budget` | Inspect real tokens spent and remaining |

Library callers can pass `checkpointGate`: `checkpoint()` then publishes its payload and waits — approve → `true` (or the declared `default`), deny/timeout → `false`; journaled replies replay on resume. `phaseState` persists `phase(title, { stage })` transitions to `.pi/workflows/active-state.json` (forward-only, `PHASE_TRANSITION_INVALID` on rollback) and gates `agent()` behind Phase 3 + human approval (`SUBAGENT_SPAWN_BLOCKED` at spawn; `APPROVAL_REQUIRED` on gated transitions). Journal entries can carry `operations: [{line, op, outcome}]`; the last failing operation is surfaced as `failingOperation` on `onAgentEnd`/error events and snapshots.

**Human approval bridge** — `createPlannotatorBridge({ port: 3123, autoOpenBrowser, approvalTimeout })` serves `/sse` (all `update` events, 15 s heartbeat) and `/reviewed` (named `reviewed` events on settle); plans persist to `.pi/workflows/plans/<id>.json`. `waitForApproval(planId)` polls on a 250 ms bound and is AbortSignal-abortable; bind errors (EADDRINUSE) reject waits instead of crashing.

**Meta-declared approval gate** — a top-level script can declare `meta.gate: "approve"` in its `export const meta` block. `runWorkflow` then pauses BEFORE the script body evaluates and publishes `meta.description` (with the runId) to the configured `checkpointGate` (or the inline `confirm` when no gate is wired), waiting for the human verdict — zero agent work starts until it resolves. Approval runs the body; denial or timeout completes the run cleanly with `result: false` and a note in `logs` (never a crash). Absent the flag, behavior is byte-identical, and a run with no gate configured auto-approves (headless `default: true`), so a gated script stays detached/background-safe and no review server is ever started for it. The shipped `plan-then-execute` builtin declares the gate and its description states the pause ("Pauses for human approval before starting agent work").

<details>
<summary><strong>Phased pipeline and run control — live vs manual</strong></summary>

A default top-level run walks the phased pipeline before the script body executes (wayfinder → prewalk → PhaseGuard), and the extension creates a per-cwd persisted state machine so the phase flags are armed on every run. The pipeline is strictly additive: an embedding that passes neither `pipeline` nor `phaseState` gets byte-identical pre-wiring behavior.

| PRD task | Feature | Live by default? | Canonical surface |
| --- | --- | --- | --- |
| 4 | Wayfinder decision map (Phase 0): fog verdict on the task prompt; a foggy prompt persists a decision map via the deterministic zero-model stub mapper | Yes — runs on every top-level run | `.pi/workflows/map.md` + `map.json` |
| 5 | Prewalk “1986 Aircraft Manual” blueprint (Phase 1): gated on `wayfinderComplete`; the blueprint is the plan the plannotator gate and `/workflows implement` read | Yes — follows wayfinder | `.pi/workflows/plans/<runId>.json` |
| 2 | PhaseGuard: `phase(title, { stage })` transitions persist forward-only (`PHASE_TRANSITION_INVALID` on rollback); the pipeline’s `wayfinderComplete`/`prewalkComplete` gates are enforced; `agent()` spawns stay ungated on default runs and are gated behind Phase 3 + human approval wherever `phaseState.gateAgentCalls` is on (embedding opt-in, or the `/workflows implement` command) | State machine armed per cwd; agent gate opt-in | `.pi/workflows/active-state.json` |
| 6 | Plannotator visual review gate (Phase 2): a script-authored `checkpoint()` — or a meta-declared `gate: "approve"` — publishes the plan to the SSE bridge and waits for approve/deny | Yes — the shipped `plan-then-execute` builtin declares `meta.gate: "approve"` and pauses before the body; user scripts can too | `meta.gate: "approve"` + `createPlannotatorBridge` + plan file + `plannotatorSubmitted`/`humanApproved` flags |
| 7 | Worktree implement (Phase 3): `/workflows implement <id>` fans blueprint steps out to worktree subagents | Manual slash command; refused until the run reached Phase 3 + human approval and a blueprint exists | per-task commits on `pi/wf/` branches |
| 8 | Atomic checkpointing, crash recovery, cleanup | Yes — startup recovery sweep in the manager constructor (`recoverStaleRuns`) runs at every extension activation; `/workflows resume` and `/workflows clean` are live | Startup sweep settles orphaned `running` runs to `paused` (never `failed`; journal preserved, lease reclaimed, nothing deleted); `/workflows resume` (journal replay, lease) and `/workflows clean` (worktree sweep); standalone `resumeRun()`/`cleanupRun()` only flip a persisted run’s status on disk — no journal replay, no re-execution, no lease |
| 9 | Non-blocking runs + read-only interceptor + status | Yes | `background: true` default; write executors conflict-guarded via `guardWorktreeWriteConflicts`; status via the manager-backed `workflow_control` tool and `/workflows status` |
| 10 | Damage control + recovery toolset (subagent kill, orphan recover, dry-run clean) | Yes — `workflow_damage_control` registered on the host; subagent exposure via the `subagentDamageControlTools` gate (default `off`) | 9-verb `workflow_damage_control` tool: list/status/agents/pause/resume/stop/kill-agent/recover/clean; `recover` reclaims stale leases + journal-prefix resumes; `clean` is dry-run by default; subagents opt in with `subagentDamageControlTools: readonly`/`on` (deliberately separate from `subagentExtensionTools`) |

**Library helpers vs canonical surfaces.** The raw exports `resumeRun`, `cleanupRun`, `getWorkflowStatus`, `listRunningWorkflows`, `acquireFileLock`, `releaseFileLock`, and `checkFileConflict` remain public for embedders, but the production surfaces above are canonical: `WorkflowManager` (resume/settle/status) and the `/workflows` commands. `resumeRun()`/`cleanupRun()` are bookkeeping status flips only; the lock helpers are primitives whose only live consumer is the `guardWorktreeWriteConflicts()` interceptor already wrapped into the host tool seams (worktree agents today claim locks only from tests/library callers — there is no live claimer yet).
</details>

| Agent option | Description |
| --- | --- |
| `tier` | `small`, `medium`, or `big` model routing |
| `model` | Exact `provider/modelId` or `provider/modelId:thinking`; overrides `tier` |
| `agentType` | Named role, tool, and model definition |
| `isolation` | Use `"worktree"` for conflict-free parallel edits |
| `keepWorktree` | Retain the finalized worktree+branch after the agent finishes |
| `schema` | JSON Schema for a validated structured result |
| `label` / `phase` | Display label and phase override |
| `timeoutMs` / `retries` | Optional per-agent timeout and recoverable-failure retries |

`agent()` resolves to plain text unless `schema` is set — a prompt that merely asks the model to "return JSON" does not change that, and reading a field off unparsed text fails silently (`undefined`, not an error), which can make a whole `parallel()` fleet look "successful" while every result is unusable. Parse and validate defensively when a schema isn't set, and flag what doesn't parse instead of dropping it:

```js
function parseOrFlag(text, requiredKeys) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try {
    const value = JSON.parse(fence ? fence[1] : text);
    if (value && typeof value === "object" && requiredKeys.every((k) => k in value)) return { ok: true, value };
  } catch {
    // fall through
  }
  return { ok: false, raw: text };
}
```

Prefer `schema` (JSON Schema validation with bounded repair) over ad hoc parsing whenever the result's shape matters downstream.

The [full documentation](https://quintinshaw.github.io/pi-dynamic-workflows/) covers every option, structured output, determinism, saved workflows, and operational control.

<details>
<summary><strong>Model tiers and run controls</strong></summary>

Model tiers live at `~/.pi/workflows/model-tiers.json` and accept Pi CLI-style thinking suffixes:

```json
{
  "tiers": {
    "small": "openai-codex/gpt-5.4-mini:low",
    "medium": "openai-codex/gpt-5.4:medium",
    "big": "openai-codex/gpt-5.5:xhigh"
  }
}
```

Use `/workflows-models` to edit them interactively. Without a config, the extension ranks authenticated models by capability hints and assigns distinct models when possible. To route one logical model across several authenticated providers with per-provider concurrency caps and run-sticky routing, see the provider pool section below.

Omitted `tokenBudget` and `agentTimeoutMs` values use configured `defaultTokenBudget` and `defaultAgentTimeoutMs` settings; without them, runs are unlimited and have no hard per-agent timeout. Add per-run or per-agent values when you need explicit gates. `concurrency` is clamped to 16; `agentRetries` retries only recoverable failures. Run-level `concurrency` (and `defaultConcurrency`) stays the master run limiter; the provider pool layers per-provider caps under it.

Newer run options: `drainTimeoutMs` (default 60 s) waits for un-awaited `agent()` calls after the script finishes, then aborts stragglers; `maxNestedWorkflowDepth` (default 1, clamp 1–8) caps workflow-in-workflow nesting; `preRunTypecheck` (default off) soft-fails `tsc --noEmit` before launch and never blocks when a toolchain is missing.

Workflow tool inputs are range-validated at the boundary: `maxAgents` 1–1000, `concurrency` 1–16, `agentRetries` 0–3, `agentTimeoutMs`/`tokenBudget` ≥ 1; combining `name` + `script` throws. `settings.json` is schema-validated — malformed JSON, unknown keys, or wrong-typed values throw a named `ConfigError` naming the file instead of silently degrading.

Defaults live in `~/.pi/workflows/settings.json`; `defaultTokenBudget` is a soft pre-call gate, and a project-level override of `null` cancels a global budget.

`/workflows-settings` inspects and edits every settings key interactively: `↑/↓` navigate, `Enter` cycles booleans/enums or opens a value submenu, `/` searches, and the save row writes only your staged changes to the chosen file (`Esc` cancels with a discard confirmation when you have unsaved changes). `status` (alias `print`) prints the effective merged config — env overrides included and marked `🔒 env` — and `paths` prints the two file locations. The global file is `~/.pi/workflows/settings.json`; the per-project override lives under `~/.pi/workflows/projects/<project>/settings.json` and is offered as a save target only when the current project is trusted. Keys pinned by a `PI_WORKFLOW_*` environment variable are shown read-only from the env value and are never written back to disk — edit the env var, not the file.

A schema-less agent that finishes its turn without any final text (a tool-call or thinking-only ending) is recovered in-session: the runner re-prompts the same session once asking for the final answer, and only declares the recoverable `AGENT_EMPTY_OUTPUT` failure if that nudge is also empty. The nudge is far cheaper than the workflow-level retry, which re-runs the whole agent from scratch; per call, `emptyOutputNudge: false` pins the legacy immediate-throw behavior. Silently truncated output (`stopReason: "length"`) is never nudged or retried — it is classified `CONTEXT_OVERFLOW` (non-recoverable), so the run settles failed with its journal preserved and `resumeFromRunId` re-runs only the overflowing agent with a fresh session. Some models occasionally end on a tool call on an otherwise-fine first attempt; if a fleet is built on one of them, set `agentRetries: 1-2` rather than treating an isolated empty output as a failed run.

Pausing and resuming a run keeps the limits it started with — `maxAgents`, `agentTimeoutMs`, `concurrency`, and `agentRetries` carry over instead of falling back to defaults, and `tokenBudget` tracking is cumulative across the pause, so a run can't reset its spend by pausing and resuming.

</details>

<details>
<summary><strong>Provider pool (multi-provider load balancing)</strong></summary>

Parallel subagents fan out and can hit a single provider's TPM / concurrent-request limit before the run finishes. The provider pool mixes two or more providers serving the same logical model: each `agent()` acquires ONE provider endpoint up front (weighted routing, per-provider concurrency caps), and that pinned choice never changes for the session.

Configure it under a `providerPool` key in `~/.pi/workflows/settings.json` (or via the `PI_WORKFLOW_PROVIDER_POOL` full-JSON environment override — see the environment-variable table below):

```jsonc
{
  "providerPool": {
    "enabled": true,
    "whenSaturated": "wait",
    "saturationWaitTimeoutMs": 300000,
    "defaultTpmWindowMs": 60000,
    "models": {
      "deepseek-v4-flash": {
        "deepseek":  { "modelId": "deepseek-v4-flash",          "concurrency": 2, "weight": 3, "tpm": 400000 },
        "openrouter": { "modelId": "deepseek/deepseek-v4-flash", "concurrency": 2, "weight": 1, "tpm": 800000 },
        "providerC": { "modelId": "vendor/deepseek-v4-flash",   "concurrency": 1, "weight": 1 }
      }
    }
  }
}
```

`models` maps a logical model id (the one tiers/routing select) to per-provider entries:

| Field | Meaning | Default |
| --- | --- | --- |
| `modelId` | The registry model id this provider serves for the logical model — required when the alias differs (e.g. `deepseek/deepseek-v4-flash` on OpenRouter) | the logical model id |
| `concurrency` | Max concurrent agents on this provider endpoint | 1 |
| `weight` | Proportional routing weight: the pool picks `min(active / weight)` among free providers, so a 3×-weighted provider takes ~3× the load without being hammered first | 1 |
| `tpm` | Manual output-TPM cap over `defaultTpmWindowMs` — the primary TPM gate (measured TPM feeds the auto-cooldown) | none |
| `cooldownMs` | Cooldown a provider enters after a recorded 429/limit event | 60000 |

Top-level keys: `enabled` (off → legacy single-resolution behavior; default true), `whenSaturated` (`"wait"` FIFO-queues saturated acquires, abort-aware, default — or `"fail"`, which throws a `PROVIDER_SATURATED` error that is non-recoverable when the whole pool is saturated, so the run checkpoints/pauses like a usage limit, and recoverable when only the run's pinned provider is hot, so the retry lands elsewhere), `saturationWaitTimeoutMs` (wait budget for a saturated acquire; 0 = wait forever, default 300000), `defaultTpmWindowMs` (rolling window for the TPM gate, default 60000). Providers referenced must already have auth configured; a provider without auth is skipped at acquire with a one-time log.

**Run-sticky routing.** The provider is chosen ONCE when a fresh subagent session starts, and the bound model never changes for that session — a subagent stays on its provider until it finishes, so trajectory continuity and provider-side prompt caching stay warm and no mid-run model swap happens. Retries of a failed agent re-acquire the SAME provider (the reservation holds its slot during backoff; `release` is idempotent). Handoff sessions bypass the pool entirely: their model is already bound and is never swapped or re-counted.

**Behavior matrix:**

| Situation | Without pool | With pool |
| --- | --- | --- |
| 8 parallel agents, caps 2/2/1 | all on one provider → 429 → pause whole run | spread 2/2/1, queue the rest; no 429 |
| Provider A 429s mid-fanout | run pauses, resume replays | A enters cooldown; new agents route B/C; the stuck agent retries A (warm cache) then A is skipped |
| Two providers, same model | manual pinning, no failover | logical model → weighted routing, per-provider caps |
| Handoff session | model persists | bypassed — never swapped |
| All providers capped | 429 → pause | FIFO wait (or fail-fast → existing pause+resume) |

</details>

<details>
<summary><strong>Storage, resume, and persisted sessions</strong></summary>

Extension state lives outside the repository under `~/.pi/workflows`:

- global settings and tiers: `~/.pi/workflows/settings.json` and `model-tiers.json`
- project runs, journals, locks, and saved overrides: `~/.pi/workflows/projects/<project>/`
- older project-local `.pi/workflows/runs` and `.pi/workflows/saved` remain readable as fallbacks

Subagents are in-memory by default. Set `persistAgentSessions: true` to retain full transcripts in Pi's standard session directory. This creates one file per agent and may store sensitive material that an agent read, so enable it deliberately.

Completed background runs persist their full result in the project run JSON. The conversation delivery includes a pointer to that file when the visible summary is shortened.

Pi's `/reload` keeps the live workflow manager in-process when the installed extension version has not changed. Active background runs therefore continue streaming progress, remain controllable, and deliver their result through the freshly loaded extension; session-local `/effort` also survives the reload. If the package version changes, active runs are paused and a fresh manager loads, leaving them safely resumable through the journal instead of mixing extension versions. This handoff applies only to `/reload`. A process restart still uses the same durable journal path, recovering an interrupted running workflow as paused so it can be resumed safely.

**Startup crash-recovery sweep.** Every `WorkflowManager` construction — including the one the extension performs at activation — scans persisted runs and settles any still-`running` run that this process has nowhere in memory (the artifact of a process that died mid-run) to `paused`, never `failed`, under the run's exclusive lease: the journal is preserved untouched and the reclaimed lease is released for a later `resume()`. The sweep never deletes anything — journals, plans, results, worktrees, and branches all survive a crash and are only removed by an explicit `/workflows clean` (or navigator delete). A best-effort `git worktree prune` also runs at construction to drop ghost worktree registrations whose directories no longer exist (metadata only — directories are left alone).

On any shutdown the extension deterministically disposes the resources it owns: the usage-limit scheduler's timers, the host-tool gateway (ending its MCP bridge socket), and any on-demand review bridge (its `close()` ends open SSE responses and closes the server). The handoff is idempotent — a double-fired shutdown cannot double-close or re-stage the same generation.

Finished runs (completed, failed, or aborted) are retained in full on disk, capped at the 300 most recent per project — older ones are evicted first, and a running or paused run is never touched. Only a smaller number (20 by default) also stay fully loaded in memory for instant access right after they finish; older finished runs still show up in `/workflows` and `workflow_control list`, just read back from disk instead of memory. Library embedders can tune both caps — `maxTerminalRunsInMemory` on `WorkflowManager` and `maxTerminalRunsOnDisk` on the run-persistence layer.

Journals keep at most 50,000 entries (oldest are dropped and re-run live on resume) and the persisted journal is capped at 32 MiB. Run JSON is scrubbed on disk for provider keys, `KEY=value` env pairs, Bearer/Basic/JWT/PEM secrets, and token prefixes (`sk-`, `ghp_`, `xox-`). Run leases carry a 30-minute TTL refreshed by heartbeat, so a crashed or hung owner (even with a reused pid) is reclaimable.

SDK callers may pass `compactJournal: true` on `runWorkflow`/`WorkflowManager.exec` (default off): resolved journal entries are interned into a summary only when reconstruction reproduces the journal byte-identically and the file shrinks — lossless, frozen at run start, carried across resume.

The shared store (`store_put`) is bounded at 10k keys / 8 MiB total / 1 MiB per value with FIFO eviction (oldest first, never the key being written); non-serializable values throw `TypeError`, oversized ones `RangeError` — rejected values never land in the store.

Completed-run result text no longer appends a resume hint; a failed or paused run's delivery carries one and names the `resumableRunId` to continue from. In-memory run logs are a ring buffer capped at 1,000 entries (persisted file logs are uncapped), and a throwing `onLog` sink never breaks the run.

</details>

<details>
<summary><strong>Keyword trigger</strong></summary>

Set a literal, case-insensitive custom trigger in `~/.pi/workflows/settings.json`:

```json
{
  "keywordTriggerWord": "pi-workflow"
}
```

The default `workflow` also matches `workflows`; a custom word matches exactly. Trigger words are case-insensitive and Unicode identifier-bounded, and do not activate inside paths, slash commands, or identifier-like text. Detection is purely textual, applied at submit time to the message you send — it does not depend on, or own, Pi's editor component, so it works the same regardless of what else is installed.

</details>

<details>
<summary><strong>Environment-variable overrides (headless / CI / containers)</strong></summary>

Every workflow setting can be overridden per key with a `PI_WORKFLOW_*` environment variable — the settings channel that works without a writable home directory or `settings.json`. Env overrides are merged on top of the global and project settings files (env wins per key), are applied to every settings reader in the extension, and never write back to disk, so a CI job can pin concurrency or budgets without mutating a developer's machine.

| Setting | Env var | Value shape |
| --- | --- | --- |
| `keywordTriggerEnabled` | `PI_WORKFLOW_KEYWORD_TRIGGER_ENABLED` | `true` / `false` |
| `keywordTriggerWord` | `PI_WORKFLOW_KEYWORD_TRIGGER_WORD` | plain word (no `/`, no whitespace) |
| `defaultAgentTimeoutMs` | `PI_WORKFLOW_DEFAULT_AGENT_TIMEOUT_MS` | positive integer; `null` or empty disables |
| `defaultTokenBudget` | `PI_WORKFLOW_DEFAULT_TOKEN_BUDGET` | positive integer; `null` or empty cancels a global budget |
| `defaultConcurrency` | `PI_WORKFLOW_DEFAULT_CONCURRENCY` | integer 1–16 |
| `providerPool` | `PI_WORKFLOW_PROVIDER_POOL` | full JSON override — see provider pool above |
| `defaultAgentRetries` | `PI_WORKFLOW_DEFAULT_AGENT_RETRIES` | integer 0–3 |
| `progressPanelMode` | `PI_WORKFLOW_PROGRESS_PANEL_MODE` | `compact` / `detailed` |
| `progressPanelMaxAgents` | `PI_WORKFLOW_PROGRESS_PANEL_MAX_AGENTS` | integer 1–1000 |
| `persistAgentSessions` | `PI_WORKFLOW_PERSIST_AGENT_SESSIONS` | `true` / `false` |
| `deliveredResultMaxChars` | `PI_WORKFLOW_DELIVERED_RESULT_MAX_CHARS` | integer 1–1000000 |
| `excludeSubagentTools` | `PI_WORKFLOW_EXCLUDE_SUBAGENT_TOOLS` | comma-separated tool names |
| `subagentHostTools` | `PI_WORKFLOW_SUBAGENT_HOST_TOOLS` | `auto` (default) / `on` / `off` |
| `subagentTools` | `PI_WORKFLOW_SUBAGENT_TOOLS` | `all` (default) / comma-separated `mcp_*` allowlist / empty = none |
| `subagentChromeTools` | `PI_WORKFLOW_SUBAGENT_CHROME_TOOLS` | `off` (default) / `on` |
| `subagentExtensionTools` | `PI_WORKFLOW_SUBAGENT_EXTENSION_TOOLS` | `off` (default) / `on` / source allowlist (e.g. `["supi-web"]`) |
| `subagentDamageControlTools` | `PI_WORKFLOW_SUBAGENT_DAMAGE_CONTROL_TOOLS` | `off` (default) / `readonly` / `on` |

Unparseable, out-of-range, or unknown values are silently ignored (the same leniency the settings-file normalization applies), so a misconfigured CI env can never crash the extension — it just falls back to the file value. Example:

```bash
PI_WORKFLOW_DEFAULT_CONCURRENCY=8 PI_WORKFLOW_PERSIST_AGENT_SESSIONS=false pi
```

</details>

<details>
<summary><strong>Web tools</strong></summary>

`web_search` clamps `count` to 1–10 (default 6) and falls back to Bing RSS when the HTML scrape yields nothing; bodies are byte-capped (search 1 MiB) and the 15 s deadline aborts the in-flight request. `web_fetch`/`web_search` block SSRF targets (loopback/private/literal-IP unless allowlisted via `allowedHosts`), validate redirects (≤5 hops), cap content at 512 KiB, wrap fetched content in untrusted delimiters, and cache URLs across runs for 5 minutes.

</details>

<details>
<summary><strong>How it maps to Claude Code dynamic workflows</strong></summary>

| Claude Code dynamic workflows | pi-dynamic-workflows on Pi |
| --- | --- |
| Code-mode orchestration | JavaScript `agent()` / `parallel()` / `pipeline()` / `phase()` in a VM realm (for determinism, not a security boundary) |
| Isolated subagent contexts | Fresh in-memory Pi sessions; results remain in variables |
| Structured outputs | JSON Schema validation with bounded repair |
| Background runs | Non-blocking run, live panel, and automatic result delivery |
| Resume | Journaled replay of the unchanged completed prefix, including edit-and-resume with a revised script (`resumeFromRunId`) |
| Model selection | Per-agent and per-phase routing across authenticated providers |
| Ultracode | `/ultracode` or `/effort ultra` |
| Additional Pi features | Worktree isolation, real cost accounting, deep research, and quality-pattern helpers |

</details>

## Determinism and limits

Workflow scripts run in a Node `vm` sandbox. `Date.now()`, `Math.random()`, `new Date()`, `require`, `import`, filesystem access, and network access are unavailable inside the orchestration script. Subagents use their assigned tools; keeping the orchestrator deterministic is what makes journal replay reliable.

Journal replay — including edit-and-resume via `resumeFromRunId` — matches cached agent results by **positional call index** (the order in which `agent()` calls execute), the same contract Claude Code uses. Editing an `agent()` prompt in place reuses the cache up to that call and re-runs it and everything after. Inserting, removing, or reordering an `agent()` call before others shifts their positions and invalidates the cache from that point on (mismatched calls simply re-run — no crash). To preserve the cached prefix, keep the earlier still-good `agent()` calls unchanged and in the same order.

Only a call that finishes with a real result is journaled — a call whose every attempt ended in a recoverable failure (including one that only ever produced `AGENT_EMPTY_OUTPUT`) is never cached. Resuming such a run with `resumeFromRunId` therefore replays every earlier, already-succeeded call from cache and re-runs only that one call and everything lexically after it — cheap and exactly targeted, not a full re-run of the fleet.

## Upgrading to 3.0

3.0 is a milestone release. The one behavior change to know about:

- **Keyword triggering now _authorizes_ the workflow tool instead of _forcing_ it.** In 2.x, typing the trigger word (default `workflow`) rewrote your message into a directive that forced a background workflow. In 3.0 it _arms_ the tool and the model decides: a real, decomposable request is fanned out across agents, but a message that only mentions workflows — a question, a filename, a passing reference — is answered normally. Nothing to configure. If you relied on the word always kicking off a run, use `/workflows run <prompt>` for the explicit path. Keyword triggering stays on by default; `/workflows-trigger off` disables it and `/workflows-trigger set <word>` changes the word.

Everything else is additive or a fix: the `workflow_control` tool (list/status/pause/resume/stop), edited-script resume, auto-resume on provider usage limits, and persistence/perf hardening. Requires pi ≥ 0.80.8.

Library API note: the unused `createSharedStoreTools` export was removed — use `createAgentStoreTools`.

## Upgrading past 3.5

One behavior change to know about:

- **Subagents now get host coding + read-only tools automatically.** In the default `subagentHostTools: "auto"` mode, the first run that needs host tools lazily starts the host tool gateway and untagged runs receive `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web_search`, and `web_fetch` proxied from the host session — no `/workflows-gateway start`, no `toolset: "host-tools"` tag required. If you relied on “subagents have no host tools”, set `"subagentHostTools": "off"` in `settings.json` (global or project override) or `PI_WORKFLOW_SUBAGENT_HOST_TOOLS=off` to restore the exact previous behavior (manual `start` + explicit toolset only). The bundle is built entirely from the extension's own SDK-factory definitions and the host's **public** `ExtensionAPI` — no pi source modification. Builtin descriptions are synced from the live host's `getAllTools()`, and on a future host SDK exposing full tool definitions, MCP-server and other extension-registered tools are proxied as well — always minus the extension's own `workflow`/`workflow_control` tools and any `excludeSubagentTools` names. An `agentType` allowlist naming one of the proxied host tools now matches the proxied definitions — allowlisted/denylisted names still win over the merge.

## Upgrading past 3.2

Two behavior changes to know about:

- **Subagents no longer load host extensions by default.** Each run now builds one shared, extension-free resource loader for all of its subagents (a memory-leak mitigation). Skills, prompts, and `AGENTS.md` context still load, and the coding tools and any toolset (e.g. `web-research`) you hand a subagent are unaffected. What subagents lose is **host-extension-registered tools** — MCP bridges, browser tools, or anything else another installed extension adds. If an `agentType` names one of those tools in its allowlist, that entry now matches nothing. This also means a subagent can no longer recurse into another orchestration extension, even one not covered by the existing tool denylist.
- **Checkpoints persisted before this release re-run once.** `checkpoint()`'s resume-identity hash now also covers `default`, `headless`, and `timeoutMs`, so changing any of them between runs correctly invalidates a stale cached answer. This is a one-time effect: any checkpoint cached under the old hash simply re-prompts once and then caches normally again.

## Development

```bash
npm install
npm test     # Biome, TypeScript (incl. the extension entry), unit tests, release checks, entry contract
```

The check pipeline type-checks the extension entry (`extensions/workflow.ts`) together with the scripts via `tsconfig.scripts.json`, and `scripts/check-entry-contract.ts` verifies that `src/index.ts` still exports the documented public API (every name the extension entry, README, and tests depend on). Run the contract gate alone with `npm run check:entry-contract`.

### Optional model-comprehension evidence

The comprehension harness is manual and never runs in normal CI, `npm test`, or the release gate. Select an available model explicitly; the harness never embeds or chooses from a static model or agent-type catalogue.

```bash
npm run comprehension -- --model provider/model                    # quick writing scenario
npm run comprehension -- --model provider/model --suite full       # write, edit, review, and debug
npm run comprehension -- --model provider/model --output runs/a.json
npm run delivery-choice -- --model provider/model                  # timing and token-budget choices
```

By default, evidence is written under ignored `.pi/model-comprehension/`. Each JSON run records the exact prompts and versions, generated workflows, skill reads, provider token usage, deterministic runtime calls/topology/results, assertions, and failure details. The delivery-choice harness also checks that ordinary requests omit `tokenBudget` and explicit user caps are preserved exactly. Scenario failures are retained as non-blocking evidence and do not produce a failing exit status; argument, model-selection, and setup errors do.

Features are also verified end-to-end against real Pi subagent sessions before release. See [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute.

## Credits

The code-mode orchestration idea comes from [Michael Livs' original pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) and Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code). This project adds model routing, journaled resume, worktree isolation, measured usage, an interactive TUI, and built-in research and review workflows.

## License

MIT — see [LICENSE](./LICENSE).
