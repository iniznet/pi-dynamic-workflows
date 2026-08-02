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
  // The report agent receives the Conflicts JSON, and the result returns it.
  assert.match(body, /CONFLICTS JSON/);
  assert.match(body, /return \{ question, queries, supported, conflicts, report \}/);
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
