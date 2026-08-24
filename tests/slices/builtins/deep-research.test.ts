/**
 * Slice D tests — deep-research builtin fixes (H5 + M19).
 *
 * H5: the "authoritative source" escape that bypassed minSupport is removed;
 * minSupport is enforced deterministically in-script (not only in the prompt);
 * fabricated/conflicting claims are discarded, never reported as fact.
 * M19: discarded claims and cross-check mismatches land in a Conflicts section
 * that reaches the report agent and the run result — nothing vanishes silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateDeepResearchWorkflow } from "../../../src/deep-research.js";
import { runWorkflow } from "../../../src/workflow.js";

// ─── Generated script surface (H5 escape removal) ──────────────────────────────

test("deep-research script no longer contains the authoritative-source escape (H5)", () => {
  const body = generateDeepResearchWorkflow();
  assert.ok(
    !body.includes("OR by one clearly authoritative source"),
    "the old escape ('OR by one clearly authoritative source') must be gone",
  );
  assert.ok(
    body.includes("authoritative-source exception"),
    "the prompt should now state there is NO authoritative-source exception",
  );
});

test("deep-research script enforces minSupport deterministically and routes to Conflicts (H5/M19)", () => {
  const body = generateDeepResearchWorkflow();
  // Deterministic enforcement: a supported claim needs >= minSupport DISTINCT sources.
  assert.match(body, /distinct\.size >= minSupport/);
  assert.match(body, /new Set\(sources\)/);
  // Conflicts section = verdict conflicts + under-supported + discarded.
  assert.match(body, /const conflicts = \[/);
  assert.match(body, /underSupported\.map/);
  assert.match(body, /discarded\.map/);
  // The report agent receives the Conflicts JSON, and the result returns it
  // (plus the N02 verification artifact).
  assert.match(body, /CONFLICTS JSON/);
  assert.match(body, /return \{ question, queries, supported, conflicts, report, verification \}/);
  // T-04: the report embeds are capped at a deterministic 4,000 chars each.
  assert.match(body, /reportEmbed = \(value\) =>/);
  assert.match(body, /text\.slice\(0, 4000\) \+ '…'/);
  assert.match(body, /reportEmbed\(supported\)/);
  assert.match(body, /reportEmbed\(conflicts\)/);
  assert.match(body, /reportEmbed\(verification\)/);
  assert.doesNotMatch(body, /SUPPORTED CLAIMS JSON:\\n' \+ JSON\.stringify\(supported\)/);
});

test("deep-research script caps the embedded source list before JSON.stringify (T1-03)", () => {
  const body = generateDeepResearchWorkflow();
  // The Verify phase computes a deterministic capped projection, then embeds it.
  assert.match(body, /const embeddedSources = \[\]/);
  // DS-5: per-claim truncation cuts at a sentence boundary (never mid-clause).
  assert.match(body, /const truncateClaim = \(text, cap\) =>/);
  assert.match(body, /truncateClaim\(c, 400\)/);
  assert.match(body, /truncateClaim\(c, 200\)/);
  assert.doesNotMatch(body, /c\.slice\(0, 397\)/);
  assert.match(body, /JSON\.stringify\(embeddedSources\)/);
  assert.match(body, /embedBudget -= size/);
  assert.match(body, /token cap\); tail sources are omitted/);
  // Small inputs are untouched: the claim cap only fires above 400 chars.
  assert.doesNotMatch(body, /JSON\.stringify\(allSources\)/);
});

// ─── Runtime: fabricated claims discarded; minSupport enforced; Conflicts built ─

test("deep-research: fabricated/conflicting claims are discarded and under-supported claims move to Conflicts", async () => {
  const prompts: string[] = [];
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        if (prompt.includes("planning web research")) return { queries: ["webgpu basics"] };
        if (prompt.includes("Research this query")) {
          // Two sources with contradictory claims; one claim is fabricated.
          return {
            sources: [
              { url: "https://a.example", claims: ["The sky is green on Wednesdays", "Unicorns run the stock market"] },
              { url: "https://b.example", claims: ["The sky is blue"] },
            ],
          };
        }
        if (prompt.includes("fact-checking cross-checker")) {
          // The LLM (fake) keeps the fabricated single-source claim as if an
          // authoritative source vouched for it, discards the unicorn claim,
          // and reports the green-vs-blue contradiction explicitly.
          return {
            supported: [
              {
                claim: "The sky is green on Wednesdays (per the authoritative sky institute)",
                sources: ["https://a.example"],
              },
              { claim: "The sky appears blue", sources: ["https://b.example", "https://c.example"] },
            ],
            discarded: ["Unicorns run the stock market"],
            conflicts: [
              { claim: "The sky is green on Wednesdays", contradicting: "https://b.example states the sky is blue" },
            ],
          };
        }
        if (prompt.includes("well-structured research report")) return "report text";
        return null;
      },
    } as never,
    persistLogs: false,
    args: { question: "What color is the sky?", angles: 3, minSupport: 2 },
  });

  const r = result.result as {
    supported?: Array<{ claim: string; sources: string[] }>;
    conflicts?: Array<{ claim: string; reason?: string }>;
  };
  // Only the claim with >= 2 DISTINCT sources survives — the fabricated
  // single-source claim (even with the "authoritative" sticker) must not.
  assert.equal(r.supported?.length, 1, "exactly one claim should survive minSupport");
  assert.equal(r.supported?.[0]?.claim, "The sky appears blue");
  // Spread out of the vm realm before deepEqual (its Array prototype differs).
  assert.deepEqual([...(r.supported?.[0]?.sources ?? [])], ["https://b.example", "https://c.example"]);

  // Conflicts = explicit contradiction + under-supported claim + discarded claim.
  const conflictClaims = (r.conflicts ?? []).map((c) => c.claim);
  assert.ok(conflictClaims.includes("The sky is green on Wednesdays"), "contradicting claim must reach Conflicts");
  assert.ok(
    conflictClaims.includes("The sky is green on Wednesdays (per the authoritative sky institute)"),
    "under-supported claim must reach Conflicts (never silently vanish)",
  );
  assert.ok(conflictClaims.includes("Unicorns run the stock market"), "discarded claim must reach Conflicts");

  // The report agent sees the Conflicts section, so the written report can
  // disclose the discarded/contradicted material instead of losing it.
  assert.ok(
    prompts.some((p) => p.includes("well-structured research report") && p.includes("CONFLICTS JSON")),
    "the report agent prompt should carry the Conflicts JSON",
  );
  // The degradation is logged, not silent.
  assert.ok(
    result.logs.some((l) => l.includes("moved to Conflicts")),
    "moving under-supported claims to Conflicts should be logged",
  );
});

test("deep-research: a null cross-check verdict degrades to empty supported/conflicts without crashing", async () => {
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning web research")) return { queries: ["q"] };
        if (prompt.includes("Research this query")) {
          return { sources: [{ url: "https://a.example", claims: ["some claim"] }] };
        }
        return null; // cross-check + report both fail
      },
    } as never,
    persistLogs: false,
    args: { question: "Q?", angles: 2, minSupport: 2 },
  });
  const r = result.result as { supported?: unknown[]; conflicts?: unknown[] };
  assert.equal(r.supported?.length, 0, "no sources → no supported claims");
  assert.equal(r.conflicts?.length, 0, "no cross-check output → no conflicts");
});

test("deep-research: the cross-check source payload is capped for large lists and byte-identical for small ones (T1-03)", async () => {
  const smallSourceList = [
    { url: "https://a.example", claims: ["short claim one", "short claim two"] },
    { url: "https://b.example", claims: ["another short claim"] },
  ];
  const claimPad = "x".repeat(120);
  const bigSourceList = Array.from({ length: 60 }, (_, i) => ({
    url: `https://s${i}.example`,
    claims: Array.from({ length: 5 }, (_c, j) => `claim ${i}.${j} ${claimPad}`),
  }));

  async function runOnce(sources: Array<{ url: string; claims: string[] }>) {
    let crossCheckPrompt = "";
    const result = await runWorkflow(generateDeepResearchWorkflow(), {
      agent: {
        async run(prompt: string) {
          if (prompt.includes("planning web research")) return { queries: ["q"] };
          if (prompt.includes("Research this query")) return { sources };
          if (prompt.includes("fact-checking cross-checker")) {
            crossCheckPrompt = prompt;
            return { supported: [] };
          }
          return "report";
        },
      } as never,
      persistLogs: false,
      args: { question: "Q?", angles: 2, minSupport: 2 },
    });
    return { payload: crossCheckPrompt.split("SOURCES JSON:")[1] ?? "", logs: result.logs };
  }

  // Small input: the embedded SOURCES JSON is byte-identical to the raw list.
  const small = await runOnce(smallSourceList);
  assert.equal(
    small.payload.trim(),
    JSON.stringify(smallSourceList),
    "a small source list must embed unchanged (no cap, no marker — snapshot stability)",
  );

  // Large input: capped and logged, never silently truncated.
  const big = await runOnce(bigSourceList);
  const parsed = JSON.parse(big.payload.trim()) as Array<{ url: string; claims: string[] }>;
  assert.ok(parsed.length < 60, "the embedded source count must be capped below the 60-source input");
  assert.ok(parsed.length >= 1, "at least one source survives the cap");
  assert.ok(
    JSON.stringify(bigSourceList).length > big.payload.trim().length,
    "the embedded payload must be smaller than the raw list",
  );
  assert.ok(
    big.logs.some((l) => l.includes("for cross-check (token cap)") && l.includes("60")),
    "capping the embedded source list must be logged, never silent",
  );
});

// ─── DS-5: sentence-boundary claim truncation ────────────────────────────────

test("deep-research: a >400-char claim is cut at a sentence boundary, never mid-clause (DS-5)", async () => {
  const longClaim =
    "Sentence one explains the first fact clearly and completely with full detail. " +
    "Second sentence continues with more specifics that push this claim well past the four hundred character cap. " +
    "x".repeat(300);
  const sources = [{ url: "https://a.example", claims: [longClaim] }];
  let crossCheckPrompt = "";
  await runWorkflow(generateDeepResearchWorkflow(), {
    agent: {
      async run(prompt: string) {
        if (prompt.includes("planning web research")) return { queries: ["q"] };
        if (prompt.includes("Research this query")) return { sources };
        if (prompt.includes("fact-checking cross-checker")) {
          crossCheckPrompt = prompt;
          return { supported: [] };
        }
        return "report";
      },
    } as never,
    persistLogs: false,
    args: { question: "Q?", angles: 2, minSupport: 2 },
  });
  const payload = (crossCheckPrompt.split("SOURCES JSON:")[1] ?? "").trim();
  const parsed = JSON.parse(payload) as Array<{ url: string; claims: string[] }>;
  const claim = parsed[0]?.claims[0] ?? "";
  assert.ok(claim.length <= 400, "the embedded claim respects the 400-char cap");
  assert.ok(claim.endsWith("…"), "the truncation marker is kept");
  const truncated = claim.slice(0, -1); // drop '…'
  assert.ok(
    /[.!?]/.test(truncated),
    `the cut lands at a sentence boundary, not mid-clause (got: ...${truncated.slice(-40)})`,
  );
  assert.ok(claim.includes("Sentence one"), "the first sentence survives intact");
  assert.ok(claim.length < longClaim.length, "a long claim must actually be truncated (cap fires)");
});

// ─── T2-05: per-phase tier defaults baked into the generated script ─────────

test("deep-research script bakes the per-phase tier defaults (T2-05)", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /label: 'plan queries', tier: "small"/);
  assert.match(body, /label: 'research '\s*\+ \(i \+ 1\), tier: "medium"/);
  assert.match(body, /label: 'cross-check', tier: "big"/);
  assert.match(body, /label: 'write report', tier: "big"/);
});

test("deep-research per-phase tiers are generator options (T2-05)", () => {
  const body = generateDeepResearchWorkflow({ tierPlan: "medium", tierReport: "small" });
  assert.match(body, /label: 'plan queries', tier: "medium"/);
  assert.match(body, /label: 'write report', tier: "small"/);
  // Untouched phases keep their defaults.
  assert.match(body, /label: 'cross-check', tier: "big"/);
});
