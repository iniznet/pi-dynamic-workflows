/**
 * Zero-dependency default-browser launcher for the plannotator review page.
 *
 * // Derived from backnotprop/plannotator (https://github.com/backnotprop/plannotator),
 * // MIT OR Apache-2.0. Copyright (c) 2025 backnotprop.
 * // Adapted to pi-dynamic-workflows' self-hosted zero-dependency bridge; the
 * // upstream React SPA, annotation and PR-diff surfaces are NOT vendored.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { type SafeTimer, safeSetTimeout } from "../../timing.js";

export interface BrowserOpenOptions {
  /** External cancellation; a pre-aborted signal never spawns a process. */
  signal?: AbortSignal;
  /** How long a spawn may stay in limbo before the launcher is reaped. Default 10s. */
  timeoutMs?: number;
  /** Injectable spawn (test seam); defaults to node:child_process.spawn. */
  spawn?: typeof nodeSpawn;
  /** Injectable platform (test seam); defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable environment (test seam); defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface BrowserOpenResult {
  opened: boolean;
  reason?: "remote" | "noop" | "abort" | "timeout" | "spawn-error";
}

/** Sentinel values (reference `isNoOpBrowserSentinel`): a browser override that explicitly means "do not launch". */
const NOOP_BROWSER_SENTINELS: ReadonlySet<string> = new Set(["true", "false", "none", ":", "0", "1"]);

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  return value === undefined ? undefined : value.trim();
}

/**
 * Remote-session detection: never pop a browser on a machine we cannot see.
 * `PLANNOTATOR_REMOTE` (0/1/true/false) overrides the heuristic; an unset or
 * unrecognized value defers to SSH markers (conservative: no spawn).
 */
function isRemoteSession(env: Record<string, string | undefined>): boolean {
  const override = envValue(env, "PLANNOTATOR_REMOTE");
  if (override !== undefined) {
    const lower = override.toLowerCase();
    if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
    return true;
  }
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION);
}

/**
 * Resolve the browser override: `PLANNOTATOR_BROWSER` wins over `BROWSER`.
 * Returns undefined (use the platform default), "noop" (explicitly do not
 * launch), or a custom launcher command/binary.
 */
function resolveBrowserOverride(env: Record<string, string | undefined>): string | undefined | "noop" {
  const value = envValue(env, "PLANNOTATOR_BROWSER") ?? envValue(env, "BROWSER");
  if (value === undefined || value === "") return undefined;
  if (NOOP_BROWSER_SENTINELS.has(value.toLowerCase())) return "noop";
  return value;
}

/** Platform dispatch (mirrors the reference `openBrowser` command selection). */
function platformCommand(
  platform: NodeJS.Platform,
  browser: string | undefined,
  url: string,
): { command: string; args: string[] } {
  if (platform === "win32") {
    // cmd.exe /c start "" [browser] <url> — the empty title arg is required
    // so a quoted URL is not mistaken for the window title.
    return { command: "cmd.exe", args: ["/c", "start", "", ...(browser ? [browser] : []), url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [...(browser ? ["-a", browser] : []), url] };
  }
  // Linux and everything else: the BROWSER override is the launcher command
  // itself; otherwise the desktop-agnostic xdg-open.
  if (browser) return { command: browser, args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Best-effort reap: a launcher that never spawned must not linger. */
function killBestEffort(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Already dead or not killable — nothing to release.
  }
}

/**
 * Open `url` in the user's default browser, abortably.
 *
 * The promise settles on the FIRST of: the child's `spawn` event (the
 * launcher accepted the request — the page is the browser's job now),
 * the child's `error` event (spawn failed), an abort, or the timeout.
 * After a successful spawn the watchdog is disarmed: the browser is the
 * user's UI and must never be killed by the bridge.
 */
export async function openReviewInBrowser(url: string, opts: BrowserOpenOptions = {}): Promise<BrowserOpenResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const spawnFn = opts.spawn ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const signal = opts.signal;

  if (isRemoteSession(env)) return { opened: false, reason: "remote" };
  const browser = resolveBrowserOverride(env);
  if (browser === "noop") return { opened: false, reason: "noop" };
  if (signal?.aborted) return { opened: false, reason: "abort" };

  const { command, args } = platformCommand(platform, browser, url);

  return await new Promise<BrowserOpenResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, { detached: true, stdio: "ignore" });
    } catch {
      resolve({ opened: false, reason: "spawn-error" });
      return;
    }
    // Detached + unref'd + ignore stdio: the launcher outlives this process
    // and never holds the event loop (or a pipe buffer) open.
    child.unref();

    let settled = false;
    let timer: SafeTimer | undefined;
    const settle = (result: BrowserOpenResult) => {
      if (settled) return;
      settled = true;
      timer?.clear();
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      killBestEffort(child);
      settle({ opened: false, reason: "abort" });
    };

    child.once("error", () => {
      killBestEffort(child);
      settle({ opened: false, reason: "spawn-error" });
    });
    child.once("spawn", () => settle({ opened: true }));
    timer = safeSetTimeout(() => {
      killBestEffort(child);
      settle({ opened: false, reason: "timeout" });
    }, timeoutMs);
    timer.unref();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
