---
name: workflow-patterns
description: Argument shapes for the 10 built-in workflow patterns — deep-research, adversarial-review, code-review, multi-perspective, codebase-audit, plan-then-execute, spec-generation, debug-loop, spec-conformance, supervised-run — runnable via the `workflow` tool's `name` input, without slash-command syntax. Use for requests like "research X", "fact-check/adversarially review this", "review this diff/PR", "analyze from multiple perspectives", "audit the codebase for Y", "plan then execute a multi-step task", "write a spec for X", "debug and fix a failing test", "audit a spec against the implementation", "supervise a delegated task against a completion criterion", or "trace the impact of a change". Not for authoring a new workflow script — see workflow-authoring.
metadata:
  version: "3.6.0"
---

# Built-in workflow patterns

pi-dynamic-workflows ships 10 curated, tested workflow patterns. Five are also
slash commands (`/deep-research`, `/adversarial-review`, `/code-review`,
`/multi-perspective`, `/codebase-audit`), but all 10 are equally reachable from
the `workflow` tool directly: call it with `name` set to the pattern name
below and `args` matching its shape, instead of writing an equivalent script
from scratch. Prefer this over authoring a new script whenever the request
fits one of these shapes — the curated version is already reviewed and tested.

A project or user saved workflow of the same name always takes precedence
over a built-in of that name — on the slash command, too.

These 10 names are reachable only at the `workflow` tool's top-level `name`
input, not via the in-script `await workflow(savedName, childArgs)` helper —
that helper resolves saved workflows only and treats any other string as raw
script text. Calling `workflow('deep-research')` from inside a script
therefore fails at script validation (the string is not a script with
`export const meta`), never as a saved-workflow name lookup; use the top-level
`name` input instead.

## Patterns

| `name` | When to reach for it | `args` |
| --- | --- | --- |
| `deep-research` | Research a question across the web with cross-checked sources | `{ question: string, angles?: number, minSupport?: number }` — `angles` (default 4, 1–8) is the number of distinct search queries; `minSupport` (default 2, 1–5) is the minimum distinct sources required for a claim to survive cross-checking (out-of-range values reject before the run starts) |
| `adversarial-review` | Investigate a task/claim, then cross-check each finding with skeptical reviewers | `{ task: string, reviewers?: number, threshold?: number, maxFindings?: number }` — `reviewers` (default 2, min 2 — a lone reviewer can't be cross-checked); `threshold` (default 0.66, so a 1-of-2 split never survives); `maxFindings` (default 25, 1–50) bounds how many findings go to the refute reviewers |
| `code-review` | Multi-angle review of a diff (8 finders: correctness, removed-behavior, call-site, reuse, simplification, efficiency, altitude, security) — an impact-analysis phase first maps the diff's impact radius + test scope (codegraph callers/callees) and scopes every finder by the emitted partition | `{ diff: string, diffSource?: string, diffTruncated?: boolean, diffLength?: number, maxCandidates?: number, verifyBatchSize?: number }` — supply `diff` directly (e.g. `git diff`, `gh pr diff <n>`), or pass `diffSource` as a `git …`/`gh pr diff …` command and the extension fetches its output host-side before the run (an explicit `diff` always wins; when you truncated it, set `diffTruncated`/`diffLength`). `maxCandidates` (default 30, 1–200) caps how many findings are verified; `verifyBatchSize` (default 5, 1–20) sizes verify batches. Findings carry a severity (critical/high/medium/low) and rank security > correctness > cleanup > altitude, severity within an angle |
| `multi-perspective` | Analyze a topic from several independent perspectives in parallel, then synthesize | `{ topic: string, perspectives?: string[] }` — omit or give fewer than 2 to use the default set (technical, product, security, user experience, maintainability) |
| `codebase-audit` | Run parallel checks against a codebase scope, then cross-validate and report — an impact-analysis phase first maps the scope's impact radius + test scope (codegraph callers/callees) and scopes every check by the emitted partition | `{ scope: string, checks: string[] }` |
| `plan-then-execute` | Decompose an objective into dependency-ordered steps, gate each step with a verifier (bounded rework loop), optionally execute each step — pauses for human approval before any agent work | `{ objective: string, context?: string, maxSteps?: number, execute?: boolean }` — `maxSteps` (default 10, 1–25) bounds how many steps are verified/executed; set `execute: true` to run each accepted step's implementation (skipped steps and rejected steps are reported, not run) |
| `spec-generation` | Draft a specification from product/technical/risk perspectives in parallel, then adversarially review into a structured artifact (goal, requirements with IDs, constraints, acceptance criteria, risks, open questions) | `{ topic: string, audience?: string, format?: "markdown" | "json" }` — `format` (default `markdown`) renders the final artifact as prose or as the raw spec JSON |
| `debug-loop` | Isolate a bug: hypothesize the root cause, reproduce it with machine evidence (bash-captured exit code + output), fix it, and machine-verify the fix with bounded rework — a green re-run stops the loop, exhaustion fails closed with per-round evidence | `{ bug: string, reproduce?: string, maxRounds?: number }` — `reproduce` is an optional pre-known reproduction command (the hypothesize agent may also name one); `maxRounds` (default 3, 1–6) bounds the fix→verify rounds |
| `spec-conformance` | Audit an implementation workspace against a spec: per-requirement mechanical evidence (symbols, registrations, probed behavior), missing/extra detection, scored conformance report — closes the loop with `spec-generation` (feed its artifact straight in) | `{ spec: object \| string, workspace?: string, maxRequirements?: number }` — `spec` is the spec-generation artifact (or its run result / a JSON string); `workspace` (default `.`) is the implementation sub-path; `maxRequirements` (default 12, 1–30) caps the per-requirement evidence fan-out |
| `supervised-run` | Delegate a task to a work agent and supervise it against a concrete measurable completion criterion: after every settle an economy supervisor agent (pure-reasoning) checks progress, injects ONE corrective agent on drift/stall, and declares done when the criterion is verified met (bounded rework) | `{ task: string, criterion: string, maxRounds?: number }` — `task` is the work to complete; `criterion` is the concrete measurable completion criterion the supervisor verifies (prefer a MACHINE-TEST criterion — a grep/find hit, a file existing, a test passing — over a subjective quality judgment); `maxRounds` (default 5, 1–12) bounds the supervisor turns (each turn may inject one corrective agent) |

## Example

```json
{ "name": "deep-research", "args": { "question": "What are the tradeoffs of X vs Y?" } }
```

This is a `workflow` tool call, not a script — omit `script` entirely. The run
starts in the background exactly like the slash-command form; `background`,
`maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget`
all still apply.

## Writing a new workflow instead

If the request doesn't fit one of these 10 shapes, author a script with
`script` as usual — see the workflow-authoring skill.
