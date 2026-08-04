/**
 * Unit tests for the vendored default-browser launcher (G3 wire).
 *
 * Every test injects a spawn stub, so nothing ever launches a real browser:
 * command shapes, remote-session and sentinel short-circuits, abort and
 * timeout handling are all exercised hermetically.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { openReviewInBrowser } from "../src/integrations/plannotator-ui/browser-open.js";

const URL = "http://127.0.0.1:9/review";

/** Minimal ChildProcess-shaped fake: records once-handlers, unref/kill no-ops. */
function fakeChild(): {
  child: ReturnType<typeof makeFakeChild>;
  emit: (event: "spawn" | "error") => void;
  killed: () => boolean;
} {
  const state: { killed: boolean; handlers: Map<string, () => void> } = { killed: false, handlers: new Map() };
  const child = makeFakeChild(state);
  return {
    child,
    emit: (event) => state.handlers.get(event)?.(),
    killed: () => state.killed,
  };
}

function makeFakeChild(state: { killed: boolean; handlers: Map<string, () => void> }) {
  const child = {
    unref() {},
    kill() {
      state.killed = true;
    },
    once(event: string, callback: () => void) {
      state.handlers.set(event, callback);
    },
  } as unknown as ChildProcess;
  return child;
}

/** Stub spawn that records (command, args) and emits "spawn" on a microtask. */
function spawnRecorder(records: Array<{ command: string; args: string[] }>) {
  return ((command: string, args: string[]) => {
    const fake = fakeChild();
    records.push({ command, args: args as string[] });
    queueMicrotask(() => fake.emit("spawn"));
    return fake.child;
  }) as unknown as typeof import("node:child_process").spawn;
}

test("win32 spawns cmd.exe /c start with the empty title arg", async () => {
  const records: Array<{ command: string; args: string[] }> = [];
  const result = await openReviewInBrowser(URL, { platform: "win32", spawn: spawnRecorder(records), env: {} });
  assert.deepEqual(result, { opened: true });
  assert.equal(records[0]?.command, "cmd.exe");
  assert.deepEqual(records[0]?.args, ["/c", "start", "", URL]);
});

test("darwin spawns open with the url", async () => {
  const records: Array<{ command: string; args: string[] }> = [];
  const result = await openReviewInBrowser(URL, { platform: "darwin", spawn: spawnRecorder(records), env: {} });
  assert.deepEqual(result, { opened: true });
  assert.equal(records[0]?.command, "open");
  assert.deepEqual(records[0]?.args, [URL]);
});

test("linux spawns xdg-open by default", async () => {
  const records: Array<{ command: string; args: string[] }> = [];
  const result = await openReviewInBrowser(URL, { platform: "linux", spawn: spawnRecorder(records), env: {} });
  assert.deepEqual(result, { opened: true });
  assert.equal(records[0]?.command, "xdg-open");
  assert.deepEqual(records[0]?.args, [URL]);
});

test("a custom BROWSER on linux becomes the launcher command", async () => {
  const records: Array<{ command: string; args: string[] }> = [];
  const result = await openReviewInBrowser(URL, {
    platform: "linux",
    spawn: spawnRecorder(records),
    env: { BROWSER: "firefox" },
  });
  assert.deepEqual(result, { opened: true });
  assert.equal(records[0]?.command, "firefox");
  assert.deepEqual(records[0]?.args, [URL]);
});

test("a BROWSER sentinel ('false') means explicitly no launch", async () => {
  let spawned = false;
  const spawn = (() => {
    spawned = true;
    return fakeChild().child;
  }) as unknown as typeof import("node:child_process").spawn;
  const result = await openReviewInBrowser(URL, { platform: "linux", spawn, env: { BROWSER: "false" } });
  assert.deepEqual(result, { opened: false, reason: "noop" });
  assert.equal(spawned, false);
});

test("a remote session (SSH_CONNECTION) never spawns a browser", async () => {
  let spawned = false;
  const spawn = (() => {
    spawned = true;
    return fakeChild().child;
  }) as unknown as typeof import("node:child_process").spawn;
  const result = await openReviewInBrowser(URL, { platform: "linux", spawn, env: { SSH_CONNECTION: "peer" } });
  assert.deepEqual(result, { opened: false, reason: "remote" });
  assert.equal(spawned, false);
});

test("PLANNOTATOR_REMOTE=0 overrides the remote heuristic and spawns", async () => {
  const records: Array<{ command: string; args: string[] }> = [];
  const result = await openReviewInBrowser(URL, {
    platform: "linux",
    spawn: spawnRecorder(records),
    env: { SSH_CONNECTION: "peer", PLANNOTATOR_REMOTE: "0" },
  });
  assert.deepEqual(result, { opened: true });
  assert.equal(records[0]?.command, "xdg-open");
});

test("an abort kills the pending launcher and settles { opened: false, reason: 'abort' }", async () => {
  const fake = fakeChild();
  const spawn = (() => fake.child) as unknown as typeof import("node:child_process").spawn;
  const controller = new AbortController();
  const promise = openReviewInBrowser(URL, {
    platform: "linux",
    spawn,
    env: {},
    signal: controller.signal,
  });
  controller.abort();
  const result = await promise;
  assert.deepEqual(result, { opened: false, reason: "abort" });
  assert.equal(fake.killed(), true, "the aborted launcher is reaped");
});

test("a launcher that never spawns times out and is reaped", async () => {
  const fake = fakeChild(); // never emits "spawn"
  const spawn = (() => fake.child) as unknown as typeof import("node:child_process").spawn;
  const result = await openReviewInBrowser(URL, { platform: "linux", spawn, env: {}, timeoutMs: 50 });
  assert.deepEqual(result, { opened: false, reason: "timeout" });
  assert.equal(fake.killed(), true, "the timed-out launcher is reaped");
});

test("a spawn error settles { opened: false, reason: 'spawn-error' }", async () => {
  const fake = fakeChild();
  const spawn = (() => {
    queueMicrotask(() => fake.emit("error"));
    return fake.child;
  }) as unknown as typeof import("node:child_process").spawn;
  const result = await openReviewInBrowser(URL, { platform: "linux", spawn, env: {} });
  assert.deepEqual(result, { opened: false, reason: "spawn-error" });
  assert.equal(fake.killed(), true);
});
