# Verify and judge

Keep work IDs outside helper results that may omit failed agents.

| Call | Contract |
| --- | --- |
| `verify(item, { reviewers: number, threshold: number, lens: string | string[] })` | Defaults: 2 reviewers, inclusive `0.5`, one lens or a cycled array. Returns `{ real, realCount, total, votes }`. Failed reviewers are omitted; successful votes are the denominator; zero survivors means `real: false`. |
| `judgePanel(attempts, { judges: number, rubric: string })` | Defaults: 3 judges and `"overall quality and correctness"`. Failed judgments are omitted. Returns the highest mean `{ index, attempt, score, judgments }`; input order wins ties; empty input returns `undefined`. |

Every `verify`/`judgePanel` invocation labels its agent calls with a deterministic per-invocation counter suffix (`verify 1.1`, `judge 1.1.2`) — the stable `verify <n>` / `judge <attempt>.<judge>` prefix keeps grouping and resume identity intact while the trailing counter keeps labels unique across repeated calls in one script (the counter is per `workflow()` frame — a nested frame restarts it). Failed reviewers/judges are tolerated exactly as above; judge scores are clamped to [0, 1] before averaging, so one out-of-range score cannot skew a candidate's mean.
