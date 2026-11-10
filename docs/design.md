# realsubagents: Design Doc v1

Nov 9, 2026 · @StackWu · **rev 2.2 (2026-11-10, route D-28): goals restated from v0.05 data; v1 scope narrowed to the split runtime, see §0** · rev 2: fixes for the five critical review issues (cost metric, escalation by observation, per-group worktrees and shared patches, lanes and scouts, shorter critical path) · rev 2.1: realctx settings v3 (prompt-cache rules §15, cost-model fit §15.1, two realctx changes §17.1; route D-23)

## 0. Status after the v0.05 dry run (rev 2.2)

The v0.0 baseline and the v0.05 dry run (`reports/bench/001`–`003`, `reports/review-2026-11-10.md`) measured the main bet. Splitting a large parallel task across two workers cut wall-clock time to 63% of a single session (about 50% on 10–12 min tasks) but not cost (89%): cache reads cost 1/25 of cache writes, so halving the quadratic read term saves about what an extra session costs to set up. Workers did not grow slower than a single session (g\_w ≈ g), and the orchestrator split all 24 runs correctly without a Partitioner or G0.

Consequences for v1:
- **Goals** (§1): large parallel tasks target time ≤ 75% (k = 2) with cost ≤ 100%. Cost savings are a hypothesis for very long sessions (n ≳ 150 calls), tested in v0.3.
- **Escalation** (§7.2) triggers on expected time gain: at least two separable parts of comparable size, and an expected single-session duration of about 6 minutes or more.
- **Verification** (§14): workers run the targeted tests of their part; the full checks run once, on the merged result, by code.
- **Scope of v1** is the *split runtime*: disposable workers in seeded worktrees, merged with `git merge-tree` and landed into the user's tree. Long-lived groups, G0, the Partitioner, contracts and the shared zone, merge trains, semif judges and regrouping (§3–§14) stay in this document as the long-term design, but are built only where later data shows the need (route v0.4).

## 1. Goals

realsubagents is a Pi extension that runs one orchestrator over a small set of long-lived, module-scoped groups. v1 has two goals: **small tasks cost about the same as a single session; large tasks finish markedly faster and cost less.** Every other decision serves these two. The guiding principle: **a model context is only a cache; the state store is main memory.**

| Scenario | Classified as | Metric | v1 target (to be calibrated) |
| --- | --- | --- | --- |
| Small task | Never escalated; the orchestrator completes it directly | Extra cost (USD) vs. a single session | ≤ +10% (design target +3%) |
| Large task, parallel | Escalated and split across ≥ 2 groups or ≥ 2 lanes (§7.4) | Wall-clock time | k\_eff = 2: ≤ 75%; k\_eff ≥ 3: ≤ 60% of a single session |
| Large task, parallel | Same | Cost (USD) | ≤ 100% of a single session (rev 2.2; ≤ 80% only as a hypothesis for n ≳ 150 calls) |
| Large task, serial | Escalated, but its atoms do not split into ≥ 2 lanes | Cost; wall-clock time | ≤ 105%; no worse than a single session (no-regression target) |

k\_eff is the number of subtasks or lanes running concurrently on the critical path. A single-lane large task has no parallelism, so it can only win through scouts and module-scoped context (§7.5); v1 promises no regression for it, not a speed-up.

**Benchmark method.** Same model set, same task set, labelled small / large serial / large parallel; the baseline is one Pi session with realctx enabled.

- **The primary metric is cost in USD**, computed per assistant message from Pi's `usage` and the model registry's per-model prices (input, output, cache read, cache write). Cheap-model roles (semif, historian, scouts) are charged at their own prices; tokens of different models are never added together.
- Raw counts of all four token kinds are reported per role: orchestrator, G0, worker, scout, semif, historian.
- Where a token figure is convenient (budgets shown to models, the dock), use W = cost ÷ the strong model's cache-read price per token: weighted tokens at the provider's real ratios, not fixed weights.
- Every parallel run logs its serial fraction (§8.1). Proposals are auto-approved under the default policy (§8.1), so no run waits on a human.
- Bootstrap cost is reported separately and not charged to individual tasks.

**Constraints the goals impose**

1. **Direct by default, escalate on observation.** Every request starts as direct work in the orchestrator, exactly like a single session. Code watches the work (files and groups touched, context growth, cost so far) and hints escalation when the cost model predicts a large task; the orchestrator then calls `rsa_escalate`, and a historian brief carries the context and the diff so far into a task. There is no up-front classification turn; small tasks never start a group process and never wake G0 (§7.2).
2. **Lazy bootstrap.** The project is modelled at the first escalation. Partitioning is deterministic code; G0 reviews only the top two candidates.
3. **Savings must be computable.** A single session re-reads a growing prefix every turn, so its cost grows with the square of its length; a group's context covers one module, lanes split the length, scouts keep exploration out of the strong model, and only Reports and references cross groups. These savings must exceed the added costs: one prefix cache write per worker, briefs, plans, Reports, review. The cost model (§15.1) is fitted on the v0.0 benchmark; its break-even point becomes the default escalation threshold.
4. **Verification scales with task size.** Direct work runs tests only; dispatched work goes through the ReviewPipeline: affected tests per subtask, the full suite once at integration (§14).

**Quality attributes** (the means to the two goals)

| Attribute | Meaning | Check |
| --- | --- | --- |
| Elegant | Few concepts; each mechanism does one thing; reuse realctx and realtasks primitives | Each mechanism names the pain point it removes |
| Economical | Expensive models only where reasoning is needed; prompt cache preserved; communication on demand | Cost (USD) per task, per group and per role; cache hit rate ≥ 90% |
| Stable | Correctness never depends on a model remembering; any member can be rebuilt from external state | Kill any process and its tasks recover; the orchestrator rebuilds its view after restart |
| Extensible | Groups can be added, split, merged; members can change model or machine; Multica can sit on top | Regrouping loses no memory or journal entries; adding a group needs no orchestrator prompt change |

**Non-goals for v1:** listening to chat channels and speculative execution; cross-repository tasks; multi-user collaboration (left to a layer such as Multica); groups nested inside groups.

## 2. Prior art

The three systems fail in three different ways: decisions rest on lossy summaries (DS Super-agent), execution units are thrown away after use (omo), and the agent's inside is invisible (Multica). Each pain point maps to one mechanism here.

| Source | Pain point | This design |
| --- | --- | --- |
| DS Super-agent | The Router decides from Worker summaries, so the reporting chain amplifies hallucinations | Reports carry evidence references; only verified conclusions enter the state store (§14) |
| DS Super-agent | The Router is a single point and the context bottleneck | The orchestrator's context is a cache of the state store; code reading moves to G0 |
| DS Super-agent | Cross-task reuse exists only in a community fork; no variants | Tasks are independent of sessions; steer, resume, fork and reparent are registry operations |
| DS Super-agent | Ambient listening and speculative execution add cost and attack surface | No speculation; work starts only from dispatch or a group interrupt |
| DS Super-agent | Prototype workers run with full access; the local management API has no authentication | Group write scope is enforced in `tool_call`; processes talk over stdio only, no open ports |
| omo | Workers are split by role, so there is no locality | Groups are split by module, by correlation of build targets (§7) |
| omo | Subagents are disposable: no steering, reuse or variants | Group members are long-lived; all four operations exist |
| omo | Every result flows back into the main session | Interrupt-style, structured Reports; routine progress stays in the group |
| Multica | Agents are black-box CLIs; the host can only assign and read logs | realsubagents runs inside the agent loop and drives sessions directly |
| Multica | Each run starts cold and rebuilds context from the issue thread | Groups persist; memory is keyed by task ID and path |

**Borrowed directly:** from DS, Thread pass-through, async start/stop, Inline & Spill context management and the external watchdog; from Multica, the issue as a durable anchor and the review gate; from realtasks, the exactly-once notification latch and wait-any.

## 3. Concepts and model

A group is a long-lived unit that owns part of the codebase, not a job title. That single choice separates this design from role-based systems such as omo.

**Entities**

| Entity | What it is | Lifetime | Persisted in |
| --- | --- | --- | --- |
| Orchestrator | The user's front desk: decomposes requests, does simple work directly, dispatches the rest, keeps the global view | The user's Pi session; may be compacted or restarted at any time | State store |
| Group | Ownership unit = a set of atoms + a sandbox + members | Across tasks; can be split, merged, migrated, retired | `groups` table |
| G0 (default group) | The orchestrator's kernel group: bootstrap, partitioning, contracts, regrouping, cross-group planning, project-specific escalation criteria | Always exists; costs nothing while idle | `groups` table |
| Member | worker (the writer of its path set), semif (judgments), historian (compression and extraction) | Worker session lives with the group; semif and historian are calls inside the realctx engine | realctx |
| Scout | A disposable, read-only helper session on a cheap model; answers one exploration question with findings and references (§7.5) | One question | realctx (helper kind) |
| Task | A unit of work, independent of any session; may have a parent (cross-group or lanes) or a fork origin | See §11 | `tasks` table |
| Lane | A temporary split of one task across disjoint atom sets inside one group; each lane has its own forked worker and worktree (§7.4) | Ends with its parent task | `tasks` table (kind = lane) |
| Shared patch | A worker's edit to a shared-zone file, made in its own tree and applied at merge by a file-type rule (§13.3) | Until merged | `shared_patches` table |
| Report | A structured interrupt from a group to the orchestrator, with evidence references | Delivered once | `reports` table |
| Contract | An interface agreement between groups: API, data format, directory boundary | Owned by G0; changed only by request | `contracts` table + files in the repository |
| Proposal | A pending decision: regroup, contract change, variant, cross-group plan | Open until decided | `proposals` table |
| State store | The single source of truth for all of the above | Permanent | SQLite (§12) |

**The project model**

- **Atom**: the smallest unit of ownership. A build target (Bazel target, Cargo crate, npm workspace package); a directory when the build system gives no targets.
- **Edge**: correlation between two atoms, a weighted sum of git co-change, static dependencies and test locality (§7.1).
- **Project map**: atoms, edges, build and test commands, conventions. Versioned; never edited in place.
- **Partition**: an assignment of atoms to groups. Hub atoms and noise files go to the **shared zone**, owned by G0. Each shared-zone atom has a kind: **mechanical** (manifests, lockfiles, registries, migrations), edited by any worker as shared patches; or **semantic** (shared types, public API), changed through contracts (§13.3).

**Invariants**

1. Group path sets are disjoint. Shared-zone atoms belong to no worker; workers touch them only as shared patches or contract requests.
2. One writer per path set: each group's or lane's path set has at most one running writer session, and a session holds at most one running task.
3. Every state change is an event appended to the state store; every other table is a projection.
4. Commands flow down over RPC or the SDK; events flow up only through the state store.
5. A model context is a cache. Anything needed after a restart lives in the state store or in realctx memory.
6. Only verified conclusions enter the project map and project-shared memory.
7. Each group (and lane and variant) works in its own tree; nothing reaches the integration branch except through MergeQueue.

## 4. Process topology

**A group is a process; its members are sessions inside that process.** The process is the sandbox and failure boundary, like an address space in an OS; members of one group share one realctx engine.

**Transport does not change token cost.** Whether a message crosses an in-process call or JSON on stdin, the same text enters the other context; models bill per token and hit the cache per prefix. Pi's SDK and RPC mode both offer steer, follow\_up and abort, so steering is equally capable. Context efficiency is set by the protocol (what a Report contains, how long, how often), not by the transport.

| Dimension | In-process SDK session | Separate `pi` process (RPC mode) |
| --- | --- | --- |
| Start-up cost | Low: reuses loaded extensions and the model registry | Each process loads extensions and opens a realctx engine |
| realctx engine | Shared: one DB connection, judge client, capture budget | One per process; the database is shared through WAL + lease locks |
| Fault isolation | A session that blocks the event loop or crashes affects all | Per process |
| Sandbox and permissions | One cwd, environment and extension set | Own cwd, sandbox, environment and extensions |
| Durability | Ends with `/reload` or Pi exit | Can survive via realtasks keep\_alive and re-adoption |
| Other machines | No | Yes (remote runtime) |

**Placement**

1. The orchestrator runs in the user's interactive `pi`. G0 runs as an SDK session in the same process: it is read-mostly and needs the state store's hot data.
2. Every other group is a `pi --mode rpc` child process. Its cwd is the group's own worktree (§13); only with k = 1 may the single group work in the user's tree.
3. A `GroupRuntime` interface has two implementations, `inProcess` and `subprocess`, with the same operations. v0.1 runs everything in-process; switching is configuration.

&#91;embedded content: Process topology · one interactive process, N group child processes\]

The orchestrator and G0 share the user's pi process; each other group is a child process. Only dispatch and steer go down, only Report interrupts come up; groups also append journal entries and evidence to the state store, which the drawing leaves out.

## 5. Modules

One extension loads in two roles: **coordinator** in the user's `pi`, **member** in each group process, chosen by `RSA_ROLE`, `RSA_GROUP` and `RSA_DB` in a subprocess, or by per-session options in-process (sessions in one process share `process.env`). One rule ties them together: **commands go down over RPC or the SDK; events go up only by appending to the state store.** Events are therefore durable and transport-independent, and in-process and subprocess groups follow the same path.

&#91;embedded content: Modules · 11 in the coordinator, 4 in each member — diagram predates rev 2: Classifier replaced by EscalationMonitor, SandboxManager added\]

The state store sits between the two roles: members only append to it, and coordinator consumers tail it. The one channel in the other direction is GroupRuntime's commands.

| Module | Role | Responsibility | Internal data | Depends on |
| --- | --- | --- | --- | --- |
| StateStore | both | Append events; update projections in the same transaction; serve tails by sequence number | Event log, projection tables, consumer cursors | SQLite + WAL + lease lock, as in realctx |
| Dispatcher | coordinator | Validate and execute task operations; enforce single writer, dependencies and budgets | None beyond the registry | StateStore, GroupRuntime |
| GroupRuntime | coordinator | Start and stop group processes and sessions; deliver prompt, steer, followUp, abort, fork | Process and session handles | Pi SDK and RPC; realtasks process-lifecycle module |
| ReportBus | coordinator | Turn events into orchestrator notifications, exactly once, coalesced | Delivery latch per event; coalescing window | realtasks notification-latch module |
| ReviewPipeline | coordinator | Verify work claimed done: affected tests per subtask, the full suite at integration, diff, scope check, semif | Reviews in flight | realtasks, realctx judge, git, project map (test locality) |
| Watchdog | coordinator | Detect stalls, loops, overruns and scope breaks; act deterministically | Heartbeats and counters per task | StateStore |
| MergeQueue | coordinator | Merge accepted work into `rsa/integration` as a merge train (batch, test once, bisect on failure); apply shared patches by file-type rule | Queue order, current batch | git, realtasks, realctx judge |
| SandboxManager | coordinator | Create group, lane and variant worktrees; sync them from `rsa/integration` at task boundaries; wire shared build caches | Worktree paths and branches | git, file system (copy-on-write where available) |
| Partitioner | coordinator | Build atoms and edges; compute candidate partitions for k = 1…5; compute lane candidates for a task | Partition and lane candidates | Build system, git history |
| EscalationMonitor | coordinator | Watch direct work (files, atoms and groups touched, context growth, cost) and hint escalation when the cost model predicts a large task | Counters for the current direct task; fitted predictor | Project map (directories before bootstrap), cost model (§15.1) |
| G0 session | coordinator | Bootstrap review, partition review, contracts, regrouping, cross-group plans, project-specific escalation criteria | Its own session | Pi SDK, realctx |
| ScopeGuard | member | Classify writes: own path set allowed; shared zone allowed and recorded as a shared patch; other groups' paths blocked | Path set, shared-zone kinds, contract list | realctx path tracker |
| Heartbeat | member | Emit progress events | None | Pi hooks |
| Member tools | member | Report, ask, request contracts, answer consults, run scouts, plan lanes, propose variants | None | StateStore, realctx helpers |

The orchestrator is not a module: it is the user's Pi session, and it uses these modules through the tools in §9.

## 6. Module behavior

Every module reacts only to events or tool calls, and changes state only by appending events. The table is the complete set of trigger–action rules; event names are defined in §10.

| Module | Trigger | Action | On failure |
| --- | --- | --- | --- |
| Dispatcher | Task tool calls (create, dispatch, steer, resume, fork, reparent, cancel, escalate) | Check preconditions (state, single writer, dependencies, budget); call GroupRuntime; append the matching event | Precondition fails: the tool returns an error and no event is appended |
| GroupRuntime | `group.spawn_requested`; Dispatcher commands | Start or stop processes and sessions; deliver prompt, steer, followUp, abort, fork | Process will not start: `group.crashed`. Command not delivered: retry once, then `task.blocked` |
| ReportBus | `report.emitted` and every event marked wake or passive | Deliver to the orchestrator by policy, exactly once; coalesce arrivals within 300 ms | Already read through `rsa_state_view` or `rsa_task_wait`: the latch flips and nothing is sent |
| ReviewPipeline | `task.review_requested` (each subtask or lane as soon as it reports done), `task.integration_requested` | 1. Check out the claimed commit of the task's branch in a review worktree (§13) 2. Run affected tests (subtask, lane) or the full suite plus cross-group tests (integration) 3. Diff statistics and scope check 4. semif completion check 5. Append `review.verdict` | No test command: needs\_human. Judge unavailable: queue and retry |
| Watchdog | `task.progress`, `budget.*`; a scan every 30 s | Apply the rules in §16: steer, block or abort; append `watchdog.alert` | Uses no model |
| MergeQueue | `review.verdict` = accept | Merge train: take every accepted item (a parent with its subtasks or lanes counts as one) → rebase each onto `rsa/integration` → apply shared patches by rule → semif merge-risk check → full tests once for the batch → advance `rsa/integration` → `merge.done` per item. Items whose contract request is undecided wait | Batch fails: bisect to the culprit and merge the rest; the culprit gets `merge.failed`, returns to running, and the reason is steered to its worker |
| SandboxManager | `group.spawn_requested`, `task.dispatched`, `task.lanes_planned`, `task.forked` | Create the worktree on its branch; before a task is dispatched to an idle worker, rebase the group branch onto `rsa/integration` and steer the worker a list of outside paths that changed; append `sandbox.synced` | Worktree cannot be created: `group.crashed` with the reason. Rebase conflict: `task.blocked` |
| Partitioner | `rsa_partition_compute`; `task.escalated` (lane candidates); periodic re-run after `merge.done` counts pass a threshold | Compute atoms, edges and candidates; append `partition.computed`; for an escalated task, cluster its atoms into lane candidates | Build system unreadable: fall back to directories |
| EscalationMonitor | Orchestrator `tool_call`, `tool_result`, `turn_end` during direct work | Update counters; when a signal in §7.2 fires, append `escalation.hinted` and add one short hint to the next turn | No project map yet: use directories. Never blocks work and never calls a model |
| G0 | Bootstrap, partition review, `contract.requested`, cross-group tasks, unowned tasks | Read code, produce structured results, open proposals | Nothing takes effect until a proposal is approved, by policy or by the orchestrator (§8.1) |
| ScopeGuard | Member `tool_call` (edit, write) | Own path set: allow. Shared zone: allow and append `shared.patch_recorded`. Another group's or lane's paths, or contract files: block and append `scope.violation` | Path cannot be parsed: allow; the diff check during review catches it |
| Heartbeat | Member `turn_end`, `tool_result` | Append `task.progress`: tool-call count, last tool, cost and raw tokens (scouts included) | — |

**The orchestrator's turn**

1. A user message arrives. Work on it directly, as a single session would. If the request clearly spans several modules, you may call `rsa_escalate` on the first turn. If a running task already owns the target paths, steer that task instead of editing.
2. If an escalation hint arrives, decide: continue directly (for example, when the task is nearly done), or call `rsa_escalate`. Escalating loses nothing: the brief carries the diff so far and references to what you read.
3. After escalating, keep talking with the user. Never poll.
4. On a wake notification: decide needs\_decision and the proposals the approval policy raised yourself when you can, otherwise ask the user; for blocked and failed, choose steer, more budget, or abandon. Proposals approved by policy arrive passively; veto one with `rsa_proposal_decide` if needed.
5. For a global view, call `rsa_state_view`. For details, follow a Report's references with `rsa_recall`; never ask a group to paste content.
6. Nothing to do while tasks run: end the turn and wait for an interrupt. Use `rsa_task_wait` only when the user asks to wait for a result.

**The worker contract** (part of the member system prompt)

1. Write only inside your path set. Mechanical shared-zone files (manifests, lockfiles, registries, migrations) may be edited in your tree; they become shared patches applied at merge. For semantic shared changes (shared types, public APIs), call `rsa_request_contract` and keep working against your proposed change: the request is optimistic and does not block you. Never edit contract files.
2. Run the affected tests before claiming done; completion is decided by the ReviewPipeline, not by the claim.
3. Call `rsa_report` only for done, blocked, needs\_decision and failed. Progress comes from Heartbeat.
4. When unsure of direction, call `rsa_ask`; continue with independent work until the answer arrives, or mark the ask as blocking.
5. Apply a steer immediately; no acknowledgement is needed.
6. Answer consults with `rsa_consult_reply` from what you already know; a consult never changes your task.
7. Send broad exploration (searching and reading beyond the code you are changing) to `rsa_scout`, and work from its findings and references.
8. A task whose atoms split cleanly may be planned as lanes with `rsa_lane_plan` (§7.4).

## 7. Flows I: bootstrap, direct work, task lifecycle

### 7.1 Bootstrap and partitioning

Bootstrap runs at the first escalation. Atoms are **build targets**, with directories as the fallback; edges are weighted by **correlation**. Layer- or module-based splitting needs no separate mechanism: it is what this algorithm produces when history is short.

| Signal | Predictive power | Cost | Limit |
| --- | --- | --- | --- |
| git co-change (atoms changed in the same commit) | Strongest: shows what one task touches | Low, from `git log` | Young repositories have little history |
| Static dependencies (build graph, imports) | Medium | Low | Dependency is not co-change |
| Test locality (which tests cover which atoms) | Medium | Medium, needs one test run | Optional |

The co-change weight grows with history length. With little history, static dependencies and directory structure dominate, so the result approaches a module split. Embedding similarity is not used: the signal is too weak.

Steps 1–5 are deterministic code (Partitioner); only step 6 uses a model.

1. **Atoms.** Read targets from the build system; on failure, use directories above a file-count threshold.
2. **Noise and hubs.** Exclude lockfiles, generated files and changelogs. Atoms with dependents above the 95th percentile go to the shared zone.
3. **Edges.** Recency-weighted co-change + static dependencies + test locality.
4. **Candidates.** For each k from `groups.min` (1) to `groups.max` (5), cluster with Leiden or a balanced min-cut.
5. **Choose k.** The largest k whose cross-group edge weight stays under 15% and whose groups all meet the minimum size. Small projects land on k = 1.
6. **Review.** G0 reads the top two candidates, names the groups, adjusts them with semantic judgment, writes the rationale, and also writes the project map: commands, conventions, the kind of each shared-zone atom (mechanical or semantic, §13.3), and the project-specific escalation criteria (§7.2). The orchestrator asks the user to confirm; the benchmark confirms automatically.

A partition assigns ownership; it does not start processes. A group process starts at its first dispatch, so a larger k adds cross-group overhead but no idle cost.

### 7.2 Direct work and escalation by observation

There is no up-front classification. A request in natural language rarely names its paths, and expected lines or tokens cannot be computed from it; a classification turn would cost every small task an extra model call, and the undecidable cases would wake G0 on a cold cache. Instead, every request starts as direct work, and code watches it.

**Tool surface.** Before the first escalation in a session, `rsa_escalate` is the orchestrator's only active rsa tool (≤ 300 tokens of description). The other orchestrator tools are enabled with `pi.setActiveTools()` after the first escalation, or when a wake notification arrives. Pi applies the change as a system-prompt patch: models that accept mid-conversation system messages keep their cached prefix, others pay one cache miss per change. A small task therefore pays for one short tool description and nothing else.

**Signals** (EscalationMonitor, deterministic code)

| Signal | Source | Default threshold |
| --- | --- | --- |
| Groups touched (reads and writes mapped through path sets; directories before bootstrap) | `tool_call` | ≥ 2 |
| Files written | `tool_call` | > 3 |
| Sensitive paths written: shared zone, contract files, dependency manifests, schema, public API (G0's criteria) | `tool_call` + project map | any |
| Projected cost to finish | Cost model (§15.1) on turns so far, context growth and the fitted task-size distribution | > escalation threshold (break-even) |
| Projected compaction before finish | `ctx.getContextUsage()` and growth per turn | predicted |

**Rules**

- No signal: the work stays direct and nothing extra is sent.
- A signal fires: EscalationMonitor appends `escalation.hinted` and adds one short note to the next turn, for example: "This task touches api/ and web/; projected cost $0.42, break-even $0.18. Consider rsa\_escalate." At most one hint per task, repeated only if the projection doubles.
- The orchestrator decides. Escalating early is cheap: the brief carries the diff so far and references to what was read, so no direct work is lost. The first escalation also triggers bootstrap (§7.1).
- The user explicitly names several modules: escalate on the first turn; no hint is needed.
- A running task already owns the target paths: steer that task; never edit around its worker.
- Direct work ends with its tests passing; the orchestrator commits it to the user's branch, and SandboxManager carries it into `rsa/integration` (§13.2).

**Calibration.** Thresholds start from the v0.0 break-even and are refitted from logged hints against two error rates: missed escalations (direct tasks that compacted or exceeded break-even) and false hints (escalated tasks that ran as one lane and finished under break-even). G0 owns the project-specific part, which paths count as schema, public API or risky, and updates it after bootstrap and every regrouping. G0 is never on the small-task path.

### 7.3 Task lifecycle in one group

1. **Create.** `rsa_escalate` or `rsa_task_create` records a queued task with goal, acceptance criteria, paths and budget. Without an explicit group, the path set decides; unmatched tasks go to G0. On escalation the Partitioner also computes lane candidates (§7.4).
2. **Dispatch.** The Dispatcher checks dependencies and the single-writer rule, starts the group if needed, has SandboxManager sync an idle group's worktree from `rsa/integration`, and sends the task to its worker.
3. **Run.** The worker works in its own worktree; Heartbeat emits progress. The orchestrator may steer; the worker may ask, run scouts, plan lanes, or request a contract change (optimistic: the worker keeps going).
4. **Claim.** `rsa_report(done)` moves the task to review.
5. **Review.** The ReviewPipeline runs the affected tests on the task's branch in a review worktree. Reject: back to running with the verdict steered in. needs\_human: blocked and raised. Accept: idle, queued for the next merge train.
6. **Merge.** MergeQueue merges it in the next train; the task becomes done. The worker keeps its context, so a follow-up task can `rsa_task_resume` from it.

### 7.4 Lanes: parallelism inside one group

A large task inside one group would otherwise run on one worker, with no parallelism and only overhead added. Lanes fix this without a new mechanism: they are cross-group subtasks (§8.1) at a smaller scale, and the invariant is one writer per path set, not per group.

1. **Candidates.** On escalation, the Partitioner clusters the task's atoms using the group's edges. If they form ≥ 2 clusters whose cut weight is under 15% of the task's internal edge weight, it proposes lanes; otherwise the task runs as a single lane.
2. **Plan.** The group's worker, which knows the module, turns the candidates into lanes with `rsa_lane_plan`: a goal and atom set per lane, dependencies, and the interface between lanes, if any. Like cross-group plans, it is approved by policy (§8.1).
3. **Interface first.** If lanes depend on each other, the worker writes the interface stubs before forking, so every lane starts from them.
4. **Fork.** The worker session forks once per lane; the shared prefix hits the cache. Each fork's path set narrows to its lane's atoms, and each lane gets its own worktree on `rsa/<group>/<lane>` (§13).
5. **Join.** Each lane is reviewed when it reports done; the parent's integration review runs the group's full suite once; the parent merges as one item. Lane sessions are archived after their drop-time capture, and the group's main worker resumes with the lanes' journal entries.

### 7.5 Scouts

Exploration (searching, reading, summarising code the change does not touch) is often 30–60% of a large task's tokens and needs no strong model. A worker calls `rsa_scout(question, paths?)`. A disposable, read-only helper session on the cheap model (realctx's helper kind) searches and reads in the worker's tree, then returns at most a few findings, each with a reference (file and line, or realctx output `#N`).

- Scouts cannot write, run no builds, and end after answering; their drop-time capture still runs, so findings become path-keyed memory.
- Several scouts may run in parallel. Their cost is charged to the task.
- Every escalated task may use scouts. For a single-lane large task they are the main saving: they lower the strong model's context growth g\_w in §15.1.

## 8. Flows II: cross-group tasks, variants, regrouping

### 8.1 Cross-group tasks

A task that needs several groups is never solved by merging them. **The solution is decided in one place, split along contracts, ordered by a dependency graph, and joined in the parent task's journal.**

**Who decides: G0, consulting only where needed.**

1. **Plan from what is known.** G0 plans from the project map, the contracts and the path-keyed memory of the affected paths.
2. **Consult on demand.** G0 sends `rsa_consult` only to groups whose memory under the affected paths is thin or flags a risk. All consults go out in parallel with one deadline (default 2 minutes); a group that misses it is planned without its reply. Each worker answers from its context: impact, constraints, risks, size estimate.
3. **One turn to a plan.** G0 writes the plan (contract delta, one subtask per group, dependencies) and the interface stubs in the same turn.
4. **Approval by policy.** A plan, contract change or lane plan is approved automatically unless it changes a published contract, touches public API, or its estimated cost exceeds the parent's budget; those wake the orchestrator, which decides or asks the user. Work under an automatically approved plan starts at once; the orchestrator or the user can veto it while it runs, which cancels the affected subtasks. Only one plan ever runs, so this is not speculative execution.

Contexts never move; only questions and answers do. A consult is read-only: the worker writes no code, and its current task is unaffected.

**Ordering: a parent task with a subtask graph.**

1. **Contract and implementation overlap.** G0's stubs are committed on the contract subtask's branch, and every subtask's worktree starts from them. Providers and consumers start at once. The contract subtask must merge before the parent merges, not before work begins.
2. **Parallel work.** Providers implement; consumers build against the stubs at the same time.
3. **Pipelined review.** Each subtask is reviewed when it reports done, with affected tests only. When every subtask is idle, the parent's integration review runs the full suite and the cross-group tests once, on `rsa/integration` + all subtask branches. A failure goes back to the subtask whose paths it touches.
4. **Merge as a unit.** The parent is one item in the merge train: all subtasks merge together, or none.

**Critical path.** Time ≈ T\_serial + T\_parallel ÷ k\_eff + overhead, where T\_serial = escalation + plan + any consults + integration review + merge train. Every run logs its serial fraction T\_serial ÷ total; the v0.2 gate requires it to be under 25%. Heavy builds share the realtasks build queue, but each group builds in its own tree, so the cap protects CPU and memory, not correctness; groups may also use different models or providers to spread rate limits.

Path sets are disjoint and each group has one writer, so "who edits this file first" never arises; only semantic order remains, and the graph expresses it.

**Why not merge the groups.** Merging is a regrouping tool for lasting coupling, not for one task. Each group's historian compresses its own session as usual; G0 writes the parent's summary from the subtasks' structured journal entries. No transcript is merged, so no historian has to choose a side. Frequent cross-group tasks between the same pair are the signal to merge them through §8.3.

### 8.2 Variants

A variant is a forked worker session plus its own worktree, judged by tests and semif. Forking context is cheap because the shared prefix hits the cache; forking the environment is cheap where the worktree is a copy-on-write clone, and builds share a cache.

1. **Trigger.** The orchestrator, or a worker via `rsa_propose_variant`, asks for n variants (default 2, capped by budget) with judging criteria.
2. **Fork.** The worker session forks n times. realctx copies referenced originals into each child, so placeholders stay byte-identical and expandable. Each fork is steered toward a different direction.
3. **Environment.** One worktree per variant on branch `rsa/<task>/<v>`, populated copy-on-write where the file system allows (§13).
4. **Run.** In parallel; each gets the parent's remaining budget ÷ n.
5. **Judge.** The same tests first; failures drop out. semif ranks the rest against the criteria; a tie goes to the user.
6. **Close.** The winner merges into the group. Losing sessions are archived, but their drop-time capture still runs, so why a path failed is remembered.

### 8.3 Regrouping

Regrouping is cheap because realctx keys memory by path, not by group. Memory never moves; a new group sees exactly the facts under its paths through path notes. Only worker sessions and task ownership need handling. G0 proposes; the orchestrator approves.

| Operation | Typical trigger | Worker session | Memory | Tasks |
| --- | --- | --- | --- | --- |
| Split | Path set or task volume too large; sub-modules barely interact | Fork into two (realctx copies originals); each narrows its path set | Unchanged | Reparented by path |
| Merge | The same pair keeps opening cross-group tasks | A dedicated historian instance reads both journals and both session summaries and writes one merged brief; a new worker session starts from it; both old sessions are archived | Unchanged | All reparented to the new group |
| Migrate | A module moves or is renamed | Unchanged | realctx `paths.autoRename` | Path set updated |
| Retire | Module deleted, or no tasks for a long time | Archived | Kept; missing paths flagged by stale check | Allowed only when every task is terminal |

Everything is archived, never deleted, so every regrouping can be reversed. Re-partitioning uses the §7.1 algorithm with a better signal: the observed rate of cross-group tasks.

## 9. Primitives

Primitives come in four layers: model tools, user commands, events (§10) and a code-level library. Each role's model sees only its own tools. Every tool is prefixed `rsa_`, matching realctx's naming. Budgets are in USD (§15).

**Orchestrator tools.** Before the first escalation only `rsa_escalate` is active; the rest are enabled with `pi.setActiveTools()` (§7.2).

| Tool | Parameters | Semantics |
| --- | --- | --- |
| `rsa_escalate` | summary, acceptance?, budget? | Turn the current direct work into a task; a historian brief carries the context, the diff so far and references to what was read. Runs bootstrap the first time |
| `rsa_task_create` | title, goal, acceptance, paths?, group?, budget?, depends\_on?, parent? | Create a queued task; without a group, the path set decides, else G0 |
| `rsa_task_dispatch` | task, group? | queued → running |
| `rsa_task_steer` | task, message | Steer a running task; otherwise queued as a follow-up |
| `rsa_task_resume` | task, from | The new task reuses the worker context of `from` (idle or done, same group, worker free) |
| `rsa_task_fork` | task, n, directions\[\], criteria | Create variants |
| `rsa_task_cancel` | task, reason | Abandon |
| `rsa_task_wait` | ids\[\], timeout\_ms | Return when any task ends or a wake notification arrives |
| `rsa_state_view` | scope: all, group or task; id? | Append a state view: groups, open tasks, open asks, budgets |
| `rsa_recall` | ref | Fetch evidence by reference: log excerpt, diff summary, memory, output `#N` |
| `rsa_answer` | ask, answer | Answer a worker's ask; delivered as a steer |
| `rsa_proposal_decide` | proposal, approve, note? | Decide a proposal the approval policy raised, or veto one it approved (§8.1) |

**G0 tools**

| Tool | Parameters | Semantics |
| --- | --- | --- |
| `rsa_partition_compute` | kmin?, kmax? | Run the Partitioner; return candidates with cross-group ratio and sizes |
| `rsa_map_write` | atoms, edges, commands, conventions, shared\_kinds, criteria | Write a new project-map version, including shared-zone kinds and the project-specific escalation criteria |
| `rsa_regroup_propose` | op: create, split, merge, migrate or retire; groups; paths; rationale | Open a regroup proposal |
| `rsa_consult` | groups\[\], question, parent?, deadline\_ms? | Send read-only consults in parallel, only where memory is thin or risky; collect the replies that arrive by the deadline |
| `rsa_plan_cross_group` | parent, contract\_delta, stubs, subtasks\[\], deps\[\] | Open a cross-group plan proposal; approved by policy unless it touches published contracts or public API, or exceeds budget |
| `rsa_contract_update` | contract, change, affected\_groups | Edit contract files and notify affected groups |
| `rsa_task_assign` | task, group | Place an unowned task |

**Worker (member) tools**

| Tool | Parameters | Semantics |
| --- | --- | --- |
| `rsa_report` | kind, summary, evidence\[\], asks? | Append `report.emitted`; kind = done also requests review |
| `rsa_request_contract` | contract?, change, reason | Append `contract.requested`; optimistic: the task keeps running against the proposed change, and only its merge waits for the decision |
| `rsa_scout` | question, paths?, n? | Run read-only cheap-model scouts (§7.5); return findings with references |
| `rsa_lane_plan` | lanes\[{atoms, goal}\], deps\[\], stubs? | Split the current task into lanes (§7.4); approved by policy |
| `rsa_ask` | question, blocking | Append `ask.opened`; blocking makes the task blocked |
| `rsa_consult_reply` | consult, impact, constraints, risks, estimate | Answer a G0 consult; read-only, task state unchanged |
| `rsa_propose_variant` | n, directions\[\], reason | Ask the orchestrator to fork |

**The Report**

```text
Report {
  task, group
  kind: done | blocked | needs_decision | contract_request | failed
  summary: at most 3 lines
  evidence: [{ type: test | diff | log | memory | output, ref }]
  verdicts: [{ question, p }]        // semif
  asks: [question]                   // for the orchestrator or the user
  cost: { usd, tokens: { input, output, cache_read, cache_write }, budget_usd }
}
```

A `ref` points at something reproducible: a realtasks task ID, a commit, a memory UUID, a realctx output `#N`. The orchestrator recalls details by reference; groups never paste content upward.

**User commands**

| Command | Effect |
| --- | --- |
| `/rsa` | Panel: groups, tasks, open asks, budgets |
| `/to <task> <message>` | Steer that task's worker directly |
| `/rsa bootstrap` | Rerun bootstrap |
| `/rsa pause <group>`, `/rsa resume <group>` | Pause or resume a group |
| `/rsa budget <task or group> <usd>` | Change a budget |
| `/rsa land` | Bring the user's branch up to `rsa/integration` (fast-forward when possible); `config.land` = manual or auto |
| `/rsa rebuild` | Rebuild projections by replaying events |

**Library API** (for tests and other extensions)

```ts
interface Rsa {
  tasks:  { create, dispatch, steer, resume, fork, reparent, cancel, escalate, planLanes, get, list }
  groups: { spawn, split, merge, migrate, retire, pause, get, list }
  sandbox: { create(branch: string): Promise<string>; sync(group: GroupId): Promise<void>; remove(path: string): Promise<void> }
  events: { append(e: EventInput): Promise<Event>; tail(fromSeq: number, filter?): AsyncIterable<Event> }
  partition: { compute(kmin?: number, kmax?: number): Promise<Candidate[]>; lanes(task: TaskId): Promise<LaneCandidate[]> }
  runtime: GroupRuntime
}

interface GroupRuntime {            // inProcess and subprocess implementations
  spawn(group: GroupId): Promise<Handle>
  stop(group: GroupId, reason: string): Promise<void>
  prompt(s: SessionId, text: string): Promise<void>
  steer(s: SessionId, text: string): Promise<void>
  followUp(s: SessionId, text: string): Promise<void>
  abort(s: SessionId): Promise<void>
  fork(s: SessionId, n: number): Promise<SessionId[]>
  alive(group: GroupId): boolean
}
```

## 10. Events

The event log is the system's only write path: every state change appends an event and updates projections in the same transaction. Restart, audit and replay all come from it.

**Envelope**

```text
Event {
  seq        monotonically increasing, globally unique
  at         timestamp
  type       see the catalog
  task?, group?, session?
  actor      orchestrator | g0 | worker | runtime | review | merge | watchdog | partitioner | user
  data       type-specific fields
  causation  seq of the event that caused this one; used for idempotency and tracing
}
```

**Catalog.** The last column is the delivery policy toward the orchestrator: wake steers into a running turn or starts a new one; passive arrives with the next turn; silent updates the dock only.

| Event | Appended by | Meaning | Delivery |
| --- | --- | --- | --- |
| `task.created` | orchestrator, G0 | New task | silent |
| `task.dispatched` | Dispatcher | Sent to a group; execution starts | silent |
| `task.progress` | Heartbeat | Tool-call count, cost and raw tokens | silent (dock and Watchdog only) |
| `escalation.hinted` | EscalationMonitor | A signal fired during direct work; carries the signal and projected cost | delivered as one short hint on the next turn |
| `task.steered` | Dispatcher | A steer was delivered | silent |
| `task.escalated` | Dispatcher | Direct work became a task | silent |
| `task.lanes_planned` | Dispatcher | A task was split into lanes | silent |
| `task.blocked` | worker (blocking ask), Dispatcher, Watchdog, SandboxManager | Blocked, with a reason | wake |
| `task.review_requested` | `rsa_report(done)` | Enters review | silent |
| `task.integration_requested` | Dispatcher | All subtasks of a parent are idle | silent |
| `task.resumed`, `task.forked`, `task.reparented` | Dispatcher | Reuse, variants, ownership change | silent |
| `task.done` | MergeQueue | Merged | passive |
| `task.failed` | ReviewPipeline | Failed | wake |
| `task.abandoned` | orchestrator | Cancelled | silent |
| `report.emitted` | worker | A structured Report | by kind: done passive; others wake |
| `ask.opened`, `ask.answered` | worker, orchestrator | Ask and answer | wake, silent |
| `consult.opened`, `consult.answered` | G0, worker | Read-only consult before a cross-group plan | silent |
| `review.verdict` | ReviewPipeline | accept, reject or needs\_human, with probabilities | accept and reject passive; needs\_human wake |
| `merge.enqueued`, `merge.batch_started`, `merge.done`, `merge.failed` | MergeQueue | Merge-train progress | silent, silent, passive, wake |
| `shared.patch_recorded` | ScopeGuard | A shared-zone edit was recorded for merge | silent |
| `sandbox.synced` | SandboxManager | A worktree was rebased onto `rsa/integration` | silent |
| `group.spawn_requested`, `group.spawned` | Dispatcher, GroupRuntime | Group process start | silent |
| `group.paused`, `group.resumed` | user, orchestrator | Pause and resume | silent |
| `group.crashed`, `group.readopted` | GroupRuntime | Crash and re-adoption | wake, silent |
| `group.retired` | Dispatcher | Retired | passive |
| `partition.computed` | Partitioner | Candidate partitions ready | silent |
| `proposal.opened`, `proposal.decided`, `proposal.applied` | G0, worker, orchestrator, approval policy | Regroup, contract, variant, lane or cross-group plan | wake only when the policy needs a decision, else silent; silent; passive |
| `contract.requested`, `contract.updated` | worker, G0 | Contract change (optimistic; G0 handles it) | silent, passive |
| `scope.violation` | ScopeGuard | Write outside the path set was blocked | wake |
| `watchdog.alert` | Watchdog | stall, loop or context pressure | wake |
| `budget.exceeded`, `budget.raised` | Watchdog, orchestrator | Budget overrun and increase (USD) | wake, silent |

**Delivery and durability**

1. An event and its projection updates commit in one transaction. If the write fails, the operation fails and the caller sees the error.
2. Each consumer (ReportBus, Watchdog, ReviewPipeline, MergeQueue, dock) keeps its own cursor and tails by `seq`; after a restart it resumes from the cursor. Delivery is at-least-once; actions are idempotent on `causation`, so effects happen exactly once.
3. Members write the shared database directly (WAL + lease lock). The coordinator polls for new `seq` every 250 ms; same-process writes also wake consumers directly.
4. Delivery to the orchestrator uses the realtasks latch: it flips when delivered or when `rsa_state_view` or `rsa_task_wait` has already shown the event.

**Mapping onto Pi hooks**

| Pi hook | Coordinator | Member |
| --- | --- | --- |
| `session_start` | Open the state store, migrate, re-adopt group processes, restore consumer cursors; activate only `rsa_escalate` | Read role options (`RSA_*` in a subprocess, session options in-process), load the path set, register member tools |
| `before_agent_start` | Inject the stable orchestration prompt (byte-identical); after the first escalation, enable the remaining tools with `pi.setActiveTools()` | Inject group or lane description, path set, shared-zone kinds and contract list (byte-identical) |
| `tool_call` | EscalationMonitor counters (direct work) | ScopeGuard |
| `tool_result` | EscalationMonitor counters (direct work) | Heartbeat counters |
| `turn_end` | Deliver when the coalescing window expires; add a pending escalation hint | Append `task.progress` |
| `agent_before_settle` | If a wake notification is queued, continue once (composes with realtasks the same way) | — |
| `session_shutdown` | On reload, park process handles in a `globalThis` handoff table | Append a final `task.progress` |

## 11. State machines

Tasks have eight states and groups have six. Every transition is caused by exactly one event type, so the projection can be rebuilt by replay.

**Task states**

| State | Meaning | Advanced by |
| --- | --- | --- |
| queued | Split from a request; not yet dispatched | orchestrator, Dispatcher |
| running | The worker is executing; for a parent, subtasks are in progress | worker |
| blocked | Waiting for an answer, a contract change, budget, or a dependency | whoever is waited on |
| review | Claimed done; being verified | ReviewPipeline |
| idle | Accepted, waiting for merge; the worker still holds the context | MergeQueue |
| done | Merged | — |
| failed | Failed and not retried | — |
| abandoned | Cancelled | — |

**Task transitions**

| From | Event | To |
| --- | --- | --- |
| queued | `task.dispatched` | running |
| running | `task.blocked` (blocking ask, budget, watchdog, sync conflict) | blocked |
| blocked | `ask.answered`, `budget.raised`, `task.steered` | running |
| running | `task.review_requested` | review |
| running (parent of subtasks or lanes) | `task.integration_requested` | review |
| review | `review.verdict` = reject | running (verdict steered to the worker) |
| review (parent) | `review.verdict` = reject, with failing paths | running; the matching subtasks return to running |
| review | `review.verdict` = needs\_human | blocked |
| review | `review.verdict` = accept | idle, plus `merge.enqueued` (an item whose contract request is undecided waits in the queue; a rejected contract steers the worker and returns the task to running) |
| idle | `merge.done` | done (a parent's subtasks become done together) |
| idle | `merge.failed` | running |
| idle, running | `proposal.decided` = reject, for the task's contract request | running (rejection steered to the worker) |
| running | `task.failed` | failed |
| any non-terminal | `task.abandoned` | abandoned |

**Group states and transitions**

| From | Event | To |
| --- | --- | --- |
| — | `group.spawn_requested` | spawning |
| spawning | `group.spawned` | active |
| active | `group.paused` | paused: no new dispatches; running tasks are steered to wrap up |
| paused | `group.resumed` | active |
| active, paused | `group.crashed` | crashed: its running tasks become blocked |
| crashed | `group.readopted`, or a new `group.spawned` | active |
| active, paused | `proposal.applied` (retire) | retiring: waits for its tasks to reach a terminal state |
| retiring | `group.retired` | retired |

Split and merge are not group states. They appear as `group.retired` for the old group(s), `group.spawned` for the new one(s), and `task.reparented` for each moved task.

## 12. Data

The `events` table is the only truth; every other table is a projection and can be rebuilt by replay (`/rsa rebuild`). Every table carries `project_key`, derived as in realctx (`git-<root commit>`), so one database serves many projects.

**IDs.** Tasks are `t` + 8 base36 characters, groups `g` + 8; G0 is always `g0`. Proposals, asks, consults and Reports use `p`, `a`, `c` and `r`. The format follows realtasks; the model sees the same IDs as the database.

**Tables**

| Table | Key | Main fields | Indexes | Kind |
| --- | --- | --- | --- | --- |
| `events` | seq | at, type, task, group, session, actor, data (JSON), causation | (task, seq), (group, seq), (type) | Append-only source of truth |
| `cursors` | consumer | seq | — | One row per consumer |
| `groups` | id | name, state, atoms, paths, contracts, runtime, isolation, worktree, branch, worker\_session, pid, pid\_start, model, budget\_usd, cost\_usd | (state) | Projection |
| `tasks` | id | kind: task, subtask or lane; title, goal, acceptance, state, group, worker\_session, worktree, branch, parent, forked\_from, resumed\_from, depends\_on, paths, budget\_usd, cost\_usd, tokens (JSON) | (group, state), (parent), (state) | Projection |
| `task_sessions` | (task, session, from\_seq) | role: worker, variant or handover; to\_seq | (session) | Projection; which sessions a task passed through |
| `reports` | id | task, kind, summary, evidence, verdicts, notified | (task), (notified) | Projection |
| `asks` | id | task, question, blocking, answer, state | (task, state) | Projection |
| `consults` | id | parent, group, question, reply (JSON), state | (parent) | Projection |
| `proposals` | id | kind: regroup, contract, variant or plan; payload; state; author | (state) | Projection |
| `contracts` | id | path, groups, version | (path) | Projection; the text lives in repository files |
| `project_map` | version | atoms, edges, commands, conventions, shared\_kinds, criteria, cost\_model (JSON) | — | Projection; append-only versions |
| `partitions` | (version, k) | groups, cross\_ratio, sizes, chosen | (chosen) | Projection; every candidate kept for comparison |
| `merge_queue` | task | branch, state, position, batch | (state, position), (batch) | Projection |
| `shared_patches` | id | task, group, path, rule: manifest, lockfile, migration, union or contract; patch; state | (task), (state) | Projection |
| `journal` | (group, seq) | task, entry | — | Projection of `report.emitted` and `review.verdict`; historians read it for briefs |
| `meta` | key | value | — | Holds `schema_version` |

**Files**

| Content | Location | Committed |
| --- | --- | --- |
| Database | `~/.pi/agent/realsubagents/rsa.sqlite` | No |
| Configuration | `~/.pi/agent/realsubagents/config.json` | No |
| Group, lane, variant and review worktrees | `~/.pi/agent/realsubagents/worktrees/<project_key>/<group>[/<lane>]/`, or a configured Dev Drive path on Windows | No; outside the repository |
| Shared build caches | Per toolchain (pnpm store, sccache directory, Bazel disk cache, Gradle cache), set in `config.json` | No |
| Contract files | `<repo>/.pi/rsa/contracts/*.md` | Yes |
| Readable project map | `<repo>/.pi/rsa/map.md` | Yes; exported by G0 from the latest version |

**Schema migration.** `meta.schema_version` records the version; migrations only move forward. The coordinator migrates at `session_start` under the lease lock. A member that finds a newer schema than it understands refuses to start and says so, so old code never writes into new tables.

## 13. Isolation and integration

A shared working tree breaks parallel work. Every build compiles other groups' half-done edits, and reads cannot be kept consistent across tools: the `read` tool can be redirected to a baseline, but `bash cat`, `rg` and the compiler cannot. So **each group works in its own tree; the build cache is shared, the tree is not.** Isolation is not a tuning knob for correctness, only a question of how cheaply the trees are made.

| Level | When | How |
| --- | --- | --- |
| shared | k = 1, or no parallel work in flight | The single group works in the user's tree. MergeQueue commits accepted work on `rsa/integration`, which `/rsa land` brings to the user's branch |
| worktree (default for k ≥ 2) | Any parallel work | One git worktree per group on `rsa/<group>`, per lane on `rsa/<group>/<lane>`, per variant on `rsa/<task>/<v>`, and one per review; populated copy-on-write where the file system allows |

### 13.1 Making trees cheap

A tree's disk cost is almost never source. Measured on the benchmark repositories (route W-2): source is 40–90 MB, but BiliNova's `target/` is 7.0 GB and pi's `node_modules` 474 MB. So the rule is: **share what is immutable, copy only what a group writes, and keep as few trees as there are concurrent writers.** SandboxManager picks a population method per volume, once, by probing it, and reports the method and the disk in use in the `/rsa` panel.

**Tier A, copy-on-write volume.** btrfs and XFS reflinks on Linux, APFS clones on macOS, ReFS or a Dev Drive on Windows (Windows 11 24H2 `CopyFile` uses block cloning). The new tree is a clone of a warm base tree, build outputs and dependencies included: near-zero space and an incremental first build. Probe: clone a 1 MB file and compare free space.

**Tier B, any file system, the default.** No admin rights and no special file system, only git and same-volume hard links (NTFS, ext4, APFS, …):

| Part of a tree | Mutable? | How it is provided | Cost per tree |
| --- | --- | --- | --- |
| History | No | `git worktree`: one object store | 0 |
| Tracked source | Yes | Normal checkout. No sparse-checkout by default: it saves little (source is small) and breaks workspace builds | Source size |
| Untracked prerequisites (SDKs, generated files) | No | Tree setup: a junction or symlink to the user's tree (below) | 0 |
| Dependencies | No | Toolchains with a global store already share: Cargo (`~/.cargo`), pnpm, uv, Go, Gradle. npm and yarn classic: hard-link the base tree's `node_modules` file by file, skipping dot-directories other than `.bin` (tool caches such as `.vite` are written in place), then re-create the workspace links so they point into the new tree; `npm ci` when the lockfile differs from the base | Directory entries only (pi: 4 MB instead of 474 MB, 8 s instead of 64 s) |
| Third-party build outputs | No, once built | Seeded by hard links from the base tree's build directory, for toolchains whose adapter declares this safe: units keyed by a content hash that does not include the tree's path (Cargo's third-party crates). A seeded file is never written in place; the adapter's check is that the base's files are byte-identical after a build in the new tree | 0 |
| The repository's own build outputs | Yes | Built in the tree. Adapter options shrink them: Cargo builds workspace members of group trees with `debug = "line-tables-only"` (members only, so third-party hashes still match) | The real cost (BiliNova: 3.3 GB instead of 7.0 GB) |

A toolchain without an adapter gets a plain worktree and its own full build: correct, only bigger. Adapters are per toolchain, in code, and listed in `config.json`; v1 ships Cargo and npm, the benchmark's toolchains. Compiler caches (`sccache`, Bazel `--disk_cache`, Gradle build cache) save build time, not space, and are configured where present.

**Number of trees.** Trees are a pool, sized by the number of groups writing at once, not by the number of groups. Read-only groups (scouts, reviewers reading a commit) get no tree. When a group's work has merged, its tree is reset to the next branch instead of deleted, which keeps its build warm. A disk budget in `config.json` (default: 25% of the volume's free space at bootstrap) caps the pool; the least recently used idle tree is evicted first, and a new tree that would exceed the budget waits in the queue like a build.

Not used: one build directory shared by several trees. Cargo locks it per build, so parallel groups would build one at a time, and uplifted binaries with the same name overwrite each other.
- **Build queue.** Heavy builds and test runs go through the realtasks build queue; the cap defaults to the number of cores ÷ 4, at least 2. Each group builds its own tree, so the cap protects CPU and memory, not correctness.
- **Tree setup.** A fresh tree has only tracked files, but builds often need untracked prerequisites (native SDKs, generated files, `.env`). Per project, `config.json` lists a setup step run once per new tree: directories to link from the user's tree (a junction on Windows, a symlink elsewhere; read-only by convention), small generated files to copy, and commands to run. Build commands that fetch from the network get an offline variant where the project has one, so builds stay reproducible. Bootstrap proposes the list by comparing a clean build of a fresh tree with the user's tree.
- **Ports.** Dev servers and similar get a port range per group.
- **git.** Each worktree has its own index. Workers never commit, rebase or push; SandboxManager and MergeQueue do, in code.

### 13.2 Sync points and the integration branch

- **`rsa/integration`** starts from the user's branch at bootstrap. MergeQueue is its only writer. `/rsa land` brings the user's branch up to it (fast-forward when possible); `config.land` is manual or auto. Before each merge train, MergeQueue merges the user's branch head into `rsa/integration`, so direct work committed by the orchestrator reaches the groups.
- **Sync at task boundaries.** A group's tree changes from outside only before a task is dispatched to an idle worker: SandboxManager rebases `rsa/<group>` onto `rsa/integration`. A mid-task sync happens only when the orchestrator steers one, for example when a task needs a contract that just merged.
- **No silent staleness.** After a sync, the worker receives one short steer listing the outside paths that changed, so a warm context is never quietly out of date.
- **Consistent reads.** Another group's code in your tree is `rsa/integration` as of your last sync, the same for `read`, bash and the compiler. For newer state, use `rsa_consult`.
- **Responsibility.** A worker never fixes another group's code. If its build fails inside another group's paths after a sync, it says so in its Report, with evidence; the ReviewPipeline assigns responsibility by path.

### 13.3 The shared zone

Hub files are touched by ordinary changes (adding a dependency edits a manifest and the lockfile; a new page edits a route registry). Requiring a blocking contract request for each would stall parallel work, so the shared zone is split by kind. G0 assigns each shared-zone atom a kind at bootstrap; unknown atoms default to semantic.

| Kind | Examples | During the task | At merge |
| --- | --- | --- | --- |
| Mechanical | Package manifests, lockfiles, route and i18n registries, barrel exports, numbered migrations | The worker edits freely in its own tree; ScopeGuard records a shared patch | MergeQueue applies the patch by file-type rule, with no model: manifests merged by key, then the lockfile regenerated by the package manager (never merged as text); migrations renumbered; append-only registries merged with `merge=union`. A conflict no rule resolves: `merge.failed` for the later item |
| Semantic | Shared types, public API, interfaces between groups | The worker calls `rsa_request_contract` and keeps working against its proposed change in its own tree | The item waits in the merge queue for G0's decision, approved by policy where allowed (§8.1); a rejection steers the worker to rework |

In a worktree, other groups' paths are writable on disk, but ScopeGuard blocks edit and write to them, and the diff check at review catches bash writes.

## 14. Verification

Nothing counts as done without reproducible evidence. semif supplies probabilities and evidence supplies facts; each alone fails. Probabilities alone absorb hallucinations; evidence alone cannot judge whether the work is right.

| semif question set | Input | Output | Status |
| --- | --- | --- | --- |
| Memory admission | Candidate fact and its neighbours | add, edit, merge or reinforce | Exists in realctx |
| Output retention | Tool-output excerpt | keep, summarize or drop | Exists in realctx |
| Completion | Report, actual test results, diff statistics, related contracts | Probabilities of accept, reject, needs\_human | New |
| Scope | Paths in the diff vs. the group's path set and contracts | in\_scope or contract\_touch | New |
| Merge risk | Pending diff, path overlap with recent merges and in-flight tasks, rebase conflicts, test stability history | Probabilities of merge\_now, defer, needs\_human | New; called by MergeQueue |

**Rules**

1. A worker saying the tests pass proves nothing. In review, realsubagents runs the tests itself through realtasks, in a review worktree, and records the result as evidence: affected tests for a subtask or lane, the full suite and cross-group tests at integration, and the full suite once per merge train. Affected tests come from test locality where recorded, otherwise from the reverse dependencies of the changed atoms in the build graph; when unknown, all tests of the group's atoms run.
2. A Report conclusion without an evidence reference is shown to the orchestrator as unverified and never enters the project map.
3. Low semif confidence becomes needs\_human, raised to the orchestrator, instead of letting a worker fix its own fix in a loop.
4. Only accepted conclusions are written to the state store's project map and to project-shared memory.
5. Direct work by the orchestrator runs tests only, without semif (§1, constraint 4).

## 15. Economics

Expensive models sit in three places only: decomposing user requests, bootstrap and regrouping, and worker execution. Everything else is a cheap model or deterministic code.

| Role | Model tier | Why |
| --- | --- | --- |
| Orchestrator | Strong reasoning; long context not required | Decomposition needs intelligence; context is rebuilt from the state store, not held in the window |
| G0 | Strong, woken on demand | Bootstrap and regrouping matter most but are rare |
| Worker | Strong; configurable per group | Writes the code |
| semif | System One discriminative model | Outputs probabilities only; cheap and fast |
| historian | Cheap, long context | The pairing realctx already validated |
| Scout | Cheap, read-only | Exploration needs no strong model; findings return with references (§7.5) |
| Watchdog, Partitioner, EscalationMonitor | Deterministic code | No model needed |

**Prompt-cache rules**

- System prompts are byte-identical for the life of a session (realctx snapshot).
- State views and notifications are appended, never rewritten. Older `rsa_state_view` results are dropped by realctx's supersession rule, with no new mechanism.
- Before the first escalation the orchestrator carries only `rsa_escalate`; other tools are added by a system-prompt patch, not a prompt rewrite (§7.2).
- Worker sessions live long, but a provider cache lives 5 minutes by default (Anthropic, OpenAI), so a prefix stays warm only while the worker is busy; resuming an idle worker pays one cache write. Pi's `PI_CACHE_RETENTION=long` extends Anthropic's cache to 1 hour at a higher write price (2× base input instead of 1.25×). It is an environment variable, so it is set per process and each role can choose it (route DD-3). Whatever lifetime a process uses, its realctx must assume the same one (`context.cacheTtlByModel`); otherwise realctx treats a warm cache as cold and rewrites the prefix early, or holds drops back while the cache is already cold. Variants and lanes share the parent's prefix when forked.
- Drops and compression apply when the cache is cold or usage crosses a threshold, as in realctx. These thresholds decide how large a prefix grows before relief, which is the r·g·n² term of §15.1. realctx settings schema v3 (2026-11-09) defaults: the last 24 turns are never dropped or compressed, queued drops apply at 40% of the safe input window with no token ceiling, history parts are prepared at 30%, emergency reclaim at 80%. realsubagents sets the Context and History settings per role instead of inheriting the user's global config, because a worker with a module-scoped job and the interactive orchestrator may want different values (tuned in v0.1; §17.1).

**Budgets.** Every task and group has a budget in **USD**, metered per assistant message from Pi's `usage` and the model registry's prices, so every role is charged at its own model's price. The benchmark uses the same meter. Where a model must see a token figure, W = cost ÷ the strong model's cache-read price per token. Exceeding a budget blocks the task and raises a wake notification; the orchestrator decides whether to add budget or abandon. Nothing keeps spending silently.

### 15.1 Cost model

The escalation threshold and the goals' feasibility both come from one model, fitted on the v0.0 benchmark. For a model with per-token prices r (cache read), w (cache write) and o (output), a single session of n turns with starting prefix P, net context growth g per turn after realctx drops, new tokens Δᵢ and output Oᵢ in turn i, and c cold restarts costs

```latex
C_{\text{single}} \approx \sum_{i=1}^{n} \big[\, r\,(P + g\,i) + w\,\Delta_i + o\,O_i \,\big] + c\,w\,\bar{L}
\;\approx\; r\,(nP + g\,n^2/2) + w\textstyle\sum\Delta_i + o\textstyle\sum O_i + c\,w\,\bar{L}
```

where L̄ is the mean context length at a cold restart. An escalated task with k lanes or subtasks of nⱼ turns each, worker prefix P\_w and growth g\_w costs

```latex
C_{\text{rsa}} \approx C_{\text{direct so far}} + \sum_{j=1}^{k} \big[\, r\,(n_j P_w + g_w\,n_j^2/2) + w\,P_w + w\textstyle\sum\Delta + o\textstyle\sum O \,\big] + C_{\text{scouts}} + C_{\text{overhead}}
```

with C\_overhead = o · (brief + plan + stubs + Reports + consult replies) + review and merge judge calls + historian.

- **Where savings come from.** The quadratic term: splitting n turns into k lanes divides g·n²/2 by about k; module-scoped context and scouts make g\_w < g; cold restarts of one huge context disappear.
- **Where costs come from.** k prefix writes w·P\_w, output-priced overhead, and scouts at cheap-model prices. Output is the most expensive token kind, so Reports, briefs and plans are kept short by template.
- **Fitting.** From v0.0 traces: P, g, Δ and O per task class; g\_w and overhead per Report, brief and plan from v0.05 and v0.1; the cold-restart rate. Gate: predictions within ±15% of measured cost. g depends on realctx's version and Context/History settings, so a fit holds only for the version and settings it was measured with; the benchmark pins both and the model is refitted when either changes.
- **Break-even.** Solve C\_rsa = C\_single for the projected task size; that is the default escalation threshold (§7.2), refitted as data accumulates.

## 16. Reliability and security

Reliability rests on three things: state lives outside the models, each group has one writer, and boundaries are enforced in code.

**Watchdog** (deterministic code in the coordinator; no model calls)

| Signal | Detection | Action |
| --- | --- | --- |
| Stall | No new tool call for a configured period | Steer a reminder → block and raise |
| Loop | The same tool with the same arguments repeated several times | Steer a reminder → abort and raise |
| Overrun | Task or group cost (USD) exceeds the budget | Block and raise |
| Scope break | The path tracker sees a write into another group's or lane's path set (bash included) | Abort immediately and raise |
| Context pressure | realctx emergency reclaim fires repeatedly | Raise, suggesting the orchestrator split the task |

Thresholds live in configuration; they start conservative and are tuned from telemetry.

**Crash recovery**

- A group process dies: re-adopt it the realtasks way (PID plus start time). If that fails, restart the group from its session file and the state store; its running tasks go back to their pre-dispatch state.
- The orchestrator restarts: rebuild groups, tasks and open asks from the state store.
- A consumer restarts: resume from its cursor; idempotency on `causation` prevents double effects.

**Permission boundaries**

- A `tool_call` hook in every member blocks edit and write into other groups' paths and contract files, and records shared-zone edits as shared patches (§13.3). Each group works in its own worktree, so another group's half-done code is never in its tree.
- bash writes cannot be intercepted reliably in advance, so review runs a git diff scope check as the backstop.
- Processes talk over stdio only. No network port, so no unauthenticated management API.
- Only MergeQueue writes `rsa/integration`, as merge trains; only `/rsa land` touches the user's branch.

## 17. Changes, phasing, open questions

### 17.1 Changes to realctx and realtasks

The changes are small; most turn a "session family" assumption into a setting.

| Component | Change | Why |
| --- | --- | --- |
| realctx | Configurable capture-budget scope: `capture.budgetScope = family, session or group` | Today a whole family shares 6 captures per hour; several groups would starve each other |
| realctx | Two kinds of subagent: long-lived **member** and disposable **helper**; members may extract historian facts | realctx §9.4 assumes subagents are disposable, but workers are where most knowledge appears; helpers serve as scouts (§7.5) |
| realctx | Sessions in one group may search each other's dropped outputs; G0 and the orchestrator may search any group read-only | semif, historians and the orchestrator recall worker evidence by reference |
| realctx | Per-process settings overlay for the Context and History sections (e.g. a `REALCTX_SETTINGS` file merged over `config.json`), with the shared memory store unchanged | Roles need different thresholds and cache lifetimes (§15). Today settings come only from `$REALCTX_HOME/config.json`, the same directory as the memory store, so a separate config means separate memories |
| realctx | Derive the cache lifetime from `PI_CACHE_RETENTION` when no per-model override is set; expose the resolved lifetime (`cacheTtls.resolve`) in the library | A worker on long retention would otherwise be compressed after 5 idle minutes; the resume-or-fresh decision (DD-3) needs the lifetime realctx uses |
| realctx | Three new judge question sets: completion, scope, merge risk | §14; judge client and policy layer unchanged |
| realctx | Expose remember, recall and judge as a library, not only as tools | realsubagents calls them from code |
| realtasks | Extract the exactly-once latch and delivery mapping into a reusable module | ReportBus reuses it |
| realtasks | Extract spawn and re-adoption into a reusable module | GroupRuntime manages group processes with it; RPC still uses Pi's rpc-client, not `task_input` |
| realtasks | Read-only access to task records and logs across sessions of one group | Review reads the test logs a worker produced |
| realtasks | A build queue with a concurrency cap shared by all groups, scaled to cores | §13.1 |

### 17.2 Phasing

First make one task go from request to accepted, measured against the baseline; then add parallelism and regrouping.

1. **v0.0 Benchmark and cost model.** A task set labelled small / large serial / large parallel; a USD meter from Pi's `usage` with raw tokens per role; wall-clock time against a single realctx session; the cost model of §15.1 fitted to the traces. Gate: baseline numbers exist, and the model predicts cost within ±15%.
2. **v0.05 Manual dry run.** Before building infrastructure: one orchestrator session and two plain `pi` sessions in two worktrees, with hand-written dispatch, brief and Report prompts, on multi-group tasks. Gate: ≤ 80% cost or ≤ 75% time at k = 2; otherwise revisit the design first. The prompts become v0.1's first drafts.
3. **v0.1 Skeleton.** Orchestrator, G0 and one group, all in-process; EscalationMonitor and `rsa_escalate`; task registry; Reports with exactly-once delivery; completion review; scouts. Gate: a real request reaches accepted and survives killing `pi`; small tasks within +10% (design target +3%); hint error rates logged.
4. **v0.2 Parallel.** Partitioner and multiple groups as separate processes; SandboxManager with per-group worktrees and shared build caches; ScopeGuard with shared patches; Watchdog; merge train; pipelined review; cross-group plans with on-demand consults, stubs, approval by policy and integration review. Gate: three groups in parallel with no build broken by another group's work in progress and no task blocked on a hub file; large parallel tasks meet the time and cost targets with a serial fraction under 25%.
5. **v0.3 Lanes and variants.** Lane planning and forking; variant worktrees, judged by tests and semif. Gate: large serial tasks meet the no-regression target, tasks that split into lanes meet the parallel targets, and one full two-variant decision completes.
6. **v0.4 Regrouping.** Split, merge, migrate, retire. Gate: a regroup loses no memory or journal entries.
6. **Later.** Run as one runtime under Multica: Multica manages issues and people, realsubagents manages the execution inside an issue.

### 17.3 Decisions and open questions

Decided in review:

- No up-front classification: every request starts direct; EscalationMonitor hints escalation from observed work; G0 owns only the project-specific criteria and is never on the small-task path.
- If a running task owns the target paths, the orchestrator steers that task.
- Group merges are done by one dedicated historian instance.
- Each group, lane and variant works in its own worktree; the build cache is shared, the tree is not. Trees sync from `rsa/integration` only at task boundaries (§13).
- The shared zone is split into mechanical files (shared patches applied by rule) and semantic files (optimistic contract requests) (§13.3).
- Cost is measured in USD from Pi's per-message usage and per-model prices; raw tokens are reported per role. Fixed token weights are not used.
- One writer per path set: a large task inside one group may split into lanes (§7.4); exploration goes to cheap-model scouts (§7.5).
- Plans, lane plans and contract changes are approved by policy unless they touch published contracts or public API, or exceed budget; reviews are pipelined; merges run as trains with bisection (§8.1).
- Time targets follow Amdahl's law: ≤ 75% at k\_eff = 2, ≤ 60% at k\_eff ≥ 3; large serial tasks have a no-regression target.
- MergeQueue has its own semif question set (merge risk).
- Atoms are build targets, with directories as the fallback.

Still open:

- The escalation threshold and the signal thresholds, from the fitted cost model's break-even point (§15.1).
- The rule set for mechanical shared patches per ecosystem (npm/pnpm, Cargo, Go, Python, Gradle), and which files default to semantic.
- Disk cost of full worktrees on large repositories on Windows without a Dev Drive; whether sparse-checkout is enough.
- Approval-policy thresholds: which plan sizes and contract changes still need the user.

### 17.4 References

- realctx: [github.com/WtzLAS/realctx](https://github.com/WtzLAS/realctx)
- realtasks: [github.com/st0nie/realtasks](https://github.com/st0nie/realtasks)
- DS Super-agent: [INSIDE coverage](https://www.inside.com.tw/article/42792-deepseek-super-agent-router-worker-ai-agent), [AIDeepThink on the prototype](https://aideepthink.cn/news/202611-deepseek-superagent-prototype-router-worker-open-source)
- Multica: [github.com/multica-ai/multica](https://github.com/multica-ai/multica)
- Magic Context: [github.com/cortexkit/magic-context](https://github.com/somjik-api/magic-context)
- Pi: [SDK](https://pi.dev/docs/latest/sdk), [RPC mode](https://pidocs.seepine.com/en/rpc)
