# 002 — v0.05 manual dry run (k = 2) — 2026-11-10

Route R.05.3–R.05.5. One orchestrator plus two workers, each a plain Pi session (Opus 5.5, thinking high, realctx as in the baseline), driven by `bench/dryrun.ts` with `prompts/v0/`. Tasks: the 4 large-parallel tasks, N = 3 each, against their 2 baseline runs. Data: `D:/rsa-bench/runs/pi-par-*/rsa-*`, `reports/bench/002-dryrun.json` (`node bench/compare.ts`).

## Result

**12 of 12 accepted** (one after rescoring: an untouched chord timer test timed out under load). No merge conflicts, no steers, no relay continuations needed; the orchestrator checked the merged tree in every run before finishing.

| task | baseline $ | rsa $ | cost ratio | baseline min | rsa min | time ratio | time ratio if balanced¹ |
|---|---|---|---|---|---|---|---|
| pi-par-orca-durable-trust | 3.31 | 2.72 | 82% | 11.8 | 7.1 | 61% | 51% |
| pi-par-osc133-npm-stale | 1.51 | 1.42 | 94% | 6.1 | 4.7 | 77% | 70% |
| pi-par-shift-chord-pnpm | 1.48 | 1.96 | 133% | 6.4 | 6.0 | 95% | 80% |
| pi-par-wsl-durable-ranking | 2.57 | 2.69 | 105% | 10.1 | 10.1 | 100% | 73% |
| **median** | | | **99%** | | | **86%** | **71%** |

¹ Same runs, with the waiting for the slower worker replaced by the mean of both workers' durations.

**G0.05 (median cost ≤ 80% or median time ≤ 75%): NO-GO as written.** H-5 overhead (orchestrator share of cost) is 10% (≤ 15% ✅). H-3 serial fraction is 41% (< 25% ❌).

## Where the time goes

Per run: split (orchestrator reads and dispatches) ~25 s, both workers in parallel, **tail** (one worker done, the other still working), merge check ~30 s.

- **Editing parallelises well.** A worker's time from its first call to its last edit is 143 s (median), against 373 s for the baseline session: two workers together spend less editing time than one session.
- **Verification does not.** The baseline verifies once at the end (121 s median after its last edit). Every worker verifies its own part (80 s median each), and slow suites dominate. In `wsl`, the durable worker had its code done after ~3.5 min, then ran the repo-wide `npm run check` and the full durable suite twice (~6 min). This comes from worker contract rule 4 ("the tests that cover the code you changed pass"). The workers read it as "run everything", and prompt v0 never says that the orchestrator checks the merged tree anyway.
- **Imbalance.** The tasks have two parts of unequal size, and the orchestrator split along them, as the prompt asked. The tail is up to 330 s (`wsl`: 250 s vs 570 s). With balanced workers the median time ratio would be 71%, just past the gate.

## Where the cost goes

Per run (mean over the 4 tasks), split by token type:

| | total | cache read | cache write | output | realctx | model calls |
|---|---|---|---|---|---|---|
| baseline | $2.21 | $0.82 | $0.54 | $0.58 | $0.28 | 59 |
| rsa | $2.19 | $0.59 | $0.74 | $0.71 | $0.15 | 68 |

- **What splitting saves, it saves as designed:** cache reads −$0.23 (each session is half as long, so the quadratic term roughly halves) and realctx −$0.13 (short sessions need almost no history work).
- **What it costs:** cache writes +$0.20 (three sessions each build their own prefix: system prompt, repository orientation, the files they read; the first three calls of each session alone cost $0.29 vs $0.08), and output +$0.13 (dispatches, Reports, two sets of summaries, more calls).
- **Why the bet is weak at this size:** cache reads cost $0.2 per million tokens, 1/25 of a cache write. The quadratic term is only a third of a 60-call session's cost, and halving it saves about as much as one extra session costs to set up.

**Cost model v1 (R.05.4).** Worker sessions have the same shape as the baseline: P 21.1 k vs 21.2 k, g 1.69 k vs 1.53 k per call, so the brief neither shortens the start nor slows the growth. The orchestrator costs about $0.25 per run. With these numbers, §15.1 predicts the k = 2 cost ratio at n = 59 calls at 104% (measured 99%), and puts a 20% saving at about **n ≈ 150 calls** per single session, 2.5× our large tasks. This is optimistic: realctx drops limit g in long sessions, which shrinks the quadratic term the bet relies on.

## What the dry run shows about the design

1. The mechanics work: split, dispatch, parallel work in separate trees, merge, check. 12 of 12 were correct, with no conflicts, and coordination overhead was within budget (H-5).
2. **The cost bet (§1, §15) does not hold for tasks of this size,** and the model says it only starts to hold for sessions about 2.5× longer.
3. **The time bet is close.** It fails here because of two things the architecture can change: verification placement (§14: workers check their own part, the orchestrator checks the merged whole once) and balanced splitting (§8 Partitioner: split by expected work, not only by package boundary).

## Spend

v0.05 runs: $23.48 (12 runs) + $3.64 of pilots that failed because of the harness. Phase total $87.14 of $100.
