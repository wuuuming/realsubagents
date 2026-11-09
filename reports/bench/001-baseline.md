# 001 — v0.0 baseline (single session) — 2026-11-10

Route R0.0.7. One Pi session (anthropic/claude-opus-5-5, thinking high, realctx `90b356c`, realctx model calls on the session model per D-24) solves each task. No subagents. Raw data: `D:/rsa-bench/runs/<task>/baseline-<n>/`. The fit is in `reports/bench/fit-v0.0.json`.

## Summary

- **32 of 32 runs accepted** (13 tasks: small N=3, large N=2, per D-21). Two runs were accepted only after rescoring, i.e. re-checking the saved diff with the fixed harness (no new agent run). See *Harness fixes*.
- **Spend:** $50.19 on the baseline runs. Total for the phase is $58.45 of the $100, including the pilot, two runs with a wrong prompt, and 2 runs on the wsl task that were discarded.
- **Cost model:** prefix growth is close to linear (median R² 0.92). Summed over a class, held-out predictions are within ±3%. But for single tasks the median error is 24%, so H-1 as written in the route (±15%) **fails**. Per-task error at this N is limited by run-to-run noise (median spread 12%). Decision D-25 is proposed below.

## Per class

| class | runs | accepted | cost median | cost total | wall median | wall max | main calls median | cache hit | realctx share |
|---|---|---|---|---|---|---|---|---|---|
| small | 18 | 18 | $0.60 | $13.13 | 4.3 min | 45.9 min¹ | 22 | 94.5% | 0% |
| large serial | 6 | 6 | $2.53 | $19.35 | 9.2 min | 14.0 min | 62 | 97.7% | 12.6% |
| large parallel | 8 | 8 | $2.13 | $17.72 | 8.5 min | 13.2 min | 58.5 | 97.1% | 11.8% |

¹ `bilinova-play-transport-types` baseline-3: one BiliNova test binary hung in the agent's background `cargo test --workspace`, and the agent waited 30 min on it (`task_wait`). Cost was normal ($0.63). The run is kept: wall clock is a metric, and this behaviour is real. The time median is barely affected.

What a large session looks like (class means from the fit): the first call already reads a cached prefix of 21–34 k tokens. The prefix then grows by about 1.5–2.1 k tokens per call. Each call adds about 2 k new tokens and writes about 0.5–0.7 k output tokens. Cost by type in large sessions: cache reads 33–44%, cache writes 19–30%, output 19–28%, realctx 11–17%. In small sessions, output and cache writes dominate.

realctx's own calls (history and memory edits, on Opus per D-24) cost about 12% of a large session and nothing in small ones (no history work in short sessions).

## Cost model fit (R0.0.6)

`src/costmodel.ts` implements the single-session part of design §15.1:
C ≈ r·(n·P + g·n(n−1)/2) + w·Δ̄·n + o·Ō·n + h·n. Prices are r = $0.2, w = $5 and o = $20 per million tokens; these were recovered exactly from the traces.

| class | P | g | Δ/call | O/call | realctx $/call |
|---|---|---|---|---|---|
| small | 15 822 | 1 927 | 2 115 | 642 | 0.0007 |
| large serial | 33 959 | 2 116 | 2 214 | 682 | 0.0061 |
| large parallel | 21 152 | 1 530 | 1 839 | 493 | 0.0049 |

**Held-out test** (`bench/fit.ts`). Each task is left out in turn, its class is fitted on the other tasks, and the task is predicted at its measured number of calls n.

| task | class | measured $ | predicted $ | error |
|---|---|---|---|---|
| bilinova-audio-source-factory | large serial | 4.88 | 3.49 | −28.5% |
| pi-extension-changelog | large serial | 2.45 | 3.46 | +41.1% |
| pi-self-update-command | large serial | 2.34 | 2.47 | +5.6% |
| pi-par-orca-durable-trust | large parallel | 3.31 | 3.16 | −4.3% |
| pi-par-osc133-npm-stale | large parallel | 1.51 | 1.53 | +1.7% |
| pi-par-shift-chord-pnpm | large parallel | 1.48 | 1.26 | −14.9% |
| pi-par-wsl-durable-ranking | large parallel | 2.57 | 2.92 | +13.9% |
| bilinova-play-transport-types | small | 0.45 | 0.58 | +28.6% |
| pi-image-resize-format | small | 0.59 | 0.74 | +25.5% |
| pi-mcp-login-local | small | 0.93 | 0.98 | +5.8% |
| pi-strip-ansi-private-csi | small | 0.43 | 0.58 | +35.5% |
| pi-tool-search-coverage | small | 0.60 | 0.74 | +23.6% |
| pi-tui-wrap-boundary | small | 1.39 | 0.73 | −47.3% |

- **Per task:** median |error| 23.6%; 6 of 13 tasks within ±15%. With one pooled fit over all classes it is 26.6%.
- **Per class (sum of held-out predictions vs. measured spend):** small −0.7%, large serial −2.6%, large parallel +0.2%, all −1.1%.
- **Noise floor:** repeated runs of the same task differ by a median of 12% (coefficient of variation, CV), up to 34%. With N = 2–3, a task's mean cost carries roughly ±7–20% of noise on its own.
- **Where the per-task error comes from:** a task's starting prefix (P: BiliNova 60 k vs. pi 12–23 k) and its output style (`pi-tui-wrap-boundary` writes 1 357 output tokens per call, twice the mean) differ from the class average. Class parameters cannot know this. Taking P, Δ and O from the first 6–10 calls of the run itself did not help (median 23–28%), because those early calls are mostly reading the repository and don't represent the rest of the session.

What this means for the design: the model is sound for the use the design makes of it, which is deciding a threshold per class (§7.2) and comparing arms over a task set (§15). It is not accurate enough to forecast the cost of one particular task before it starts. The escalation threshold should therefore be set per class from the aggregate fit, not from a per-task forecast.

## Harness fixes during the batch

All of these were harness problems, not agent failures. Each is in the route log.

1. **Withheld test new in source** (`pi-par-wsl-durable-ranking` b1 errored). The agent had created the hidden test file itself, and `git add -A -N` left an index entry that blocked `git apply --3way`. Fixed; the runner now removes the index entry too.
2. **Flaky regression test** (`pi-par-shift-chord-pnpm` b1 and b2 rejected). The chord kernel-lock test timed out at 5 s, in code the agent did not touch. Rescored on a quiet machine, both runs passed. Two changes: the D-18 flake rule (a regression check is re-run once and only failures seen twice count), and leftover-process cleanup (below).
3. **Prompts that disagreed with the hidden tests** (`pi-self-update-command`: stdout vs. stderr; `pi-par-wsl-durable-ranking`: "on POSIX" vs. cwd `/` on every platform). Prompts fixed. The 3 affected runs are kept as `invalid-prompt-*` (cost data only), and the wsl task was re-run twice; both accepted.
4. **Leftover processes.** On Windows, Pi's background tasks outlive Pi, and they load the CPU during acceptance and the next run (a likely cause of the lock test timeouts). The runner now kills the Pi process tree and any process whose command line or executable mentions the run directory before acceptance (`killLeftovers`, `result.leftoverProcesses`). This was tested on synthetic processes; it has not yet been used in an agent run.

## Proposed D-25 (needs your decision)

Redefine **H-1** as: the held-out **per-class aggregate** error is ≤ ±15% for every class, *and* the median per-task error is reported next to the noise floor. Reasons: the model's job in the design is per class, and per-task error at N = 2–3 cannot get below the noise floor (12% median, 34% max) no matter how good the model is. Under D-25, G0.0 passes: every class is within ±3%.

Alternatives:
- **Keep H-1 per task.** G0.0 fails. Getting there would need more runs per task (N ≥ 6 to halve the noise, about $50 more) and per-task features such as repository size for P. That is out of reach within the $100.
- **Accept the per-task failure as a known limit and move on.** Record it under K and proceed to v0.05.

## Next

- After the D-25 decision: G0.0 gate report (`reports/gates/G0.0.md`), then v0.05 (the first subagent arm at k = 2, the same 13 tasks).
- $41.55 of the phase budget is left.
