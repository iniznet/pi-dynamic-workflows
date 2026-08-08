#!/usr/bin/env node
/**
 * F2 'concurrency-cap' test-suite runner.
 *
 * Caps the node test runner's file-level concurrency so the suite stops pegging
 * every core. Perf-CPU audit (tasks/perf-cpu-audit/report.md §1): ~65% of the
 * observed 100%-CPU report was (a) the test runner defaulting to
 * `availableParallelism() - 1` — 15 CPU-bound files at once on 16 cores — which
 * saturates the box by construction. The cap deliberately trades wall time
 * (A1 baseline 65,580ms at N=15 → more at N=4, measured below) to leave 12 of
 * 16 cores idle during the suite; `PI_TEST_CONCURRENCY` restores parallelism on
 * CI without edits.
 *
 * Invocation: the contract's empirical check passes — `tsx --test` DOES forward
 * `--test-concurrency` (probe: 2×1.5s tests, N=1 → 2.3s start delta = serial,
 * N=2 → 0.2s = parallel) — but the tsx CLI wrapper adds measurable startup cost
 * on Windows vs the documented fallback `node --import tsx --test` (probe:
 * 4.06s vs 2.83s; `npx` alone adds ~8s). We therefore invoke node directly with
 * the tsx loader: the same node test runner, same tsx module loader, fastest
 * equivalent path.
 *
 * Env overrides (CI):
 *   PI_TEST_CONCURRENCY  positive int — restore parallelism (e.g. 15) without edits
 *   PI_TEST_TIMEOUT_MS   positive int — per-test guard; the 180s default sits
 *                        above the worst 63s load-stall self-skip (A1 run2) and
 *                        far below a true hang. Guard-only: no healthy file
 *                        approaches it (worst single file solo = 9.35s).
 *
 * Extra CLI args are forwarded to the test runner: flags (anything starting
 * with `-`, e.g. `--test-name-pattern=...`) go BEFORE the globs because node's
 * test runner only applies such flags when they precede the positional file
 * args; positional paths (a single file to debug) are appended after.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";

const CONCURRENCY_CAP = 4;
const DEFAULT_TIMEOUT_MS = 180_000;

const TEST_GLOBS = [
  "tests/*.test.ts",
  "tests/gateway/*.test.ts",
  "tests/subagent/*.test.ts",
  "tests/helpers/*.test.ts",
  "tests/slices/**/*.test.ts",
];

function parsePositiveInt(raw, label) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function resolveConcurrency() {
  if (process.env.PI_TEST_CONCURRENCY) {
    return parsePositiveInt(process.env.PI_TEST_CONCURRENCY, "PI_TEST_CONCURRENCY");
  }
  return Math.min(os.availableParallelism() - 1, CONCURRENCY_CAP);
}

function resolveTimeoutMs() {
  if (process.env.PI_TEST_TIMEOUT_MS) {
    return parsePositiveInt(process.env.PI_TEST_TIMEOUT_MS, "PI_TEST_TIMEOUT_MS");
  }
  return DEFAULT_TIMEOUT_MS;
}

const concurrency = resolveConcurrency();
const timeoutMs = resolveTimeoutMs();
const startedAt = performance.now();

// Node's test runner ignores option flags that appear after positional file
// args (verified empirically), so user flags are injected before the globs
// and only bare paths are appended after them.
const forwardedFlags = process.argv.slice(2).filter((arg) => arg.startsWith("-"));
const forwardedPaths = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    `--test-concurrency=${concurrency}`,
    `--test-timeout=${timeoutMs}`,
    ...forwardedFlags,
    ...TEST_GLOBS,
    ...forwardedPaths,
  ],
  { stdio: "inherit" },
);

child.on("error", (error) => {
  console.error(`[run-tests] failed to start the test runner: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`[run-tests] test runner terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
  console.log(`concurrency=${concurrency} wall=${Math.round(performance.now() - startedAt)}ms`);
});
