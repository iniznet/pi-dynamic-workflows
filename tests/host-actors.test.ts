/**
 * V2-P12 — session-scoped host-event actors (cross-run watchdog/advisor/spec).
 *
 * Tests the actor manager (src/host-actors.ts) end to end:
 *  1. watchdog flags goal drift on session events (before_agent_start +
 *     session_compact) and delivers a goal reminder through the sendMessage hook,
 *  2. advisor injects a review on request (trigger match / no-match),
 *  3. spec ledger accumulates acceptance criteria ACROSS sessions (persisted
 *     state reload) with the open → verified lifecycle,
 *  4. side-input contract honored: contributions are BeforeAgentStartEventResult-
 *     shaped session-side inputs only, context events are observational, and the
 *     triggerTurn stop-the-world gate is supervisor-only,
 *  5. default-off: an inert manager registers nothing and delivers nothing; the
 *     extension registers NO actor observers unless `hostActors: "on"`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultPersistenceFs, readJsonWithBackupRecovery } from "../src/fs-persistence.js";
import {
  type AdvisorActorConfig,
  boundedContextView,
  createHostActorManager,
  extractAcceptanceCriteria,
  fnv1aHex,
  goalSimilarity,
  type HostActorManagerOptions,
  HostActorsConfigError,
  normalizeCriterionText,
  parseHostActorConfigs,
  promptCarriesDoneMarker,
  type SpecActorConfig,
  type SupervisorActorConfig,
  triggerMatches,
  type WatchdogActorConfig,
} from "../src/host-actors.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { rmForce } from "./helpers/rm-force.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-dw-${label}-`));
}

function makeManager(options: Omit<HostActorManagerOptions, "now"> & { now?: () => number } = {}) {
  const delivered: Array<{ message: unknown; triggerTurn: boolean }> = [];
  const manager = createHostActorManager({
    ...options,
    deliver: (message, deliveryOptions) => {
      delivered.push({ message, triggerTurn: deliveryOptions.triggerTurn });
    },
  });
  return { manager, delivered };
}

/** Content of a session-side custom message (string form used by actors). */
function contentOf(message: { content: string | Array<{ type: string; text?: string }> } | undefined): string {
  if (!message) return "";
  return typeof message.content === "string" ? message.content : "";
}

const WATCHDOG: WatchdogActorConfig = {
  id: "watchdog-1",
  profile: "watchdog",
  goal: "Fix the failing unit test in the calculator module",
};

const ADVISOR: AdvisorActorConfig = {
  id: "advisor-1",
  profile: "advisor",
  topic: "decision-point",
  trigger: "review needed",
  advice: "Re-read the acceptance criteria before editing; prefer the smallest correct diff.",
};

const SPEC: SpecActorConfig = {
  id: "spec-1",
  profile: "spec",
  remindOnCompact: true,
};

const SUPERVISOR: SupervisorActorConfig = {
  id: "supervisor-1",
  profile: "supervisor",
  topic: "scope",
  trigger: "abort scope",
  directive: "STOP current scope; return to the task brief before continuing.",
};

describe("deterministic cores", () => {
  it("goalSimilarity is a pure Jaccard token similarity", () => {
    assert.equal(goalSimilarity("Fix the calculator test", "Fix the calculator test"), 1);
    assert.equal(goalSimilarity("Fix the calculator test", "FIX THE CALCULATOR TEST"), 1);
    const disjoint = goalSimilarity("Fix the calculator test", "add a dark theme to settings");
    assert.ok(disjoint < 0.2, `disjoint goal/prompt must read as drift, got ${disjoint}`);
    const overlapping = goalSimilarity("Fix the calculator test", "fix the calculator as discussed");
    assert.ok(overlapping >= 0.4, `overlapping goal/prompt must read as on-goal, got ${overlapping}`);
    assert.equal(goalSimilarity("", "anything"), 0);
  });

  it("fnv1aHex is deterministic and content-addressed", () => {
    const text = normalizeCriterionText("The calculator must pass the regression suite");
    assert.equal(fnv1aHex(text), fnv1aHex(text));
    assert.notEqual(fnv1aHex("a"), fnv1aHex("b"));
    assert.match(fnv1aHex(text), /^[0-9a-f]{8}$/);
  });

  it("extractAcceptanceCriteria is line-based on the configured markers", () => {
    const prompt = [
      "Add a subtract button.",
      "Acceptance criteria: the calculator must support subtraction.",
      "- criterion: results match the reference implementation",
      "and a trailing line without markers.",
    ].join("\n");
    const criteria = extractAcceptanceCriteria(prompt, ["acceptance", "criteria", "criterion"]);
    assert.equal(criteria.length, 2);
    assert.ok(criteria[0]?.includes("must support subtraction"));
    assert.ok(criteria[1]?.includes("reference implementation"));
  });

  it("promptCarriesDoneMarker detects the verified transition", () => {
    assert.equal(promptCarriesDoneMarker("the subtraction test is now passing", ["passing"]), true);
    assert.equal(promptCarriesDoneMarker("still working on it", ["passing"]), false);
  });

  it("triggerMatches supports substring and /^regex$/ triggers", () => {
    assert.equal(triggerMatches("review needed", "Please do a review needed here"), true);
    assert.equal(triggerMatches("review needed", "nothing to see"), false);
    assert.equal(triggerMatches("^abort scope$", "abort scope"), true);
    assert.equal(triggerMatches("^abort scope$", "please abort scope now"), false);
  });

  it("boundedContextView is a defensive, capped text projection", () => {
    const view = boundedContextView(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
        { role: "toolResult", content: "x".repeat(100) },
        "not-an-object",
        null,
      ],
      40,
    );
    assert.equal(view.length, 3);
    assert.equal(view[0]?.text, "hello");
    assert.equal(view[1]?.text, "world");
    assert.ok((view[2]?.text.length ?? 0) <= 40);
  });
});

describe("watchdog — goal-drift detector on session events", () => {
  it("flags drift on before_agent_start and returns a session-side message", () => {
    const { manager, delivered } = makeManager({
      enabled: true,
      dir: tempDir("watchdog"),
      actors: [WATCHDOG],
    });
    const contribution = manager.onBeforeAgentStart({
      prompt: "add a dark theme to the settings panel",
      systemPrompt: "system",
    });
    assert.ok(contribution, "drift must produce a contribution");
    assert.ok(contribution.message, "drift must inject a message");
    assert.equal(contribution.message?.customType, "workflow.actor");
    assert.match(contentOf(contribution.message), /goal drift/i);
    assert.match(contentOf(contribution.message), /calculator module/);
    assert.equal(contribution.systemPrompt, undefined, "watchdog never replaces the system prompt");
    assert.equal(delivered.length, 0, "before_agent_start deliveries ride the event result, not sendMessage");

    const summary = manager.getActor("watchdog-1");
    assert.equal(summary?.sessionDeliveries, 1);
    assert.ok(summary);
    const state = readJsonWithBackupRecovery<{ driftFlags: Array<{ similarity: number }> }>(
      defaultPersistenceFs(),
      manager.statePath("watchdog-1"),
    );
    assert.equal(state?.driftFlags.length, 1, "drift flag is persisted");
    assert.ok((state?.driftFlags[0]?.similarity ?? 1) < 0.2);
  });

  it("stays quiet on an on-goal prompt", () => {
    const { manager } = makeManager({
      enabled: true,
      dir: tempDir("watchdog-on-goal"),
      actors: [WATCHDOG],
    });
    const contribution = manager.onBeforeAgentStart({
      prompt: "fix the calculator unit test now",
      systemPrompt: "system",
    });
    assert.equal(contribution, undefined);
  });

  it("re-affirms the goal on session_compact via the sendMessage hook", () => {
    const { manager, delivered } = makeManager({
      enabled: true,
      dir: tempDir("watchdog-compact"),
      actors: [WATCHDOG],
    });
    manager.onSessionCompact({ reason: "threshold", fromExtension: false, willRetry: true });
    assert.equal(delivered.length, 1, "compaction reminder is delivered");
    assert.equal(delivered[0]?.triggerTurn, false, "watchdog never forces a turn");
    const message = delivered[0]?.message as { content: string };
    assert.match(message.content, /goal reminder/i);
    assert.match(message.content, /calculator module/);
  });

  it("does not deliver when delivery mode is quiet", () => {
    const { manager, delivered } = makeManager({
      enabled: true,
      dir: tempDir("watchdog-quiet"),
      actors: [{ ...WATCHDOG, delivery: { mode: "quiet" } }],
    });
    manager.onSessionCompact({ reason: "manual", fromExtension: true, willRetry: false });
    assert.equal(delivered.length, 0);
  });
});

describe("advisor — quiet decision-point reviewer", () => {
  it("injects the configured review when the trigger matches (on request)", () => {
    const { manager } = makeManager({
      enabled: true,
      dir: tempDir("advisor"),
      actors: [ADVISOR],
    });
    const contribution = manager.onBeforeAgentStart({
      prompt: "We have a review needed before merging the refactor.",
      systemPrompt: "system",
    });
    assert.ok(contribution?.message);
    assert.match(contentOf(contribution?.message), /review · decision-point/);
    assert.match(contentOf(contribution?.message), /acceptance criteria/);
  });

  it("stays quiet when the trigger is absent", () => {
    const { manager } = makeManager({
      enabled: true,
      dir: tempDir("advisor-quiet"),
      actors: [ADVISOR],
    });
    assert.equal(manager.onBeforeAgentStart({ prompt: "continue the refactor", systemPrompt: "system" }), undefined);
  });

  it("never forces a turn (delivery policy triggerTurn false)", () => {
    const { manager } = makeManager({
      enabled: true,
      dir: tempDir("advisor-policy"),
      actors: [ADVISOR],
    });
    assert.deepEqual(manager.getActor("advisor-1")?.delivery, { mode: "message", triggerTurn: false });
  });
});

describe("spec — acceptance ledger across sessions", () => {
  it("accumulates criteria across manager instances on the same dir", () => {
    const dir = tempDir("spec-ledger");
    try {
      const first = makeManager({ enabled: true, dir, actors: [SPEC] });
      first.manager.onBeforeAgentStart({
        prompt: "Acceptance criteria: the calculator must support subtraction.",
        systemPrompt: "system",
      });
      first.manager.onBeforeAgentStart({
        prompt: "criterion: negative inputs raise a clear error",
        systemPrompt: "system",
      });
      assert.equal(first.manager.getActor("spec-1")?.openCriteria, 2);

      // A NEW manager (new session) on the same dir reloads the persisted
      // ledger and keeps accumulating — the cross-session property.
      const second = makeManager({ enabled: true, dir, actors: [SPEC] });
      assert.equal(second.manager.getActor("spec-1")?.openCriteria, 2, "ledger reloads from disk");
      second.manager.onBeforeAgentStart({
        prompt: "Acceptance criteria: results must match the reference implementation.",
        systemPrompt: "system",
      });
      assert.equal(second.manager.getActor("spec-1")?.openCriteria, 3);
      assert.equal(second.manager.getActor("spec-1")?.events, 3, "each criteria event is journaled");
    } finally {
      void rmForce(dir);
    }
  });

  it("tracks the open → verified lifecycle deterministically", () => {
    const dir = tempDir("spec-verify");
    try {
      const { manager } = makeManager({ enabled: true, dir, actors: [SPEC] });
      manager.onBeforeAgentStart({
        prompt: "Acceptance criteria: subtraction must match the reference implementation.",
        systemPrompt: "system",
      });
      assert.equal(manager.getActor("spec-1")?.openCriteria, 1);
      // A done-marked prompt that MENTIONS the criterion verifies it (no
      // acceptance marker in the verification prompt → no new criterion).
      manager.onBeforeAgentStart({
        prompt: "subtraction now passes the full suite — verified.",
        systemPrompt: "system",
      });
      assert.equal(manager.getActor("spec-1")?.openCriteria, 0, "the verified marker closes the mentioned criterion");
      // Idempotent: the same criterion text never duplicates the ledger.
      manager.onBeforeAgentStart({
        prompt: "Acceptance criteria: subtraction must match the reference implementation.",
        systemPrompt: "system",
      });
      const summary = manager.getActor("spec-1");
      assert.equal(summary?.openCriteria, 0, "re-stating a verified criterion does not reopen it");
    } finally {
      void rmForce(dir);
    }
  });

  it("reminds open criteria on compaction when enabled", () => {
    const { manager, delivered } = makeManager({
      enabled: true,
      dir: tempDir("spec-remind"),
      actors: [SPEC],
    });
    manager.onBeforeAgentStart({
      prompt: "Acceptance criteria: the calculator must support subtraction.",
      systemPrompt: "system",
    });
    manager.onSessionCompact({ reason: "overflow", fromExtension: false, willRetry: true });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.triggerTurn, false);
    assert.match(
      contentOf(delivered[0]?.message as { content: string | Array<{ type: string; text?: string }> }),
      /open acceptance criteria/,
    );
  });
});

describe("side-input contract (V2 note)", () => {
  it("before_agent_start returns exactly BeforeAgentStartEventResult-shaped contributions", () => {
    const dir = tempDir("contract");
    try {
      const { manager } = makeManager({ enabled: true, dir, actors: [WATCHDOG] });
      const contribution = manager.onBeforeAgentStart({
        prompt: "add a dark theme to the settings panel",
        systemPrompt: "system",
      });
      assert.ok(contribution);
      const keys = Object.keys(contribution).sort();
      assert.deepEqual(keys, ["message"], "only session-side message/systemPrompt keys may be returned");
      const messageKeys = Object.keys(contribution.message ?? {}).sort();
      assert.deepEqual(messageKeys, ["content", "customType", "details", "display"]);
    } finally {
      void rmForce(dir);
    }
  });

  it("context events are observational: never rewrite messages, never deliver", () => {
    const { manager, delivered } = makeManager({
      enabled: true,
      dir: tempDir("contract-context"),
      actors: [{ ...WATCHDOG, subscriptions: ["context"] }],
    });
    const result = manager.onContext({
      messages: [{ role: "user", content: "add a dark theme to the settings panel" }],
    });
    assert.equal(result, undefined, "context dispatch never returns a ContextEventResult rewrite");
    assert.equal(delivered.length, 0, "context observation never delivers");
  });

  it("triggerTurn is rejected for every profile except supervisor (stop-the-world gate)", () => {
    const dir = tempDir("contract-trigger");
    try {
      assert.throws(
        () =>
          createHostActorManager({
            enabled: true,
            dir,
            actors: [{ ...WATCHDOG, delivery: { triggerTurn: true } }],
          }),
        HostActorsConfigError,
      );
      assert.throws(
        () =>
          createHostActorManager({
            enabled: true,
            dir,
            actors: [{ ...ADVISOR, delivery: { mode: "directive" } }],
          }),
        HostActorsConfigError,
      );
      // Supervisor profile is the sanctioned directive/triggerTurn path.
      const { manager } = makeManager({ enabled: true, dir, actors: [SUPERVISOR] });
      assert.deepEqual(manager.getActor("supervisor-1")?.delivery, {
        mode: "directive",
        triggerTurn: true,
      });
      const contribution = manager.onBeforeAgentStart({
        prompt: "abort scope and start the side quest",
        systemPrompt: "system",
      });
      assert.ok(contribution?.message);
      assert.match(contentOf(contribution?.message), /directive · scope/);
    } finally {
      void rmForce(dir);
    }
  });

  it("directive response mode delivers through sendMessage with triggerTurn on compaction", () => {
    const { manager, delivered } = makeManager({
      enabled: true,
      dir: tempDir("contract-directive"),
      actors: [SUPERVISOR],
    });
    manager.onSessionCompact({ reason: "manual", fromExtension: false, willRetry: false });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.triggerTurn, true, "supervisor restated directive forces a turn");
  });

  it("the module has no resume-identity surface (actors are side effects, not steps)", () => {
    const { manager } = makeManager({ enabled: true, dir: tempDir("contract-noid"), actors: [WATCHDOG] });
    // The manager exposes no callIndex/journal/run identity — only the actor
    // registry + session-side contribution surface.
    const summaries = manager.listActors();
    assert.deepEqual(Object.keys(summaries[0] ?? {}).sort(), [
      "activationBudget",
      "delivery",
      "events",
      "id",
      "openCriteria",
      "profile",
      "sessionDeliveries",
      "subscriptions",
    ]);
  });
});

describe("per-actor activation budget", () => {
  it("suppresses deliveries once the per-actor budget is exhausted", () => {
    const dir = tempDir("budget");
    try {
      const { manager } = makeManager({
        enabled: true,
        dir,
        actors: [{ ...WATCHDOG, activationBudget: 1 }],
      });
      const drift = { prompt: "add a dark theme to the settings panel", systemPrompt: "system" };
      assert.ok(manager.onBeforeAgentStart(drift), "first drift delivers");
      assert.equal(manager.onBeforeAgentStart(drift), undefined, "second drift is suppressed by the budget");
      assert.equal(manager.getActor("watchdog-1")?.sessionDeliveries, 1);
      const persisted = readJsonWithBackupRecovery<{ events: Array<{ kind: string }> }>(
        defaultPersistenceFs(),
        manager.statePath("watchdog-1"),
      );
      assert.ok(
        persisted?.events.some((entry) => entry.kind === "delivery_suppressed"),
        "the suppressed delivery is journaled",
      );
    } finally {
      void rmForce(dir);
    }
  });
});

describe("default-off (settings gate)", () => {
  it("an inert manager registers no actors and delivers nothing", () => {
    const { manager, delivered } = makeManager({
      enabled: false,
      dir: tempDir("off"),
      actors: [WATCHDOG],
    });
    assert.deepEqual(manager.listActors(), []);
    assert.equal(manager.getActor("watchdog-1"), undefined);
    assert.equal(manager.onBeforeAgentStart({ prompt: "add a dark theme", systemPrompt: "system" }), undefined);
    manager.onSessionCompact({ reason: "manual", fromExtension: false, willRetry: false });
    manager.onSessionStart({ reason: "startup" });
    manager.onContext({ messages: [{ role: "user", content: "x" }] });
    assert.equal(delivered.length, 0);
  });

  it("persisted defs load on a fresh manager without explicit configs", () => {
    const dir = tempDir("defs");
    try {
      const first = makeManager({ enabled: true, dir, actors: [WATCHDOG] });
      first.manager.flush();
      const second = makeManager({ enabled: true, dir });
      assert.deepEqual(
        second.manager.listActors().map((actor) => actor.id),
        ["watchdog-1"],
      );
    } finally {
      void rmForce(dir);
    }
  });

  it("parseHostActorConfigs drops malformed entries leniently", () => {
    const configs = parseHostActorConfigs([
      WATCHDOG,
      { id: "bad", profile: "watchdog" }, // no goal
      { id: "no-profile" },
      { id: "loud", profile: "watchdog", goal: "g", delivery: { triggerTurn: true } },
      "garbage",
    ]);
    assert.deepEqual(
      configs.map((config) => config.id),
      ["watchdog-1"],
    );
  });
});

describe("extension wiring (mock pi)", () => {
  interface HandlerRecorder {
    handlers: Record<string, Array<(...args: any[]) => unknown>>;
    sent: Array<{ message: unknown; options?: unknown }>;
  }

  function makeMockPi(): HandlerRecorder & { pi: ExtensionAPI } {
    const handlers: Record<string, Array<(...args: any[]) => unknown>> = {};
    const sent: Array<{ message: unknown; options?: unknown }> = [];
    const activeTools: string[] = [];
    const pi = {
      registerTool: () => {},
      registerCommand: () => {},
      getCommands: () => [],
      on: (event: string, handler: (...args: any[]) => unknown) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (tools: string[]) => {
        activeTools.splice(0, activeTools.length, ...tools);
      },
      sendMessage: (message: unknown, options?: unknown) => {
        sent.push({ message, options });
      },
    } as unknown as ExtensionAPI;
    return { handlers, sent, pi };
  }

  it("registers NO actor observers by default (hostActors off) and registers them when on", async () => {
    const fakeHome = tempDir("extension-actors");
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const off = makeMockPi();
        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(off.pi);
        assert.equal(off.handlers.session_start.length, 1);
        assert.equal(off.handlers.before_agent_start, undefined, "default off → no before_agent_start observer");
        assert.equal(off.handlers.context, undefined, "default off → no context observer");
        assert.equal(off.handlers.session_compact, undefined, "default off → no session_compact observer");
        off.handlers.session_shutdown?.[0]?.({ reason: "reload" });

        // Opt-in via the env override (the same gate settings.json carries).
        process.env.PI_WORKFLOW_HOST_ACTORS = "on";
        const actorsDir = join(fakeHome, ".pi", "agent", "workflows", "actors");
        mkdirSync(actorsDir, { recursive: true });
        writeFileSync(
          join(actorsDir, "actors.json"),
          JSON.stringify([
            {
              id: "watchdog-ext",
              profile: "watchdog",
              goal: "Fix the failing unit test in the calculator module",
            },
          ]),
          "utf-8",
        );
        const on = makeMockPi();
        installExtension(on.pi);
        assert.equal(on.handlers.before_agent_start.length, 1, "on → before_agent_start observer registered");
        assert.equal(on.handlers.context.length, 1, "on → context observer registered");
        assert.equal(on.handlers.session_compact.length, 1, "on → session_compact observer registered");

        // A drifting prompt yields a BeforeAgentStartEventResult-shaped return.
        const contribution = on.handlers.before_agent_start[0]?.(
          { prompt: "add a dark theme to the settings panel", systemPrompt: "system" },
          {},
        );
        const result = contribution as
          | {
              message?: { content: string | Array<{ type: string; text?: string }> } | undefined;
            }
          | undefined;
        assert.ok(result?.message, "extension returns the watchdog's drift message");
        assert.match(contentOf(result?.message), /goal drift/i);

        // session_compact delivers through pi.sendMessage with triggerTurn false.
        on.handlers.session_compact[0]?.({ reason: "threshold", fromExtension: false, willRetry: true }, {});
        assert.equal(on.sent.length, 1);
        assert.deepEqual(on.sent[0]?.options, { triggerTurn: false });
        on.handlers.session_shutdown?.[0]?.({ reason: "reload" });
      });
    } finally {
      delete process.env.PI_WORKFLOW_HOST_ACTORS;
      await rmForce(fakeHome);
    }
  });

  it("session_start dispatch feeds the spec actor's session boundary", async () => {
    const fakeHome = tempDir("extension-session-start");
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        process.env.PI_WORKFLOW_HOST_ACTORS = "on";
        const actorsDir = join(fakeHome, ".pi", "agent", "workflows", "actors");
        mkdirSync(actorsDir, { recursive: true });
        writeFileSync(
          join(actorsDir, "actors.json"),
          JSON.stringify([
            {
              id: "spec-ext",
              profile: "spec",
              acceptanceMarkers: ["acceptance"],
              remindOnCompact: true,
            },
          ]),
          "utf-8",
        );
        const mock = makeMockPi();
        const { default: installExtension } = await import("../extensions/workflow.js");
        installExtension(mock.pi);
        mock.handlers.session_start[0]?.(
          { reason: "startup" },
          {
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "session-1" },
            ui: { setWidget: () => {} },
          },
        );
        // The session boundary event must not throw for a mock/minimal event.
        mock.handlers.session_shutdown?.[0]?.({ reason: "reload" });
      });
    } finally {
      delete process.env.PI_WORKFLOW_HOST_ACTORS;
      await rmForce(fakeHome);
    }
  });
});
