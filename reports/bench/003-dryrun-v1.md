# 003 — v0.05 dry run with prompts v1 (k = 2) — 2026-11-10

Route D-26. Same setup as report 002 (4 large-parallel tasks × N = 3, Opus 5.5, thinking high), but with `prompts/v1/` (arm `rsav1`):
- workers run only the targeted tests named in their dispatch;
- the orchestrator runs the repo-wide checks once, on the merged tree;
- the orchestrator balances the split by expected work.

Data: `D:/rsa-bench/runs/pi-par-*/rsav1-*`, `reports/bench/003-dryrun-v1.json` (`node bench/compare.ts --arm rsav1`).

## Result

**12 of 12 accepted** on the first check: no rescores, no merge conflicts, 2 steers in total.

| task | baseline $ | v0 $ | **v1 $** | v1 cost ratio | baseline min | v0 min | **v1 min** | v1 time ratio |
|---|---|---|---|---|---|---|---|---|
| pi-par-orca-durable-trust | 3.31 | 2.72 | 2.21 | 67% | 11.8 | 7.1 | 5.7 | 48% |
| pi-par-osc133-npm-stale | 1.51 | 1.42 | 1.50 | 99% | 6.1 | 4.7 | 4.6 | 75% |
| pi-par-shift-chord-pnpm | 1.48 | 1.96 | 1.57 | 107% | 6.4 | 6.0 | 5.3 | 83% |
| pi-par-wsl-durable-ranking | 2.57 | 2.69 | 2.00 | 78% | 10.1 | 10.1 | 5.2 | 52% |
| **median ratio** | | 99% | | **89%** | | 86% | | **63%** |

**G0.05 (median cost ≤ 80% or median time ≤ 75%): GO, on time** (63%). Cost improved from 99% to 89% but does not meet its target on its own.

## What changed (medians per run)

| phase of a run | v0 | v1 |
|---|---|---|
| split (orchestrator reads, dispatches) | 25 s | 28 s |
| both workers working | 224 s | 154 s |
| tail (one worker done, the other still working) | 88 s | 51 s |
| check of the merged tree by the orchestrator | 29 s | 42 s |
| **total** | **376 s** | **296 s** |

- **Verification placement worked.** Workers stopped running repo-wide checks and full suites. The orchestrator's single check on the merged tree takes 13 s longer than its v0 check did, far less than the workers' checks it replaced.
- **Balancing worked where the task allowed it.** In `osc133` the orchestrator split one package (`coding-agent`) by file between both workers; in `orca` and `shift-chord` it put two smaller packages together against the larger one. In `wsl` the split stayed by package, but the durable worker no longer spent ~6 min on suites.
- **Larger tasks gain more.** The two largest tasks (orca, wsl: 10–12 min baseline) are at about half the time and 67–78% of the cost. The two smaller ones (6 min) save less, because the fixed parts (split, merge, check: about 70 s) weigh more.

## Health metrics

- **H-5 overhead share** (orchestrator cost ÷ run cost): median 15%, exactly at the limit (≤ 15%). It rose from 10% because the workers got cheaper while the orchestrator now does the repo-wide check.
- **H-3 serial fraction**: median 48% (< 25% ❌), higher than v0's 41% even though every phase got shorter. The fixed serial parts (split ~28 s, check ~42 s) plus the tail are now a larger share of a shorter run. With runs of 5 min, H-3 < 25% would need the split, the tail and the check together under 75 s. This is a target for v0.2 (the scouts in §7 and the shared-zone stubs in §13.3 shorten the split; an incremental merge check shortens the check), not a gate here.

## Cost model

Worker sessions are now shorter (25 calls, against 59 for the baseline) with the same start and growth (P 20.8 k vs 21.2 k, g 1.67 k vs 1.53 k per call). The cost ratio is still above 80% for the same reason as in report 002: the extra sessions' prefix writes and the orchestrator offset the read savings. The time gain does not depend on cost.

## Spend

v1 runs: $21.87 (12 runs, including the pilot). Phase total: $109.01 of the $120 guard (D-26) and of the $215 project cap (D-27); $105.99 is left for v0.1–v0.4.
