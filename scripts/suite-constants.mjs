/**
 * Shared suite-concurrency cap for the test tooling.
 *
 * Single source of truth for the default file-level test-runner concurrency.
 * `src/agent/worktree-runner.ts` interpolates it into the worktree TDD default
 * so N parallel /implement tasks spawn N capped processes instead of
 * N × (availableParallelism() - 1) workers.
 *
 * The suite runner (scripts/run-tests.mjs, F1-owned) carries its own inline
 * CONCURRENCY_CAP pinned to the same value (the F1 4→2 drop landed there);
 * keep the two aligned, or route run-tests.mjs through this module, whenever
 * the cap next changes.
 *
 * Plain ESM (no tsx) so both plain-node scripts and tsx/TS sources can consume
 * it; TypeScript consumers resolve types via the sibling suite-constants.d.mts.
 */
export const SUITE_CONCURRENCY_CAP = 2;
