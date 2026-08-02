import assert from "node:assert/strict";
import test from "node:test";
import {
  isMissingPeerError,
  lazyPeerImport,
  MissingPeerError,
  PEER_DEPENDENCIES,
  probePeerAvailability,
} from "../../../src/peer-deps.js";

// ─── MissingPeerError shape ─────────────────────────────────────────────────────

test("MissingPeerError carries the peer name and required version range", () => {
  const err = new MissingPeerError("typebox", "*");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "MissingPeerError");
  assert.equal(err.peerName, "typebox");
  assert.equal(err.requiredRange, "*");
  assert.match(err.message, /"typebox"/);
  assert.match(err.message, /required: \*/);
  assert.match(err.message, /npm i typebox@\*/);
});

test("MissingPeerError preserves the underlying cause", () => {
  const cause = new Error("ERR_MODULE_NOT_FOUND");
  const err = new MissingPeerError("typebox", "*", { cause });
  assert.equal(err.cause, cause);
});

test("isMissingPeerError narrows MissingPeerError instances only", () => {
  assert.equal(isMissingPeerError(new MissingPeerError("typebox", "*")), true);
  assert.equal(isMissingPeerError(new Error("typebox")), false);
  assert.equal(isMissingPeerError("typebox"), false);
});

test("PEER_DEPENDENCIES mirrors the package.json peer ranges", () => {
  assert.equal(PEER_DEPENDENCIES["@earendil-works/pi-coding-agent"], ">=0.80.8");
  assert.equal(PEER_DEPENDENCIES["@earendil-works/pi-tui"], ">=0.80.6");
  assert.equal(PEER_DEPENDENCIES.typebox, "*");
});

// ─── lazyPeerImport ─────────────────────────────────────────────────────────────

test("lazyPeerImport resolves a present peer", async () => {
  const typebox = await lazyPeerImport<typeof import("typebox")>("typebox");
  assert.equal(typeof typebox.Type, "object");
  assert.equal(typeof typebox.Type.String, "function");
});

test("lazyPeerImport throws MissingPeerError (with range) for an unresolvable peer", async () => {
  await assert.rejects(
    () => lazyPeerImport("definitely-not-an-installed-package-xyz"),
    (err: unknown) => {
      assert.ok(isMissingPeerError(err), "should be a MissingPeerError");
      assert.equal(err.peerName, "definitely-not-an-installed-package-xyz");
      assert.equal(err.requiredRange, "(see package.json peerDependencies)");
      assert.match(err.message, /definitely-not-an-installed-package-xyz/);
      return true;
    },
  );
});

test("lazyPeerImport failure for a known peer names its required range", async () => {
  await assert.rejects(
    () => lazyPeerImport("definitely-not-an-installed-package-xyz"),
    (err: unknown) => {
      assert.ok(isMissingPeerError(err));
      assert.match(err.message, /required: /);
      return true;
    },
  );
});

// ─── probePeerAvailability ──────────────────────────────────────────────────────

test("probePeerAvailability is true for an installed peer, false for an unknown package", () => {
  assert.equal(probePeerAvailability("typebox"), true);
  assert.equal(probePeerAvailability("definitely-not-an-installed-package-xyz"), false);
});
