/**
 * Import-survival (H4): the headless-safe surface must keep working when the
 * pi-tui peer is absent/incompatible, and peer-dependent pieces must degrade
 * with MissingPeerError diagnostics instead of cryptic load failures.
 *
 * Approach note: the test runs in its own process (node --test isolates test
 * files) and registers an ESM resolve hook that blocks `@earendil-works/pi-tui`
 * before any package import, simulating a host without that peer. pi-coding-agent
 * itself imports pi-tui at module scope, so the barrel (and every module that
 * imports pi-coding-agent) can never load in a pi-tui-less host — that is pi's
 * own dependency surface, not ours. What slice B guarantees is: (a) the lazy-peer
 * diagnostics, (b) the TUI facade degrading to undefined, (c) the genuinely
 * pi-tui-free headless pieces (scheduler, persistence, errors, config) loading.
 * The full barrel surface with peers present is asserted in
 * workflow-tool-lazy.test.ts.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-tui") {
      throw new Error(`Cannot find package '@earendil-works/pi-tui'`);
    }
    return nextResolve(specifier, context);
  },
});

import assert from "node:assert/strict";
import test from "node:test";

const TUI_SURFACE_NAMES = [
  "deliverText",
  "installResultDelivery",
  "installTaskPanel",
  "keyToAction",
  "NavigatorModel",
  "NavigatorState",
  "openWorkflowNavigator",
  "renderNavigator",
  "registerWorkflowCommands",
  "registerWorkflowModelsCommand",
] as const;

test("lazy-peer diagnostics name the missing peer and its required range", async () => {
  const { isMissingPeerError, lazyPeerImport, MissingPeerError, PEER_DEPENDENCIES, probePeerAvailability } =
    await import("../../../src/peer-deps.js");

  assert.equal(typeof MissingPeerError, "function");
  assert.equal(probePeerAvailability("@earendil-works/pi-tui"), false, "pi-tui must probe absent");
  assert.equal(probePeerAvailability("typebox"), true, "typebox is not blocked");

  await assert.rejects(
    () => lazyPeerImport("@earendil-works/pi-tui"),
    (err: unknown) => {
      assert.ok(isMissingPeerError(err), "expected MissingPeerError");
      assert.equal(err.peerName, "@earendil-works/pi-tui");
      assert.equal(err.requiredRange, PEER_DEPENDENCIES["@earendil-works/pi-tui"]);
      assert.match(err.message, />=0\.80\.6/);
      return true;
    },
  );
});

test("the TUI facade degrades to undefined when pi-tui is absent", async () => {
  const facade = await import("../../../src/peer-facades.js");
  for (const name of TUI_SURFACE_NAMES) {
    assert.equal(facade[name], undefined, `${name} should degrade to undefined when pi-tui cannot load (H4 facade)`);
  }
});

test("pi-tui-free headless pieces load even when pi-tui is absent", async () => {
  const scheduler = await import("../../../src/usage-limit-scheduler.js");
  assert.equal(typeof scheduler.UsageLimitScheduler, "function");
  assert.equal(typeof scheduler.computeAutoResumeDelayMs, "function");

  const persistence = await import("../../../src/run-persistence.js");
  assert.equal(typeof persistence.createRunPersistence, "function");
  assert.equal(typeof persistence.generateRunId, "function");

  const errors = await import("../../../src/errors.js");
  assert.equal(typeof errors.WorkflowError, "function");
  assert.equal(typeof errors.wrapError, "function");
});
