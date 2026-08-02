/** Peer package names this package lazily depends on (see PEER_DEPENDENCIES). */
export type MissingPeerName = "@earendil-works/pi-coding-agent" | "@earendil-works/pi-tui" | "typebox";

/** Peer name → required version range, mirrored from package.json peerDependencies. */
export type PeerDependencyTable = Record<MissingPeerName, string>;

/**
 * Raised when a peer dependency is missing or incompatible at the point a
 * peer-dependent feature is used. Carries the peer's name and the version range
 * the host must provide so the diagnostic is actionable (install the peer, or
 * run the extension inside a host that already ships it).
 */
export class MissingPeerError extends Error {
  readonly peerName: string;
  readonly requiredRange: string;

  constructor(peerName: string, requiredRange: string, options: { cause?: unknown } = {}) {
    super(
      `Missing or incompatible peer dependency "${peerName}" — required: ${requiredRange}. ` +
        `Install it (e.g. \`npm i ${peerName}@${requiredRange}\`) or run the extension inside a host that provides it.`,
      options,
    );
    this.name = "MissingPeerError";
    this.peerName = peerName;
    this.requiredRange = requiredRange;
  }
}

/** Narrow an unknown failure to MissingPeerError. */
export function isMissingPeerError(error: unknown): error is MissingPeerError {
  return error instanceof MissingPeerError;
}

/**
 * Peer dependencies this package needs to function, keyed by package name with
 * the version range required by package.json `peerDependencies`. Kept in sync
 * manually: the value here IS the diagnostic the user sees when a peer is
 * missing or incompatible, so it must never drift from package.json.
 */
export const PEER_DEPENDENCIES = {
  "@earendil-works/pi-coding-agent": ">=0.80.8",
  "@earendil-works/pi-tui": ">=0.80.6",
  typebox: "*",
} as const satisfies PeerDependencyTable;

/**
 * Dynamically import a peer dependency, converting any resolution/evaluation
 * failure into a MissingPeerError that names the peer and the required version
 * range. The diagnostic is the point of H4: a missing or incompatible peer must
 * fail at the moment the peer-dependent feature is USED with an actionable
 * message — never as a cryptic module-resolution SyntaxError at extension load.
 */
/**
 * Required range for a peer by name, falling back to a pointer at package.json
 * for names outside the known table (the lazy loader accepts any specifier).
 */
function peerRange(peerName: string): string {
  const table: Record<string, string> = PEER_DEPENDENCIES;
  return table[peerName] ?? "(see package.json peerDependencies)";
}

export async function lazyPeerImport<T>(peerName: string): Promise<T> {
  try {
    return (await import(peerName)) as T;
  } catch (cause) {
    throw new MissingPeerError(peerName, peerRange(peerName), { cause });
  }
}

/**
 * Synchronously check whether a peer package resolves in this process's module
 * graph. import.meta.resolve performs no module evaluation, so this is a cheap
 * availability probe for deciding whether a peer-dependent feature can be
 * offered at all (e.g. skipping TUI registration in a headless host).
 */
export function probePeerAvailability(peerName: string): boolean {
  try {
    (import.meta as ImportMeta & { resolve(specifier: string): string }).resolve(peerName);
    return true;
  } catch {
    return false;
  }
}
