import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateAdversarialReviewWorkflow, generateMultiPerspectiveWorkflow } from "../src/adversarial-review.js";
import { findBuiltinWorkflow, prepareBuiltinWorkflowArgs } from "../src/builtin-workflows.js";
import { generateCodeReviewWorkflow } from "../src/code-review.js";
import { generateCodebaseAuditWorkflow, generateDeepResearchWorkflow } from "../src/deep-research.js";
import { createWebTools } from "../src/web-tools.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

// ─── Deep Research ──────────────────────────────────────────────────────────────

test("generateDeepResearchWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateDeepResearchWorkflow());
  assert.equal(meta.name, "deep_research");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Queries", "Gather", "Verify", "Report"],
  );
  assert.match(body, /args && args\.question/);
  assert.match(body, /web_search/);
  assert.match(body, /web_fetch/);
});

test("generateDeepResearchWorkflow uses configurable angles and minSupport", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /args\.angles/);
  assert.match(body, /args\.minSupport/);
});

test("generateDeepResearchWorkflow guards the planner result before reading queries (#86)", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /Array\.isArray\(plan\.queries\)/);
  assert.match(body, /\[question\]/); // falls back to the question when the planner yields nothing
});

test("deep_research tolerates a null query planner and falls back to the question (#86)", async () => {
  // Regression for #86: the planner agent() can return null (e.g. a subagent that
  // died on a terminal provider error). The Queries phase must not crash on
  // plan.queries — it should fall back to the original question so research proceeds.
  const gatherPrompts: string[] = [];
  const runner = {
    async run(prompt: string) {
      if (prompt.includes("planning web research")) return null; // planner "failed"
      if (prompt.includes("Research this query")) {
        gatherPrompts.push(prompt);
        return { sources: [] };
      }
      return null; // verify/report are already null-tolerant downstream
    },
  };
  // Would reject (crash) before the fix; must resolve now.
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: runner as never,
    persistLogs: false,
    args: { question: "What is WebGPU?", angles: 3 },
  });
  assert.ok(gatherPrompts.length >= 1, "Gather should still run using the fallback query");
  assert.ok(
    gatherPrompts.some((p) => p.includes("What is WebGPU?")),
    "the fallback query should be the original question",
  );
  // Value-compare (not deepEqual): the script runs in a vm realm, so its arrays
  // have the realm's Array prototype and fail a strict reference-equal check.
  const queries = (result.result as { queries?: string[] })?.queries;
  assert.equal(queries?.length, 1, "a null planner should fall back to exactly one query");
  assert.equal(queries?.[0], "What is WebGPU?", "the fallback query should be the original question");
});

// ─── Adversarial Review ─────────────────────────────────────────────────────────

test("generateAdversarialReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.equal(meta.name, "adversarial_review");
  assert.match(body, /args && args\.task/);
  assert.match(body, /threshold/);
  assert.match(body, /survives/);
});

test("generateAdversarialReviewWorkflow phases are Investigate, Refute, Consensus", () => {
  const { meta } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Investigate", "Refute", "Consensus"],
  );
});

// ─── Codebase Audit ─────────────────────────────────────────────────────────────

test("generateCodebaseAuditWorkflow produces a valid, parseable script", () => {
  const { meta } = parseWorkflowScript(
    generateCodebaseAuditWorkflow("src/", ["check types", "find bugs", "review style"]),
  );
  assert.equal(meta.name, "codebase_audit");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Individual Checks", "Cross-Validation", "Report"],
  );
});

test("generateCodebaseAuditWorkflow creates an agent per check item", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["check-a", "check-b", "check-c"]);
  assert.match(body, /check-a/);
  assert.match(body, /check-b/);
  assert.match(body, /check-c/);
});

test("generateCodebaseAuditWorkflow uses parallel for checks", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["lint"]);
  assert.match(body, /parallel\(/);
});

test("generateCodebaseAuditWorkflow includes validator and report phases", () => {
  const body = generateCodebaseAuditWorkflow("src/", ["test"]);
  assert.match(body, /validator/);
  assert.match(body, /report-writer/);
});

test("generateCodebaseAuditWorkflow embeds a scope/check containing quotes/backticks as a valid, parseable script", () => {
  const tricky = 'it\'s a "test" with `backticks` and \\backslashes\\';
  const body = generateCodebaseAuditWorkflow(tricky, ["find TODO's", 'quote "marks"', "back`ticks`"]);
  // JSON.stringify-embedded values must round-trip through parsing/execution
  // without breaking out of the generated script (see the quote-injection fix).
  const { meta } = parseWorkflowScript(body);
  assert.equal(meta.name, "codebase_audit");
});

test("generateCodebaseAuditWorkflow running with quote-laden scope/checks executes without a parse error", async () => {
  const tricky = 'it\'s a "test" with `backticks`';
  const body = generateCodebaseAuditWorkflow(tricky, ["find TODO's"]);
  const seenScopes: string[] = [];
  const result = await runWorkflow(body, {
    agent: {
      async run(prompt: string) {
        seenScopes.push(prompt);
        return "ok";
      },
    },
    persistLogs: false,
  });
  assert.equal(result.agentCount, 3, "the check agent + validator + report agents all run without throwing");
  assert.ok(
    seenScopes.some((p) => p.includes(tricky)),
    "the full, untruncated scope should reach the check agent's prompt",
  );
});

test("generateCodebaseAuditWorkflow truncates only the display description, never the operative scope", () => {
  const long = "x".repeat(100);
  const body = generateCodebaseAuditWorkflow(long, ["check"]);
  // The operative `const scope = ...` must carry the full, untruncated value —
  // a truncated operative scope would silently narrow what gets audited.
  assert.ok(body.includes(JSON.stringify(long)), "the operative scope must be the full 100-char string");
  // The human-readable meta.description is display-only and may be truncated.
  assert.ok(body.includes(`${"x".repeat(60)}…`), "meta.description should show the truncated, ellipsized scope");
  assert.ok(
    !body.includes(JSON.stringify(`Codebase audit: ${long}`)),
    "meta.description itself should not contain the full untruncated scope",
  );
});

// ─── Multi-Perspective ──────────────────────────────────────────────────────────

test("generateMultiPerspectiveWorkflow produces a valid, parseable script", () => {
  const { meta } = parseWorkflowScript(
    generateMultiPerspectiveWorkflow("climate change", ["economic", "environmental", "social"]),
  );
  assert.equal(meta.name, "multi_perspective_analysis");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Perspective Analysis", "Synthesis"],
  );
});

test("generateMultiPerspectiveWorkflow creates one agent per perspective", () => {
  const perspectives = ["technical", "business", "user"];
  const body = generateMultiPerspectiveWorkflow("new API", perspectives);
  assert.match(body, /technical/);
  assert.match(body, /business/);
  assert.match(body, /user/);
});

test("generateMultiPerspectiveWorkflow uses parallel for perspective analysis", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1", "p2"]);
  assert.match(body, /parallel\(/);
});

test("generateMultiPerspectiveWorkflow includes synthesis phase", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1"]);
  assert.match(body, /synthesizer/);
});

test("generateMultiPerspectiveWorkflow returns analyses and synthesis", () => {
  const body = generateMultiPerspectiveWorkflow("topic", ["p1"]);
  assert.match(body, /analyses/);
  assert.match(body, /synthesis/);
});

test("generateMultiPerspectiveWorkflow embeds a topic/perspective containing quotes/backticks as a valid, parseable script", () => {
  const trickyTopic = 'it\'s a "test" with `backticks` and \\backslashes\\';
  const body = generateMultiPerspectiveWorkflow(trickyTopic, ["user's view", 'quote "marks"', "back`ticks`"]);
  const { meta } = parseWorkflowScript(body);
  assert.equal(meta.name, "multi_perspective_analysis");
});

test("generateMultiPerspectiveWorkflow running with quote-laden topic/perspectives executes without a parse error", async () => {
  const trickyTopic = 'it\'s a "test" with `backticks`';
  const body = generateMultiPerspectiveWorkflow(trickyTopic, ["user's view", "another's angle"]);
  const seenPrompts: string[] = [];
  const result = await runWorkflow(body, {
    agent: {
      async run(prompt: string) {
        seenPrompts.push(prompt);
        return "ok";
      },
    },
    persistLogs: false,
  });
  assert.equal(result.agentCount, 3, "2 perspective agents + the synthesizer all run without throwing");
  assert.ok(
    seenPrompts.some((p) => p.includes(trickyTopic)),
    "the full topic should reach a perspective agent's prompt",
  );
});

// ─── Web Tools ──────────────────────────────────────────────────────────────────

test("createWebTools exposes web_search and web_fetch", () => {
  const tools = createWebTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
});

// ─── Code Review ────────────────────────────────────────────────────────────────

test("generateCodeReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateCodeReviewWorkflow());
  assert.equal(meta.name, "code_review");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Find", "Verify", "Report"],
  );
  assert.match(body, /parallel/);
  assert.match(body, /candidateSchema/);
});

test("generateCodeReviewWorkflow truncates an oversized diff and surfaces it", () => {
  const { body } = parseWorkflowScript(generateCodeReviewWorkflow());
  assert.match(body, /MAX_DIFF_CHARS/);
  assert.match(body, /diffTruncated/);
});

// ─── Code Review: diffSource host-side resolution (GAP-3) ───────────────────────
// The /code-review slash command has always fetched diffSource itself
// (builtin-commands.ts); this section pins the same resolution on the workflow
// tool's `name` path — prepareBuiltinWorkflowArgs() → fetchDiffFromSource(),
// wired in workflow-tool.ts before the registry resolves the script.

/** Temp git repo with one committed change to `file.txt` (mirrors the m12 fixture). */
function initRepoWithChange(): string {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-gap3-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "gap3@test.local");
  git("config", "user.name", "gap3");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "file.txt"), "base\n+changed\n");
  return repo;
}

/** Temp git repo with a commit and a clean working tree, so `git diff HEAD` is empty. */
function initCleanRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pi-dw-gap3-clean-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "gap3@test.local");
  git("config", "user.name", "gap3");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

/** Fake manager recording startInBackground invocations, typed to the tool's needs. */
function makeRecordingManager() {
  const started: Array<{ script: string; args: Record<string, unknown> }> = [];
  const manager = {
    startInBackground(script: string, args?: unknown) {
      started.push({ script, args: (args ?? {}) as Record<string, unknown> });
      return { runId: `run-gap3-${started.length}`, promise: new Promise(() => {}) };
    },
  } as unknown as WorkflowManager;
  return { manager, started };
}

test("code-review prepareArgs resolves diffSource:'git diff HEAD' into a non-empty diff (fixture repo with a committed change)", async () => {
  const repo = initRepoWithChange();
  try {
    const notified: string[] = [];
    const prepared = (await prepareBuiltinWorkflowArgs("code-review", { diffSource: "git diff HEAD" }, repo, (m) =>
      notified.push(m),
    )) as Record<string, unknown>;
    assert.ok(
      notified.some((m) => m.includes("Fetching diff from git diff HEAD")),
      "the pre-exec notify must fire before the fetch",
    );
    assert.equal(typeof prepared.diff, "string");
    assert.match(prepared.diff as string, /diff --git a\/file\.txt b\/file\.txt/);
    assert.match(prepared.diff as string, /\+changed/);
    assert.equal(prepared.diffSource, "git diff HEAD");
    // The prepared args must satisfy the builtin's own resolve() validation and
    // produce the real code_review script — the model-visible end result.
    const builtin = findBuiltinWorkflow("code-review");
    assert.ok(builtin);
    const invocation = builtin.resolve(repo, prepared);
    assert.equal(parseWorkflowScript(invocation.script).meta.name, "code_review");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code-review prepareArgs on a clean repo yields a descriptive empty-diff error", async () => {
  const repo = initCleanRepo();
  try {
    await assert.rejects(
      () => prepareBuiltinWorkflowArgs("code-review", { diffSource: "git diff HEAD" }, repo),
      /no diff output from: git diff HEAD/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code-review prepareArgs bypasses the resolver entirely when args.diff is supplied", async () => {
  const repo = initCleanRepo(); // even a clean repo must not matter: no fetch runs
  try {
    const args = { diff: "a pasted diff\n", diffSource: "gh pr diff 999999" };
    const prepared = await prepareBuiltinWorkflowArgs("code-review", args, repo);
    assert.equal(prepared, args, "the exact same object must come back untouched (no fetch, no copy)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code-review prepareArgs rejects non-git/gh diffSource commands (no shell breakout)", async () => {
  const repo = initCleanRepo();
  try {
    await assert.rejects(
      () => prepareBuiltinWorkflowArgs("code-review", { diffSource: "rm -rf /" }, repo),
      /diffSource must start with "git" or "gh"/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code-review prepareArgs rejects a non-string diffSource with a descriptive error", async () => {
  const repo = initCleanRepo();
  try {
    await assert.rejects(
      () => prepareBuiltinWorkflowArgs("code-review", { diffSource: 42 } as never, repo),
      /args\.diffSource to be a string/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("code-review prepareArgs leaves a whitespace-only diffSource untouched (resolve() still requires diff)", async () => {
  const repo = initCleanRepo();
  try {
    const args = { diffSource: "   " };
    const prepared = await prepareBuiltinWorkflowArgs("code-review", args, repo);
    assert.equal(prepared, args);
    const builtin = findBuiltinWorkflow("code-review");
    assert.ok(builtin);
    assert.throws(() => builtin.resolve(repo, args), /requires args\.diff/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepareBuiltinWorkflowArgs is a no-op for builtins without a prepareArgs hook", async () => {
  const repo = initCleanRepo();
  const args = { question: "q" };
  const prepared = await prepareBuiltinWorkflowArgs("deep-research", args, repo);
  assert.equal(prepared, args);
});

// ─── Workflow tool `name` wiring: diffSource reaches the run (GAP-3) ────────────

test("workflow tool name:'code-review' with diffSource fetches the diff before the run starts", async () => {
  const repo = initRepoWithChange();
  try {
    const { manager, started } = makeRecordingManager();
    const tool = createWorkflowTool({ cwd: repo, manager });
    const updates: string[] = [];
    const res = await tool.execute(
      "gap3-name-diffsource",
      { name: "code-review", args: { diffSource: "git diff HEAD" } },
      undefined,
      ((u: { content?: Array<{ type: string; text?: string }> }) => {
        updates.push(u.content?.[0]?.text ?? "");
      }) as never,
      {} as never,
    );
    const details = res.details as { runId?: string; background?: boolean };
    assert.ok(details.runId, "the run should start");
    assert.ok(
      updates.some((t) => t.includes("Fetching diff from git diff HEAD")),
      `the pre-exec notify should stream on the tool path; got: ${JSON.stringify(updates)}`,
    );
    assert.equal(started.length, 1);
    assert.match(started[0].args.diff as string, /diff --git a\/file\.txt b\/file\.txt/);
    assert.match(started[0].args.diff as string, /\+changed/);
    assert.equal(started[0].args.diffSource, "git diff HEAD");
    // The tool path passes the raw diff; the generated script computes its own
    // truncation (code-review.ts), so no host-side truncation flags are set.
    assert.equal(started[0].args.diffTruncated, undefined);
    assert.equal(parseWorkflowScript(started[0].script).meta.name, "code_review");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("workflow tool name:'code-review' on a clean repo fails with the empty-diff error and starts no run", async () => {
  const repo = initCleanRepo();
  try {
    const { manager, started } = makeRecordingManager();
    const tool = createWorkflowTool({ cwd: repo, manager });
    await assert.rejects(
      () =>
        tool.execute(
          "gap3-clean",
          { name: "code-review", args: { diffSource: "git diff HEAD" } },
          undefined,
          undefined,
          {} as never,
        ),
      /no diff output from: git diff HEAD/,
    );
    assert.equal(started.length, 0, "no run should start when the diff fetch fails");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("workflow tool: a saved 'code-review' workflow shadows the builtin and skips diffSource resolution", async () => {
  const repo = initCleanRepo();
  try {
    const storage = createWorkflowStorage(repo);
    const customScript = "export const meta = { name: 'custom_code_review', description: 'override' }\nreturn 1";
    storage.save({ name: "code-review", description: "custom override", script: customScript, location: "project" });
    const { manager, started } = makeRecordingManager();
    const tool = createWorkflowTool({ cwd: repo, manager, storage });
    const updates: string[] = [];
    // A diffSource that would fail hard if the hook ran (gh is never invoked,
    // and the shadow must not fetch) — proves the shadow path skips resolution.
    const res = await tool.execute(
      "gap3-shadow",
      { name: "code-review", args: { diffSource: "gh pr diff 999999" } },
      undefined,
      ((u: { content?: Array<{ type: string; text?: string }> }) => {
        updates.push(u.content?.[0]?.text ?? "");
      }) as never,
      {} as never,
    );
    const details = res.details as { runId?: string };
    assert.ok(details.runId, "the saved workflow run should start");
    assert.equal(started.length, 1);
    assert.equal(started[0].script, customScript);
    assert.deepEqual(started[0].args, { diffSource: "gh pr diff 999999" }, "raw args forwarded, never prepared");
    assert.ok(!updates.some((t) => t.includes("Fetching diff")), "the shadow must not trigger a diff fetch");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
