# Verify and judge

Keep work IDs outside helper results that may omit failed agents.

| Call | Contract |
| --- | --- |
| `verify(item, { reviewers: number, threshold: number, lens: string | string[] })` | Defaults: 2 reviewers, inclusive `0.5`, one lens or a cycled array. Returns `{ real, realCount, total, votes }`. Failed reviewers are omitted; successful votes are the denominator; zero survivors means `real: false`. |
| `judgePanel(attempts, { judges: number, rubric: string })` | Defaults: 3 judges and `"overall quality and correctness"`. Failed judgments are omitted. Returns the highest mean `{ index, attempt, score, judgments }`; input order wins ties; empty input returns `undefined`. |

## Small-tier quality caveat (DS-3)

Helper votes bind to the economy `small` tier by default (T2-04) — cheap, but a
too-small verifier can raise false negatives (the runtime quality caveat
mirrors workflow.ts's own comment). When the item is large or the cost of a
missed real is high:

- `verify()` on research claims: prefer `reviewers: 3` + `threshold: 0.66`
  (odd reviewer counts avoid tie splits), or pass `tier: "medium"` for the
  votes.
- `consensus()`: a `small`-tier panel pairs better with a higher
  `agreeThreshold` — the small model's weaker signal needs a stronger
gate to avoid premature agreement.
- `completenessCheck()`: the `small`-tier gap-miss risk is real (a cheap model
  may overlook a missing section). Prefer `tier: "medium"` or a stricter
  `mustContain` list when the completeness verdict gates a deliverable.

Every `verify`/`judgePanel` invocation labels its agent calls with a deterministic per-invocation counter suffix (`verify 1.1`, `judge 1.1.2`) — the stable `verify <n>` / `judge <attempt>.<judge>` prefix keeps grouping and resume identity intact while the trailing counter keeps labels unique across repeated calls in one script (the counter is per `workflow()` frame — a nested frame restarts it). Failed reviewers/judges are tolerated exactly as above; judge scores are clamped to [0, 1] before averaging, so one out-of-range score cannot skew a candidate's mean.
