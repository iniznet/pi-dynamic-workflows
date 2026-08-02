/**
 * Unit tests for the Plannotator visual review gate (Phase 2).
 */

import assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createPlannotatorBridge,
  getPlanStatus,
  type ReviewPlan,
  submitPlan,
  waitForApproval,
  waitForStatus,
} from "../src/integrations/plannotator.js";

describe("plan submission and status", () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "plannotator-"));
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("persists a pending plan to .pi/workflows/plans", async () => {
    const blueprint = { id: "bp-1", title: "Add auth" };
    const plan = await submitPlan(blueprint);
    assert.equal(plan.status, "pending");
    assert.ok(plan.id);
    assert.equal(plan.blueprint, blueprint);
    const onDisk = await getPlanStatus(plan.id);
    assert.equal(onDisk.id, plan.id);
    assert.equal(onDisk.status, "pending");
  });

  it("getPlanStatus throws for a missing plan", async () => {
    await assert.rejects(() => getPlanStatus("does-not-exist"));
  });

  it("waitForApproval returns false after a timeout with no decision", async () => {
    const plan = await submitPlan({ x: 1 });
    const approved = await waitForApproval(plan.id, 1100);
    assert.equal(approved, false);
  });

  it("waitForApproval returns true once the plan is approved", async () => {
    const plan = await submitPlan({ x: 1 });
    // Approve out-of-band before polling starts so the first check succeeds.
    const planDir = join(dir, ".pi", "workflows", "plans");
    const approved: ReviewPlan = { ...plan, status: "approved", reviewedAt: new Date().toISOString() };
    await writeFile(join(planDir, `${plan.id}.json`), JSON.stringify(approved, null, 2), "utf-8");
    assert.equal(await waitForApproval(plan.id, 5000), true);
  });

  it("waitForApproval returns false for a rejected plan", async () => {
    const plan = await submitPlan({ x: 1 });
    const planDir = join(dir, ".pi", "workflows", "plans");
    const rejected: ReviewPlan = {
      ...plan,
      status: "rejected",
      feedback: "needs more detail",
      reviewedAt: new Date().toISOString(),
    };
    await writeFile(join(planDir, `${plan.id}.json`), JSON.stringify(rejected, null, 2), "utf-8");
    assert.equal(await waitForApproval(plan.id, 5000), false);
  });

  it("approval round-trip matches the file on disk", async () => {
    const plan = await submitPlan({ task: "migrate db" });
    const planDir = join(dir, ".pi", "workflows", "plans");
    const raw = await readFile(join(planDir, `${plan.id}.json`), "utf-8");
    assert.deepEqual(JSON.parse(raw), plan);
  });
});

describe("waitForApproval abort", () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "plannotator-abort-"));
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("aborts on signal", async () => {
    const plan = await submitPlan({ x: 1 });
    const controller = new AbortController();
    const waiting = waitForApproval(plan.id, 5000, controller.signal);
    controller.abort();
    await assert.rejects(waiting, /aborted/i);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const plan = await submitPlan({ x: 1 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => waitForApproval(plan.id, 5000, controller.signal), /aborted/i);
  });

  it("still respects the timeout when no abort fires", async () => {
    const plan = await submitPlan({ x: 1 });
    const controller = new AbortController();
    const approved = await waitForApproval(plan.id, 500, controller.signal);
    assert.equal(approved, false);
    assert.equal(controller.signal.aborted, false);
  });
});

/** Reserves an OS-assigned port, frees it, and returns it for a deterministic bind. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("unable to allocate a port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Runs a callback with process.cwd() pointed at a throwaway directory. */
async function inTempDir(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "plannotator-bridge-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function fetchSse(port: number): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${port}/sse`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("bridge server did not become reachable");
}

describe("createPlannotatorBridge", () => {
  it("submits and reports status through the bridge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plannotator-bridge-"));
    const originalCwd = process.cwd();
    process.chdir(dir);
    let bridge: ReturnType<typeof createPlannotatorBridge> | undefined;
    try {
      bridge = createPlannotatorBridge({ port: 0, autoOpenBrowser: false });
      const blueprint = { title: "bridge plan" };
      const plan = await bridge.submitPlan(blueprint);
      assert.equal(plan.status, "pending");
      const status = await bridge.getPlanStatus(plan.id);
      assert.deepEqual(status.blueprint, blueprint);
    } finally {
      bridge?.close();
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not crash when the port is already bound", async () => {
    await inTempDir(async () => {
      const port = await freePort();
      const first = createPlannotatorBridge({ port, autoOpenBrowser: false });
      const second = createPlannotatorBridge({ port, autoOpenBrowser: false });
      try {
        const plan = await first.submitPlan({ x: 1 });
        // In-flight wait must reject when the second bind fails (no unhandled 'error' crash).
        await assert.rejects(() => second.waitForApproval(plan.id, 5000), /EADDRINUSE/);
        // Subsequent calls reject immediately with the recorded bind error.
        await assert.rejects(() => second.waitForApproval(plan.id, 5000), /EADDRINUSE/);
      } finally {
        second.close();
        first.close();
      }
    });
  });

  it("surfaces an update via onStatusChange when a plan is approved", async () => {
    await inTempDir(async () => {
      const port = await freePort();
      const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false });
      try {
        const plan = await bridge.submitPlan({ task: "hook me" });
        const updates: ReviewPlan[] = [];
        const unsubscribe = bridge.onStatusChange?.((observed) => updates.push(observed));
        const waiting = bridge.waitForApproval(plan.id, 5000);
        const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
        const approved: ReviewPlan = { ...plan, status: "approved", reviewedAt: new Date().toISOString() };
        await writeFile(join(plansDir, `${plan.id}.json`), JSON.stringify(approved, null, 2), "utf-8");
        assert.equal(await waiting, true);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].status, "approved");
        unsubscribe?.();
      } finally {
        bridge.close();
      }
    });
  });

  it("streams an update over SSE when a plan is approved", async () => {
    await inTempDir(async () => {
      const port = await freePort();
      const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false });
      try {
        const plan = await bridge.submitPlan({ task: "approve me" });
        const response = await fetchSse(port);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "text/event-stream");
        const reader = response.body?.getReader();
        assert.ok(reader, "expected a readable SSE body");

        const waiting = bridge.waitForApproval(plan.id, 5000);
        const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
        const approved: ReviewPlan = { ...plan, status: "approved", reviewedAt: new Date().toISOString() };
        await writeFile(join(plansDir, `${plan.id}.json`), JSON.stringify(approved, null, 2), "utf-8");
        assert.equal(await waiting, true);

        const decoder = new TextDecoder();
        let body = "";
        while (!body.includes('"status":"approved"')) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        await reader.cancel();
        assert.ok(body.includes('"status":"approved"'), `expected approved SSE payload, got: ${body}`);
      } finally {
        bridge.close();
      }
    });
  });
});

// ─── Settle guard (infra-utils:f1): a tick that resumes after the promise
// settled must return instead of re-arming the 250ms poll ──────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fetch a URL with retries until the bridge server accepts connections. */
async function fetchRetry(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url);
    } catch {
      await sleep(20);
    }
  }
  throw new Error("bridge server did not become reachable");
}

/** Read SSE chunks until `predicate` matches the accumulated body or the deadline passes. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (body: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let body = "";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return body;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("read deadline")), remaining);
        timer.unref();
      }),
    ]);
    if (result.done) return body;
    body += decoder.decode(result.value, { stream: true });
    if (predicate(body)) return body;
  }
}

/** True when the stream closed (done or error) within the window; false on timeout. */
async function readUntilClosed(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("read deadline")), remaining);
          timer.unref();
        }),
      ]);
      if (result.done) return true;
    } catch {
      return true; // a connection error also means the stream is gone
    }
  }
}

describe("waitForStatus settle guard", () => {
  it("stops polling after the promise settles — no re-armed tick reads the plan again", async () => {
    await inTempDir(async () => {
      let reads = 0;
      let trigger: ((error: Error) => void) | undefined;
      const waiting = waitForStatus(process.cwd(), "plan-1", {
        timeoutMs: 10_000,
        readPlanFile: async () => {
          reads++;
          return null; // never settles via plan status
        },
        registerFailure: (reject) => {
          trigger = reject;
          return () => {};
        },
      });
      await sleep(600); // ≥ 2 poll intervals (250ms) — polling is live before settle
      assert.ok(reads >= 1, `expected the poll to be running, saw ${reads} reads`);
      trigger?.(new Error("server error"));
      await assert.rejects(waiting, /server error/);
      const readsAtSettle = reads;
      await sleep(600); // a buggy re-arm would read again within this window
      assert.equal(reads, readsAtSettle, "no further plan reads after settle — the poll must not re-arm");
    });
  });
});

describe("SSE lifecycle", () => {
  it("close() ends every open SSE stream so keep-alive sockets are released", async () => {
    await inTempDir(async () => {
      const port = await freePort();
      const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false });
      try {
        const response = await fetchRetry(`http://127.0.0.1:${port}/sse`);
        const reader = response.body?.getReader();
        assert.ok(reader, "expected an SSE body reader");
        bridge.close();
        const closed = await readUntilClosed(reader);
        assert.equal(closed, true, "the SSE stream must be ended by close()");
      } finally {
        bridge.close();
      }
    });
  });

  it("heartbeats idle SSE connections with comments to keep middleboxes alive", async () => {
    await inTempDir(async () => {
      const port = await freePort();
      const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false, sseHeartbeatMs: 20 });
      try {
        const response = await fetchRetry(`http://127.0.0.1:${port}/sse`);
        const reader = response.body?.getReader();
        assert.ok(reader);
        const body = await readUntil(reader, (b) => b.includes(": ping"), 2000);
        assert.ok(body.includes(": ping"), `expected a heartbeat comment; got: ${JSON.stringify(body)}`);
      } finally {
        bridge.close();
      }
    });
  });

  it("pushes a reviewed event to /reviewed clients when a review settles", async () => {
    await inTempDir(async () => {
      const port = await freePort();
      const bridge = createPlannotatorBridge({ port, autoOpenBrowser: false });
      try {
        const plan = await bridge.submitPlan({ task: "event-driven review" });
        const response = await fetchRetry(`http://127.0.0.1:${port}/reviewed`);
        assert.equal(response.status, 200);
        const reader = response.body?.getReader();
        assert.ok(reader);
        const waiting = bridge.waitForApproval(plan.id, 5000);
        const plansDir = join(process.cwd(), ".pi", "workflows", "plans");
        const approved: ReviewPlan = { ...plan, status: "approved", reviewedAt: new Date().toISOString() };
        await writeFile(join(plansDir, `${plan.id}.json`), JSON.stringify(approved, null, 2), "utf-8");
        assert.equal(await waiting, true);
        const body = await readUntil(reader, (b) => b.includes("event: reviewed"), 2000);
        assert.ok(body.includes("event: reviewed"), `expected a reviewed SSE event; got: ${JSON.stringify(body)}`);
        assert.ok(body.includes('"status":"approved"'), "the event payload carries the settled status");
      } finally {
        bridge.close();
      }
    });
  });
});
