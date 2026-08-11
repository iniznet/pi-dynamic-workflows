/**
 * Slice D2 — N02 claim-evidence verifier tests.
 *
 * Covers (N02):
 *  - the deterministic core (normalize / substring-match / evidence hash / cap)
 *    as pure functions AND as the vm-embedded copies inside the generated
 *    deep-research script (drift guard — the logic under test IS the logic
 *    that runs);
 *  - end-to-end: a verified claim (fixture URL re-fetched via a stubbed
 *    verification agent) is marked verified with matched sources + a stable
 *    evidence hash; unverified claims are FLAGGED (kept in the artifact +
 *    logged), never silently dropped; only CITED pages can corroborate;
 *  - minSupport enforcement stays deterministic (an under-supported claim
 *    moves to Conflicts and spawns NO verification agent);
 *  - resume replays the verification steps from the journal.
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  capEvidenceText,
  claimEvidenceMatches,
  claimVerifyCoreSource,
  computeEvidenceHash,
  normalizeForEvidenceMatch,
} from "../../../src/claim-verify.js";
import { generateDeepResearchWorkflow } from "../../../src/deep-research.js";
import { type JournalEntry, runWorkflow } from "../../../src/workflow.js";

// ─── Deterministic core: pure functions ───────────────────────────────────────

test("normalizeForEvidenceMatch: NFC + lowercase + whitespace collapse (deterministic)", () => {
  assert.equal(normalizeForEvidenceMatch("  The   Sky IS BLUE  "), "the sky is blue");
  assert.equal(normalizeForEvidenceMatch("café\n\nCAFÉ"), "café café");
  assert.equal(normalizeForEvidenceMatch(""), "");
});

test("claimEvidenceMatches: exact normalized substring match", () => {
  assert.ok(claimEvidenceMatches("The sky is blue", "In daylight the sky is blue everywhere."));
  // Case + whitespace-insensitive.
  assert.ok(claimEvidenceMatches("The   Sky   IS   Blue", "today the sky is blue"));
  // Page that does not state the claim.
  assert.equal(claimEvidenceMatches("The sky is green", "The sky is blue today."), false);
  // Empty / degenerate inputs never match.
  assert.equal(claimEvidenceMatches("", "anything"), false);
  assert.equal(claimEvidenceMatches("a claim", ""), false);
});

test("claimEvidenceMatches: paraphrase fallback for normalized claims (word-form tolerant, in-order coverage)", () => {
  // The cross-checker normalizes wording; the page states the SAME fact with
  // different morphology / inserted words — the significant-word fallback must
  // match (in-order, prefix-tolerant, >= 60% coverage).
  assert.ok(
    claimEvidenceMatches(
      "The Acme widget supports refresh rates up to 120 frames per second",
      "The latest Acme widgets support refresh rates reaching up to 120 frames per second on modern displays.",
    ),
  );
  // A page about a DIFFERENT widget: shared words (widget/120/frames/second)
  // are only 50% coverage — below the threshold, so it must NOT match.
  assert.equal(
    claimEvidenceMatches(
      "The Acme widget supports refresh rates up to 120 frames per second",
      "Our widget hits 120 frames per second on modern displays.",
    ),
    false,
  );
  // Short claims never fall back to fuzzy matching (exact path only).
  assert.equal(claimEvidenceMatches("It is blue", "it is blue"), true, "exact path still wins");
  assert.equal(claimEvidenceMatches("Just blue", "the sky is blue"), false, "no fallback below 5 significant words");
});

test("computeEvidenceHash: deterministic, 8-hex, sensitive to evidence", () => {
  const a = computeEvidenceHash("claim x", ["https://a.example", "https://b.example"], true, ["https://a.example"]);
  assert.match(a, /^[0-9a-f]{8}$/);
  // Same inputs → same hash (determinism; source order normalized by sort).
  assert.equal(
    a,
    computeEvidenceHash("claim x", ["https://b.example", "https://a.example"], true, ["https://a.example"]),
  );
  // Different evidence → different hash.
  assert.notEqual(
    a,
    computeEvidenceHash("claim y", ["https://a.example", "https://b.example"], true, ["https://a.example"]),
  );
  assert.notEqual(a, computeEvidenceHash("claim x", ["https://a.example"], true, ["https://a.example"]));
  assert.notEqual(a, computeEvidenceHash("claim x", ["https://a.example", "https://b.example"], false, []));
  assert.notEqual(a, computeEvidenceHash("claim x", ["https://a.example", "https://b.example"], true, []));
});

test("capEvidenceText: capEmbedded semantics (slice, marker, visible log)", () => {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const short = "x".repeat(100);
  assert.equal(capEvidenceText(short, 200, log), short);
  assert.equal(logs.length, 0, "no truncation → no log");
  const long = "y".repeat(500);
  const capped = capEvidenceText(long, 200, log);
  assert.equal(capped.length, 201, "200 chars + ellipsis marker");
  assert.ok(capped.endsWith("…"), "ellipsis marker present");
  assert.equal(logs.length, 1, "truncation is logged, never silent");
  assert.match(logs[0], /capped at 200 chars/);
  // Non-string values are serialized deterministically.
  assert.equal(capEvidenceText({ a: 1 }, 5, log), `${JSON.stringify({ a: 1 }).slice(0, 5)}…`);
});

// ─── Drift guard: the vm-embedded copies behave like the exported functions ──

test("claimVerifySource: embedded deterministic core matches the exported pure functions (vm)", () => {
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(claimVerifyCoreSource(), context);
  const embedded = {
    normalizeForEvidenceMatch: context.normalizeForEvidenceMatch as typeof normalizeForEvidenceMatch,
    claimEvidenceMatches: context.claimEvidenceMatches as typeof claimEvidenceMatches,
    computeEvidenceHash: context.computeEvidenceHash as typeof computeEvidenceHash,
    capEvidenceText: context.capEvidenceText as typeof capEvidenceText,
  };
  const pairs: Array<[string, string]> = [
    ["The sky is blue", "IN DAYLIGHT, THE   SKY is blue."],
    ["The widget supports 120 FPS", "Our widget hits 120 frames per second on modern displays."],
    ["The widget supports 120 FPS", "The widget is available in three colors."],
    ["", "anything"],
    ["Just blue", "the sky is blue"],
  ];
  for (const [claim, page] of pairs) {
    assert.equal(
      embedded.claimEvidenceMatches(claim, page),
      claimEvidenceMatches(claim, page),
      `match divergence for (${claim}, ${page})`,
    );
  }
  const hashInputs: Array<[string, string[], boolean, string[]]> = [
    ["claim x", ["https://a.example", "https://b.example"], true, ["https://a.example"]],
    ["claim x", ["https://b.example"], false, []],
    ["claim y", [], false, []],
  ];
  for (const [claim, sources, verified, matched] of hashInputs) {
    assert.equal(
      embedded.computeEvidenceHash(claim, sources, verified, matched),
      computeEvidenceHash(claim, sources, verified, matched),
    );
    assert.equal(embedded.normalizeForEvidenceMatch(claim), normalizeForEvidenceMatch(claim));
  }
  const cappedZ = embedded.capEvidenceText("z".repeat(300), 100);
  assert.equal(cappedZ.length, 101);
  assert.ok(cappedZ.endsWith("…"));
  assert.equal(embedded.capEvidenceText("short", 1000), "short");
});

// ─── Generated script surface ─────────────────────────────────────────────────

test("deep-research script embeds the claim-verify block and keeps minSupport deterministic", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /You are a claim-evidence verifier/);
  assert.match(body, /web_fetch and return the fetched page text VERBATIM/);
  assert.match(body, /const verification = \[\]/);
  assert.match(body, /const verifiedKeys = new Set\(\)/);
  assert.match(body, /VERIFICATION JSON/);
  assert.match(body, /verified: false could not be confirmed against their cited pages/);
  assert.match(body, /flagged unverified, never dropped/);
  // The deterministic minSupport enforcement MUST stay intact (N02 contract).
  assert.match(body, /distinct\.size >= minSupport/);
  assert.match(body, /return \{ question, queries, supported, conflicts, report, verification \}/);
});

// ─── Runtime: verified claims (fixture URL via stubbed verifier) ─────────────

interface VerificationEntry {
  claim: string;
  sources: string[];
  verified: boolean;
  matchedSources: string[];
  evidenceHash: string;
}

/** Stub deep-research agent run with a configurable verifier response. */
function researchStub(verifierPages: unknown[], onVerifier?: () => void) {
  return {
    async run(prompt: string) {
      if (prompt.includes("planning web research")) return { queries: ["webgpu basics"] };
      if (prompt.includes("Research this query")) {
        return {
          sources: [
            { url: "https://a.example/article", claims: ["The widget supports 120 FPS"] },
            { url: "https://b.example/faq", claims: ["The widget supports 120 FPS"] },
          ],
        };
      }
      if (prompt.includes("fact-checking cross-checker")) {
        return {
          supported: [
            {
              claim: "The widget supports 120 FPS",
              sources: ["https://a.example/article", "https://b.example/faq"],
            },
          ],
          discarded: [],
          conflicts: [],
        };
      }
      if (prompt.includes("claim-evidence verifier")) {
        onVerifier?.();
        return { pages: verifierPages };
      }
      if (prompt.includes("well-structured research report")) return "report text";
      return null;
    },
  };
}

async function runDeepResearch(
  agent: unknown,
  runId: string,
  journal?: Map<string, JournalEntry>,
  journalOut?: (entry: JournalEntry) => void,
) {
  return runWorkflow(generateDeepResearchWorkflow(), {
    agent: agent as never,
    persistLogs: false,
    runId,
    args: { question: "What is the widget refresh rate?", angles: 2, minSupport: 2 },
    ...(journal ? { resumeJournal: journal } : {}),
    ...(journalOut ? { onAgentJournal: journalOut } : {}),
  });
}

test("deep-research: verifier marks a claim verified when a cited page states it (N02)", async () => {
  const pages = [
    { url: "https://a.example/article", content: "The widget supports 120 FPS at 4K resolution." },
    { url: "https://b.example/faq", content: "Frequently asked questions about colors and packaging." },
  ];
  const r1 = await runDeepResearch(researchStub(pages), "dr-verify-run");
  const v1 = r1.result as { verification?: VerificationEntry[] };
  assert.equal(v1.verification?.length, 1);
  const entry = v1.verification?.[0];
  assert.ok(entry, "verification entry present");
  assert.equal(entry.claim, "The widget supports 120 FPS");
  assert.equal(entry.verified, true);
  // Spread out of the vm realm before deepEqual (its Array prototype differs).
  assert.deepEqual([...(entry.sources ?? [])], ["https://a.example/article", "https://b.example/faq"]);
  assert.deepEqual([...(entry.matchedSources ?? [])], ["https://a.example/article"]);
  assert.match(entry.evidenceHash, /^[0-9a-f]{8}$/);
  // The evidence hash matches the deterministic pure function.
  assert.equal(
    entry.evidenceHash,
    computeEvidenceHash(entry.claim, [...(entry.sources ?? [])], true, [...(entry.matchedSources ?? [])]),
  );
  assert.ok(
    r1.logs.some((l) => l.includes("verified 1 of 1 supported claim(s)")),
    "verification summary is logged",
  );

  // Determinism: a second run with the same inputs yields an identical artifact.
  const r2 = await runDeepResearch(researchStub(pages), "dr-verify-run-2");
  const v2 = r2.result as { verification?: VerificationEntry[] };
  assert.equal(JSON.stringify(v1.verification), JSON.stringify(v2.verification));
});

test("deep-research: unverified claims are FLAGGED, never silently dropped (N02)", async () => {
  // The cited pages do NOT contain the claim (and one verifier returns null).
  const r = await runDeepResearch(researchStub([]), "dr-unverified-run");
  const v = r.result as { verification?: VerificationEntry[] };
  assert.equal(v.verification?.length, 1, "the claim is still in the artifact");
  const entry = v.verification?.[0];
  assert.ok(entry);
  assert.equal(entry.verified, false);
  assert.deepEqual([...(entry.matchedSources ?? [])], []);
  assert.match(entry.evidenceHash, /^[0-9a-f]{8}$/);
  assert.ok(
    r.logs.some((l) => l.includes("flagged unverified, never dropped")),
    "unverified claims are flagged in the logs, never silent",
  );
  assert.ok(
    r.logs.some((l) => l.includes("verified 0 of 1 supported claim(s)")),
    "summary counts the unverified claim",
  );
  // The report agent is told about the unverified claim: capture its prompt.
  const reportPrompts: string[] = [];
  const agent = {
    async run(prompt: string) {
      if (prompt.includes("planning web research")) return { queries: ["q"] };
      if (prompt.includes("Research this query")) {
        return { sources: [{ url: "https://a.example/article", claims: ["The widget supports 120 FPS"] }] };
      }
      if (prompt.includes("fact-checking cross-checker")) {
        return {
          supported: [
            { claim: "The widget supports 120 FPS", sources: ["https://a.example/article", "https://b.example/faq"] },
          ],
          discarded: [],
          conflicts: [],
        };
      }
      if (prompt.includes("claim-evidence verifier")) return { pages: [] };
      if (prompt.includes("well-structured research report")) {
        reportPrompts.push(prompt);
        return "report text";
      }
      return null;
    },
  };
  await runDeepResearch(agent, "dr-unverified-report-run");
  assert.ok(reportPrompts.length === 1);
  const reportPrompt = reportPrompts[0];
  assert.ok(reportPrompt.includes("VERIFICATION JSON"), "report carries the verification artifact");
  assert.ok(
    reportPrompt.includes('"verified":false') && reportPrompt.includes("never as fact"),
    "report is told to disclose the unverified claim, never present it as fact",
  );
});

test("deep-research: only CITED pages can corroborate a claim (N02 integrity guard)", async () => {
  // The verifier returns content for an UNCITED URL that states the claim — it
  // must not count, or a fabricated page could launder evidence into the report.
  const pages = [{ url: "https://evil.example/planted", content: "The widget supports 120 FPS" }];
  const r = await runDeepResearch(researchStub(pages), "dr-integrity-run");
  const v = r.result as { verification?: VerificationEntry[] };
  assert.equal(v.verification?.[0]?.verified, false, "uncited page cannot corroborate");
  assert.deepEqual([...(v.verification?.[0]?.matchedSources ?? [])], []);
  assert.ok(r.logs.some((l) => l.includes("flagged unverified, never dropped")));
});

test("deep-research: minSupport enforcement stays deterministic and spawns no verifier for under-supported claims (N02)", async () => {
  let verifierCalls = 0;
  const agent = {
    async run(prompt: string) {
      if (prompt.includes("planning web research")) return { queries: ["q"] };
      if (prompt.includes("Research this query")) {
        return { sources: [{ url: "https://a.example", claims: ["Single-source claim"] }] };
      }
      if (prompt.includes("fact-checking cross-checker")) {
        // The (fake) LLM claims support from ONE authoritative-looking source.
        return { supported: [{ claim: "Single-source claim", sources: ["https://a.example"] }] };
      }
      if (prompt.includes("claim-evidence verifier")) {
        verifierCalls++;
        return { pages: [] };
      }
      return "report";
    },
  };
  const r = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: agent as never,
    persistLogs: false,
    args: { question: "Q?", angles: 2, minSupport: 2 },
  });
  const result = r.result as { supported?: unknown[]; conflicts?: Array<{ claim: string }>; verification?: unknown[] };
  assert.equal(result.supported?.length, 0, "under-supported claim must NOT survive minSupport");
  assert.ok(
    (result.conflicts ?? []).some((c) => c.claim === "Single-source claim"),
    "under-supported claim moves to Conflicts",
  );
  assert.equal(verifierCalls, 0, "verification runs only on claims that SURVIVED minSupport");
  assert.equal(result.verification?.length, 0);
  assert.ok(
    r.logs.some((l) => l.includes("moved to Conflicts")),
    "minSupport routing still logged",
  );
});

// ─── Resume: verification steps are journaled agents ─────────────────────────

test("deep-research: resume replays the verification steps from the journal (N02)", async () => {
  const journal = new Map<string, JournalEntry>();
  const first = await runDeepResearch(
    researchStub([{ url: "https://a.example/article", content: "The widget supports 120 FPS at 4K resolution." }]),
    "dr-resume-run",
    undefined,
    (e) => journal.set(`${e.runId}:${e.index}`, e),
  );
  const v1 = first.result as { verification?: VerificationEntry[] };
  assert.equal(v1.verification?.[0]?.verified, true);

  // Second run: identical script + runId, journaled cache. The stub must never
  // be called again — every step (incl. the verification agent) replays.
  let liveCalls = 0;
  const second = await runDeepResearch(
    {
      async run(_prompt: string) {
        liveCalls++;
        return null;
      },
    },
    "dr-resume-run",
    journal,
  );
  assert.equal(liveCalls, 0, "no live agent calls on a full cache hit");
  const v2 = second.result as { verification?: VerificationEntry[] };
  assert.equal(JSON.stringify(v1.verification), JSON.stringify(v2.verification));
  assert.equal(v2.verification?.[0]?.verified, true, "replayed verification keeps its verdict");
});
