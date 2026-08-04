<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# Workflow capability index

Contract format: `1.0.0`<br>
Contract content / skill / extension: `3.6.0`

This compact generated index covers supported runtime globals and workflow-tool inputs. For constraints, compatibility behavior, internal boundaries, and dynamic-reference ownership, follow the [exhaustive generated facts](capability-details.md).

## Supported capability index

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
