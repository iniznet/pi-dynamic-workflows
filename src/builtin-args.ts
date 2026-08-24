/**
 * Shared numeric-argument coercion and validation for the built-in workflow
 * patterns (deep-research, adversarial-review, code-review).
 *
 * WHY this module exists (builtins:f2–f5, builtins:i1): the resolvers used to
 * read numeric args with `(args && args.n) || default`. That silently mangles
 * a present falsy value (e.g. `threshold: 0` became 0.5), accepts NaN and
 * negative numbers, and lets absurd values drive unbounded fan-out (e.g.
 * `reviewers: 10_000` → 10_000 parallel refute agents). This module centralizes
 * the one definition of "valid": min/max bounds, integer enforcement for
 * counts, and defaults applied ONLY when a value is missing.
 *
 * Two layers consume it so they can never drift apart:
 *  1. The resolver layer (builtin-workflows.ts) rejects invalid input loudly
 *     before a run starts (validateNumericArgs).
 *  2. numericArgCoercionSource() bakes an equivalent parser into the generated
 *     scripts, which run inside a vm and cannot import this module — so a
 *     script launched through any path (workflow tool `name`, slash command,
 *     direct runWorkflow/resume) applies exactly the same rules at runtime.
 */

export interface NumericArgSpec {
  /** The args key, e.g. "angles". Must be a valid JS identifier. */
  name: string;
  /** Applied ONLY when the value is missing — never over a present falsy value. */
  default: number;
  /** Inclusive lower bound; values below reject. */
  min?: number;
  /** Inclusive upper bound; values above reject (bounds fan-out, builtins:i5). */
  max?: number;
  /** Counts (agents, candidates, batches) must be whole numbers. */
  integer?: boolean;
}

interface NumericArgOutcome {
  value?: number;
  error?: string;
}

/** Coerce+validate one raw arg value against a spec. Missing → default. */
export function coerceNumber(raw: unknown, spec: NumericArgSpec): NumericArgOutcome {
  if (raw === undefined || raw === null || raw === "") return { value: spec.default };
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { error: `arg "${spec.name}" must be a number, got ${JSON.stringify(raw)}` };
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    return { error: `arg "${spec.name}" must be a finite number, got ${JSON.stringify(raw)}` };
  }
  if (spec.integer && !Number.isInteger(n)) {
    return { error: `arg "${spec.name}" must be a whole number, got ${n}` };
  }
  if (spec.min !== undefined && n < spec.min) {
    return { error: `arg "${spec.name}" must be >= ${spec.min}, got ${n}` };
  }
  if (spec.max !== undefined && n > spec.max) {
    return { error: `arg "${spec.name}" must be <= ${spec.max}, got ${n}` };
  }
  return { value: n };
}

/**
 * Validate every present numeric arg of a record against its specs and throw
 * the first error found — the resolver's contract boundary, so invalid input
 * (0 reviewers, a 10_000-candidate cap) fails loudly before a run starts
 * instead of silently mangling or fanning out unbounded. Missing args are
 * valid: the generated script applies the spec default at runtime.
 */
export function validateNumericArgs(
  record: Record<string, unknown>,
  specs: readonly NumericArgSpec[],
  pattern: string,
): void {
  for (const spec of specs) {
    const outcome = coerceNumber(record[spec.name], spec);
    if (outcome.error) throw new Error(`Built-in workflow "${pattern}" ${outcome.error}`);
  }
}

/**
 * Emit a vm-embeddable parser equivalent to coerceNumber() for every spec.
 * Each generator bakes this source in at generation time; keeping the two
 * implementations textually in sync keeps the resolver's rejection and the
 * script's runtime rejection identical.
 */
export function numericArgCoercionSource(specs: readonly NumericArgSpec[]): string {
  const decls = specs.map((spec) => {
    const min = spec.min === undefined ? "undefined" : String(spec.min);
    const max = spec.max === undefined ? "undefined" : String(spec.max);
    const integer = spec.integer === true ? "true" : "false";
    return (
      `const ${spec.name} = __coerceArg(${JSON.stringify(spec.name)}, args && args.${spec.name}, ` +
      `${spec.default}, ${min}, ${max}, ${integer})`
    );
  });
  return [
    "// Numeric-arg coercion mirrors src/builtin-args.ts coerceNumber(): missing → default,",
    "// present-but-invalid → throw. Never `|| default` (that mangles a falsy 0).",
    "const __coerceArg = (name, raw, d, min, max, integer) => {",
    "  if (raw === undefined || raw === null || raw === '') return d",
    "  if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('arg \"' + name + '\" must be a number, got ' + JSON.stringify(raw))",
    "  const n = typeof raw === 'number' ? raw : Number(raw)",
    "  if (!Number.isFinite(n)) throw new Error('arg \"' + name + '\" must be a finite number, got ' + String(raw))",
    "  if (integer && !Number.isInteger(n)) throw new Error('arg \"' + name + '\" must be a whole number, got ' + n)",
    "  if (min !== undefined && n < min) throw new Error('arg \"' + name + '\" must be >= ' + min + ', got ' + n)",
    "  if (max !== undefined && n > max) throw new Error('arg \"' + name + '\" must be <= ' + max + ', got ' + n)",
    "  return n",
    "}",
    ...decls,
  ].join("\n");
}

/** deep-research: how many search angles to fan out (Queries → Gather). */
export const DEEP_RESEARCH_NUMERIC_ARGS: readonly NumericArgSpec[] = [
  { name: "angles", default: 4, min: 1, max: 8, integer: true },
  { name: "minSupport", default: 2, min: 1, max: 5, integer: true },
];

/** adversarial-review: refute fan-out (findings × reviewers) and the survival gate. */
export const ADVERSARIAL_REVIEW_NUMERIC_ARGS: readonly NumericArgSpec[] = [
  // reviewers >= 2 and the 0.66 default threshold guarantee a 1-of-2 split
  // never survives the refute phase (M22): 1/2 = 0.5 < 0.66. A lone reviewer
  // could never be cross-checked at all, so a 1-reviewer config is rejected.
  { name: "reviewers", default: 2, min: 2, max: 8, integer: true },
  { name: "threshold", default: 0.66, min: 0, max: 1 },
  { name: "maxFindings", default: 25, min: 1, max: 50, integer: true },
];

/**
 * Combined refute-phase agent budget (builtins:i5): findings × reviewers must
 * stay under this or the generated script degrades the findings pool with a
 * visible log. Baked into the generated script at generation time, so a run
 * launched through any path applies it.
 */
export const MAX_REFUTE_AGENTS = 250;

/** code-review: verify-phase fan-out is ceil(candidates / verifyBatchSize) agents. */
export const CODE_REVIEW_NUMERIC_ARGS: readonly NumericArgSpec[] = [
  { name: "maxCandidates", default: 30, min: 1, max: 200, integer: true },
  { name: "verifyBatchSize", default: 5, min: 1, max: 20, integer: true },
];
