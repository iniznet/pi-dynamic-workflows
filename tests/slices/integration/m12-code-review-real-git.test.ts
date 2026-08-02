/**
 * Slice V2 (test-suite) — M12 companion: the /code-review diff fetch against
 * the REAL git binary (the mock-based suite cannot prove the real exec works).
 *
 * Runs the empty-args handler in a temporary git repo with a committed change:
 * the real `git diff HEAD` must produce the diff, the pre-exec progress notify
 * must fire (M12), and the review run must start with the fetched diff. This
 * file intentionally has NO resolve hook — builtin-commands uses the real
 * child_process here.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerBuiltinWorkflows } from "../../../src/builtin-commands.js";
import { parseWorkflowScript } from "../../../src/workflow.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "../../helpers/mock-pi.js";

/** A temp git repo with one committed change to `file.txt`. */
function initRepoWithChange(): string {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-m12-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "m12@test.local");
  git("config", "user.name", "m12");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "file.txt"), "base\n+changed\n");
  return repo;
}

test("M12: /code-review fetches the diff with real git and starts the review (success flow)", async () => {
  const repo = initRepoWithChange();
  try {
    const { pi, commands } = makeCommandRegistryPi();
    const { ctx, notified } = makeNotifyCtx();
    const started: Array<{ script: string; args: Record<string, unknown> }> = [];
    const manager = {
      startInBackground(script: string, args?: unknown) {
        started.push({ script, args: (args ?? {}) as Record<string, unknown> });
        return { runId: "run-m12-real", promise: new Promise(() => {}) };
      },
    } as unknown as never;

    registerBuiltinWorkflows(pi, { cwd: repo, manager });
    const command = commands.find((c) => c.name === "code-review");
    assert.ok(command);
    const handler = command.handler as (args: string, c: ExtensionCommandContext) => Promise<void>;

    await handler("", ctx);

    // The pre-exec progress notify (M12) names the source it is about to fetch.
    assert.ok(
      notified.some((n) => n.message.includes("Fetching diff from git diff HEAD")),
      `pre-exec notify expected; got: ${JSON.stringify(notified)}`,
    );

    // The real git diff reached the review run with truncation provenance.
    assert.equal(started.length, 1, "the review starts after the real diff fetch");
    assert.match(started[0].args.diff as string, /diff --git a\/file\.txt b\/file\.txt/);
    assert.match(started[0].args.diff as string, /\+changed/);
    assert.equal(started[0].args.diffSource, "git diff HEAD");
    assert.equal(started[0].args.diffTruncated, false);
    assert.equal(typeof started[0].args.diffLength, "number");
    const { meta } = parseWorkflowScript(started[0].script);
    assert.equal(meta.name, "code_review");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
