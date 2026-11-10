# Prompt guidance for prompts v0 (route R.05.1, PR-4 … PR-7)

Distilled from the vendors' current guides (read 2026-11-10). The benchmark model is Claude Opus 5.5, so Anthropic's guidance for that model wins where the vendors differ. Each rule below says where it comes from and which prompt it shapes.

## Sources

- [A] Anthropic, [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [A55] Anthropic, [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
- [A5] Anthropic, [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) (the 5.5 guide says its patterns still apply)
- [AM] Anthropic Engineering, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [O6] OpenAI, [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) and [A model guide for the GPT-6 family](https://openai.com/index/practical-guide-building-gpt-6/)
- [OC] OpenAI, [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- [G] Google Cloud, [System instructions and prompt engineering for agentic AI](https://docs.cloud.google.com/gemini/docs/discover/engineer-agentic-prompts)
- [G3] Google Cloud, [Gemini 3 prompting guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/gemini-3-prompting-guide)
- [T] TechSphere News, [OpenAI's GPT-6 Astra prompting guide: initiative, slop words, and test overruns](https://techspherenews.com/openai-s-gpt-6-astra-prompting-guide-initiative-slop-words-and-test-overruns) (secondary report of OpenAI's guide)
- [S] AOT Library, [Drop ad-hoc test-writing prompts; tell test-heavy models not to write tests](https://mahalsystems.ai/aot/optimizations/no-self-written-tests/) (summarises SWE-bench prompt studies)
- [U] The user's own experience with GPT-6 (2026-11-10): it over-engineers, especially by writing many tests that are never used, and it is passive: it does not take a step unless that step is stated explicitly.

## Rules and where they apply

| # | Rule | Source | Applied in |
|---|---|---|---|
| 1 | Put stable instructions in the system prompt and dynamic inputs (task, brief, Reports) in user messages. Never change the system prompt or tool list mid-session: doing so invalidates the cache and earlier thinking. | [A55], [G], [O6] (caching) | All roles: the contracts go in through `--append-system-prompt` from the first request; dispatches and Reports are user messages |
| 2 | Give each delegate an objective, an output format, guidance on tools and sources, and clear task boundaries. Vague delegation causes duplicated work and gaps. | [AM] §2 | PR-5 dispatch fields: goal, acceptance, paths, other groups' paths, brief, Report format |
| 3 | Say what "done" includes, up front. Without that, agents stop at a first draft or keep going past the point. | [O6], [A55] "unattended runs" | PR-5 `acceptance`; PR-6 rule "done means" |
| 4 | Opus 5.x verifies its own work. Explicit "add a verification step" instructions cause over-verification. Define completion, not a checking ritual. | [A5] | PR-6 says what done is, not "verify twice"; no verifier subagent |
| 5 | Opus 5.x can widen or narrow scope. Ask it to deliver the task at the intended scope and to say in one sentence if the request looks wrong. | [A5] | PR-6 scope rule; the path set gives scope a concrete form |
| 6 | Explain why a rule exists. The model generalises from the reason. | [A] "add context" | PR-6: why stay in your paths (parallel writer, merge); PR-7: why Reports are short (output price, orchestrator context) |
| 7 | Use plain, normal language. Aggressive wording ("CRITICAL", "MUST") makes current models over-trigger or take boundaries too literally. | [A] tool use, [O6] boundaries | All prompts |
| 8 | Explicitly authorise safe routine work so the agent does not stop to ask. | [O6] | PR-6: running local builds and tests needs no approval |
| 9 | Unattended agents stop early with a summary. Name the unwanted stops; on the harness side, treat a text-only end of turn as a report, and continue at most 2–3 times. | [A55] | PR-6 closing paragraph; relay `continue` rule (max 2) |
| 10 | In multiagent harnesses, show elapsed time on every message back to the model, plus one sentence that time matters. | [A55] "time signals" | Relay appends `elapsed Ns` to every dispatch, Report, steer and continuation |
| 11 | Structure with consistent XML tags; keep tag names the same across prompts. | [A], [G] | `<task>`, `<acceptance>`, `<paths>`, `<other_groups>`, `<brief>`, `<report>` |
| 12 | Put the core request and the critical constraints last, after the context. | [G3] | Dispatch ends with the paths rule and the Report instruction |
| 13 | Tool descriptions: short, one purpose each, and say exactly when to use the tool. | [O6] skills, [AM] §4, [G] schemas (types, enums, required) | `rsa_dispatch`, `rsa_steer`, `rsa_finish`, `rsa_report` |
| 14 | Scale effort to complexity, with explicit numbers. | [AM] §3 | Orchestrator: exactly 2 groups in v0.05 (k = 2), explore only enough to split |
| 15 | Calibrate the length of written output explicitly. Opus 5.x writes long documents unless told otherwise. | [A5] | PR-7: summary at most 3 lines; evidence as references, not pasted content |
| 16 | Don't ask for an upfront plan or running status updates in an autonomous rollout: it makes the model stop early. | [OC] | Workers are not asked for plans or progress notes; Heartbeat is the harness's job (design §6) |
| 17 | Batch independent tool calls in parallel. | [A], [OC] | Not added: Pi's base prompt and Opus 5.5 already do this; adding it would differ from the baseline arm |
| 18 | Keep context lean: delegates return synthesised results, not raw logs. | [G] context hygiene, [AM] | PR-7 references instead of pasted logs; the orchestrator never asks a group to paste |

## Model-family overlays

Some tendencies belong to one model family, and the fix for one family hurts another. For example, explicit "run the tests" instructions help a passive model but cause over-verification on Opus 5.x ([A5]). So the shared prompts (`orchestrator.md`, `worker.md`) stay family-neutral, and the relay appends `overlays/<provider>-<role>.md` after them when the role's model comes from that provider. It is still one system prompt, fixed from the first request (rule 1).

| Overlay | Tendency | Sources | What it says |
|---|---|---|---|
| `openai-worker.md` | Passive: waits for explicit permission or a restated request; stops after a first implementation | [O6], [T], [U] | Lists the routine steps it may take without asking (edit in paths, build, run affected tests, fix, rerun) and treats the acceptance as the request to carry through |
| `openai-worker.md` | Over-engineering, especially unused tests and checking scripts; runs disproportionately large test suites on small changes | [T], [S], [U] | A new test only when the acceptance asks for one or the behaviour is untested; extend existing files; no self-check scripts or helpers; run the affected tests, not the suite; minimal code change |
| `openai-orchestrator.md` | Passive: presents a plan for approval instead of dispatching | [O6], [T], [U] | Dispatch both workers once the split is known; decide on Reports in the same turn |

There is no Anthropic overlay. The v0.05 benchmark runs Opus 5.5 in every role, and its tendencies (scope drift, long written output) are handled in the shared prompts.

**Benchmark fairness.** The overlays and the shared prompts contain no cost-saving instruction that the baseline arm lacks; the test-restraint rule exists only in the OpenAI overlay, which v0.05 does not use. Otherwise v0.05 would measure a prompt change, not the architecture. If test restraint is worth having for Opus too, it is tuned as a separate knob in both arms (`reports/tuning/`).

## Deliberately not used

- **Effort changes.** [A55] suggests starting Opus 5.5 at `medium`. The baseline ran at `high`, so the arms stay at `high`; effort is a separate tuning knob (`reports/tuning/`).
- **Thinking instructions** ("think carefully"). [A55] advises removing them; thinking is adaptive and always on.
- **Few-shot examples.** [A] recommends them for output format. The Report is a tool call with a schema ([G] rule 13), which fixes the format without examples and costs fewer prefix tokens.

## v1 changes (`prompts/v1/`, route D-26)

From the v0.05 dry run (`reports/bench/002-dryrun.md`):
- **Verification placement.** Worker rule 4 now names what to run (the dispatch's targeted test command plus the test files the worker touched) and says why the rest waits: the orchestrator runs the repo-wide checks once on the merged tree. This narrows scope rather than adding a verification step, in line with [A5]. Fairness: total verification per run equals the baseline's single final check.
- **Balanced split.** The orchestrator estimates each part's size and moves work to even out the workers, because the run ends when the slower worker does ([AM] §3: scale effort explicitly). The dispatch's acceptance gives the exact targeted test command (rule 2, output format and tools).
