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
