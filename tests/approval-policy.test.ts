/**
 * V2-P01 + V2-N6 + V2-N3 — risk-classified approval policy, LLM auto-approval
 * classifier, serialized grants, trusted-script allowlist, and gate-time cost
 * preview.
 *
 * Slice A1 (approval layer). Covers:
 *  - per-risk-class policy matrix (allow/ask/auto/deny) on checkpoint() +
 *    the fan-out gate;
 *  - classifier allow/escalate + fail-closed (unavailable/null → escalate,
 *    headless escalate → throw);
 *  - classifier spend metered against the run budget;
 *  - per-run serialized grants (session + once), never widening;
 *  - trusted-script allowlist: skip on re-run, per-exact-hash invalidation,
 *    allowlist written only on HUMAN approval;
 *  - hashCheckpoint stability: the optional riskClass key is hash-stable and
 *    absent-riskClass checkpoints replay byte-identically;
 *  - N3 gate-time cost preview line + `details` display-only channel.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ApprovalClassifier,
  ApprovalGrantStore,
  approvalGrantKey,
  buildGateCostLine,
  createTrustedScriptsStore,
  parseApprovalClassifierVerdict,
  scriptBodyHash,
  type TrustedScriptsStore,
} from "../src/index.js";
import type { CheckpointOptions, JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const okAgent = {
  async run(_prompt: string, _options?: unknown) {
    return "ok";
  },
};

/** An in-memory TrustedScriptsStore double (the real store is tested separately). */
function memoryTrustedStore(): { store: TrustedScriptsStore; trusted: Set<string> } {
  const trusted = new Set<string>();
  return {
    trusted,
    store: {
      filePath: "(memory)",
      isTrusted(hash) {
        return trusted.has(hash);
      },
      async add(record) {
        trusted.add(record.hash);
        return true;
      },
      async remove(hash) {
        return trusted.delete(hash);
      },
      list() {
        return [...trusted].map((hash) => ({ hash, addedAt: "t0" }));
      },
    },
  };
}

/** A fake classifier whose verdict is fixed per test. */
function fakeClassifier(
  verdict: "allow" | "escalate" | null,
  opts: { calls?: Array<{ action: string; riskClass?: string; evidence?: string }>; prompt?: string } = {},
): ApprovalClassifier {
  const calls = opts.calls ?? [];
  return {
    async classify(input) {
      calls.push({ action: input.action, riskClass: input.riskClass, evidence: input.evidence });
      return {
        verdict,
        prompt: opts.prompt ?? `classify ${input.action}`,
        reply: verdict === "allow" ? "ALLOW" : verdict === "escalate" ? "ESCALATE" : "garbage",
      };
    },
  };
}

// ─── V2-P01: risk-class matrix on checkpoint() ──────────────────────────────

test("P01: policy allow auto-flows the declared default without prompting", async () => {
  let confirmCalls = 0;
  const script = `export const meta = { name: 'p01_allow', description: 'allow' }
const r = await checkpoint('Read the workspace?', { riskClass: 'read', default: true })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { read: "allow" },
    confirm: async () => {
      confirmCalls++;
      return false; // would deny if reached
    },
  });
  assert.equal(res.result.r, true, "policy-allow takes the declared default");
  assert.equal(confirmCalls, 0, "no human prompt for a policy-allow");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["policy-allow"],
  );
});

test("P01: policy deny refuses without prompting", async () => {
  let confirmCalls = 0;
  const script = `export const meta = { name: 'p01_deny', description: 'deny' }
const r = await checkpoint('Run the destructive migration?', { riskClass: 'execute', default: true })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { execute: "deny" },
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(res.result.r, false, "policy-deny resolves false (refused)");
  assert.equal(confirmCalls, 0, "no human prompt for a policy-deny");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["policy-deny"],
  );
});

test("P01: policy ask routes the checkpoint to the human (confirm)", async () => {
  const asked: Array<{ prompt: string; options: CheckpointOptions }> = [];
  const script = `export const meta = { name: 'p01_ask', description: 'ask' }
const r = await checkpoint('Write the file?', { riskClass: 'write', default: false })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { write: "ask" },
    confirm: async (prompt, options) => {
      asked.push({ prompt, options: options as CheckpointOptions });
      return true;
    },
  });
  assert.equal(res.result.r, true, "the human's verdict resolves");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.prompt, "Write the file?");
  assert.equal(asked[0]?.options.riskClass, "write");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["human-approve"],
  );
});

test("P01: policy ask + headless fails CLOSED (throws, never rubber-stamps a risky action)", async () => {
  const script = `export const meta = { name: 'p01_headless', description: 'headless risk' }
const r = await checkpoint('Run the migration?', { riskClass: 'execute', default: true })
return { r }`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: okAgent,
        persistLogs: false,
        approvalPolicy: { execute: "ask" },
      }),
    /requires human approval|headless/i,
  );
});

test("P01: policy ask + headless 'abort' still throws (existing headless rule untouched)", async () => {
  const script = `export const meta = { name: 'p01_headless_abort', description: 'headless abort' }
const r = await checkpoint('Run the migration?', { riskClass: 'execute', default: true, headless: 'abort' })
return { r }`;
  await assert.rejects(
    () => runWorkflow(script, { agent: okAgent, persistLogs: false, approvalPolicy: { execute: "ask" } }),
    /needs human input|headless/i,
  );
});

test("P01: policy auto + classifier ALLOW approves the declared default", async () => {
  const calls: Array<{ action: string; riskClass: string }> = [];
  const script = `export const meta = { name: 'p01_auto_allow', description: 'auto allow' }
const r = await checkpoint('Fetch the external URL?', { riskClass: 'network', action: 'fetch:url:1', default: true })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { network: "auto" },
    approvalClassifier: fakeClassifier("allow", { calls }),
    confirm: async () => {
      throw new Error("classifier-allow must not reach the human");
    },
  });
  assert.equal(res.result.r, true);
  assert.equal(calls.length, 1, "the classifier ran once");
  assert.equal(calls[0]?.action, "fetch:url:1", "the classifier saw the exact action");
  assert.equal(calls[0]?.riskClass, "network");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["classifier-allow"],
  );
});

test("P01: policy auto + classifier ESCALATE routes to the human", async () => {
  const script = `export const meta = { name: 'p01_auto_esc', description: 'auto escalate' }
const r = await checkpoint('Overwrite the config?', { riskClass: 'write', action: 'overwrite:config', default: false })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { write: "auto" },
    approvalClassifier: fakeClassifier("escalate"),
    confirm: async () => true, // the human approves after the escalation
  });
  assert.equal(res.result.r, true, "escalation reaches the human who approves");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["classifier-escalate", "human-approve"],
  );
});

test("P01: policy auto + classifier UNAVAILABLE fails closed (headless throws)", async () => {
  const script = `export const meta = { name: 'p01_auto_null', description: 'auto null' }
const r = await checkpoint('Run the migration?', { riskClass: 'execute', action: 'migrate:db', default: true })
return { r }`;
  // No confirm threaded in — the classifier comes back null (unavailable) and
  // the escalation has no human to reach: the run must fail closed, never
  // silently approve a high-risk action.
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: okAgent,
        persistLogs: false,
        approvalPolicy: { execute: "auto" },
        approvalClassifier: fakeClassifier(null),
      }),
    /requires human approval|headless/i,
  );
});

test("P01: policy auto + classifier UNAVAILABLE with a human present escalates to the human", async () => {
  const script = `export const meta = { name: 'p01_auto_null_human', description: 'auto null human' }
const r = await checkpoint('Run the migration?', { riskClass: 'execute', action: 'migrate:db2', default: false })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { execute: "auto" },
    approvalClassifier: fakeClassifier(null),
    confirm: async () => true,
  });
  assert.equal(res.result.r, true, "unavailable classifier escalates to the human, who approves");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["classifier-escalate", "human-approve"],
  );
});

test("P01: the classifier's spend is metered against the run budget", async () => {
  const script = `export const meta = { name: 'p01_meter', description: 'meter classifier' }
const r = await checkpoint('Approve?', { riskClass: 'network', action: 'metered:1', default: true })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { network: "auto" },
    approvalClassifier: fakeClassifier("allow", { prompt: "classify metered:1" }),
  });
  assert.ok((res.tokenUsage?.total ?? 0) > 0, "the classifier's estimated tokens are metered into the run token usage");
});

test("P01: the classifier decision is recorded in the run result (report evidence), never in any agent hash", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'p01_report', description: 'report evidence' }
const r = await checkpoint('Approve?', { riskClass: 'network', action: 'recorded:1', default: true })
await agent('work', { label: 'work' })
return { r }`;
  const res = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { network: "auto" },
    approvalClassifier: fakeClassifier("allow"),
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["classifier-allow"],
  );
  // hashAgentCall's field set is untouched: the journaled agent hash must not
  // vary with the approval policy (compare with a policy-less run of the same
  // script by checking the hash against a reference — see the hash-stability
  // test below for the checkpoint side).
  assert.equal(journal.length, 2);
  assert.equal(journal[1]?.result, "ok");
});

// ─── V2-P01: serialized per-run grants ─────────────────────────────────────

test("P01: a human approval records an allow-session grant — the same action auto-flows for the rest of the run", async () => {
  let confirmCalls = 0;
  const script = `export const meta = { name: 'p01_grant_session', description: 'session grant' }
const a = await checkpoint('Approve the migration?', { riskClass: 'execute', action: 'migrate:v1', default: false })
const b = await checkpoint('Approve the migration?', { riskClass: 'execute', action: 'migrate:v1', default: false })
return { a, b }`;
  const res = await runWorkflow<{ a: boolean; b: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { execute: "ask" },
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(res.result.a, true, "first occurrence asks the human");
  assert.equal(res.result.b, true, "second occurrence replays through the session grant");
  assert.equal(confirmCalls, 1, "the grant skipped the second prompt");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["human-approve", "session-grant"],
  );
});

test("P01: grants are action-exact — a DIFFERENT action re-asks (never widens)", async () => {
  let confirmCalls = 0;
  const script = `export const meta = { name: 'p01_grant_exact', description: 'action exact' }
const a = await checkpoint('Approve?', { riskClass: 'execute', action: 'act:1', default: false })
const b = await checkpoint('Approve?', { riskClass: 'execute', action: 'act:2', default: false })
return { a, b }`;
  const res = await runWorkflow<{ a: boolean; b: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { execute: "ask" },
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(res.result.a, true);
  assert.equal(res.result.b, true);
  assert.equal(confirmCalls, 2, "a different action is NOT covered by the grant");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["human-approve", "human-approve"],
  );
});

test("P01: grantMode 'once' pre-approves exactly ONE future occurrence", async () => {
  let confirmCalls = 0;
  const script = `export const meta = { name: 'p01_grant_once', description: 'once grant' }
const a = await checkpoint('Approve?', { riskClass: 'execute', action: 'act:once', default: false, grantMode: 'once' })
const b = await checkpoint('Approve?', { riskClass: 'execute', action: 'act:once', default: false })
const c = await checkpoint('Approve?', { riskClass: 'execute', action: 'act:once', default: false })
return { a, b, c }`;
  const res = await runWorkflow<{ a: boolean; b: boolean; c: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { execute: "ask" },
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(res.result.a, true, "first occurrence asks the human");
  assert.equal(res.result.b, true, "second occurrence consumes the once-grant");
  assert.equal(res.result.c, true, "third occurrence asks again (grant consumed)");
  assert.equal(confirmCalls, 2, "the once-grant covered exactly one occurrence");
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["human-approve", "once-grant", "human-approve"],
  );
});

test("P01: grants are per-run — a fresh run re-asks (never cross-run widening)", async () => {
  let confirmCalls = 0;
  const script = `export const meta = { name: 'p01_grant_run', description: 'per run' }
const a = await checkpoint('Approve?', { riskClass: 'execute', action: 'act:run', default: false })
return { a }`;
  const runOnce = async () =>
    runWorkflow<{ a: boolean }>(script, {
      agent: okAgent,
      persistLogs: false,
      approvalPolicy: { execute: "ask" },
      confirm: async () => {
        confirmCalls++;
        return true;
      },
    });
  const first = await runOnce();
  const second = await runOnce();
  assert.equal(first.result.a, true);
  assert.equal(second.result.a, true);
  assert.equal(confirmCalls, 2, "the grant from run 1 does not leak into run 2");
});

test("P01: ApprovalGrantStore unit semantics — session persists, once consumes", () => {
  const store = new ApprovalGrantStore();
  const key = approvalGrantKey("agent", "fan-out:10:default toolset");
  assert.equal(store.peek(key), null);
  store.grant(key, "session");
  assert.equal(store.peek(key), "session");
  store.grant(key, "once");
  assert.equal(store.peek(key), "session", "session wins over once");
  store.consumeOnce(key);
  assert.equal(store.peek(key), "session", "consuming a missing once-grant leaves session intact");
});

// ─── V2-P01: fan-out gate honors risk classes ───────────────────────────────

const fanOutScript = `export const meta = { name: 'p01_fanout', description: 'fanout risk' }
const xs = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('f' + i, { label: 'f' + i })))
return xs.length`;

test("P01: agent policy allow auto-flows a big fan-out (no approval pause)", async () => {
  let confirmCalls = 0;
  const res = await runWorkflow<number>(fanOutScript, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { agent: "allow" },
    confirm: async () => {
      confirmCalls++;
      return false;
    },
  });
  assert.equal(res.result, 10);
  assert.equal(confirmCalls, 0, "policy-allow skips the fan-out gate entirely");
});

test("P01: agent policy deny refuses a big fan-out (WORKFLOW_ABORTED)", async () => {
  await assert.rejects(
    () =>
      runWorkflow(fanOutScript, {
        agent: okAgent,
        persistLogs: false,
        approvalPolicy: { agent: "deny" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /denied by the approval policy/);
      return true;
    },
  );
});

test("P01: agent policy ask keeps the existing count-gated human approval", async () => {
  let confirmCalls = 0;
  const res = await runWorkflow<number>(fanOutScript, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { agent: "ask" },
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(res.result, 10);
  assert.equal(confirmCalls, 1, "a big fan-out under policy ask pauses for the human");
});

test("P01: agent policy auto + classifier allow auto-flows a big fan-out", async () => {
  const calls: Array<{ action: string }> = [];
  const res = await runWorkflow<number>(fanOutScript, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { agent: "auto" },
    approvalClassifier: fakeClassifier("allow", { calls }),
    confirm: async () => {
      throw new Error("classifier-allow must not reach the human");
    },
  });
  assert.equal(res.result, 10);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.action ?? "", /^fan-out:10:/);
  assert.deepEqual(
    res.approvalDecisions?.map((d) => d.decision),
    ["classifier-allow"],
  );
});

test("P01: agent policy auto + classifier escalate asks the human, then grants the fan-out for the run", async () => {
  let confirmCalls = 0;
  // Two identical 10-item fan-outs: the first escalates to the human (who
  // approves), the second flows through the allow-session grant.
  const script = `export const meta = { name: 'p01_fanout_grant', description: 'fanout grant' }
const a = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('g' + i, { label: 'g' + i })))
const b = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('h' + i, { label: 'h' + i })))
return [a.length, b.length]`;
  const res = await runWorkflow<[number, number]>(script, {
    agent: okAgent,
    persistLogs: false,
    approvalPolicy: { agent: "auto" },
    approvalClassifier: fakeClassifier("escalate"),
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  // Spread the vm-realm array into a host array before comparing (the suite's
  // cross-realm pattern — deepStrictEqual on a vm-created array literal fails
  // on the prototype difference).
  assert.deepEqual([...res.result], [10, 10]);
  assert.equal(confirmCalls, 1, "the second identical fan-out flows through the session grant");
});

// ─── V2-N6: trusted-script allowlist ────────────────────────────────────────

const gatedScript = `export const meta = { name: 'n6_gated', description: 'gated script', gate: 'approve' }
const a = await checkpoint('Approve step?', { default: false })
const b = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('t' + i, { label: 't' + i })))
return { a, b: b.length }`;

test("N6: a previously HUMAN-approved script hash skips meta.gate + checkpoint + fan-out gates on re-run", async () => {
  const { store, trusted } = memoryTrustedStore();
  let confirmCalls = 0;
  const confirm = async () => {
    confirmCalls++;
    return true;
  };
  // The allowlist write requires a MANAGED run (agentKillChannel — the
  // manager's unconditional per-execution handle): one-shot direct embeds
  // never persist trust, so tests/embeddings can't arm the user's allowlist.
  const managedRun = {
    killedCallIds: new Set<string>(),
    idleAbortedCallIds: new Set<string>(),
    idleEscalatedCallIds: new Set<string>(),
    killControllers: new Map<string, AbortController>(),
  };

  // Run 1: nothing is trusted yet — meta.gate asks, the checkpoint asks, and
  // the fan-out asks; the human approves everything. The meta.gate approval
  // (human, managed run) writes the allowlist.
  const first = await runWorkflow<{ a: boolean; b: number }>(gatedScript, {
    agent: okAgent,
    persistLogs: false,
    trustedScripts: store,
    agentKillChannel: managedRun,
    confirm,
  });
  assert.equal(first.result.a, true);
  assert.equal(first.result.b, 10);
  assert.equal(confirmCalls, 3, "run 1 gates all asked the human");
  assert.equal(trusted.size, 1, "the human approval recorded the script hash");

  // Run 2: same exact script → trusted → all three gates skip. The in-body
  // checkpoint takes its DECLARED default (false — the author's unattended
  // behavior), the fan-out gate is skipped, and the human is never contacted.
  confirmCalls = 0;
  const second = await runWorkflow<{ a: boolean; b: number }>(gatedScript, {
    agent: okAgent,
    persistLogs: false,
    trustedScripts: store,
    agentKillChannel: managedRun,
    confirm,
  });
  assert.equal(second.result.a, false, "the trusted checkpoint takes its declared default (false)");
  assert.equal(second.result.b, 10, "the fan-out gate was skipped");
  assert.equal(confirmCalls, 0, "run 2 never contacted the human (gate-skip)");
});

test("N6: any edit to the script invalidates the allowlist (approval per exact hash)", async () => {
  const { store, trusted } = memoryTrustedStore();
  const confirm = async () => true;
  const managedRun = {
    killedCallIds: new Set<string>(),
    idleAbortedCallIds: new Set<string>(),
    idleEscalatedCallIds: new Set<string>(),
    killControllers: new Map<string, AbortController>(),
  };
  await runWorkflow<{ a: boolean; b: number }>(gatedScript, {
    agent: okAgent,
    persistLogs: false,
    trustedScripts: store,
    agentKillChannel: managedRun,
    confirm,
  });
  assert.equal(trusted.size, 1);

  // Edited body: a trailing comment changes the hash → the entry no longer
  // matches, so every gate re-asks the human (the old entry never widens).
  const editedWithChange = `export const meta = { name: 'n6_gated', description: 'gated script', gate: 'approve' }
const a = await checkpoint('Approve step?', { default: false })
const b = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('t' + i, { label: 't' + i })))
return { a, b: b.length } /* edited */`;
  let confirmCalls = 0;
  const second = await runWorkflow<{ a: boolean; b: number }>(editedWithChange, {
    agent: okAgent,
    persistLogs: false,
    trustedScripts: store,
    agentKillChannel: managedRun,
    confirm: async () => {
      confirmCalls++;
      return true;
    },
  });
  assert.equal(second.result.a, true);
  assert.equal(second.result.b, 10);
  assert.equal(confirmCalls, 3, "an edited script re-asks the human at every gate — the old entry never widens");
});

test("N6: a headless auto-approve does NOT write the allowlist (only human approvals trust a script)", async () => {
  const { store, trusted } = memoryTrustedStore();
  // Headless: meta.gate auto-approves (checkpoint headless default) — but that
  // is not a HUMAN approval, so no allowlist entry is written. The big fan-out
  // then fails closed (headless abort) — exactly the pre-N6 gate behavior.
  await assert.rejects(
    () =>
      runWorkflow<{ a: boolean; b: number }>(gatedScript, {
        agent: okAgent,
        persistLogs: false,
        trustedScripts: store,
      }),
    /not approved|headless|aborted/i,
  );
  assert.equal(trusted.size, 0, "headless auto-approval must not mark the script trusted");
});

test("N6: the real store persists under the deterministic clock and dedupes adds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "n6-store-"));
  try {
    const filePath = join(dir, "trusted-scripts.json");
    const store = createTrustedScriptsStore({ filePath });
    const hash = scriptBodyHash("export const meta = { name: 'x', description: 'y' }\nreturn 1");
    assert.equal(store.isTrusted(hash), false);
    await store.add({ hash, name: "x", source: "test" });
    await store.add({ hash, name: "x", source: "test" }); // idempotent
    assert.equal(store.isTrusted(hash), true);
    assert.equal(store.list().length, 1, "duplicate adds dedupe");

    // A second store instance (new process view) reads the same persisted file.
    const reopened = createTrustedScriptsStore({ filePath });
    assert.equal(reopened.isTrusted(hash), true, "the allowlist survives a reopen");
    const raw = JSON.parse(await readFile(filePath, "utf-8")) as { version: number; records: unknown[] };
    assert.equal(raw.version, 1);
    assert.equal(raw.records.length, 1);

    await store.remove(hash);
    assert.equal(store.isTrusted(hash), false);
    // A FRESH instance (as a new run would create) sees the persisted removal.
    const fresh = createTrustedScriptsStore({ filePath });
    assert.equal(fresh.isTrusted(hash), false, "removal persists for new store instances");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("N6: gate-skip is host-side policy — the same script's agent hashes are identical across trusted/untrusted runs", async () => {
  const journalA: JournalEntry[] = [];
  const journalB: JournalEntry[] = [];
  const { store } = memoryTrustedStore();
  const script = `export const meta = { name: 'n6_hash', description: 'hash stable' }
await agent('work', { label: 'work' })
return 1`;
  // Untrusted run with gates exercised; trusted run with the allowlist populated.
  await store.add({ hash: scriptBodyHash(script), addedAt: "t0" });
  await runWorkflow(script, {
    agent: okAgent,
    persistLogs: false,
    onAgentJournal: (e) => journalA.push(e),
  });
  await runWorkflow(script, {
    agent: okAgent,
    persistLogs: false,
    trustedScripts: store,
    onAgentJournal: (e) => journalB.push(e),
  });
  assert.equal(journalA[0]?.hash, journalB[0]?.hash, "gate-skip never joins hashAgentCall");
});

// ─── V2-P01: hashCheckpoint stability with the optional riskClass key ──────

test("P01: adding riskClass to a checkpoint busts the resume cache (re-evaluates live)", async () => {
  const journal = new Map<string, JournalEntry>();
  const script = (risk: string) => `export const meta = { name: 'p01_hash_risk', description: 'risk hash' }
const r = await checkpoint('Approve?', { ${risk} default: true })
return { r }`;
  const first = await runWorkflow<{ r: boolean }>(script(""), {
    agent: okAgent,
    persistLogs: false,
    runId: "p01-risk-hash-run",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.equal(first.result.r, true);

  // Same prompt/default, but a riskClass is added — the optional key changes
  // the identity, so the journaled unclassified reply must NOT replay.
  const second = await runWorkflow<{ r: boolean }>(script("riskClass: 'execute',"), {
    agent: okAgent,
    persistLogs: false,
    runId: "p01-risk-hash-run",
    resumeJournal: journal,
    approvalPolicy: { execute: "deny" },
  });
  assert.equal(second.result.r, false, "the re-classified checkpoint re-evaluated live under its new policy");
});

test("P01: an absent riskClass keeps the checkpoint hash byte-identical (legacy journals replay)", async () => {
  const journal = new Map<string, JournalEntry>();
  const script = `export const meta = { name: 'p01_hash_stable', description: 'stable' }
const r = await checkpoint('Approve?', { default: true })
return { r }`;
  const first = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    runId: "p01-hash-stable-run",
    confirm: async () => "human-said-yes",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.equal(first.result.r, "human-said-yes");

  let rePrompted = false;
  const second = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    runId: "p01-hash-stable-run",
    resumeJournal: journal,
    confirm: async () => {
      rePrompted = true;
      return "different";
    },
  });
  assert.equal(rePrompted, false, "no riskClass key → identical hash → cache-hit replay");
  assert.equal(second.result.r, "human-said-yes");
});

// ─── V2-N3: gate-time cost preview ─────────────────────────────────────────

test("N3: buildGateCostLine renders the consent line (estimate · agents · budget forecast)", () => {
  const line = buildGateCostLine({
    plannedTokens: 1500,
    plannedAgents: 10,
    budgetRemaining: 5000,
    budgetTotal: 5000,
    spentTokens: 0,
    costUsd: 0,
  });
  assert.match(line, /estimated ~1500 tokens of agent work/);
  assert.match(line, /10 agent\(s\)/);
  assert.match(line, /5000 tokens remaining/);
  assert.match(line, /forecast within budget/);
});

test("N3: the forecast flags a budget EXCEED", () => {
  const line = buildGateCostLine({
    plannedTokens: 9000,
    budgetRemaining: 5000,
    budgetTotal: 5000,
    spentTokens: 0,
    costUsd: 0,
  });
  assert.match(line, /forecast EXCEEDS budget/);
});

test("N3: a dollar figure appears only when a real provider-reported rate exists", () => {
  const noRate = buildGateCostLine({
    plannedTokens: 1000,
    budgetRemaining: Infinity,
    budgetTotal: null,
    spentTokens: 0,
    costUsd: 0,
  });
  assert.doesNotMatch(noRate, /\$/, "no invented dollar figure without provider-reported cost");
  const withRate = buildGateCostLine({
    plannedTokens: 1000,
    budgetRemaining: Infinity,
    budgetTotal: null,
    spentTokens: 2000,
    costUsd: 0.02,
  });
  assert.match(withRate, /\$0\.010/, "a rate derived from actual spend renders a dollar figure");
});

test("N3: the fan-out gate carries the cost preview as display-only `details` (never hashed)", async () => {
  let seenDetails: string | undefined;
  const script = `export const meta = { name: 'n3_fanout', description: 'cost details' }
const xs = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('c' + i, { label: 'c' + i })))
return xs.length`;
  await runWorkflow<number>(script, {
    agent: okAgent,
    persistLogs: false,
    confirm: async (_prompt, options) => {
      seenDetails = (options as CheckpointOptions).details;
      return true;
    },
  });
  assert.ok(seenDetails !== undefined, "the fan-out checkpoint carries a details line");
  // No agents have run yet, so the per-item token estimate is unknown — but
  // the agent count + budget forecast are still shown (the N3 consent line).
  assert.match(seenDetails ?? "", /10 agent\(s\)/);
  assert.match(seenDetails ?? "", /no run token budget/);
});

test("N3: the checkpoint identity ignores `details` — two runs with different spend replay identically", async () => {
  // The forecast line varies with run state; it must never be part of the
  // checkpoint hash (a resume must not re-block on a changed forecast).
  const journal = new Map<string, JournalEntry>();
  const script = `export const meta = { name: 'n3_details', description: 'details stable' }
const r = await checkpoint('Approve?', { default: true, details: 'estimated ~999 tokens' })
return { r }`;
  const first = await runWorkflow<{ r: boolean }>(script, {
    agent: okAgent,
    persistLogs: false,
    runId: "n3-details-run",
    confirm: async () => "human-1",
    onAgentJournal: (e) => journal.set(`${e.runId}:${e.index}`, e),
  });
  assert.equal(first.result.r, "human-1");

  const second = await runWorkflow<{ r: boolean }>(script.replace("estimated ~999", "estimated ~42"), {
    agent: okAgent,
    persistLogs: false,
    runId: "n3-details-run",
    resumeJournal: journal,
    confirm: async () => {
      throw new Error("a changed details line must not re-prompt");
    },
  });
  assert.equal(second.result.r, "human-1", "the journaled reply replays despite the changed display line");
});

// ─── V2-P01: classifier verdict parsing (unit) ─────────────────────────────

test("P01: parseApprovalClassifierVerdict is lenient over free-text replies", () => {
  assert.equal(parseApprovalClassifierVerdict("ALLOW"), "allow");
  assert.equal(parseApprovalClassifierVerdict("ESCALATE: because of uncertainty"), "escalate");
  assert.equal(parseApprovalClassifierVerdict("I think ALLOW is fine here"), "allow");
  assert.equal(parseApprovalClassifierVerdict(""), null);
  assert.equal(parseApprovalClassifierVerdict("maybe"), null, "unrecognized replies fail closed (null)");
  assert.equal(parseApprovalClassifierVerdict(null), null);
});

// ─── V2-P01: decision records surface in the run result ────────────────────

test("P01: approvalDecisions is undefined when no risk-classed gate fired (shape unchanged)", async () => {
  const script = `export const meta = { name: 'p01_empty', description: 'no gates' }
const r = await agent('plain', { label: 'plain' })
return r`;
  const res = await runWorkflow<{ r: string }>(script, { agent: okAgent, persistLogs: false });
  assert.equal(res.approvalDecisions, undefined, "JSON-dropped on policy-less runs");
  assert.equal(res.result, "ok");
});

test("P01: grant keys are action-exact (unit)", () => {
  const a = approvalGrantKey("execute", "migrate:db");
  const b = approvalGrantKey("execute", "migrate:other");
  const c = approvalGrantKey("network", "migrate:db");
  assert.notEqual(a, b, "different actions never share a grant key");
  assert.notEqual(a, c, "the risk class is part of the grant key");
  assert.equal(approvalGrantKey("execute", "migrate:db"), a, "identical action+class is deterministic");
});
