/**
 * Command watchdog unit tests (idle-detector design-final.json §commandWatchdog
 * unitTests). The wrapper is tested against a FAKE inner BashOperations that
 * mimics the SDK local backend's documented contract: on signal abort it kills
 * its (fake) child and rejects with Error("aborted"); on timeout it rejects
 * with Error("timeout:<secs>"); otherwise it streams onData chunks and resolves
 * with { exitCode }.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type BashOperations, createLocalBashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyCommandWatchdogToTools,
  buildWatchdogKillMarker,
  CommandActivityRegistry,
  createWatchdogBashOperations,
  DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS,
  getCommandWatchdogRegistry,
} from "../src/command-watchdog.js";
import { resolveCommandWatchdogOptions } from "../src/config.js";
import { rmForce } from "./helpers/rm-force.js";

/** Whether a pid is still alive (0-signal probe; true when the probe throws ESRCH). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface FakeChild {
  pid: number;
  alive: boolean;
  onData: ((data: Buffer) => void) | undefined;
  stream: (data: Buffer) => void;
  resolve: (value: { exitCode: number | null }) => void;
}

/**
 * Fake inner ops: streams onData, honors the abort signal (kills the fake
 * child + rejects Error("aborted")), honors a timeout (rejects
 * Error("timeout:<secs>")), and resolves { exitCode } on demand via
 * child.resolve().
 */
function createFakeInner(): {
  ops: BashOperations;
  children: FakeChild[];
  spawned: Array<{ command: string; cwd: string; timeout?: number }>;
} {
  const children: FakeChild[] = [];
  const spawned: Array<{ command: string; cwd: string; timeout?: number }> = [];
  let pidCounter = 1000;
  const ops: BashOperations = {
    exec(command, cwd, { onData, signal, timeout }) {
      let resolveFn: ((value: { exitCode: number | null }) => void) | undefined;
      const child: FakeChild = {
        pid: ++pidCounter,
        alive: true,
        onData: undefined,
        stream: (data) => {
          if (child.alive) onData(data);
        },
        resolve: (value) => resolveFn?.(value),
      };
      children.push(child);
      spawned.push({ command, cwd, timeout });
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      return new Promise((resolve, reject) => {
        resolveFn = (value) => {
          child.alive = false;
          resolve(value);
        };
        child.onData = (data) => onData(data);
        if (timeout !== undefined) {
          setTimeout(() => {
            if (child.alive) {
              child.alive = false;
              reject(new Error(`timeout:${timeout}`));
            }
          }, timeout * 1000);
        }
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              child.alive = false;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }
      });
    },
  };
  return {
    ops,
    children,
    spawned,
  };
}

function collectOnData(): { onData: (data: Buffer) => void; text: () => string } {
  const parts: Buffer[] = [];
  return {
    onData: (data) => parts.push(data),
    text: () => Buffer.concat(parts).toString("utf8"),
  };
}

describe("createWatchdogBashOperations", () => {
  test("idle kill: aborts via its own controller, returns {exitCode:null}, appends marker, fires onCommandKill", async () => {
    const { ops } = createFakeInner();
    const { onData, text } = collectOnData();
    const kills: string[] = [];
    const wrapped = createWatchdogBashOperations(ops, {
      idleTimeoutMs: 60,
      hardTimeoutMs: 0,
      maxConsecutiveIdleKills: 3,
      onCommandKill: (info) => kills.push(`${info.reason}:${info.consecutiveKills}`),
    });
    const result = await wrapped.exec("sleep 1000", "/tmp", { onData, signal: undefined, timeout: undefined, env: {} });
    assert.deepEqual(result, { exitCode: null }, "killed shape: exitCode null");
    assert.match(text(), /\[killed: idle 0\.06s — no output within the watchdog budget; process tree aborted\]/);
    assert.deepEqual(kills, ["idle:1"], "onCommandKill fires with reason idle and count 1");
  });

  test("partial output preserved: chunks then idle-kill accumulate to chunks + marker", async () => {
    const { ops, children } = createFakeInner();
    const { onData, text } = collectOnData();
    const wrapped = createWatchdogBashOperations(ops, { idleTimeoutMs: 40, hardTimeoutMs: 0 });
    const pending = wrapped.exec("yarn install", "/tmp", { onData, signal: undefined, timeout: undefined, env: {} });
    const child = children[0];
    child.stream(Buffer.from("first line\n"));
    child.stream(Buffer.from("second line\n"));
    const result = await pending;
    assert.deepEqual(result, { exitCode: null });
    assert.ok(text().startsWith("first line\nsecond line\n"), "partial output preserved before the marker");
    assert.match(text(), /\[killed: idle 0\.04s — no output/);
  });

  test("no kill while output flows: chunks inside the threshold keep the exec alive; it resolves with the real exitCode", async () => {
    const { ops, children } = createFakeInner();
    const { onData } = collectOnData();
    const wrapped = createWatchdogBashOperations(ops, { idleTimeoutMs: 200, hardTimeoutMs: 0 });
    const pending = wrapped.exec("stream", "/tmp", { onData, signal: undefined, timeout: undefined, env: {} });
    const child = children[0];
    // Stream every 60ms (inside the 200ms window) 5× — the idle timer keeps
    // resetting, so the exec must NOT be killed; then resolve it normally.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 60));
      child.stream(Buffer.from(`chunk ${i}\n`));
    }
    await new Promise((r) => setTimeout(r, 50));
    child.resolve({ exitCode: 0 });
    const result = await pending;
    assert.equal(result.exitCode, 0, "no idle kill while output flows inside the window");
  });

  test("no kill while output flows (real backend): a command streaming within the window resolves normally", async () => {
    const { onData } = collectOnData();
    const wrapped = createWatchdogBashOperations(createLocalBashOperations(), {
      idleTimeoutMs: 2000,
      hardTimeoutMs: 0,
    });
    const result = await wrapped.exec('node -e "console.log(1);console.log(2);console.log(3)"', process.cwd(), {
      onData,
      signal: undefined,
      timeout: undefined,
      env: {},
    });
    assert.equal(result.exitCode, 0, "a command that keeps producing output is never idle-killed");
  });

  test("hard timeout forwarding: model timeout passes through unchanged; run-level default applies only when model passes none", async () => {
    const spawned: Array<{ command: string; timeout?: number }> = [];
    // Spy inner: records the forwarded timeout and resolves immediately.
    const spy: BashOperations = {
      async exec(command, _cwd, { timeout }) {
        spawned.push({ command, timeout });
        return { exitCode: 0 };
      },
    };
    const wrapped = createWatchdogBashOperations(spy, { idleTimeoutMs: 0, hardTimeoutMs: 120_000 });
    // Model timeout (seconds) wins over the run-level default.
    await wrapped.exec("cmd", "/tmp", { onData: () => {}, signal: undefined, timeout: 30, env: {} });
    assert.equal(spawned[0]?.timeout, 30, "model timeout (seconds) forwarded unchanged");
    // No model timeout → run-level hard timeout ms converted to seconds.
    await wrapped.exec("cmd2", "/tmp", { onData: () => {}, signal: undefined, timeout: undefined, env: {} });
    assert.equal(spawned[1]?.timeout, 120, "run-level hard timeout forwarded as seconds (120000ms → 120s)");
  });

  test("model timeout beats idle timer → timeout error rethrown unchanged (SDK renders 'Command timed out')", async () => {
    const { ops } = createFakeInner();
    const { onData } = collectOnData();
    // idleTimeoutMs huge so the model's tiny timeout (0.05s) wins the race.
    const wrapped = createWatchdogBashOperations(ops, { idleTimeoutMs: 60_000, hardTimeoutMs: 0 });
    const pending = wrapped.exec("cmd", "/tmp", { onData, signal: undefined, timeout: 0.05, env: {} });
    const error = await pending.then(
      () => null,
      (e) => e as Error,
    );
    assert.equal(
      error?.message,
      "timeout:0.05",
      "timeout rejection rethrown verbatim (never converted to an idle kill)",
    );
  });

  test("session abort during idle wait → 'Command aborted' (tool signal rethrown)", async () => {
    const { ops } = createFakeInner();
    const { onData } = collectOnData();
    const controller = new AbortController();
    const wrapped = createWatchdogBashOperations(ops, { idleTimeoutMs: 60_000, hardTimeoutMs: 0 });
    const pending = wrapped.exec("cmd", "/tmp", { onData, signal: controller.signal, timeout: undefined, env: {} });
    controller.abort();
    const error = await pending.then(
      () => null,
      (e) => e as Error,
    );
    assert.equal(error?.message, "aborted", "session abort → 'aborted' rethrown → SDK renders 'Command aborted'");
  });

  test("non-own errors (missing cwd, spawn failure) rethrown unchanged", async () => {
    const inner: BashOperations = {
      async exec() {
        throw new Error("Working directory does not exist: /nope\nCannot execute bash commands.");
      },
    };
    const wrapped = createWatchdogBashOperations(inner, { idleTimeoutMs: 1000, hardTimeoutMs: 0 });
    const error = await wrapped
      .exec("ls", "/nope", { onData: () => {}, signal: undefined, timeout: undefined, env: {} })
      .then(
        () => null,
        (e) => e as Error,
      );
    assert.equal(
      error?.message,
      "Working directory does not exist: /nope\nCannot execute bash commands.",
      "non-own error rethrown verbatim",
    );
  });

  test("marker names consecutive-kill count + knobs after kill #1; isStalling flips at max; reason idle-escalated", async () => {
    const registry = new CommandActivityRegistry();
    const { ops } = createFakeInner();
    const reasons: string[] = [];
    const wrapped = createWatchdogBashOperations(ops, {
      idleTimeoutMs: 40,
      hardTimeoutMs: 0,
      maxConsecutiveIdleKills: 2,
      registry,
      label: "call-1",
      onCommandKill: (info) => reasons.push(info.reason),
    });
    // First idle kill → count 1.
    await wrapped.exec("blind-loop", "/tmp", { onData: () => {}, signal: undefined, timeout: undefined, env: {} });
    assert.deepEqual(reasons, ["idle"]);
    assert.equal(registry.getEntry("call-1")?.consecutiveIdleKills, 1);
    // Second idle kill of the same label → count 2 → isStalling + escalation.
    await wrapped.exec("blind-loop", "/tmp", { onData: () => {}, signal: undefined, timeout: undefined, env: {} });
    assert.deepEqual(reasons, ["idle", "idle-escalated"]);
    assert.equal(registry.isStalling("call-1", 2), true, "isStalling at the max consecutive-kill count");
    assert.equal(registry.isStalling("call-1", 3), false, "not stalling below the max");
  });

  test("buildWatchdogKillMarker: first kill base marker; later kills append count + knobs", () => {
    assert.equal(
      buildWatchdogKillMarker(120_000, 0, 1),
      "[killed: idle 120s — no output within the watchdog budget; process tree aborted]",
    );
    assert.equal(
      buildWatchdogKillMarker(120_000, 0, 2),
      "[killed: idle 120s — no output within the watchdog budget; process tree aborted (kill #2 this attempt; knobs: commandIdleTimeoutMs=120000, commandHardTimeoutMs=0)]",
    );
  });

  test("Windows tree kill: an idle-killed command takes its detached grandchild down too (taskkill /F /T)", {
    skip:
      process.platform === "win32"
        ? false
        : "win32-only: exercises the SDK's killProcessTree taskkill /F /T tree semantics",
  }, async () => {
    // Parent script: spawns a DETACHED node grandchild (stdio ignored so no
    // output can reset the idle timer), records its pid to a file, then sits
    // silent forever. The watchdog idle-kills the parent; taskkill /F /T must
    // take the whole tree down with it.
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-treekill-"));
    const pidFile = join(dir, "grandchild.pid");
    const parentScript = join(dir, "parent.cjs");
    writeFileSync(
      parentScript,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "setInterval(()=>{},1000);",
      ].join("\n"),
      "utf8",
    );
    try {
      const { onData } = collectOnData();
      const wrapped = createWatchdogBashOperations(createLocalBashOperations(), {
        idleTimeoutMs: 300,
        hardTimeoutMs: 0,
      });
      const result = await wrapped.exec(`node ${JSON.stringify(parentScript)}`, dir, {
        onData,
        signal: undefined,
        timeout: undefined,
        env: {},
      });
      assert.deepEqual(result, { exitCode: null }, "the silent parent was idle-killed (killed shape)");
      const grandchildPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "the grandchild was spawned");
      // Give the OS a moment to reap the tree before probing liveness.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(
        isProcessAlive(grandchildPid),
        false,
        "the detached grandchild was tree-killed with its idle-killed parent",
      );
    } finally {
      await rmForce(dir);
    }
  });
});

describe("applyCommandWatchdogToTools", () => {
  const bashDef: ToolDefinition = {
    name: "bash",
    label: "bash",
    description: "Execute bash",
    parameters: Type.Object({ command: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
  const otherDef: ToolDefinition = {
    name: "read",
    label: "read",
    description: "Read a file",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };

  test("disabled passthrough: all knobs 0 → defs returned unchanged (byte-identical)", () => {
    const tools = [bashDef, otherDef];
    const result = applyCommandWatchdogToTools(tools, "/tmp", { idleTimeoutMs: 0, hardTimeoutMs: 0 });
    assert.equal(result[0], bashDef, "bash def reference unchanged when disabled");
    assert.equal(result[1], otherDef, "non-bash def reference unchanged");
  });

  test("active: bash def's execute rebound, non-bash defs untouched, schema/description preserved", () => {
    const result = applyCommandWatchdogToTools([bashDef, otherDef], "/tmp", { idleTimeoutMs: 1000, hardTimeoutMs: 0 });
    const wrappedBash = result[0];
    assert.equal(wrappedBash.name, "bash");
    assert.equal(wrappedBash.description, "Execute bash", "SDK description preserved via spread");
    assert.notEqual(wrappedBash.execute, bashDef.execute, "execute rebound to the watchdog-wrapped backend");
    assert.equal(result[1], otherDef, "non-bash def untouched");
  });

  test("resolveCommandWatchdogOptions: all-zero knobs → undefined (disabled)", () => {
    assert.equal(resolveCommandWatchdogOptions({ commandIdleTimeoutMs: 0, commandHardTimeoutMs: null }), undefined);
    assert.equal(resolveCommandWatchdogOptions({ commandIdleTimeoutMs: null, commandHardTimeoutMs: 0 }), undefined);
  });

  test("resolveCommandWatchdogOptions: clamps hard timeout to the SDK ceiling and floors floats", () => {
    const resolved = resolveCommandWatchdogOptions({
      commandIdleTimeoutMs: 1500.9,
      commandHardTimeoutMs: 999_999_999_999,
    });
    assert.equal(resolved?.idleTimeoutMs, 1500, "floored");
    assert.equal(resolved?.hardTimeoutMs, 2_147_483_000, "clamped to SDK MAX_TIMEOUT_SECONDS × 1000");
  });
});

describe("CommandActivityRegistry", () => {
  test("records start/data/kill and exposes the stalling bound", () => {
    const registry = new CommandActivityRegistry();
    registry.recordStart("a", "cmd", "/tmp");
    registry.recordData("a");
    assert.equal(registry.recordIdleKill("a"), 1);
    assert.equal(registry.recordIdleKill("a"), 2);
    assert.equal(registry.isStalling("a", 2), true);
    assert.equal(registry.isStalling("a", 3), false);
    assert.equal(registry.getEntry("missing"), undefined);
    registry.resetAttempt("a");
    assert.equal(registry.isStalling("a", 2), false, "resetAttempt clears the consecutive chain");
  });

  test("recordSuccess breaks a consecutive chain", () => {
    const registry = new CommandActivityRegistry();
    registry.recordStart("a", "cmd", "/tmp");
    registry.recordIdleKill("a");
    registry.recordIdleKill("a");
    registry.recordSuccess("a");
    assert.equal(registry.isStalling("a", 2), false);
  });

  test("getCommandWatchdogRegistry returns a shared default instance", () => {
    assert.equal(getCommandWatchdogRegistry(), getCommandWatchdogRegistry());
    assert.equal(DEFAULT_MAX_CONSECUTIVE_IDLE_KILLS, 3);
  });
});
