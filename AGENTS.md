# Repository guidance

## Workflow documentation

Before changing the workflow runtime, tool API, capability contract, or `workflow-authoring` skill, read [Protected workflow-authoring guidance](CONTRIBUTING.md#protected-workflow-authoring-guidance).

- Keep stable capability facts in the executable capability contract and generated documentation.
- Keep detailed authoring guidance in the on-demand skill, not the always-on prompt.
- Do not copy live model or agent-type catalogues into static guidance.
- Run `npm run context:check` with the other checks listed in the contributor guide.
- If a protected file changes, review it before running `npm run guidance:accept -- <path>`.

## Entry surface

- The extension entry `extensions/workflow.ts` is type-checked by `npm run check:scripts` (`tsconfig.scripts.json` includes `extensions/`).
- `scripts/check-entry-contract.ts` (via `npm run check`) freezes the public `src/index.ts` export surface: adding or removing a public export requires updating `ENTRY_CONTRACT` there.
- Settings overrides via `PI_WORKFLOW_*` env vars are the headless/CI channel; see README "Environment-variable overrides".

## Runtime invariants

- Run `status`/`lease` are written ONLY by `startExecuting` / `settleExecuting` / `releaseHeldLease` (workflow-manager.ts); new write paths must route through these. Journal dedup helpers live in `run-persistence.ts` (`journalEntryKey`/`upsertJournalEntry`/`buildResumeJournal`/`keepsResumeJournal`), not workflow-manager.
- Persistence saves are CAS: byte-fingerprint re-read, tmp+rename, ≤8 attempts, merging checkpoints by taskId and journal by (runId,index). Writes stamp `schemaVersion: 1`; `load()` runs `migrateRunState()` (legacy = v0).
- Journal compaction (opt-in `compactJournal`) is QA-gated: a `kind:"compact"` summary persists only if `verifyJournalCompaction` reproduces the original journal byte-identically; failures keep the original.
- `'error'` fires only when the managed controller is NOT aborted — intentional pause()/stop()/deleteRun()/external-signal aborts settle to `'aborted'` silently. `'persist-error'` surfaces terminal persist failures after one status-only retry. `settleWatchdogMs` (default 30 s) force-releases a run whose aborted execution never settles. New `WorkflowErrorCode` members are numeric (-310xx); comprehension evidence serializes `errorCode` as a string.
- `resume()` takes a full `ExecOptions` passthrough (`onProgress`/`confirm` for TUI-bearing resumes), while the run's frozen knobs (budget, maxAgents, concurrency, timeouts, retries) stay those of the original start.
- Builtin arg/step validation exists as TS + embedded vm-source twins (`numericArgCoercionSource`, `orderStepsByDependenciesSource`, `normalizeSpecArtifactSource`, `diffShardSource`) — edits must keep both byte-in-sync.
- `WorkflowRunOptions.loadTierConfig` is injectable (hash seeding only); the resume-replay hash includes resolved tier→model, so editing `model-tiers.json` invalidates stale journaled results.
- `finalizeWorktree` returns `FinalizeResult`; teardown failures log the failing git step (`add -A` vs `commit`) + trimmed stderr — common cause: missing `user.identity`.
- Local `tasks/` scratch is git-ignored and excluded from Biome; keep it out of the shared repo.
- Guidance integrity checks are LF-basis (`* text eol=lf`; `readLf` normalization): hashes/byte counts are platform-independent; Windows checkouts must stay `eol=lf`.
- `npm run guidance:repair` atomically refreshes context-surface + guidance baseline and re-accepts every frozen file in one deterministic pass.

## Module map (maintenance)

- `src/gateway/*` — host-tool IPC gateway (`host-tool-gateway.ts`, `mcp-bridge.ts`); `src/agent/mcp-proxy-client.ts` — subagent-side proxy client.
- `src/phases/*` — wayfinder (phase 0), `state-machine.ts`, prewalk (phase 1); `src/integrations/plannotator.ts` — plan-approval bridge (phase 2).
- `src/agent/worktree-runner.ts` — `executeTask`/`implementProtocol`; `src/worktree.ts` — worktree lifecycle.
