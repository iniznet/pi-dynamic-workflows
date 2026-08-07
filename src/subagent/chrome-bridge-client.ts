/**
 * ChromeBridgeClient — thin client-only bridge for pi-chrome's local bridge
 * (design: tasks/subagent-chrome-tools/DESIGN.md).
 *
 * pi-chrome (the extension package that registers the host's `chrome_*` tools)
 * runs a localhost HTTP server (`127.0.0.1:17318`, env-overridable via
 * `PI_CHROME_BRIDGE_HOST` / `PI_CHROME_BRIDGE_PORT`) that a companion Chrome
 * extension polls for commands. This module lets workflow subagents reach the
 * SAME bridge as plain HTTP clients, exactly like pi-chrome's own multi-session
 * client mode (`sendViaOwner` in pi-chrome's chrome-profile-bridge/index.ts).
 *
 * Deliberate boundaries:
 *  - CLIENT ONLY: this class never binds a port and never tries to promote to
 *    bridge owner. pi-chrome owns the bridge; stealing the port would break the
 *    host session's own chrome tools. When the owner is unreachable, the error
 *    names pi-chrome as the missing dependency.
 *  - AUTH IS SHARED, NOT MINTED: `/chrome authorize` stores its grant on
 *    `globalThis["__piChromeProfileBridgeAuth__"]` (pi-chrome keeps it there,
 *    not in per-extension storage, so a /reload does not drop it). Workflow
 *    subagents run in the same process as the host extension, so reading that
 *    key makes the host's grant authoritative for subagent chrome calls — no
 *    separate authorization UX.
 */

/** Wire-level shape of a bridge `/command` response. */
export interface BridgeCommandResponse {
  ok?: boolean;
  result?: unknown;
  error?: string;
}

/** Options for {@link ChromeBridgeClient}. */
export interface ChromeBridgeClientOptions {
  /** Bridge base URL; defaults to the env-overridable 127.0.0.1:17318. */
  url?: string;
  /** Injectable fetch (test seam); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Options for {@link ChromeBridgeClient.heartbeat}. */
export interface HeartbeatOptions {
  /**
   * When true, a failed heartbeat (network error or non-2xx response) throws
   * instead of being swallowed. Defaults to false — heartbeats are best-effort
   * keepalives and must never take down the calling workflow.
   */
  throwOnError?: boolean;
}

/** Default bridge host, mirroring pi-chrome's DEFAULT_HOST. */
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";

/** Fallback bridge port (pi-chrome's DEFAULT_PORT); also the garbage-env fallback. */
const DEFAULT_CHROME_BRIDGE_PORT = 17318;

/**
 * Resolve the bridge port from `PI_CHROME_BRIDGE_PORT`. A valid TCP port
 * (integer, 0 < port <= 65535) wins; anything else — missing, empty,
 * fractional, negative, out-of-range, or unparseable garbage — falls back to
 * the default, so a bad env value can never yield `http://127.0.0.1:NaN`.
 * Mirrors the readEnvLimit leniency (plan-size.ts).
 */
export function resolveChromeBridgePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_CHROME_BRIDGE_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_CHROME_BRIDGE_PORT;
}

const DEFAULT_PORT = resolveChromeBridgePort(process.env.PI_CHROME_BRIDGE_PORT);

/** The exact globalThis key pi-chrome persists its `/chrome authorize` grant under. */
export const PI_CHROME_AUTH_GLOBAL_KEY = "__piChromeProfileBridgeAuth__";

/** Shape of the persisted auth grant on globalThis. */
export interface ChromeAuthGrant {
  until: number | "indefinite";
}

/** globalThis extended with pi-chrome's shared keys (read-only on our side). */
interface ChromeGlobalState {
  [PI_CHROME_AUTH_GLOBAL_KEY]?: ChromeAuthGrant;
}

/**
 * Read pi-chrome's shared auth grant. Undefined when pi-chrome has not
 * persisted one (never authorized, or revoked). Expired grants are dropped
 * here — the caller does not need to distinguish "never" from "expired".
 */
export function readChromeAuthGrant(): ChromeAuthGrant | undefined {
  const grant = (globalThis as ChromeGlobalState)[PI_CHROME_AUTH_GLOBAL_KEY];
  if (!grant) return undefined;
  if (grant.until === "indefinite" || grant.until > Date.now()) return grant;
  // Mirror pi-chrome: an expired grant is removed so a later read stays clean.
  delete (globalThis as ChromeGlobalState)[PI_CHROME_AUTH_GLOBAL_KEY];
  return undefined;
}

/** Whether the host session currently holds a valid chrome-control grant. */
export function isChromeAuthorized(): boolean {
  return readChromeAuthGrant() !== undefined;
}

/** The standard lock message pi-chrome throws when the grant is missing. */
export const CHROME_CONTROL_LOCKED_MESSAGE =
  "Chrome control locked. Ask the user to run /chrome authorize before using chrome_* tools.";

/** Throw the standard lock error when the host session is not authorized. */
export function requireChromeAuthorized(): void {
  if (!isChromeAuthorized()) throw new Error(CHROME_CONTROL_LOCKED_MESSAGE);
}

/**
 * Thin POST-only client for pi-chrome's bridge `/command` endpoint.
 * Construction is side-effect free; nothing touches the network until send().
 */
export class ChromeBridgeClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ChromeBridgeClientOptions = {}) {
    this.url = options.url ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * POST one bridge action and await its result. Honors the AbortSignal the
   * pi runtime passes per tool call (abort propagates to the HTTP request).
   * Error mapping keeps messages actionable:
   *  - bridge responds !ok  → the bridge's own error text;
   *  - 404                  → owner pi-chrome is too old (multi-session missing);
   *  - aborted by signal    → "Chrome command aborted";
   *  - connection refused   → pi-chrome not running / bridge owner absent.
   */
  async send(
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error("Chrome command aborted");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    try {
      const response = await this.fetchImpl(`${this.url}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, params, timeoutMs }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as BridgeCommandResponse;
      if (response.status === 404) {
        throw new Error(
          "A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
        );
      }
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
      return payload.result;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        if (signal?.aborted) throw new Error("Chrome command aborted");
        throw new Error(`Timed out waiting for the Chrome bridge owner after ${timeoutMs}ms`);
      }
      const message = (error as Error)?.message ?? "";
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      const causeCode = (error as { cause?: NodeJS.ErrnoException })?.cause?.code ?? "";
      if (
        /fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(message) ||
        code === "ECONNREFUSED" ||
        causeCode === "ECONNREFUSED" ||
        causeCode === "ECONNRESET"
      ) {
        throw new Error(
          `Chrome bridge at ${this.url} is not reachable. Subagent chrome_* tools require the host pi-chrome extension (install "pi-chrome" in your pi packages) and its companion Chrome extension, with an active /chrome authorize grant.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", forwardAbort);
    }
  }

  /**
   * POST a keepalive for this session to the bridge `/heartbeat` endpoint
   * (S5.1) so the owner can track stale grants. Best-effort by default: a
   * missing bridge must not crash a workflow, so failures are swallowed and
   * reported as `false` unless {@link HeartbeatOptions.throwOnError} is set.
   * Returns true when the bridge acked (2xx).
   */
  async heartbeat(sessionKey: string, opts: HeartbeatOptions = {}): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey }),
      });
    } catch (error) {
      if (opts.throwOnError) throw error;
      return false;
    }
    if (!response.ok) {
      if (opts.throwOnError) throw new Error(`Chrome bridge heartbeat HTTP ${response.status}`);
      return false;
    }
    return true;
  }
}
