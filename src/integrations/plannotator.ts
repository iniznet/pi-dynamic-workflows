/**
 * Plannotator Visual Review Gate (Phase 2).
 * Provides browser-based plan review with SSE for real-time updates.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type SafeTimer, safeSetInterval, safeSetTimeout } from "../timing.js";

export interface ReviewPlan {
  id: string;
  title: string;
  blueprint: unknown;
  status: "pending" | "approved" | "rejected";
  feedback?: string;
  submittedAt: string;
  reviewedAt?: string;
}

export interface PlannotatorConfig {
  port: number;
  autoOpenBrowser: boolean;
  approvalTimeout: number;
  /** SSE heartbeat cadence; comments keep middleboxes from timing out idle streams. */
  sseHeartbeatMs?: number;
}

export interface PlannotatorBridge {
  submitPlan(blueprint: unknown): Promise<ReviewPlan>;
  waitForApproval(planId: string, timeout?: number, signal?: AbortSignal): Promise<boolean>;
  getPlanStatus(planId: string): Promise<ReviewPlan>;
  /** Subscribe to status transitions (fires for every non-pending observation). Returns an unsubscribe function. */
  onStatusChange?(callback: (plan: ReviewPlan) => void): () => void;
  close(): void;
}

const DEFAULT_CONFIG: PlannotatorConfig = {
  port: 3123,
  autoOpenBrowser: true,
  approvalTimeout: 300000,
};

/** Re-read cadence for waitForApproval; responsive for a human gate, bounded, and abortable. */
const POLL_INTERVAL_MS = 250;
/** Default SSE heartbeat cadence: comfortably under typical proxy idle timeouts (60s+). */
const DEFAULT_SSE_HEARTBEAT_MS = 15000;

function planDir(): string {
  return join(process.cwd(), ".pi", "workflows", "plans");
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Invoked with the plan whenever a non-pending status is observed. */
  onStatusChange?: (plan: ReviewPlan) => void;
  /** Lets a caller fail an in-flight wait externally (e.g. server error). Returns cleanup. */
  registerFailure?: (reject: (error: Error) => void) => () => void;
  /** Injectable plan reader (test seam); defaults to reading `<dir>/<planId>.json`. */
  readPlanFile?: (planId: string) => Promise<ReviewPlan | null>;
}

function defaultPlanReader(dir: string): (planId: string) => Promise<ReviewPlan | null> {
  return async (planId) => {
    try {
      const data = await readFile(join(dir, `${planId}.json`), "utf-8");
      return JSON.parse(data) as ReviewPlan;
    } catch {
      // Not readable yet (missing or mid-write); the poller keeps waiting.
      return null;
    }
  };
}

export function waitForStatus(dir: string, planId: string, options: WaitOptions): Promise<boolean> {
  const { timeoutMs, signal, onStatusChange, registerFailure, readPlanFile } = options;
  const readPlan = readPlanFile ?? defaultPlanReader(dir);
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<boolean>((resolve, reject) => {
    let timer: SafeTimer | undefined;
    let unregisterFailure: (() => void) | undefined;
    let settled = false;

    const cleanup = () => {
      timer?.clear();
      if (signal) signal.removeEventListener("abort", onAbort);
      unregisterFailure?.();
    };
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (signal) fail(abortError(signal));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (registerFailure) unregisterFailure = registerFailure(fail);

    const startedAt = Date.now();
    const tick = async () => {
      // Never resume polling after settle: a tick that was already re-armed
      // when the promise settled (abort / registerFailure / timeout) must
      // return immediately instead of re-arming again.
      if (settled) return;
      let plan: ReviewPlan | null | undefined;
      try {
        plan = await readPlan(planId);
      } catch {
        // Reader threw unexpectedly; keep polling until the deadline.
        plan = null;
      }
      // The await above is the settle window: fail()/finish() may have run
      // while the plan file was being read. Polling past that is a leak.
      if (settled) return;
      if (plan && plan.status !== "pending") {
        onStatusChange?.(plan);
        finish(plan.status === "approved");
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        finish(false);
        return;
      }
      // Unref'd: a pending poll must never hold the process open on its own.
      timer = safeSetTimeout(tick, POLL_INTERVAL_MS);
      timer.unref();
    };
    void tick();
  });
}

export async function submitPlan(blueprint: unknown, _config?: Partial<PlannotatorConfig>): Promise<ReviewPlan> {
  const plan: ReviewPlan = {
    id: randomUUID(),
    title: "Execution Blueprint Review",
    blueprint,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };
  const dir = planDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${plan.id}.json`), JSON.stringify(plan, null, 2), "utf-8");
  return plan;
}

export function waitForApproval(planId: string, timeout?: number, signal?: AbortSignal): Promise<boolean> {
  return waitForStatus(planDir(), planId, {
    timeoutMs: timeout ?? DEFAULT_CONFIG.approvalTimeout,
    signal,
  });
}

export async function getPlanStatus(planId: string): Promise<ReviewPlan> {
  const data = await readFile(join(planDir(), `${planId}.json`), "utf-8");
  return JSON.parse(data) as ReviewPlan;
}

export function createPlannotatorBridge(config?: Partial<PlannotatorConfig>): PlannotatorBridge {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const emitter = new EventEmitter();
  const pendingWaits = new Set<(error: Error) => void>();
  // Registry of open SSE streams. A keep-alive SSE response is never closed by
  // the client's silence alone, so the bridge must track every response to end
  // it on close() and to heartbeat/drop dead clients.
  const sseClients = new Set<ServerResponse>();
  // Per-client emitter listener cleanup (a res -> remove-listener fn).
  const sseHandlers = new Map<ServerResponse, () => void>();
  let serverError: Error | undefined;

  const dropClient = (res: ServerResponse) => {
    if (!sseClients.has(res)) return;
    sseClients.delete(res);
    sseHandlers.get(res)?.();
    sseHandlers.delete(res);
    try {
      res.end();
    } catch {
      // Already closed; nothing to release.
    }
  };

  /** Register an SSE response and stream `update` events (optionally as a named event). */
  const registerSse = (req: IncomingMessage, res: ServerResponse, eventName?: string) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // writeHead alone does not flush on Node 26; the client would never see headers (or data) without this.
    res.flushHeaders();
    sseClients.add(res);
    const onUpdate = (plan: ReviewPlan) => {
      if (res.destroyed || res.writableEnded) {
        dropClient(res);
        return;
      }
      const payload = eventName
        ? `event: ${eventName}\ndata: ${JSON.stringify(plan)}\n\n`
        : `data: ${JSON.stringify(plan)}\n\n`;
      res.write(payload);
    };
    emitter.on("update", onUpdate);
    sseHandlers.set(res, () => emitter.off("update", onUpdate));
    const onClosed = () => dropClient(res);
    req.on("close", onClosed);
    res.on("close", onClosed);
    res.on("error", onClosed);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/sse") {
      registerSse(req, res);
    } else if (req.url === "/reviewed") {
      // Event-driven review stream: pushes a `reviewed` event to connected
      // clients when a review settles (observed by an active poll). Polling
      // via waitForApproval/getPlanStatus remains the fallback.
      registerSse(req, res, "reviewed");
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // A failed bind (e.g. EADDRINUSE) must not become an unhandled 'error' crash:
  // record it, fail in-flight waits, and let subsequent calls reject immediately.
  server.on("error", (error: Error) => {
    serverError = error;
    for (const reject of pendingWaits) reject(error);
    pendingWaits.clear();
  });
  server.listen(cfg.port);

  // Heartbeat: SSE comments keep proxies/middleboxes from timing out idle
  // connections, and dead clients (destroyed or unwritable) are force-dropped
  // from the registry so they stop receiving writes. Unref'd: idle with no
  // clients, the heartbeat must not hold the process open.
  const heartbeat = safeSetInterval(() => {
    for (const res of sseClients) {
      if (res.destroyed || res.writableEnded) {
        dropClient(res);
        continue;
      }
      try {
        res.write(": ping\n\n");
      } catch {
        dropClient(res);
      }
    }
  }, cfg.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    submitPlan: (blueprint: unknown) => submitPlan(blueprint, cfg),
    waitForApproval: (planId: string, timeout?: number, signal?: AbortSignal) => {
      if (serverError) return Promise.reject(serverError);
      return waitForStatus(planDir(), planId, {
        timeoutMs: timeout ?? cfg.approvalTimeout,
        signal,
        onStatusChange: (plan) => emitter.emit("update", plan),
        registerFailure: (reject) => {
          pendingWaits.add(reject);
          return () => pendingWaits.delete(reject);
        },
      });
    },
    getPlanStatus,
    onStatusChange: (callback: (plan: ReviewPlan) => void) => {
      emitter.on("update", callback);
      return () => emitter.off("update", callback);
    },
    close: () => {
      heartbeat.clear();
      emitter.removeAllListeners();
      // End every open SSE stream BEFORE closing the server: Node keeps
      // keep-alive SSE sockets open, so server.close() alone would never
      // release them (or their sockets) until the browser disconnects.
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          // Already closed.
        }
      }
      sseClients.clear();
      sseHandlers.clear();
      if (server.listening) {
        server.close();
        // Node >=18.2: force-close the underlying sockets so a client that
        // never observes the end-of-stream doesn't linger after close().
        const withCloseAll = server as unknown as { closeAllConnections?: () => void };
        withCloseAll.closeAllConnections?.();
      }
    },
  };
}
