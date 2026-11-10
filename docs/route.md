# realsubagents: Route

Created 2026-11-09 · companion to **realsubagents Design Doc v1 (rev 2)**

The design doc says *what* to build. This route says *in what order*, *how each step is measured*, and *where things stand*. It is the single place for reporting, optimizing and tracking.

---

## 0. How to use this document

**Status legend:** ⬜ not started · 🟨 in progress · ✅ done · ⛔ blocked · ⏸ deferred · ❌ dropped

**IDs**

| Prefix | Meaning | Example |
| --- | --- | --- |
| `P0`, `v0.0` … `v0.4` | Phase | v0.2 |
| `R<phase>.<n>` | Work item | R1.6 |
| `G<phase>` | Gate (exit criteria of a phase) | G0.1 |
| `M-n` | Goal metric (the two v1 goals) | M-1 |
| `H-n` | Health metric (used for optimizing) | H-3 |
| `PR-n` | Prompt | PR-6 |
| `U-n` | Upstream dependency (realctx, realtasks) | U-4 |
| `W-n` | Windows / platform item | W-2 |
| `DD-n` | Design debt from the review | DD-1 |
| `K-n` | Risk | K-1 |
| `Q-n` | Open input or question | Q-1 |
| `D-n` | Decision | D-9 |

**Rules**

1. A work item becomes ✅ only with an **evidence link**: a commit, a test run, a benchmark report or a gate report.
2. A gate passes only with a **gate report** (§8.1). A failed gate produces a decision (D-n): fix, pivot or stop.
3. A design change updates the design doc and the decision log (§7) **in the same change**.
4. Numbers in §1 come from benchmark reports only, never from estimates. Every number has a source.
5. **Cadence:** a status entry (§8.3) at the end of every working session; a benchmark report (§8.2) per benchmark run; a gate report per phase; a tuning-log entry (§8.4) per knob change.
6. Reports live in `reports/` (`reports/bench/`, `reports/gates/`, `reports/tuning/`); this file links to them.

---

## 1. Destination: goal and health metrics

**Goal metrics** (design doc §1). The baseline is a single Pi session with realctx, same models and same task set. Each figure is the median over N runs (N = 3 for small tasks, N = 2 for large ones under the v0.0 budget, D-21), with its spread.

| ID | Metric | Target | Baseline | Latest | Status | Source |
| --- | --- | --- | --- | --- | --- | --- |
| M-1 | Small task: extra cost (USD) vs. baseline | ≤ +10% (design +3%) | — | — | ⬜ | — |
| M-2 | Large parallel, k\_eff = 2: wall-clock vs. baseline | ≤ 75% | — | — | ⬜ | — |
| M-3 | Large parallel, k\_eff ≥ 3: wall-clock vs. baseline | ≤ 60% | — | — | ⬜ | — |
| M-4 | Large parallel: cost vs. baseline | ≤ 80% | — | — | ⬜ | — |
| M-5 | Large serial: cost; wall-clock vs. baseline | ≤ 105%; ≤ 100% | — | — | ⬜ | — |
| M-6 | Task success rate (acceptance command passes) | ≥ baseline | — | — | ⬜ | — |

**Health metrics** (what to watch and tune; targets are initial and revised by decision)

| ID | Metric | Initial target | First measured | Latest | Source |
| --- | --- | --- | --- | --- | --- |
| H-1 | Cost-model prediction error (held-out, per-class aggregate; D-25) | within ±15% | v0.0 | per task: median 23.6% (6/13 within); per class aggregate: −0.7% / −2.6% / +0.2%; noise floor (within-task CV) 12% | ✅ (D-25) |
| H-2 | Prompt-cache hit rate (cache read ÷ total input), per role | ≥ 90% | v0.0 | — | — |
| H-3 | Serial fraction of parallel runs | < 25% | v0.05 | — | — |
| H-4a | Missed escalations (direct tasks that compacted or passed break-even) | ≤ 10% | v0.1 | — | — |
| H-4b | False hints (escalated tasks that ran as one lane and finished under break-even) | ≤ 20% | v0.1 | — | — |
| H-5 | Overhead share: C\_overhead ÷ C\_rsa (design doc §15.1) | ≤ 15% | v0.05 | — | — |
| H-6 | Review quality: false accepts / needs\_human rate | 0 / ≤ 15% | v0.1 | — | — |
| H-7 | Scope violations; builds broken by another group's work in progress | 0; 0 | v0.2 | — | — |
| H-8 | Tasks blocked on a shared-zone (hub) file | 0 | v0.2 | — | — |
| H-9 | Test runs per merged item (merge train) | ≤ 0.5 | v0.2 | — | — |
| H-10 | Kill-and-recover test pass rate | 100% | v0.1 | — | — |
| H-11 | Scout share of exploration tokens; strong-model context growth g\_w ÷ g | track; < 0.6 | v0.1 | — | — |

---

## 2. Route at a glance

```text
P0 Prep ──► v0.0 Benchmark + cost model ──► v0.05 Manual dry run ──►◆ GO / NO-GO
                                                                     │
        ┌────────────────────────────────────────────────────────────┘
        ▼
      v0.1 Skeleton ──► v0.2 Parallel ──► v0.3 Lanes + variants ──► v0.4 Regrouping ──► Later: Multica

Parallel tracks, all phases:  T-P Prompts · T-U Upstream · T-W Windows · T-D Design debt
```

| Phase | Objective | Depends on | Gate | Status |
| --- | --- | --- | --- | --- |
| P0 | Inputs decided, repository scaffolded, extension loads in Pi | — | G0 | ✅ [G0](../reports/gates/G0.md) |
| v0.0 | Baseline numbers and a fitted cost model | P0 | G0.0 | ✅ |
| v0.05 | Prove the main bet by hand before building infrastructure | v0.0 | G0.05 (go / no-go) | ⬜ |
| v0.1 | One group, in-process, request → accepted; small tasks cheap | v0.05 = GO | G0.1 | ⬜ |
| v0.2 | Several groups in parallel; hits the large-parallel targets | v0.1 | G0.2 | ⬜ |
| v0.3 | Lanes (parallelism inside a group) and variants | v0.2 | G0.3 | ⬜ |
| v0.4 | Split, merge, migrate, retire | v0.3 | G0.4 | ⬜ |
| Later | Run under Multica | v0.4 | — | ⏸ |

---

## 3. Phases

### P0 — Prep

**Objective:** everything needed to start measuring.

| ID | Item | Deliverable | Status | Evidence |
| --- | --- | --- | --- | --- |
| R0.1 | Answer the open inputs Q-1 … Q-7 (§7.2) | Decisions D-n recorded | ✅ | Q-1 … Q-7 answered 2026-11-09; D-9, D-12 … D-16 |
| R0.2 | Scaffold the repository: `git init`; TypeScript Pi package (`package.json` with `pi.extensions`, peer dependency `@earendil-works/pi-coding-agent` 1.5.0, `tsconfig`, `node --test`); folders `extensions/realsubagents/`, `src/`, `bench/`, `prompts/`, `reports/`, `docs/` (move the design doc and this route into `docs/`) | Repository builds, typecheck passes | ✅ | `86d78c8`; `npm run typecheck`, `npm test` 1/1 |
| R0.3 | Dev loop: load the extension with `pi -e ./extensions/realsubagents/index.ts`; a no-op `/rsa` command responds | Smoke test | ✅ | `86d78c8`; `npm run smoke` → `SMOKE OK: pi 1.5.0 (managed)` |
| R0.4 | Windows checks (T-W): Dev Drive available? `git worktree add` time and disk use on the benchmark repositories; Git Bash on PATH for child processes | W-1 … W-4 filled in | ✅ | W-1 … W-4 done; tree population measured (W-7, W-8) → D-17 |

**G0:** the repository builds and typechecks, the extension loads in Pi, and Q-1 … Q-7 are decided.

### v0.0 — Benchmark and cost model

**Objective:** baseline numbers for every task class, and a cost model that predicts them (design doc §15.1).

| ID | Item | Deliverable | Status | Evidence |
| --- | --- | --- | --- | --- |
| R0.0.1 | Task set (D-21): 6 small, 3 large serial, 4 large parallel (≥ 2 with k ≥ 3), over 2 repositories, each frozen at a commit with an acceptance command | `bench/tasks/<id>/task.json` + `prompt.md` (D-19) | ✅ | 13 tasks (6 small, 3 large serial, 4 large parallel), all validated base ✗ / reference ✓ (`bench/validate.sh`) |
| R0.0.2 | Runner: headless baseline runs (`pi --mode json` or RPC) with realctx on, in a fresh worktree at the frozen commit plus the repository's tree setup (D-15), isolated per D-14, N per D-21, per-run spend cap, phase budget guard | `bench/run.ts` | ✅ | `bench/run.ts` (+ `task.ts`, `sh.ts`, `repos.json`); modes agent / base / reference; pilot run accepted, [report](../reports/bench/pilot-2026-11-09.md) |
| R0.0.3 | Meter: read the session file: assistant-message `usage` **and** `usage` entries of kind `cache_warm`. Cost per role, four raw token counts, wall-clock, turns, compactions | `bench/meter.ts`, one JSON per run | ✅ | `bench/meter.ts` (assistant `usage`, `usage` entries, compaction `usage`, extension calls via `rsa-usage` entries + sidecar; per role / model, H-2 cache hit rate, turns, compactions); `tests/meter.test.ts` 4/4; `bench/usage-probe.ts` against Pi 1.5.0 → `USAGE PROBE OK` |
| R0.0.4 | Acceptance check after each run; failed runs reported separately | Success rate per task (M-6) | ✅ | `bench/regression.ts`: named tests + full suite vs. baseline failure list (cargo, vitest JSON, node TAP); `tests/regression.test.ts` |
| R0.0.5 | Trace extraction per turn: context length, new tokens Δ, output O, cold restarts | `bench/traces/` | ✅ | Extractor done in `bench/meter.ts --trace` (ctx, Δ, O, cold restarts, after-compaction per call); traces land in `bench/traces/` once runs exist |
| R0.0.6 | Cost model: implementation and fitting (P, g, Δ, O per class; cold-restart rate); held-out error | `src/costmodel.ts`, `bench/fit.ts` | ✅ | 32 runs; prices recovered from traces; prefix growth R² median 0.92; fit in `reports/bench/fit-v0.0.json` |
| R0.0.7 | Benchmark report #1 (baseline) | `reports/bench/001-baseline.md` | ✅ | 32/32 accepted, $50.19 |

**G0.0:** every task has its N baseline runs (D-21) with spread reported; total spend ≤ $100; H-1 within ±15% on held-out tasks, measured per class (D-25).

### v0.05 — Manual dry run (go / no-go)

**Objective:** test the main bet (module-scoped workers beat one session on multi-group tasks) with almost no code.

| ID | Item | Deliverable | Status | Evidence |
| --- | --- | --- | --- | --- |
| R.05.1 | Prompts v0: PR-4 brief, PR-5 dispatch, PR-6 worker contract, PR-7 Report | `prompts/v0/` | ⬜ | |
| R.05.2 | Relay script: one orchestrator session and two `pi --mode rpc` workers in two worktrees; the script relays dispatch and Reports and merges at the end | `bench/dryrun.ts` | ⬜ | |
| R.05.3 | Run ≥ 4 large parallel tasks, N = 3 | Runs metered as in v0.0 | ⬜ | |
| R.05.4 | Fit g\_w and per-Report, per-brief overhead; update the cost model | Cost model v1 | ⬜ | |
| R.05.5 | Dry-run report and go / no-go decision | `reports/gates/v0.05.md`, D-n | ⬜ | |

Time is measured as the critical path of model and tool time; relay latency counts as zero and is noted.

**G0.05:** median ≤ 80% cost **or** ≤ 75% time at k = 2.
**If NO-GO, pivot options:** (a) keep only scouts plus lanes in a single session; (b) ship scouts alone as a small extension; (c) stop and write up. The choice is recorded as D-n.

### v0.1 — Skeleton

**Objective:** one group, in-process: a real request goes to accepted, survives a kill, and small tasks stay cheap.

| ID | Item | Deliverable | Status | Evidence |
| --- | --- | --- | --- | --- |
| R1.1 | StateStore: `node:sqlite` (as realctx uses), WAL, lease lock, events + projections in one transaction, consumer cursors, forward-only migrations | `src/store/` with tests | ⬜ | |
| R1.2 | Event catalog subset for v0.1; projections; `/rsa rebuild` | Replay test: rebuilt state = live state | ⬜ | |
| R1.3 | GroupRuntime `inProcess`: SDK sessions with per-session role options | `src/runtime/inprocess.ts` | ⬜ | |
| R1.4 | Dispatcher: create, dispatch, steer, resume, cancel, escalate | Precondition tests | ⬜ | |
| R1.5 | ReportBus: exactly-once latch, 300 ms coalescing, wake / passive / silent delivery | Delivery tests | ⬜ | |
| R1.6 | EscalationMonitor, `rsa_escalate`, `setActiveTools` tool surface, escalation hint, historian brief | Small-task overhead measured | ⬜ | |
| R1.7 | Member role: Heartbeat, `rsa_report`, `rsa_ask`, member prompt | | ⬜ | |
| R1.8 | Scouts: `rsa_scout` on the cheap model, findings with references | H-11 measured | ⬜ | |
| R1.9 | ReviewPipeline v1: tests in a review worktree plus the completion judge (realctx `SemIfClient`, `src/api.ts`) | H-6 measured | ⬜ | |
| R1.10 | Crash and restart: kill `pi` mid-task, rebuild, resume (fixes DD-1) | H-10 test | ⬜ | |
| R1.11 | Prompts v1: PR-1, PR-2, PR-3, PR-8 (review reject), PR-9, PR-10, PR-11 | `prompts/v1/` with evaluations | ⬜ | |
| R1.12 | `/rsa` panel and dock (minimal) | | ⬜ | |
| R1.13 | Benchmark: all small tasks plus the large serial tasks | `reports/bench/00x-v0.1.md` | ⬜ | |

**G0.1:** a real request reaches accepted end-to-end and survives killing `pi`; M-1 ≤ +10%; H-4a and H-4b logged; H-10 = 100%; all tests green.

### v0.2 — Parallel

**Objective:** several groups as processes, in their own trees, hitting the large-parallel targets.

| ID | Item | Deliverable | Status | Evidence |
| --- | --- | --- | --- | --- |
| R2.1 | Partitioner: atoms (npm/pnpm workspaces and Cargo first, directories as fallback), co-change and static edges, clustering, choice of k; G0 review (PR-12); `rsa_map_write`; `/rsa bootstrap` | Partitions of the benchmark repositories | ⬜ | |
| R2.2 | GroupRuntime `subprocess` (`pi --mode rpc`), re-adoption by PID and start time | Kill test per group | ⬜ | |
| R2.3 | SandboxManager: worktrees, copy-on-write detection (Dev Drive), shared caches, sync at task boundaries plus the changed-paths steer (PR-8) | | ⬜ | |
| R2.4 | ScopeGuard: three-way write classification, shared patches, case-insensitive Windows path matching (W-5) | H-7 | ⬜ | |
| R2.5 | MergeQueue: merge train, bisection, shared-patch rules (npm/pnpm first), `/rsa land` | H-9 | ⬜ | |
| R2.6 | Watchdog | Alert tests | ⬜ | |
| R2.7 | Pipelined review; affected-test selection | | ⬜ | |
| R2.8 | G0 cross-group work: on-demand consults (PR-13), plan and stubs (PR-14), approval policy, parent tasks, integration review | H-3 | ⬜ | |
| R2.9 | Build queue with a concurrency cap (U-9 or local semaphore) | | ⬜ | |
| R2.10 | Judges: scope and merge risk (PR-15) | | ⬜ | |
| R2.11 | Benchmark: all large parallel tasks | `reports/bench/00x-v0.2.md` | ⬜ | |

**G0.2:** three groups work in parallel; H-7 = 0 / 0; H-8 = 0; M-2, M-3 and M-4 met; H-3 < 25%.

### v0.3 — Lanes and variants

| ID | Item | Deliverable | Status | Evidence |
| --- | --- | --- | --- | --- |
| R3.1 | Lane candidates (Partitioner); `rsa_lane_plan` (PR-16) | | ⬜ | |
| R3.2 | Fork into n sessions. Pi's `fork` replaces the active session, so copy session files and open n sessions | `GroupRuntime.fork` | ⬜ | |
| R3.3 | Lane worktrees, lane review, parent join | | ⬜ | |
| R3.4 | Variants: one worktree per variant; judging by tests, then semif; ties go to the user | | ⬜ | |
| R3.5 | Benchmark: large serial tasks plus the lane-splittable subset | | ⬜ | |

**G0.3:** M-5 met; lane-split tasks meet M-2 or M-3 and M-4; one full two-variant decision completes.

### v0.4 — Regrouping

| ID | Item | Deliverable | Status | Evidence |
| --- | --- | --- | --- | --- |
| R4.1 | Split and merge (historian merge brief, PR-17) | | ⬜ | |
| R4.2 | Migrate (realctx `paths.autoRename`) and retire | | ⬜ | |
| R4.3 | Re-partition triggered by the cross-group task rate | | ⬜ | |
| R4.4 | Reversal test: undo every regroup operation | | ⬜ | |

**G0.4:** a regroup loses no memory or journal entries, and every regroup can be reversed.

---

## 4. Cross-cutting tracks

### T-P Prompts

Every prompt ships with an evaluation: a fixture set, its output length (output tokens are the most expensive kind) and its task outcome. Versions live in `prompts/v<n>/`.

| ID | Prompt | First needed | Version | Status | Evaluation |
| --- | --- | --- | --- | --- | --- |
| PR-1 | Orchestrator system prompt (byte-identical, short) | v0.1 | — | ⬜ | M-1, hint follow-through |
| PR-2 | `rsa_escalate` tool description (≤ 300 tokens) | v0.1 | — | ⬜ | M-1 |
| PR-3 | Escalation hint text | v0.1 | — | ⬜ | H-4a, H-4b |
| PR-4 | Historian escalation brief | v0.05 | — | ⬜ | Worker success; brief length |
| PR-5 | Dispatch message: goal, acceptance, paths, brief, budget | v0.05 | — | ⬜ | Worker success |
| PR-6 | Worker member prompt (design doc §6 worker contract) | v0.05 | — | ⬜ | Scope violations, Report quality |
| PR-7 | Report guidance: when to report, 3-line summary, choosing evidence | v0.05 | — | ⬜ | H-5, references followable |
| PR-8 | Steers: review reject, watchdog stall / loop, merge failed, sync changed paths | v0.1 / v0.2 | — | ⬜ | Recovery rate |
| PR-9 | Wake-notification format, coalesced rendering | v0.1 | — | ⬜ | Orchestrator decision quality |
| PR-10 | Scout prompt and finding format | v0.1 | — | ⬜ | H-11, finding accuracy |
| PR-11 | Completion judge question set | v0.1 | — | ⬜ | H-6 on a labelled set |
| PR-12 | G0 bootstrap: partition review, criteria, shared-zone kinds | v0.2 | — | ⬜ | User acceptance of the partition |
| PR-13 | G0 consult question and reply schema | v0.2 | — | ⬜ | H-3 |
| PR-14 | G0 cross-group plan and stubs | v0.2 | — | ⬜ | Integration review pass rate |
| PR-15 | Scope and merge-risk judges | v0.2 | — | ⬜ | Labelled set |
| PR-16 | Lane plan; variant directions | v0.3 | — | ⬜ | Lane success |
| PR-17 | Historian merge brief (group merge) | v0.4 | — | ⬜ | No loss in a recall test |

### T-U Upstream dependencies

realctx (WtzLAS) and realtasks (st0nie) are third-party packages, installed locally under `~/.pi/agent/git/github.com/`. **Strategy: build an adapter in realsubagents first (`src/adapters/`), send upstream PRs in parallel, and never block a gate on an upstream merge.**

| ID | Change (design doc §17.1) | Needed by | Interim workaround | Status |
| --- | --- | --- | --- | --- |
| U-1 | realctx: capture budget scope per group | v0.2 | One group in v0.1 needs nothing; v0.2 accepts some starvation and measures it | ⬜ |
| U-2 | realctx: member and helper subagent kinds | v0.1 | Workers run as ordinary realctx sessions; scouts use own cheap-model sessions | ⬜ |
| U-3 | realctx: search other sessions' dropped outputs within a group | v0.1 | `rsa_recall` reads Pi session files directly by reference | ⬜ |
| U-4 | realctx: new judge question sets | v0.1 | Call `SemIfClient` (realctx `src/api.ts`) with our own question sets | ⬜ |
| U-5 | realctx: library API for remember, recall, judge | v0.1 | Import realctx `src/` modules through the adapter; pin a commit | ⬜ |
| U-6 | realtasks: reusable exactly-once latch | v0.1 | Reimplement the latch (small) | ⬜ |
| U-7 | realtasks: reusable spawn and re-adoption | v0.2 | Port `src/proc.ts` logic into the adapter | ⬜ |
| U-8 | realtasks: cross-session task logs | v0.2 | Not needed: review runs tests itself | ⬜ |
| U-9 | realtasks: shared build queue | v0.2 | Local semaphore in realsubagents | ⬜ |
| U-10 | Pi: an extension API to record model usage in the session (`SessionManager.appendUsage` exists but extensions only get `ReadonlySessionManager`); realctx: record its historian and rewrite calls with it. Today their cost is missing from the session file, so the meter (R0.0.3) under-counts realctx's background spend | v0.0 | Benchmark-only extension that wraps `ModelRegistry.prototype.complete` / `streamSimple` and appends usage to a sidecar JSONL per run, which the meter adds | 🟨 workaround: `extensions/rsa-bench-usage` |
| U-11 | realctx: per-process settings overlay for Context and History, sharing one memory store (design §17.1) | v0.1 | Benchmark: per-run `REALCTX_HOME` with explicit settings (D-23); v0.1 runs every role on the same settings | ⬜ |
| U-12 | realctx: cache lifetime from `PI_CACHE_RETENTION`; resolved lifetime in the library (design §17.1) | v0.1 | Set `context.cacheTtlByModel` to match the retention a process uses; read the same value in realsubagents | ⬜ |

### T-W Windows and platform

| ID | Item | Phase | Status |
| --- | --- | --- | --- |
| W-1 | Dev Drive (ReFS) available for worktrees? Block cloning works? **2026-11-09:** none; C: and D: are NTFS. Windows build 26200 supports Dev Drive; creating one needs admin (Q-6). Until then, plain worktrees | P0 | ✅ |
| W-2 | `git worktree add` time and disk use on the benchmark repositories. **2026-11-09:** BiliNova 2.3 s (1,860 files; source 90 MB), pi 2.3 s (2,949 files; source 41 MB), NTFS, D:. Source is 1–7% of a built tree; the cost is build outputs (BiliNova `target/` 7.0 GB) and dependencies (pi `node_modules` 474 MB) → D-17 | P0 | ✅ |
| W-3 | Git Bash for child `pi` processes. **2026-11-09:** Pi resolves `%ProgramFiles%\Git\bin\bash.exe` itself (docs/windows.md), and realtasks' bash uses Pi's `getShellConfig()`. Child processes are started as `node <cli.js>` (`src/pi-cli.ts`), not through the `pi` launcher | P0 | ✅ |
| W-4 | Shared build caches. **2026-11-09:** present: cargo, dotnet, uv, npm; absent: pnpm, sccache, Bazel, Gradle, Go. The benchmark repositories need Cargo (registry already global) and npm (no store: covered by W-8) | P0 / v0.2 | ✅ |
| W-7 | Tier B seeding for Cargo (`experiments/tree-seeding/run-cargo.sh`). **2026-11-09, BiliNova:** seeding 2.4 s (734 files / 2.7 GB linked, files < 64 KB copied); first build compiles only the 11 workspace crates (31 s); base unchanged (0 of 734 linked files). `target/` per tree 4.3 GB (naive 7.0 GB); with `profile.dev.package.<member>.debug="line-tables-only"` for workspace members only: 3.3 GB, 25 s, tests identical to the base (1,202 passed, 4 baseline failures). A global debug setting would change third-party hashes and lose the reuse. Quirk: BiliNova's `build.rs` watches `.git/commondir`, which exists only in worktrees, so the user's tree rebuilds 2 crates on every build, seeding or not | P0 | ✅ |
| W-8 | Tier B seeding for npm workspaces (`experiments/tree-seeding/run-npm.sh`). **2026-11-09, pi:** seeding 8 s (`npm ci`: 64 s), `node_modules` 4.1 MB per tree (naive 474 MB), 16 workspace links re-pointed; offline build 14 s; `agent` 94/94 and `ai` identical to the base (30 baseline failures); base unchanged (0 of 20,756). Found: vitest writes `node_modules/.vite/**/results.json` in place, so dot-directories in `node_modules` (except `.bin`) are skipped, never linked. Tree setup for pi: copy the git-ignored `packages/ai/src/providers/data/` and build with `build:offline` (the online build fetches model catalogs and failed once on a timeout) | P0 | ✅ |
| W-9 | Tier A probe (copy-on-write) on a volume that has it: ReFS / Dev Drive here, or btrfs / APFS elsewhere. Not testable on this machine (W-1) | v0.2 | ⬜ |
| W-5 | Case-insensitive paths and `\` vs `/` in ScopeGuard and path sets | v0.2 | ⬜ |
| W-6 | Process re-adoption on Windows (PID plus start time) | v0.2 | ⬜ |

### T-D Design debt (non-critical review findings)

| ID | Item | Fix by | Status |
| --- | --- | --- | --- |
| DD-1 | Crash recovery contradicts itself: §11 says running tasks go to `blocked`, §16 says back to their pre-dispatch state; choose one | v0.1 | ⬜ |
| DD-2 | Missing `review → failed` and `blocked → failed` transitions; reword "exactly one event type per transition" | v0.1 | ⬜ |
| DD-3 | Resume-or-fresh policy for idle workers once their cache is cold (`cache_warming_decision` hook). Options now include long retention (`PI_CACHE_RETENTION=long`, 1 h, write at 2× base) for workers likely to be resumed; the policy must use the lifetime realctx resolves (U-12) | v0.1 | ⬜ |
| DD-4 | Precedence of ScopeGuard, Watchdog and the review diff check | v0.2 | ⬜ |
| DD-5 | Who writes acceptance tests (G0 in the contract subtask, or the worker first) | v0.2 | ⬜ |
| DD-6 | Redraw the topology and module diagrams for rev 2 | Any time | ⬜ |
| DD-7 | Verify that the sync steer covers direct orchestrator edits to a group's paths | v0.2 | ⬜ |

---

## 5. Optimization loop

Change **one knob at a time**, run the relevant benchmark subset (N = 3), and write a tuning-log entry (§8.4). Keep a change only if the median improves beyond the interquartile range and no goal metric regresses.

| Knob | Location | Tuned from | First tuned |
| --- | --- | --- | --- |
| Escalation threshold and signal thresholds | EscalationMonitor, project map | H-4a, H-4b, M-1 | v0.1 |
| Hint repetition rule | EscalationMonitor | H-4b, M-1 | v0.1 |
| Orchestrator tool-surface size | §7.2, PR-1, PR-2 | M-1 | v0.1 |
| Brief and Report length | PR-4, PR-7 | H-5 | v0.05 |
| Scout policy and cheap-model choice | PR-10, config | H-11, M-5 | v0.1 |
| Resume vs. fresh worker session | DD-3 | H-2, cost | v0.1 |
| Judge confidence thresholds | ReviewPipeline | H-6 | v0.1 |
| Consult deadline | G0 | H-3 | v0.2 |
| Approval-policy thresholds | §8.1 | H-3, veto rate | v0.2 |
| Merge-train batch size | MergeQueue | H-9, time | v0.2 |
| realctx Context/History settings per role (protect turns, apply threshold and ceiling, history prepare threshold) | U-11 | Cost per task, g\_w | v0.1 |
| Build-queue cap | config | Time, CPU | v0.2 |
| Partition cross-group ratio (15%) and k | Partitioner | Rate of cross-group tasks | v0.2 |
| Watchdog thresholds | Watchdog | False-alert rate | v0.2 |
| Lane cut threshold (15%) | Partitioner | Lane success, M-5 | v0.3 |

---

## 6. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner phase |
| --- | --- | --- | --- | --- | --- |
| K-1 | The gains do not appear at k = 2 | Medium | High | v0.05 go / no-go before any infrastructure | v0.05 |
| K-2 | The Pi API changes after 1.5.0 | Medium | Medium | Pin the peer dependency; keep Pi calls behind GroupRuntime | all |
| K-3 | Upstream does not accept the realctx / realtasks changes | Medium | Medium | Adapters (T-U); vendor if needed | all |
| K-4 | Worktrees on Windows without a Dev Drive are too slow or too large | Medium | Medium | Measured (W-2): source is cheap, build outputs are the cost. Tier B seeding (W-7, W-8), tree pool, disk budget (D-17) | P0, v0.2 |
| K-11 | A tool writes through a hard link and silently changes the base tree | Low | High | Small files copied, not linked; per-toolchain adapters only; the seed manifest check (`verify`) runs in the adapter's test and after benchmark runs | P0, v0.2 |
| K-12 | A realctx update changes defaults or behaviour mid-phase (v3 reset all Context/History settings) and breaks comparability of runs | Medium | Medium | Pin the realctx commit per phase (`bench/pins.json`), write explicit settings per run, refit the cost model on a change (D-23) | v0.0 |
| K-5 | Benchmark noise from nondeterministic models | High | Medium | N = 3, medians and IQR, fixed commits | v0.0 |
| K-6 | Provider rate limits when workers run in parallel | Medium | High | Measure; per-group providers | v0.2 |
| K-7 | The judge is miscalibrated | Medium | Medium | Labelled set; needs\_human fallback | v0.1 |
| K-8 | Shared-patch rules break lockfiles | Medium | Medium | v0.2 supports npm/pnpm only; regenerate, never merge as text | v0.2 |
| K-9 | Benchmark spend overruns | Medium | Low | Spend cap per run and per phase (Q-3) | v0.0 |
| K-10 | The orchestrator ignores or overuses escalation | Medium | Medium | PR-1 / PR-3 evaluations; H-4a and H-4b | v0.1 |

---

## 7. Decisions and open inputs

### 7.1 Decision log

| ID | Date | Decision | Source |
| --- | --- | --- | --- |
| D-1 | 2026-11-09 | Cost is measured in USD from Pi's per-message usage; raw tokens are reported per role; fixed token weights are not used | Design doc rev 2, §1, §15 |
| D-2 | 2026-11-09 | No up-front classification; escalation is hinted by observing the work | §7.2 |
| D-3 | 2026-11-09 | One worktree per group (and lane and variant); shared build caches; sync at task boundaries | §13 |
| D-4 | 2026-11-09 | Shared zone: mechanical files become shared patches; semantic files use optimistic contracts | §13.3 |
| D-5 | 2026-11-09 | One writer per path set; lanes and scouts | §7.4, §7.5 |
| D-6 | 2026-11-09 | Approval by policy, pipelined review, merge train with bisection | §8.1 |
| D-7 | 2026-11-09 | Time targets follow Amdahl's law; large serial tasks have a no-regression target | §1 |
| D-8 | 2026-11-09 | Phasing: v0.05 dry run added; cross-group work moved to v0.2 | §17.2 |
| D-9 | 2026-11-09 | Repository at `D:/Projects/realsubagents`, remote `wuuuming/realsubagents`, branch `main`; commits authored by GitHub account `wuuuming` (no-reply email, repo-local config) | Q-5, user |
| D-10 | 2026-11-09 | Plain TypeScript run by Node type stripping (no build step), `node --test`, TypeScript 7 for typechecking; Pi 1.5.0 pinned in devDependencies, `*` peer dependencies (as realctx) | R0.2 |
| D-11 | 2026-11-09 | Child Pi processes are started as `node <cli.js> --mode rpc` via `src/pi-cli.ts` (managed install → local package; `RSA_PI_CLI` override), one OS process per member | R0.3, W-3 |
| D-12 | 2026-11-09 | Benchmark repositories: **BiliNova** (Rust workspace, 9 crates, Windows-native; frozen at `d65d4bd`) and **earendil-works/pi** (TypeScript npm workspaces, 12 packages; frozen at tag `v1.5.0`, `f9a2636`). Clones in `D:/rsa-bench/repos/` (outside this repository) | Q-1 |
| D-13 | 2026-11-09 | Models: strong `claude-opus-5-5` (orchestrator, G0, workers, baseline); cheap `claude-haiku-5-5` (scouts, historian); semif as configured in realctx. Spend cap $5 per run, $150 per phase; a run that hits the cap counts as failed. Anthropic access is a subscription, so USD is computed from Pi's list prices | Q-2, Q-3 |
| D-14 | 2026-11-09 | Benchmark isolation: the normal agent dir (so `auth.json`, with its rotating OAuth refresh token, is never copied); `--no-extensions` plus explicit `-e` for realctx and realtasks only (both arms identical); a fresh `REALCTX_HOME` per run with a copy of realctx's `config.json`; a per-run `--session-dir`. No memories carry over between runs | R0.0.2 |
| D-15 | 2026-11-09 | Tree setup: untracked build prerequisites are linked (read-only) or copied (generated, small) into every new tree (design doc §13.1). BiliNova: junctions for `native/` (424 MB FFmpeg / libplacebo SDKs) and `native-audio/`; `player-core`'s build script fails without them. pi: copy `packages/ai/src/providers/data/` (1.1 MB), build with `build:offline` | W-2, W-8 |
| D-17 | 2026-11-09 | Tree population (design doc §13.1): Tier A copy-on-write clone where the volume supports it; otherwise Tier B: worktree + linked prerequisites + hard-linked immutable dependencies and third-party build outputs (per-toolchain adapter, small files copied) + own build outputs; trees pooled by concurrent writers, recycled after merge, capped by a disk budget. Sparse-checkout dropped as the default (source is 1–7% of a tree) | W-2, W-7, W-8, K-4 |
| D-18 | 2026-11-09 | Benchmark acceptance never uses a repository's full test suite as is: at the frozen commits BiliNova has 4 failing tests (of 1,221) and pi on Windows ~1,040 failing tests in 8 of 12 packages. Acceptance = the task's named tests pass, plus no test outside the baseline failure list fails | R0.0.1, R0.0.4 |
| D-16 | 2026-11-09 | Defaults accepted: adapters plus upstream PRs (Q-4); plain worktrees on NTFS, no Dev Drive (Q-6); the v0.05 relay is a script (Q-7) | Q-4, Q-6, Q-7 |
| D-19 | 2026-11-09 | Task format and validation: a task is reconstructed from a historical commit (`source`) at its parent (`base`); the commit's tests are withheld and checked out only at acceptance; `prompt.md` states the problem as the issue did, not the fix. A task enters the set only if `--mode base` is rejected and `--mode reference` (the historical change) is accepted; the reference run writes the regression baseline list | R0.0.1, R0.0.4 |
| D-20 | 2026-11-09 | *(superseded by D-24)* realctx's own model calls in benchmark runs (historian `history.model` and memory edit/merge `rewriteModel`, which otherwise fall back to the session model) use `anthropic/claude-haiku-5-5`, per D-13; the runner sets both in the per-run config. The user's `history.model` (`openai/gpt-6-luna`) is not used in benchmarks | D-13; pilot found rewrites on opus |
| D-21 | 2026-11-09 | v0.0 budget $100 in total (the pilot included). Task set cut to 6 small (N = 3), 3 large serial (N = 2), 4 large parallel (N = 2); about $81 estimated, rest is reserve. One large task is run first and the counts re-planned from its cost. `bench/run.ts` refuses an agent run when spend so far plus the per-run cap would exceed the phase budget. Replaces D-13's $150 per phase for v0.0 | User, 2026-11-09 |
| D-22 | 2026-11-09 | Task set sources. pi gives 5 small, 2 large serial and all 4 large parallel tasks; BiliNova gives 1 small (`2667a4b`) and 1 large serial (`f07e0d0`). BiliNova's history after the 07-26 checkpoint has few commits with tests that fail at their parent, and the rest need a GPU (`5dba678`) or are tests without a source change (`9e0dcdd`). `bilinova-audio-source-factory` is accepted on its factory contract tests only; its session refactor is checked by the regression suite alone, so its pass rate says less than the others'. Large parallel tasks are composites (D-19 `parts`) of independent historical fixes in different packages, on a common base that every part's diff applies to; `CHANGELOG.md` files are left out of every reference diff because they make parts conflict and are not part of a task | R0.0.1 |
| D-23 | 2026-11-09 | realctx settings schema v3 (upstream `90b356c`): on load, a config older than v3 has its Context and History sections reset to new defaults (protect 24 turns, apply at 40% with no ceiling, history at 30%, emergency 80%, no size floors) and the cache lifetime is resolved per model, with an optional daily fetch from models.dev. Benchmark: realctx pinned to `90b356c` in `bench/pins.json` (the runner refuses agent runs on another commit unless `RSA_ALLOW_DRIFT=1`); the per-run config takes only endpoints and models from the user's config, sets `version: 3`, uses v3 defaults for Context and History, turns `cacheTtlAuto` off and sets a 5 m lifetime for the session model, so runs neither depend on the user's settings nor on the network. The pilot ran on `12f7cad` with the user's v2 settings (apply at 65%, protect 4 turns) and is not pooled with the baselines. Design rev 2.1 (§15, §15.1, §17.1) | R0.0.2 |
| D-24 | 2026-11-09 | Supersedes D-20 (user's choice). realctx's own model calls in benchmark runs (`rewriteModel`, `history.model`) are left empty, so they use the session model, as in the user's own setup (the user does not want haiku as historian). `RSA_REALCTX_MODEL` still overrides. Costs more per run; the meter shows these calls under caller `realctx` | user, 2026-11-09 |
| D-25 | 2026-11-10 | H-1 is measured per class: the sum of held-out predictions vs. measured spend must be within ±15% for every class; the median per-task error is reported next to the noise floor (within-task CV). Reason: the model is used per class (§7.2 threshold, §15 arm comparison), and per-task error at N = 2–3 is bounded below by run-to-run noise (12% median, 34% max). | `reports/bench/001-baseline.md` |

### 7.2 Open inputs (needed before or during P0)

| ID | Question | Needed by | Answer |
| --- | --- | --- | --- |
| Q-1 | Benchmark repositories: 2–3 real repositories, at least one monorepo with workspaces and one with ≥ 3 natural modules | v0.0 | BiliNova + earendil-works/pi (D-12) |
| Q-2 | Models: the strong model (orchestrator, G0, worker) and the cheap model (semif, historian, scouts) | v0.0 | Opus 5.5 + Haiku 5.5 (D-13) |
| Q-3 | Benchmark spend cap in USD, per run and per phase | v0.0 | $5 / run (D-13); v0.0 phase $100 (D-21) |
| Q-4 | Upstream strategy: adapters plus upstream PRs (recommended), a fork, or adapters only | v0.1 | Adapters plus upstream PRs (D-16) |
| Q-5 | Repository: `D:/Projects/realsubagents` as the package root? A git remote? | P0 | **Answered 2026-11-09:** yes; remote https://github.com/wuuuming/realsubagents (public), commits authored as `wuuuming` (D-9) |
| Q-6 | Is a Dev Drive available, or can one be created? | P0 | No; plain worktrees for now (D-16) |
| Q-7 | v0.05 relay: a script (recommended, reproducible) or driven by hand | v0.05 | Script (D-16) |

---

## 8. Report templates

### 8.1 Gate report — `reports/gates/<phase>.md`

```markdown
# Gate <G-id> — <phase> — <date>
Result: PASS | FAIL | PASS WITH WAIVER
## Criteria
| Criterion | Target | Measured | Source | Pass |
## Goal and health metrics changed in this phase
| ID | Before | After | Source |
## Evidence
- commits, test runs, benchmark reports
## Waivers and known gaps
## Decisions taken (D-n)
## Next phase: entry conditions met?
```

### 8.2 Benchmark report — `reports/bench/<nnn>-<label>.md`

```markdown
# Benchmark <nnn> — <label> — <date>
Code: <commit> · Pi: 1.5.0 · realctx: <commit> · Models: strong=<id>, cheap=<id>
Task set: <version> · Runs per task: N=3 · Spend: $<total>
## Summary (median [IQR], ratio vs. baseline)
| Class | Cost | Wall-clock | Success | Cache hit |
## Per task
| Task | Label | Cost | Time | Turns | Compactions | Escalated | k_eff | Serial frac | Pass |
## Cost by role
| Role | USD | Input | Output | Cache read | Cache write |
## Cost model check
| Task | Predicted | Measured | Error |
## Observations and anomalies
## Proposed tuning (→ §5)
```

### 8.3 Status entry (append to §9)

```markdown
### <date> — <phase>
- Done: <item IDs with evidence>
- In progress: <item IDs>
- Blocked: <item IDs, reason, needed from whom>
- Metrics moved: <IDs>
- Decisions: <D-n>
- Next: <item IDs>
```

### 8.4 Tuning-log entry — `reports/tuning/<nnn>-<knob>.md`

```markdown
# Tuning <nnn> — <knob> — <date>
Hypothesis: <change> will move <metric> by <amount> because <reason>
Change: <old value> → <new value> (commit)
Runs: <task subset>, N=3
| Metric | Before median [IQR] | After median [IQR] |
Result: KEEP | REVERT · Side effects on goal metrics:
```

---

## 9. Status log (append-only)

### 2026-11-09 — pre-P0
- Done: design review; design doc rev 2 (critical issues C1–C5 resolved in the design); this route created.
- Next: R0.1 (answer Q-1 … Q-7), then R0.2 – R0.4.

### 2026-11-09 — P0
- Done: R0.2 (`86d78c8`: repository, package, typecheck, tests), R0.3 (`npm run smoke`: Pi 1.5.0 in RPC mode loads only this extension; `/rsa` handled without a model call), W-1, W-3.
- In progress: R0.4 (W-2 and W-4 measured on a proxy repository); R0.1 (Q-5 answered).
- Blocked: G0 needs Q-1, Q-2, Q-3, Q-4, Q-6, Q-7 from the user.
- Decisions: D-9, D-10, D-11.
- Next: once Q-1 … Q-3 are answered, redo W-2 / W-4 on those repositories, pass G0, start v0.0 (R0.0.1 task set, R0.0.2 runner, R0.0.3 meter).

### 2026-11-09 — P0 (continued)
- Done: R0.1 (Q-1 … Q-7 answered: D-12 … D-16); R0.4 (W-2, W-4 on the benchmark repositories); W-7, W-8 (Tier B tree seeding works for Cargo and npm, base trees untouched); tree population design written into the design doc §13.1 (D-17).
- Baselines at the frozen commits: BiliNova builds only with its untracked SDKs linked (D-15) and has 4 failing tests; pi on Windows has ~1,040 failing tests in 8 of 12 packages → acceptance against a baseline failure list (D-18).
- Found: realctx's historian and rewrite calls are not recorded in the session file, so the meter would under-count them (U-10).
- Next: G0 check, then v0.0: R0.0.3 meter (with the U-10 workaround), R0.0.2 runner, R0.0.1 task set.

### 2026-11-09 — v0.0 (runner)
- Done: G0; R0.0.3 meter (+ U-10 workaround); R0.0.2 runner; R0.0.4 acceptance with regression lists (D-18, D-19); first task and first paid pilot run ([report](../reports/bench/pilot-2026-11-09.md)): accepted, $1.42, 7.5 min, 30 model calls, 95% cache hits.
- Found: realctx's memory rewrites ran on the session model (opus) because `rewriteModel` is empty → D-20. realctx writes project-shared memories into `<tree>/.pi/realctx/`; the runner leaves them out of the diff. realtasks is not isolated per run (state under the agent dir).
- Next: R0.0.1 task set (13 tasks, D-21), validated for free; one large run to price large tasks; then the baseline runs.

### 2026-11-09 — v0.0 (task set)
- Done: 13 tasks written (D-21 counts; sources D-22): small `pi-tui-wrap-boundary`, `pi-image-resize-format`, `pi-strip-ansi-private-csi`, `pi-mcp-login-local`, `pi-tool-search-coverage`, `bilinova-play-transport-types`; large serial `pi-self-update-command`, `pi-extension-changelog`, `bilinova-audio-source-factory`; large parallel `pi-par-orca-durable-trust` (k 3), `pi-par-shift-chord-pnpm` (k 3), `pi-par-osc133-npm-stale` (k 2), `pi-par-wsl-durable-ranking` (k 2).
- Found: realctx moved to settings schema v3 upstream → D-23 (pin, explicit per-run settings), U-11, U-12, K-12, design rev 2.1.
- Found: the BiliNova contract test reads `samples/dash-avio/audio.m4s`, which is untracked; `samples` is now linked into BiliNova trees (`bench/repos.json`).
- Done: R0.0.1. All 13 tasks pass D-19 validation (reference accepted, base rejected) via `bench/validate.sh` (free, no agent; ~2.5 h of test runs).
- Found: 5 tasks first failed validation at the reference because their test files hold tests that fail on Windows both before and after the change (home-path shortening, external editor, config paths, package-manager). Their acceptance commands now name only the commit's new tests (vitest `-t`, node `--test-name-pattern`); the full files still run in the regression check, so the extra failures are covered by the baseline-failure lists. Reasons are in each `task.json` `notes`.
- Fixed: `bench/validate.sh` now removes its own earlier `reference-1`/`base-1` runs first; before that, a re-run stopped at "runDir exists".
- Next: R0.0.6 / G0.0 runs. N per label and the $100 budget follow D-21; check spend with `node bench/ledger.ts`.
- Done: user's realctx settings restored after their v3 update. Their historian `openai/gpt-6-luna` failed because their ChatGPT subscription had hit its usage limit; `history.model` is now empty at the user's request.
- Decided: D-24 (realctx's own calls in benchmark runs use the session model; supersedes D-20). The pilot run is renamed `pilot-haiku-1`; its $1.42 still counts toward the budget, but it is not baseline data.
- Done: first large run (`pi-self-update-command`): $1.90 (main $1.68, realctx on the session model $0.22, about 12%), 6.2 min, 58 calls, no cold restarts. Not accepted, but the task was at fault: the prompt said "warn" without naming stdout, the hidden test reads `console.log`, and the agent printed to stderr. Prompt fixed; the run is kept as `invalid-prompt-1` (cost data only).
- Re-plan (D-21 counts kept): small ~$1.6 × 18, large serial ~$2.2 × 6, large parallel ~$4 × 8 (estimate) ≈ $74, plus $3.32 spent ≈ $77 of $100.
- Started: `bench/batch.sh` runs rounds over all tasks, one run at a time, and can resume; caps are $5 small and $8 large.
- Round 1 done (13 runs, $23.5): 11 accepted. The other 2 failed because of the harness, not the agent:
  - `pi-par-wsl-durable-ranking` errored: the agent had created `search.test.ts`, which is withheld and does not exist at base. Its intent-to-add index entry (`git add -A -N`) blocked `git apply --3way`. Fixed: the runner now also removes the path from the index.
  - `pi-par-shift-chord-pnpm` was rejected although acceptance passed: its only "new failure" is a chord lock test that starts real child processes, in code the agent did not touch.
- Decided: D-18 flake rule. When a regression check shows new failures, the runner runs it once more; a failure counts only if it fails both times. The others are recorded in `regression.flaky`.
- Added: `node bench/run.ts --rescore <runDir>` re-checks a finished run with the current harness from its saved `diff.patch` (free; cost and time stay as measured; the old verdict is kept under `rescored.previous`). Both round-1 runs are queued for rescore after the batch, so CPU contention does not distort the batch's wall-clock times.

### 2026-11-10 — v0.0 (baseline batch, cost model)
- Done: G0.0 baseline batch. 32 runs (13 tasks), all accepted, $50.19; phase total $58.45. Report: `reports/bench/001-baseline.md`.
- Fixed: 2 more prompts that disagreed with the hidden tests (`pi-par-wsl-durable-ranking`: "on POSIX" vs. cwd `/` everywhere). Its 2 runs are kept as `invalid-prompt-1/2`; 2 new runs were made, both accepted. `pi-par-shift-chord-pnpm` b2 was rescored and accepted (lock test timeout, as in b1).
- Fixed: leftover processes. Pi's background tasks outlive Pi on Windows; the runner now kills them, and any process that mentions the run dir, before acceptance (`killLeftovers` in `bench/sh.ts`, `result.leftoverProcesses`). Tested on synthetic processes; first use will be in v0.05.
- Done: R0.0.5, R0.0.6 (`src/costmodel.ts`, `bench/fit.ts`, 4 unit tests), R0.0.7.
- Found: H-1 fails per task (median 23.6%) but holds per class (within ±3%). Per-task error is bounded by noise (within-task CV 12%) and task-specific P and output style. Proposed D-25.
- Decided: D-25 accepted by the user.
- Done: G0.0 passed (`reports/gates/G0.0.md`). v0.05 starts with $41.55 left.

### 2026-11-10 — v0.05 (prompts)
- Started R.05.1: `prompts/v0/` has `GUIDANCE.md` (vendor guidance mapped to rules, with sources), `orchestrator.md` (PR-4, PR-5), `worker.md` (PR-6, PR-7) and OpenAI overlays.
- Decided (user input): OpenAI GPT-6 over-engineers (unused tests) and is passive. Handled by per-provider overlays appended to the system prompt, not by the shared prompts, because explicit test or verification instructions cause over-verification on Opus 5.x.
- Rule: the rsa arm's prompts carry no cost-saving instruction that the baseline lacks, so v0.05 measures the architecture, not a prompt change.
- Next: tool descriptions (`rsa_dispatch`, `rsa_steer`, `rsa_finish`, `rsa_report`), relay `bench/dryrun.ts` (R.05.2), pilot run.
