/**
 * Plannotator Visual Review Gate (Phase 2).
 * Provides browser-based plan review with SSE for real-time updates.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { writeJsonFileAtomic } from "../fs-persistence.js";
import type { WorkflowStateManager } from "../phases/state-machine.js";
import { type SafeTimer, safeSetInterval, safeSetTimeout } from "../timing.js";
import { type BrowserOpenOptions, type BrowserOpenResult, openReviewInBrowser } from "./plannotator-ui/browser-open.js";
import { renderReviewPage } from "./plannotator-ui/review-page.js";

export interface ReviewPlan {
  id: string;
  title: string;
  blueprint: unknown;
  status: "pending" | "approved" | "rejected";
  feedback?: string;
  submittedAt: string;
  reviewedAt?: string;
  /**
   * Never persisted: attached only to the object returned by the bridge's
   * submitPlan when the review page could not be auto-opened, so a caller can
   * surface the manual review URL to the human.
   */
  note?: string;
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

/**
 * Bridge construction options: {@link PlannotatorConfig} fields plus the
 * on-demand Phase 2 gate hooks. Source-compatible with `Partial<PlannotatorConfig>`
 * (existing callers pass `{ port, autoOpenBrowser }` unchanged).
 */
export interface PlannotatorBridgeOptions extends Partial<PlannotatorConfig> {
  /**
   * Optional persisted phase state machine. On a valid /approve the bridge runs
   * `approvePlan()` (flips `humanApproved` in active-state.json); a phase
   * mismatch (APPROVAL_REQUIRED) answers the browser with 409 while the plan
   * file stays approved. Absent → the bridge is a pure approve/deny gate.
   */
  stateManager?: WorkflowStateManager;
  /** Injectable browser opener (test seam); defaults to openReviewInBrowser. */
  openBrowser?: (url: string, opts?: BrowserOpenOptions) => Promise<BrowserOpenResult>;
}

/**
 * Default human-verdict wait for an approval: 5 minutes. Exported so the
 * facade's small-plan path (extensions/workflow.ts) polls with the SAME
 * default the bridge uses for its approvalTimeout, keeping the two routes
 * consistent for the run's wait deadline.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

const DEFAULT_CONFIG: PlannotatorConfig = {
  port: 3123,
  autoOpenBrowser: true,
  approvalTimeout: DEFAULT_APPROVAL_TIMEOUT_MS,
};

/** Re-read cadence for waitForApproval; responsive for a human gate, bounded, and abortable. */
const POLL_INTERVAL_MS = 250;
/** Default SSE heartbeat cadence: comfortably under typical proxy idle timeouts (60s+). */
const DEFAULT_SSE_HEARTBEAT_MS = 15000;
/** Max POST /approve body: a larger body is a protocol violation, not a review. */
const MAX_APPROVE_BODY_BYTES = 64 * 1024;
/** Plan id shape check for /plan and /approve (matches randomUUID output). */
const PLAN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Max feedback characters on /approve. */
const MAX_FEEDBACK_CHARS = 8000;
const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };

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
  await writePlanAtomic(plan);
  return plan;
}

/**
 * Read a request body up to maxBytes. Rejects on overflow (and destroys the
 * socket) or on a stream error — never buffers unbounded input.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Atomic replace of a plan file — routes through the shared
 * {@link writeJsonFileAtomic} (fs-persistence.ts). Audit WPA-01: this was a
 * private tmp+rename copy WITHOUT the Windows-EPERM rename retry, and the
 * bridge /approve path ran it against the same concurrent 250ms waitForStatus
 * poller the retry was built for (observed ~1-in-8 HTTP 500). Dir semantics
 * stay here: the bridge's own planDir().
 */
async function writePlanAtomic(plan: ReviewPlan): Promise<void> {
  await writeJsonFileAtomic(join(planDir(), `${plan.id}.json`), plan);
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

export function createPlannotatorBridge(options: PlannotatorBridgeOptions = {}): PlannotatorBridge {
  const cfg = { ...DEFAULT_CONFIG, ...options };
  const openBrowserFn = options.openBrowser ?? openReviewInBrowser;
  const emitter = new EventEmitter();
  const pendingWaits = new Set<(error: Error) => void>();
  // The most recent submitted plan; GET /plan (no query) serves it to the
  // review page. Cleared on close().
  let latestPlanId: string | undefined;
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

  const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(payload));
  };

  /** Resolve the review page URL from the live socket; undefined until bound. */
  const reviewUrl = (): string | undefined => {
    const addr = server.address();
    if (addr === null) return undefined;
    const port = typeof addr === "object" ? addr.port : cfg.port;
    return `http://127.0.0.1:${port}/review`;
  };

  // GET /plan[?planId=] — the review page fetches this without a query and
  // gets the latest submitted plan; a planId query serves that specific plan.
  const handleGetPlan = async (_req: IncomingMessage, res: ServerResponse) => {
    const planIdParam = new URL(_req.url ?? "/", "http://127.0.0.1").searchParams.get("planId");
    try {
      if (planIdParam !== null) {
        if (!PLAN_ID_RE.test(planIdParam)) {
          sendJson(res, 400, { error: "invalid planId" });
          return;
        }
        const plan = await getPlanStatus(planIdParam);
        sendJson(res, 200, { plan });
        return;
      }
      if (!latestPlanId) {
        sendJson(res, 404, { error: "no plan submitted yet" });
        return;
      }
      const plan = await getPlanStatus(latestPlanId);
      sendJson(res, 200, { plan });
    } catch {
      sendJson(res, 404, { error: "plan not found" });
    }
  };

  // POST /approve — browser review verdict. Validation ladder runs before any
  // write: 400 malformed/non-object/missing or bad-UUID planId → 400 unknown
  // plan → 409 already-decided → 400 oversized feedback. Success persists the
  // approved plan atomically, emits the SSE update, then (optionally) runs the
  // state machine hook (a phase-mismatch 409 never rolls back the approved
  // file — the poll path still delivers the verdict).
  const handleApprove = async (req: IncomingMessage, res: ServerResponse) => {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_APPROVE_BODY_BYTES));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendJson(res, 400, { error: "body must be a JSON object" });
      return;
    }
    const planId = (body as { planId?: unknown }).planId;
    if (typeof planId !== "string" || !PLAN_ID_RE.test(planId)) {
      sendJson(res, 400, { error: "invalid planId" });
      return;
    }
    const feedback = (body as { feedback?: unknown }).feedback;
    if (feedback !== undefined && (typeof feedback !== "string" || feedback.length > MAX_FEEDBACK_CHARS)) {
      sendJson(res, 400, { error: "feedback must be a string under 8000 chars" });
      return;
    }
    let current: ReviewPlan;
    try {
      current = await getPlanStatus(planId);
    } catch {
      // Unknown planId → 400 (the review page treats any 4xx as terminal).
      sendJson(res, 400, { error: "unknown plan" });
      return;
    }
    if (current.status !== "pending") {
      sendJson(res, 409, { error: "plan already decided", status: current.status });
      return;
    }
    const approved: ReviewPlan = {
      ...current,
      status: "approved",
      ...(feedback !== undefined ? { feedback } : {}),
      reviewedAt: new Date().toISOString(),
    };
    try {
      await writePlanAtomic(approved);
    } catch {
      sendJson(res, 500, { error: "could not persist approval" });
      return;
    }
    emitter.emit("update", approved);
    if (cfg.stateManager) {
      try {
        await cfg.stateManager.approvePlan();
      } catch (error) {
        if (error instanceof WorkflowError && error.code === WorkflowErrorCode.APPROVAL_REQUIRED) {
          // Phase guard refused: approvePlan is only valid in Phase 2. The plan
          // file stays approved, but subagent execution was not unlocked.
          sendJson(res, 409, { error: "approval not valid in current phase" });
          return;
        }
        sendJson(res, 500, { error: "state machine update failed" });
        return;
      }
    }
    sendJson(res, 200, { ok: true, planId, status: "approved" });
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    if (url === "/approve") {
      if (method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      void handleApprove(req, res);
      return;
    }
    if (method !== "GET") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url === "/" || url === "/review") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderReviewPage());
    } else if (url === "/favicon.ico") {
      // Avoid browser console noise while the page is open.
      res.writeHead(204);
      res.end();
    } else if (url === "/plan" || url.startsWith("/plan?")) {
      void handleGetPlan(req, res);
    } else if (url === "/sse") {
      registerSse(req, res);
    } else if (url === "/reviewed") {
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
    submitPlan: async (blueprint: unknown) => {
      const plan = await submitPlan(blueprint, cfg);
      latestPlanId = plan.id;
      if (cfg.autoOpenBrowser) {
        // Fire-and-forget: a failed/denied launcher must never reject submitPlan.
        const url = reviewUrl();
        if (url) {
          void openBrowserFn(url, { timeoutMs: 10_000 })
            .then((result) => {
              if (!result.opened) {
                // The run continues and polls; surface the manual review URL on
                // the result so a caller can point the human at the page.
                plan.note = `Open ${url} to approve the plan`;
              }
            })
            .catch(() => {});
        }
      }
      return plan;
    },
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
      latestPlanId = undefined;
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
