/**
 * Slice D tests — code-review builtin fixes (H7 + M20).
 *
 * H7: the diff is sharded per angle — each finder and each verifier sees only
 * its angle's slice; the union of all slices covers the full diff (nothing is
 * silently dropped from review).
 * M20: findings carry a severity field and there is a dedicated security
 * finder angle (H) that outranks correctness in the final report.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_REVIEW_ANGLES,
  diffShard,
  generateCodeReviewWorkflow,
  splitDiffSegments,
} from "../../../src/code-review.js";
import { runWorkflow } from "../../../src/workflow.js";

// ─── diffShard util: union == full diff, disjoint per angle ────────────────────

const MULTI_HUNK_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added-a1
 line2
@@ -10,3 +11,3 @@
 line10
-removed-a1
 line11
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,3 +6,3 @@
 x
+y
 z
`;

/** Extract hunk-body lines (context/added/removed) from a unified diff. */
function hunkBodyLines(text: string): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (/^@@\s/.test(line)) {
      inHunk = true;
      continue;
    }
    if (/^diff\s/.test(line)) {
      inHunk = false;
      continue;
    }
    if (inHunk && /^[ +-]/.test(line)) out.push(line);
  }
  return out;
}

test("splitDiffSegments yields one self-contained segment per hunk (H7)", () => {
  const segments = splitDiffSegments(MULTI_HUNK_DIFF);
  // a.ts has 2 hunks, b.ts has 1 → 3 segments.
  assert.equal(segments.length, 3);
  for (const segment of segments) {
    assert.match(segment, /^diff --git/, "each segment should carry its file header");
    assert.match(segment, /^@@\s/m, "each segment should carry exactly one hunk");
    assert.equal(segment.match(/^@@\s/gm)?.length, 1, "exactly one hunk per segment");
  }
});

test("diffShard slices cover every hunk and the union of hunk bodies is the full diff (H7)", () => {
  const shards = CODE_REVIEW_ANGLES.map((angle) => diffShard(MULTI_HUNK_DIFF, angle));

  // Every hunk of the original appears in at least one shard.
  const hunks = MULTI_HUNK_DIFF.split("\n").filter((l) => l.startsWith("@@"));
  assert.ok(hunks.length >= 1);
  for (const hunk of hunks) {
    assert.ok(
      shards.some((s) => s.includes(hunk)),
      `hunk ${hunk} must appear in some shard`,
    );
  }

  // The multiset of hunk-body lines across shards equals the original's —
  // the slices partition the diff content without dropping or duplicating it.
  assert.deepEqual(
    shards.flatMap(hunkBodyLines).sort(),
    hunkBodyLines(MULTI_HUNK_DIFF).sort(),
    "union of shard bodies must equal the full diff bodies",
  );

  // No single shard carries the whole diff.
  for (const shard of shards) {
    assert.ok(shard.length < MULTI_HUNK_DIFF.length, "no shard should carry the entire diff");
  }

  // Every file path is present in at least one shard (all files covered).
  for (const file of ["src/a.ts", "src/b.ts"]) {
    assert.ok(
      shards.some((s) => s.includes(file)),
      `${file} must be covered by some shard`,
    );
  }
});

test("diffShard treats an unknown angle defensively (full diff) and handles an empty diff", () => {
  assert.equal(diffShard(MULTI_HUNK_DIFF, "Z" as never), MULTI_HUNK_DIFF);
  assert.equal(diffShard("", "A"), "");
  // A header-less preamble forms one segment, dealt to the first angle so the
  // content is still covered; the other angles get nothing for it.
  assert.equal(diffShard("no hunks here", "A"), "no hunks here");
  assert.equal(diffShard("no hunks here", "B"), "");
});

test("code-review script bakes the sharding util and per-angle shard blocks (H7)", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /const splitDiffSegments = /);
  assert.match(body, /const shardFor = \(angle\) =>/);
  for (const angle of CODE_REVIEW_ANGLES) {
    assert.match(body, new RegExp(`shardBlock\\('${angle}'\\)`), `finder ${angle} should use its own shard`);
  }
  assert.match(body, /shardBlock\(batch\.angle\)/, "verifiers should get only their angle's shard");
});

// ─── M20: severity + security angle ────────────────────────────────────────────

const SEVERITY_DIFF = `diff --git a/src/f1.ts b/src/f1.ts
index 1..2 100644
--- a/src/f1.ts
+++ b/src/f1.ts
@@ -1,3 +1,4 @@
 a
+one
 b
@@ -8,3 +9,3 @@
 c
-two
 d
diff --git a/src/f2.ts b/src/f2.ts
index 3..4 100644
--- a/src/f2.ts
+++ b/src/f2.ts
@@ -1,3 +1,4 @@
 e
+three
 f
@@ -9,3 +10,3 @@
 g
-four
 h
diff --git a/src/f3.ts b/src/f3.ts
index 5..6 100644
--- a/src/f3.ts
+++ b/src/f3.ts
@@ -1,3 +1,4 @@
 i
+five
 j
@@ -9,3 +10,3 @@
 k
-six
 l
diff --git a/src/f4.ts b/src/f4.ts
index 7..8 100644
--- a/src/f4.ts
+++ b/src/f4.ts
@@ -1,3 +1,4 @@
 m
+seven
 n
@@ -9,3 +10,3 @@
 o
-eight
 p
`;

test("code-review candidate schema requires severity and the security finder exists (M20)", () => {
  const body = generateCodeReviewWorkflow();
  assert.match(body, /severity: \{ type: 'string', enum: \['critical', 'high', 'medium', 'low'\] \}/);
  assert.match(body, /required: \['file', 'line', 'severity', 'summary', 'failure_scenario'\]/);
  assert.match(body, /You are a security auditor/);
  assert.match(body, /H-security/);
});

test("code-review end-to-end: sharded finders, per-angle verifiers, severity-ranked findings (H7/M20)", async () => {
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string) {
      prompts.push(prompt);
      if (prompt.includes("You are a verifier")) {
        return { verdicts: [{ verdict: "CONFIRMED", reason: "traced in the slice" }] };
      }
      if (prompt.includes("final report")) return "synthesis text";
      // Finders: one candidate per angle, tagged with the file their shard owns.
      if (prompt.includes('shard="A"')) {
        return {
          candidates: [
            { file: "src/f1.ts", line: 2, severity: "low", summary: "off-by-one", failure_scenario: "mis-index" },
          ],
        };
      }
      if (prompt.includes('shard="B"')) {
        return {
          candidates: [
            {
              file: "src/f1.ts",
              line: 9,
              severity: "medium",
              summary: "removed guard",
              failure_scenario: "invariant lost",
            },
          ],
        };
      }
      if (prompt.includes('shard="C"')) {
        return {
          candidates: [
            { file: "src/f2.ts", line: 3, severity: "high", summary: "caller broken", failure_scenario: "type error" },
          ],
        };
      }
      if (prompt.includes('shard="H"')) {
        return {
          candidates: [
            {
              file: "src/f4.ts",
              line: 30,
              severity: "critical",
              summary: "sql injection",
              failure_scenario: "database compromised",
            },
          ],
        };
      }
      return { candidates: [] };
    },
  };

  const result = await runWorkflow(generateCodeReviewWorkflow(), {
    agent: runner as never,
    persistLogs: false,
    args: { diff: SEVERITY_DIFF },
  });
  const r = result.result as {
    total: number;
    verified: number;
    surviving: number;
    diffTruncated: boolean;
    findings: Array<{ file: string; severity: string; angle: string; verdict: string }>;
  };

  assert.equal(r.total, 4, "4 candidates across finders A/B/C/H");
  assert.equal(r.verified, 4, "all candidates verified");
  assert.equal(r.surviving, 4, "all CONFIRMED survive");
  assert.equal(r.diffTruncated, false);

  // M20: security (H) outranks correctness; severity orders within an angle.
  // Spread out of the vm realm before deepEqual (its Array prototype differs).
  assert.deepEqual(
    [...r.findings.map((f) => f.angle)],
    ["H", "C", "B", "A"],
    "report order: security, correctness (by severity), cleanup",
  );
  assert.equal(r.findings[0].file, "src/f4.ts");
  assert.equal(r.findings[0].severity, "critical");
  assert.equal(r.findings[0].angle, "H");

  // H7: every finder prompt carries ONLY its angle's shard — no full diff.
  const finderA = prompts.find((p) => p.includes("line-by-line correctness scanner"));
  const finderH = prompts.find((p) => p.includes("security auditor"));
  assert.ok(finderA && finderH, "both correctness and security finders should run");
  assert.ok(finderA.includes("src/f1.ts"), "finder A sees its assigned file");
  assert.ok(!finderA.includes("src/f4.ts"), "finder A must NOT see another angle's file");
  assert.ok(finderH.includes("src/f4.ts"), "finder H sees its assigned file");
  assert.ok(!finderH.includes("src/f1.ts"), "finder H must NOT see another angle's file");

  // H7: verifiers get only their angle's slice.
  const verifierA = prompts.find((p) => p.includes("You are a verifier") && p.includes('shard="A"'));
  const verifierH = prompts.find((p) => p.includes("You are a verifier") && p.includes('shard="H"'));
  assert.ok(verifierA && verifierH, "per-angle verifier batches should exist");
  assert.ok(verifierA.includes("src/f1.ts"), "verifier A sees the angle-A slice");
  assert.ok(!verifierA.includes("src/f4.ts"), "verifier A must NOT see the angle-H slice");
  assert.ok(verifierH.includes("src/f4.ts"), "verifier H sees the angle-H slice");

  // Coverage: every file in the diff was seen by at least one finder prompt.
  for (const file of ["src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"]) {
    assert.ok(
      prompts.some((p) => p.includes(file)),
      `${file} must be covered by some finder's shard`,
    );
  }
});
