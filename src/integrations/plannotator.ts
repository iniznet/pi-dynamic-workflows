/**
 * Plannotator Visual Review Gate (Phase 2).
 * Provides browser-based plan review with SSE for real-time updates.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

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

interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Invoked with the plan whenever a non-pending status is observed. */
  onStatusChange?: (plan: ReviewPlan) => void;
  /** Lets a caller fail an in-flight wait externally (e.g. server error). Returns cleanup. */
  registerFailure?: (reject: (error: Error) => void) => () => void;
}

function waitForStatus(dir: string, planId: string, options: WaitOptions): Promise<boolean> {
  const { timeoutMs, signal, onStatusChange, registerFailure } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<boolean>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unregisterFailure: (() => void) | undefined;
    let settled = false;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
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
      try {
        const data = await readFile(join(dir, `${planId}.json`), "utf-8");
        const plan = JSON.parse(data) as ReviewPlan;
        if (plan.status !== "pending") {
          onStatusChange?.(plan);
          finish(plan.status === "approved");
          return;
        }
      } catch {
        // Plan not readable yet; keep polling until the deadline.
      }
      if (Date.now() - startedAt >= timeoutMs) {
        finish(false);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
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
  let serverError: Error | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // writeHead alone does not flush on Node 26; the client would never see headers (or data) without this.
      res.flushHeaders();
      const onUpdate = (plan: ReviewPlan) => res.write(`data: ${JSON.stringify(plan)}\n\n`);
      emitter.on("update", onUpdate);
      req.on("close", () => emitter.off("update", onUpdate));
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
      emitter.removeAllListeners();
      if (server.listening) server.close();
    },
  };
}
