# realsubagents: Design Doc v1

Nov 9, 2026 · @StackWu

## 1. Goals

realsubagents is a Pi extension that runs one orchestrator over a small set of long-lived, module-scoped groups. v1 has two goals: **small tasks cost about the same tokens as a single session; large tasks finish markedly faster and use fewer tokens.** Every other decision serves these two. The guiding principle: **a model context is only a cache; the state store is main memory.**

| Scenario | Classified as | Metric | v1 target (to be calibrated) |
| --- | --- | --- | --- |
| Small task | The orchestrator completes it directly | Extra weighted tokens vs. a single session | ≤ +10% |
| Large task | Spans ≥ 2 groups, or a single session would have to compact or drop context to finish | Wall-clock time | ≤ 60% of a single session |
| Large task | Same | Weighted tokens | ≤ 80% of a single session |

**Benchmark method.** Same model, same task set; the baseline is one Pi session with realctx enabled. Weighted tokens = 5 × input + 10 × output + 1 × cache read + 5 × cache write; raw counts are reported alongside. Bootstrap cost is reported separately and not charged to individual tasks.

**Constraints the goals impose**

1. **Direct by default, escalate on demand.** The orchestrator first works like a single session. It dispatches only when the change spans groups or crosses the escalation threshold; a historian brief carries the context over. Small tasks never start a group process.
2. **Lazy bootstrap.** The project is modelled the first time a dispatch is needed. Partitioning is deterministic code; G0 reviews only the top two candidates.
3. **Savings must be computable.** A single session re-reads a growing prefix every turn; a group's context covers one module, and only Reports and references cross groups. These savings must exceed the added costs: one cache write per session, consults, Reports, review. The benchmark finds the break-even point, which becomes the default escalation threshold.
4. **Verification scales with task size.** Direct work runs tests only; dispatched work goes through the full ReviewPipeline.

**Quality attributes** (the means to the two goals)

| Attribute | Meaning | Check |
| --- | --- | --- |
| Elegant | Few concepts; each mechanism does one thing; reuse realctx and realtasks primitives | Each mechanism names the pain point it removes |
| Economical | Expensive models only where reasoning is needed; prompt cache preserved; communication on demand | Weighted tokens per task and per group; cache hit rate ≥ 90% |
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
| G0 (default group) | The orchestrator's kernel group: bootstrap, partitioning, contracts, regrouping, cross-group planning, simplicity judgments | Always exists; costs nothing while idle | `groups` table |
| Member | worker (the group's only writer), semif (judgments), historian (compression and extraction) | Worker session lives with the group; semif and historian are calls inside the realctx engine | realctx |
| Task | A unit of work, independent of any session; may have a parent (cross-group) or a fork origin | See §11 | `tasks` table |
| Report | A structured interrupt from a group to the orchestrator, with evidence references | Delivered once | `reports` table |
| Contract | An interface agreement between groups: API, data format, directory boundary | Owned by G0; changed only by request | `contracts` table + files in the repository |
| Proposal | A pending decision: regroup, contract change, variant, cross-group plan | Open until decided | `proposals` table |
| State store | The single source of truth for all of the above | Permanent | SQLite (§12) |

**The project model**

- **Atom**: the smallest unit of ownership. A build target (Bazel target, Cargo crate, npm workspace package); a directory when the build system gives no targets.
- **Edge**: correlation between two atoms, a weighted sum of git co-change, static dependencies and test locality (§7.1).
- **Project map**: atoms, edges, build and test commands, conventions. Versioned; never edited in place.
- **Partition**: an assignment of atoms to groups. Hub atoms and noise files go to the **shared zone**, owned by G0 and changed only through contracts.

**Invariants**

1. Group path sets are disjoint. Shared-zone atoms belong to no worker.
2. One writer per group: a worker session holds at most one running task.
3. Every state change is an event appended to the state store; every other table is a projection.
4. Commands flow down over RPC or the SDK; events flow up only through the state store.
5. A model context is a cache. Anything needed after a restart lives in the state store or in realctx memory.
6. Only verified conclusions enter the project map and project-shared memory.

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
2. Every other group is a `pi --mode rpc` child process. Its cwd follows the isolation level (§13); by default all groups share one working tree.
3. A `GroupRuntime` interface has two implementations, `inProcess` and `subprocess`, with the same operations. v0.1 runs everything in-process; switching is configuration.

&#91;embedded content: Process topology · one interactive process, N group child processes\]

The orchestrator and G0 share the user's pi process; each other group is a child process. Only dispatch and steer go down, only Report interrupts come up; groups also append journal entries and evidence to the state store, which the drawing leaves out.

## 5. Modules

One extension loads in two roles: **coordinator** in the user's `pi`, **member** in each group process, chosen by `RSA_ROLE`, `RSA_GROUP` and `RSA_DB`. One rule ties them together: **commands go down over RPC or the SDK; events go up only by appending to the state store.** Events are therefore durable and transport-independent, and in-process and subprocess groups follow the same path.

&#91;embedded content: Modules · 10 in the coordinator, 4 in each member\]

The state store sits between the two roles: members only append to it, and coordinator consumers tail it. The one channel in the other direction is GroupRuntime's commands.

| Module | Role | Responsibility | Internal data | Depends on |
| --- | --- | --- | --- | --- |
| StateStore | both | Append events; update projections in the same transaction; serve tails by sequence number | Event log, projection tables, consumer cursors | SQLite + WAL + lease lock, as in realctx |
| Dispatcher | coordinator | Validate and execute task operations; enforce single writer, dependencies and budgets | None beyond the registry | StateStore, GroupRuntime |
| GroupRuntime | coordinator | Start and stop group processes and sessions; deliver prompt, steer, followUp, abort, fork | Process and session handles | Pi SDK and RPC; realtasks process-lifecycle module |
| ReportBus | coordinator | Turn events into orchestrator notifications, exactly once, coalesced | Delivery latch per event; coalescing window | realtasks notification-latch module |
| ReviewPipeline | coordinator | Verify work claimed done: tests, diff, scope check, semif | Reviews in flight | realtasks, realctx judge, git |
| Watchdog | coordinator | Detect stalls, loops, overruns and scope breaks; act deterministically | Heartbeats and counters per task | StateStore |
| MergeQueue | coordinator | Merge accepted work into the integration baseline, one item at a time | Queue order | git, realtasks, realctx judge |
| Partitioner | coordinator | Build atoms and edges; compute candidate partitions for k = 1…5 | Partition candidates | Build system, git history |
| Classifier | coordinator | Run the deterministic simplicity check; hand undecidable cases to G0 | Current criteria (set by G0) | Project map |
| G0 session | coordinator | Bootstrap review, partition review, contracts, regrouping, cross-group plans, simplicity judgments | Its own session | Pi SDK, realctx |
| ScopeGuard | member | Block writes outside the group; redirect reads of other groups' paths to the integration baseline | Path set, contract list | realctx path tracker |
| Heartbeat | member | Emit progress events | None | Pi hooks |
| Member tools | member | Report, ask, request contracts, answer consults, propose variants | None | StateStore |

The orchestrator is not a module: it is the user's Pi session, and it uses these modules through the tools in §9.

## 6. Module behavior

Every module reacts only to events or tool calls, and changes state only by appending events. The table is the complete set of trigger–action rules; event names are defined in §10.

| Module | Trigger | Action | On failure |
| --- | --- | --- | --- |
| Dispatcher | Task tool calls (create, dispatch, steer, resume, fork, reparent, cancel, escalate) | Check preconditions (state, single writer, dependencies, budget); call GroupRuntime; append the matching event | Precondition fails: the tool returns an error and no event is appended |
| GroupRuntime | `group.spawn_requested`; Dispatcher commands | Start or stop processes and sessions; deliver prompt, steer, followUp, abort, fork | Process will not start: `group.crashed`. Command not delivered: retry once, then `task.blocked` |
| ReportBus | `report.emitted` and every event marked wake or passive | Deliver to the orchestrator by policy, exactly once; coalesce arrivals within 300 ms | Already read through `rsa_state_view` or `rsa_task_wait`: the latch flips and nothing is sent |
| ReviewPipeline | `task.review_requested`, `task.integration_requested` | 1. Build a snapshot (§13) 2. Run the project map's tests 3. Diff statistics and scope check 4. semif completion check 5. Append `review.verdict` | No test command: needs\_human. Judge unavailable: queue and retry |
| Watchdog | `task.progress`, `budget.*`; a scan every 30 s | Apply the rules in §16: steer, block or abort; append `watchdog.alert` | Uses no model |
| MergeQueue | `review.verdict` = accept | One at a time: rebase → semif merge-risk check → tests → merge → `merge.done` | Conflict or test failure: `merge.failed`; the task returns to running and the reason is steered to its worker |
| Partitioner | `rsa_partition_compute`; periodic re-run after `merge.done` counts pass a threshold | Compute atoms, edges and candidates; append `partition.computed` | Build system unreadable: fall back to directories |
| Classifier | `rsa_classify` | Check the request against the criteria (§7.2); return direct, dispatch, or undecided | Undecided: ask G0 |
| G0 | Bootstrap, partition review, `contract.requested`, cross-group tasks, unowned tasks, undecided classifications | Read code, produce structured results, open proposals | Nothing takes effect until a proposal is approved |
| ScopeGuard | Member `tool_call` (edit, write, read) | Read of another group's path: rewrite to the integration baseline. Write outside the path set or contract files: block and append `scope.violation` | Path cannot be parsed: allow; the diff check during review catches it |
| Heartbeat | Member `turn_end`, `tool_result` | Append `task.progress`: tool-call count, last tool, weighted tokens | — |

**The orchestrator's turn**

1. A user message arrives. Call `rsa_classify`. Direct: do the work in this session. Dispatch: create tasks with `rsa_task_create`. If a running task already owns the target paths, steer that task instead of editing.
2. While working directly, if the actual change crosses any simplicity threshold, call `rsa_escalate`: a historian brief carries the context into a new task.
3. After dispatching, keep talking with the user. Never poll.
4. On a wake notification: decide needs\_decision and contract\_request yourself when you can, otherwise ask the user; for blocked and failed, choose steer, more budget, or abandon.
5. For a global view, call `rsa_state_view`. For details, follow a Report's references with `rsa_recall`; never ask a group to paste content.
6. Nothing to do while tasks run: end the turn and wait for an interrupt. Use `rsa_task_wait` only when the user asks to wait for a result.

**The worker contract** (part of the member system prompt)

1. Write only inside the group's path set. Request contract changes with `rsa_request_contract`; never edit contract files.
2. Run the tests before claiming done; completion is decided by the ReviewPipeline, not by the claim.
3. Call `rsa_report` only for done, blocked, needs\_decision and failed. Progress comes from Heartbeat.
4. When unsure of direction, call `rsa_ask`; continue with independent work until the answer arrives, or mark the ask as blocking.
5. Apply a steer immediately; no acknowledgement is needed.
6. Answer consults with `rsa_consult_reply` from what you already know; a consult never changes your task.

## 7. Flows I: bootstrap, direct work, task lifecycle

### 7.1 Bootstrap and partitioning

Bootstrap runs the first time a dispatch is needed. Atoms are **build targets**, with directories as the fallback; edges are weighted by **correlation**. Layer- or module-based splitting needs no separate mechanism: it is what this algorithm produces when history is short.

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
6. **Review.** G0 reads the top two candidates, names the groups, adjusts them with semantic judgment, writes the rationale, and also writes the project map and the simplicity criteria. The orchestrator asks the user to confirm.

A partition assigns ownership; it does not start processes. A group process starts at its first dispatch, so a larger k adds cross-group overhead but no idle cost.

### 7.2 Direct work and escalation

G0 owns the simplicity criteria and updates them after bootstrap and every regrouping. To keep the check from eating a small task's budget, it runs in two stages: the Classifier applies the criteria in code, and G0 is woken only when the code cannot decide.

| Criterion | Default | Checked by |
| --- | --- | --- |
| Files touched | ≤ 3 | Code |
| Groups touched | Exactly 1, no shared zone or contract files | Code (path-set match) |
| Expected changed lines | ≤ 150 | Code |
| Dependencies, database schema, public API | Unchanged | Code screens by path and file type; G0 confirms |
| Expected weighted tokens | Below the escalation threshold (benchmark break-even) | Code |

- All met: the orchestrator works directly.
- Any clearly unmet: dispatch.
- Cannot be decided from the request (no paths named, for example): G0 decides.
- A direct change that crosses any threshold mid-way: stop, `rsa_escalate`, continue as a dispatched task.
- A running task already owns the target paths: steer that task; never edit around its worker.

### 7.3 Task lifecycle in one group

1. **Create.** `rsa_task_create` records a queued task with goal, acceptance criteria, paths and budget. Without an explicit group, the path set decides; unmatched tasks go to G0.
2. **Dispatch.** The Dispatcher checks dependencies and the single-writer rule, starts the group if needed, and sends the task to its worker.
3. **Run.** The worker works; Heartbeat emits progress. The orchestrator may steer; the worker may ask or request a contract change (blocked until answered).
4. **Claim.** `rsa_report(done)` moves the task to review.
5. **Review.** The ReviewPipeline verifies in a snapshot. Reject: back to running with the verdict steered in. needs\_human: blocked and raised. Accept: idle, queued for merge.
6. **Merge.** MergeQueue merges; the task becomes done. The worker keeps its context, so a follow-up task can `rsa_task_resume` from it.

## 8. Flows II: cross-group tasks, variants, regrouping

### 8.1 Cross-group tasks

A task that needs several groups is never solved by merging them. **The solution is decided in one place, split along contracts, ordered by a dependency graph, and joined in the parent task's journal.**

**Who decides: G0, after consulting.**

1. G0 sends `rsa_consult` to each affected group. Each worker answers from its warm context: impact, constraints, risks, size estimate.
2. G0 combines the answers into a plan: contract delta, one subtask per group, dependencies.
3. The plan is a proposal; the orchestrator approves it, asking the user when needed.

Contexts never move; only questions and answers do. A consult is read-only: the worker writes no code, and its current task is unaffected.

**Ordering: a parent task with a subtask graph.**

1. **Contract first.** The first subtask belongs to G0: interfaces and stubs, committed to the integration baseline.
2. **Parallel work.** Providers implement; consumers build against the contract at the same time. Consumers depend on the contract subtask, not on the provider's implementation.
3. **Integration review.** When every subtask is idle, the parent enters review. The ReviewPipeline runs cross-group tests in a snapshot of baseline + all subtask diffs. A failure goes back to the subtask whose paths it touches.
4. **Merge as a unit.** MergeQueue merges all subtasks together, or none.

Path sets are disjoint and each group has one writer, so "who edits this file first" never arises; only semantic order remains, and the graph expresses it.

**Why not merge the groups.** Merging is a regrouping tool for lasting coupling, not for one task. Each group's historian compresses its own session as usual; G0 writes the parent's summary from the subtasks' structured journal entries. No transcript is merged, so no historian has to choose a side. Frequent cross-group tasks between the same pair are the signal to merge them through §8.3.

### 8.2 Variants

A variant is a forked worker session plus a copy-on-write snapshot, judged by tests and semif. Forking context is cheap because the shared prefix hits the cache; forking the environment is cheap because the snapshot stores only differences and builds share a cache.

1. **Trigger.** The orchestrator, or a worker via `rsa_propose_variant`, asks for n variants (default 2, capped by budget) with judging criteria.
2. **Fork.** The worker session forks n times. realctx copies referenced originals into each child, so placeholders stay byte-identical and expandable. Each fork is steered toward a different direction.
3. **Environment.** One copy-on-write snapshot per variant on branch `rsa/<task>/<v>`, whatever the project's isolation level.
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

Primitives come in four layers: model tools, user commands, events (§10) and a code-level library. Each role's model sees only its own tools. Every tool is prefixed `rsa_`, matching realctx's naming.

**Orchestrator tools**

| Tool | Parameters | Semantics |
| --- | --- | --- |
| `rsa_classify` | request, paths? | Simplicity check (§7.2): direct, dispatch, or decided by G0 |
| `rsa_escalate` | summary | Turn the current direct work into a task; a historian brief carries the context |
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
| `rsa_proposal_decide` | proposal, approve, note? | Approve or reject a regroup, contract, variant or cross-group plan |

**G0 tools**

| Tool | Parameters | Semantics |
| --- | --- | --- |
| `rsa_partition_compute` | kmin?, kmax? | Run the Partitioner; return candidates with cross-group ratio and sizes |
| `rsa_map_write` | atoms, edges, commands, conventions, criteria | Write a new project-map version, including the simplicity criteria |
| `rsa_regroup_propose` | op: create, split, merge, migrate or retire; groups; paths; rationale | Open a regroup proposal |
| `rsa_consult` | groups\[\], question, parent? | Send a read-only consult; collect structured replies |
| `rsa_plan_cross_group` | parent, contract\_delta, subtasks\[\], deps\[\] | Open a cross-group plan proposal |
| `rsa_contract_update` | contract, change, affected\_groups | Edit contract files and notify affected groups |
| `rsa_task_assign` | task, group | Place an unowned task |
| `rsa_classify_decide` | request, verdict: direct or dispatch, reason | Decide a case the Classifier could not |

**Worker (member) tools**

| Tool | Parameters | Semantics |
| --- | --- | --- |
| `rsa_report` | kind, summary, evidence\[\], asks? | Append `report.emitted`; kind = done also requests review |
| `rsa_request_contract` | contract?, change, reason | Append `contract.requested`; the task becomes blocked |
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
  cost: { weighted_tokens, budget }
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
| `/rsa budget <task or group> <n>` | Change a budget |
| `/rsa rebuild` | Rebuild projections by replaying events |

**Library API** (for tests and other extensions)

```ts
interface Rsa {
  tasks:  { create, dispatch, steer, resume, fork, reparent, cancel, escalate, get, list }
  groups: { spawn, split, merge, migrate, retire, pause, get, list }
  events: { append(e: EventInput): Promise<Event>; tail(fromSeq: number, filter?): AsyncIterable<Event> }
  partition: { compute(kmin?: number, kmax?: number): Promise<Candidate[]> }
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
| `task.progress` | Heartbeat | Tool-call count, weighted tokens | silent (dock and Watchdog only) |
| `task.steered` | Dispatcher | A steer was delivered | silent |
| `task.escalated` | Dispatcher | Direct work became a task | silent |
| `task.blocked` | worker, Dispatcher, Watchdog | Blocked, with a reason | wake |
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
| `merge.enqueued`, `merge.done`, `merge.failed` | MergeQueue | Merge progress | silent, passive, wake |
| `group.spawn_requested`, `group.spawned` | Dispatcher, GroupRuntime | Group process start | silent |
| `group.paused`, `group.resumed` | user, orchestrator | Pause and resume | silent |
| `group.crashed`, `group.readopted` | GroupRuntime | Crash and re-adoption | wake, silent |
| `group.retired` | Dispatcher | Retired | passive |
| `partition.computed` | Partitioner | Candidate partitions ready | silent |
| `proposal.opened`, `proposal.decided`, `proposal.applied` | G0, worker, orchestrator | Regroup, contract, variant or cross-group plan | wake, silent, passive |
| `contract.requested`, `contract.updated` | worker, G0 | Contract change | wake, passive |
| `scope.violation` | ScopeGuard | Write outside the path set was blocked | wake |
| `watchdog.alert` | Watchdog | stall, loop or context pressure | wake |
| `budget.exceeded`, `budget.raised` | Watchdog, orchestrator | Budget overrun and increase | wake, silent |

**Delivery and durability**

1. An event and its projection updates commit in one transaction. If the write fails, the operation fails and the caller sees the error.
2. Each consumer (ReportBus, Watchdog, ReviewPipeline, MergeQueue, dock) keeps its own cursor and tails by `seq`; after a restart it resumes from the cursor. Delivery is at-least-once; actions are idempotent on `causation`, so effects happen exactly once.
3. Members write the shared database directly (WAL + lease lock). The coordinator polls for new `seq` every 250 ms; same-process writes also wake consumers directly.
4. Delivery to the orchestrator uses the realtasks latch: it flips when delivered or when `rsa_state_view` or `rsa_task_wait` has already shown the event.

**Mapping onto Pi hooks**

| Pi hook | Coordinator | Member |
| --- | --- | --- |
| `session_start` | Open the state store, migrate, re-adopt group processes, restore consumer cursors | Read `RSA_*`, load the path set, register member tools |
| `before_agent_start` | Inject the stable orchestration prompt (byte-identical) | Inject group description, path set and contract list (byte-identical) |
| `tool_call` | — | ScopeGuard |
| `tool_result` | — | Heartbeat counters |
| `turn_end` | Deliver when the coalescing window expires | Append `task.progress` |
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
| running | `task.blocked` (ask, contract request, budget, watchdog) | blocked |
| blocked | `ask.answered`, `contract.updated`, `budget.raised`, `task.steered` | running |
| running | `task.review_requested` | review |
| running (parent) | `task.integration_requested` | review |
| review | `review.verdict` = reject | running (verdict steered to the worker) |
| review (parent) | `review.verdict` = reject, with failing paths | running; the matching subtasks return to running |
| review | `review.verdict` = needs\_human | blocked |
| review | `review.verdict` = accept | idle, plus `merge.enqueued` |
| idle | `merge.done` | done (a parent's subtasks become done together) |
| idle | `merge.failed` | running |
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
| `groups` | id | name, state, atoms, paths, contracts, runtime, isolation, sandbox, worker\_session, pid, pid\_start, model, budget, used | (state) | Projection |
| `tasks` | id | title, goal, acceptance, state, group, worker\_session, parent, forked\_from, resumed\_from, depends\_on, paths, budget, used | (group, state), (parent), (state) | Projection |
| `task_sessions` | (task, session, from\_seq) | role: worker, variant or handover; to\_seq | (session) | Projection; which sessions a task passed through |
| `reports` | id | task, kind, summary, evidence, verdicts, notified | (task), (notified) | Projection |
| `asks` | id | task, question, blocking, answer, state | (task, state) | Projection |
| `consults` | id | parent, group, question, reply (JSON), state | (parent) | Projection |
| `proposals` | id | kind: regroup, contract, variant or plan; payload; state; author | (state) | Projection |
| `contracts` | id | path, groups, version | (path) | Projection; the text lives in repository files |
| `project_map` | version | atoms, edges, commands, conventions, criteria (JSON) | — | Projection; append-only versions |
| `partitions` | (version, k) | groups, cross\_ratio, sizes, chosen | (chosen) | Projection; every candidate kept for comparison |
| `merge_queue` | task | branch, state, position | (state, position) | Projection |
| `journal` | (group, seq) | task, entry | — | Projection of `report.emitted` and `review.verdict`; historians read it for briefs |
| `meta` | key | value | — | Holds `schema_version` |

**Files**

| Content | Location | Committed |
| --- | --- | --- |
| Database | `~/.pi/agent/realsubagents/rsa.sqlite` | No |
| Configuration | `~/.pi/agent/realsubagents/config.json` | No |
| Group sandboxes (snapshots or worktrees) | `~/.pi/agent/realsubagents/sandboxes/<project_key>/<group>/` | No; outside the repository |
| Contract files | `<repo>/.pi/rsa/contracts/*.md` | Yes |
| Readable project map | `<repo>/.pi/rsa/map.md` | Yes; exported by G0 from the latest version |

**Schema migration.** `meta.schema_version` records the version; migrations only move forward. The coordinator migrates at `session_start` under the lease lock. A member that finds a newer schema than it understands refuses to start and says so, so old code never writes into new tables.

## 13. Isolation levels

One full worktree per group does not scale: in a large project it means N copies on disk, N builds and N times the memory. Isolation is a per-project setting with four levels; **the default is snapshot-at-review**: groups share one working tree day to day, and isolation is materialized only for review, merge and variants.

| Level | How | Disk | Builds | Isolation |
| --- | --- | --- | --- | --- |
| shared | All groups share one working tree; disjoint path sets are enforced by ScopeGuard | 1 copy | One shared incremental cache | Low: another group's half-done change can break your full build |
| snapshot-at-review (default) | Shared tree day to day; for review and merge, a copy-on-write snapshot of baseline + this group's diff is built and tested | Differences only | Shared build cache | Review results are unaffected by other groups' work in progress |
| cow-per-group | One long-lived copy-on-write snapshot per group | Differences only | Separate builds, eased by the shared cache | High |
| worktree | One git worktree per group | Full | Full | Highest |

**Implementation**

- Copy-on-write by platform: reflink copies on btrfs, XFS and APFS; on Linux, also overlay mounts (user-space fuse-overlayfs). Without either, fall back to worktree and say so in the `/rsa` panel.
- Variants always use copy-on-write snapshots, regardless of the project's level.
- Heavy builds and test runs go through a realtasks build queue with a concurrency cap (default 2), so several groups never compile everything at once.
- In shared and snapshot-at-review, a worker whose build fails inside another group's paths says so in its Report, with evidence. The ReviewPipeline assigns responsibility by path; the worker never fixes another group's code.

**Measures when groups share a working tree** (shared and snapshot-at-review)

Groups may read each other's code. In a shared tree another group's files may be half-edited, so these measures apply by default:

| Aspect | Measure |
| --- | --- |
| Writes | ScopeGuard blocks edit and write outside the path set; bash writes are caught by the diff check at review |
| Reads | ScopeGuard rewrites reads of another group's paths to the integration baseline (reviewed and merged code), never the half-done version. For the latest state, use `rsa_consult` or an explicit live read, which is logged as an event |
| Build outputs | Each group has its own output directory; only the compile cache is shared |
| Long-running processes | Dev servers and similar get a port range per group |
| git | Workers never touch the shared git index; add, commit and rebase are done only by MergeQueue |

In cow-per-group and worktree, other groups' trees are mounted read-only.

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

1. A worker saying the tests pass proves nothing. In review, realsubagents runs the project map's test commands itself through realtasks, inside the snapshot, and records the result as evidence.
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
| Watchdog, Partitioner, Classifier | Deterministic code | No model needed |

**Prompt-cache rules**

- System prompts are byte-identical for the life of a session (realctx snapshot).
- State views and notifications are appended, never rewritten. Older `rsa_state_view` results are dropped by realctx's supersession rule, with no new mechanism.
- Worker sessions live long, so their prefixes stay warm; variants share the parent's prefix.
- Drops and compression apply when the cache is cold or usage crosses a threshold, as in realctx.

**Budgets.** Every task and group has a budget in **weighted tokens**:

```latex
W = 5\,T_{\text{input}} + 10\,T_{\text{output}} + 1\,T_{\text{cache read}} + 5\,T_{\text{cache write}}
```

The benchmark uses the same weights. Exceeding a budget blocks the task and raises a wake notification; the orchestrator decides whether to add budget or abandon. Nothing keeps spending silently.

## 16. Reliability and security

Reliability rests on three things: state lives outside the models, each group has one writer, and boundaries are enforced in code.

**Watchdog** (deterministic code in the coordinator; no model calls)

| Signal | Detection | Action |
| --- | --- | --- |
| Stall | No new tool call for a configured period | Steer a reminder → block and raise |
| Loop | The same tool with the same arguments repeated several times | Steer a reminder → abort and raise |
| Overrun | Task or group weighted tokens exceed the budget | Block and raise |
| Scope break | The path tracker sees a write outside the group's path set | Abort immediately and raise |
| Context pressure | realctx emergency reclaim fires repeatedly | Raise, suggesting the orchestrator split the task |

Thresholds live in configuration; they start conservative and are tuned from telemetry.

**Crash recovery**

- A group process dies: re-adopt it the realtasks way (PID plus start time). If that fails, restart the group from its session file and the state store; its running tasks go back to their pre-dispatch state.
- The orchestrator restarts: rebuild groups, tasks and open asks from the state store.
- A consumer restarts: resume from its cursor; idempotency on `causation` prevents double effects.

**Permission boundaries**

- A `tool_call` hook in every member blocks edit and write outside the path set and contract files, and redirects cross-group reads (§13).
- bash writes cannot be intercepted reliably in advance, so review runs a git diff scope check as the backstop.
- Processes talk over stdio only. No network port, so no unauthenticated management API.
- Merges into the integration baseline go through MergeQueue, one at a time.

## 17. Changes, phasing, open questions

### 17.1 Changes to realctx and realtasks

The changes are small; most turn a "session family" assumption into a setting.

| Component | Change | Why |
| --- | --- | --- |
| realctx | Configurable capture-budget scope: `capture.budgetScope = family, session or group` | Today a whole family shares 6 captures per hour; several groups would starve each other |
| realctx | Two kinds of subagent: long-lived **member** and disposable **helper**; members may extract historian facts | §9.4 assumes subagents are disposable, but workers are where most knowledge appears |
| realctx | Sessions in one group may search each other's dropped outputs; G0 and the orchestrator may search any group read-only | semif, historians and the orchestrator recall worker evidence by reference |
| realctx | Three new judge question sets: completion, scope, merge risk | §14; judge client and policy layer unchanged |
| realctx | Expose remember, recall and judge as a library, not only as tools | realsubagents calls them from code |
| realtasks | Extract the exactly-once latch and delivery mapping into a reusable module | ReportBus reuses it |
| realtasks | Extract spawn and re-adoption into a reusable module | GroupRuntime manages group processes with it; RPC still uses Pi's rpc-client, not `task_input` |
| realtasks | Read-only access to task records and logs across sessions of one group | Review reads the test logs a worker produced |
| realtasks | A build queue with a concurrency cap shared by all groups | §13 |

### 17.2 Phasing

First make one task go from request to accepted, measured against the baseline; then add parallelism and regrouping.

1. **v0.0 Benchmark.** A task set and a meter for weighted tokens and wall-clock time against a single realctx session. Gate: the baseline numbers exist for small and large tasks.
2. **v0.1 Skeleton.** Orchestrator, G0 and one group, all in-process; Classifier and escalation; task registry; Reports with exactly-once delivery; completion review. Gate: a real request reaches accepted and survives killing `pi`; small tasks within +10%.
3. **v0.2 Parallel.** Partitioner and multiple groups as separate processes; ScopeGuard; Watchdog; snapshot-at-review isolation. Gate: three groups work in parallel with no scope violations.
4. **v0.3 Variants.** Fork, copy-on-write snapshots, judging by tests and semif. Gate: one full two-variant decision.
5. **v0.4 Regrouping and cross-group work.** Split, merge, migrate, retire; contract requests; consults, parent tasks and integration review. Gate: a merge loses no memory or journal entries; large tasks meet the time and token targets.
6. **Later.** Run as one runtime under Multica: Multica manages issues and people, realsubagents manages the execution inside an issue.

### 17.3 Decisions and open questions

Decided in review:

- G0 owns the simplicity criteria; the Classifier applies them and escalates undecidable cases to G0.
- If a running task owns the target paths, the orchestrator steers that task.
- Group merges are done by one dedicated historian instance.
- Groups may read each other's code; shared trees still isolate reads, builds, ports and git (§13).
- Budgets use weighted tokens: input 5, output 10, cache read 1, cache write 5.
- MergeQueue has its own semif question set (merge risk).
- Atoms are build targets, with directories as the fallback.

Still open:

- The numeric simplicity thresholds and the escalation threshold, to be calibrated from the v0.0 benchmark's break-even point.

### 17.4 References

- realctx: [github.com/WtzLAS/realctx](https://github.com/WtzLAS/realctx)
- realtasks: [github.com/st0nie/realtasks](https://github.com/st0nie/realtasks)
- DS Super-agent: [INSIDE coverage](https://www.inside.com.tw/article/42792-deepseek-super-agent-router-worker-ai-agent), [AIDeepThink on the prototype](https://aideepthink.cn/news/202611-deepseek-superagent-prototype-router-worker-open-source)
- Multica: [github.com/multica-ai/multica](https://github.com/multica-ai/multica)
- Magic Context: [github.com/cortexkit/magic-context](https://github.com/somjik-api/magic-context)
- Pi: [SDK](https://pi.dev/docs/latest/sdk), [RPC mode](https://pidocs.seepine.com/en/rpc)
