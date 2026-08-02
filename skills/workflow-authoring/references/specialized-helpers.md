# Specialized helpers

Preserve candidate or work identity outside helper results that may omit failed agents.

## Quality

| Helper | Authoring contract |
| --- | --- |
| `completenessCheck(args, results)` | Returns `{ complete, missing? }` or recoverable `null`. The critic sees only the first 4,000 serialized characters, so chunk or summarize larger evidence. Treat the verdict as advisory. |
| `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | `round(index)` is zero-based. Defaults: `JSON.stringify` key, two dry rounds, 50 rounds. Returns `{ items, termination: "dry" | "maxRounds" | "capacity" | "failed", failedRounds }`. Only a successful round that yields no fresh items is dry; a round returning `null` is a FAILED round (termination `"failed"`, `failedRounds` incremented) — never dry. Token-budget or agent-limit exhaustion returns the partial items with termination `"capacity"`. Non-finite `maxRounds`/`consecutiveEmpty` throw a `TypeError`; finite values are floored and clamped. |

## Control

| Helper | Authoring contract |
| --- | --- |
| `gate(thunk, validator, { attempts })` | Calls `thunk(feedback, attempt)` with initial `undefined` feedback and a zero-based attempt. `validator(value)` returns `{ ok, feedback? }`, synchronously or asynchronously; a bare boolean is not accepted. Three attempts by default. Returns `{ ok, value, attempts }`, including the last value on exhaustion. See [validated gate](../examples/validated-gate.js). |
| `checkpoint(prompt, options?)` | Journals a human/default decision. Foreground confirm, headless behavior, and the visual approve/deny gate (`runWorkflow({ checkpointGate })`) are implemented; with a gate configured, the payload is published to the gate and the human verdict resolves the reply (approve → `true`/declared default, deny/timeout → `false`). |

Always `await gate()`. A thunk containing `await` must itself be declared `async`; await `agent()` before adding its resolved value to a ledger. Runtime agent retries repeat recoverable execution failures; helper attempts are new semantic calls. Bound both layers and ledger exhaustion.
