/**
 * CLI exit-code contract for scripts/check-workflow-script.ts (F-T10).
 *
 * README.md documents the pre-flight check; the script itself declares the
 * exit codes: 0 = valid (prints the parsed meta), 1 = invalid script or
 * unreadable path (prints the reason), 2 = usage (no path argument). Spawned
 * the same way the comprehension CLI is exercised
 * (tests/workflow-comprehension.test.ts) — real process, real parse.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-workflow-script.ts");

const VALID_SCRIPT = `export const meta = {
  name: 'valid_contract',
  description: 'A valid workflow for the exit-code contract',
  phases: [{ title: 'Plan' }, { title: 'Execute' }],
}
return { done: true }
`;

const INVALID_SCRIPT = `const notMeta = 1
`;

/** Run the checker against the given argv; returns {status, stdout, stderr}. */
function runCheck(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("check-workflow-script exits 0 for a valid workflow file and prints the parsed meta", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-check-valid-"));
  const path = join(dir, "valid.js");
  writeFileSync(path, VALID_SCRIPT, "utf8");
  const result = runCheck(path);
  assert.equal(result.status, 0, "a valid script must exit 0");
  assert.match(result.stdout, /^OK /);
  assert.match(result.stdout, /workflow "valid_contract"/);
  assert.match(result.stdout, /A valid workflow for the exit-code contract/);
  assert.match(result.stdout, /phases: Plan, Execute/, "phases are rendered from the parsed meta");
});

test("check-workflow-script exits 1 for an invalid workflow file and prints the reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-check-invalid-"));
  const path = join(dir, "invalid.js");
  writeFileSync(path, INVALID_SCRIPT, "utf8");
  const result = runCheck(path);
  assert.equal(result.status, 1, "a script that fails parseWorkflowScript must exit 1");
  assert.match(result.stderr, /INVALID/);
  assert.match(result.stderr, /meta/, "the reason names the missing meta contract");
});

test("check-workflow-script exits 1 for an unreadable path", () => {
  const result = runCheck(join(ROOT, "does-not-exist-workflow.js"));
  assert.equal(result.status, 1, "a path that cannot be read must exit 1");
  assert.match(result.stderr, /Cannot read/);
});

test("check-workflow-script exits 2 with the usage line when no path is given", () => {
  const result = runCheck();
  assert.equal(result.status, 2, "a missing path argument is a usage error (exit 2)");
  assert.match(result.stderr, /Usage: npx tsx scripts\/check-workflow-script\.ts/);
});
