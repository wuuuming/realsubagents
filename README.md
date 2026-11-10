# realsubagents

A minimal subagent tool for [Pi](https://github.com/earendil-works/pi). It adds one tool, `subagent`, which hands a task to a fresh Pi process and returns that process's final message.

That is all it does:

- **Delegation only.** The call blocks until the subagent finishes. You cannot steer it mid-run, it sends no messages, and it keeps no state. Pressing Esc aborts it and kills its process tree.
- **No reuse.** Every call starts a new process with `--no-session`.
- **No nesting.** Subagents run with `RSA_SUBAGENT=1`, so this extension registers nothing inside them.
- **No policy.** The extension never decides whether a task is worth delegating, how to split it, or how many subagents to run. The user or the main agent decides that, because tasks differ in type and scale.

A subagent runs in the main agent's working directory, on the same model and thinking level. It loads your configured extensions and gets none of the conversation, so the `task` must be self-contained. If one message contains several `subagent` calls, they run in parallel, because Pi runs tool calls in parallel. Give parallel subagents work that does not write the same files. The subagents' token usage is added to the main session's totals.

## Use

```bash
pi -e ./extensions/realsubagents/index.ts
```

Set `RSA_PI_CLI` to point at a specific Pi `cli.js`, or `RSA_PI_VERSION` to pick an installed managed release. If neither is set, the current managed install is used.

## Development

Requires Node ≥ 22.13 and Pi 1.5.x. TypeScript runs natively, so there is no build step.

```bash
npm install
npm run typecheck
npm test          # uses a fake Pi CLI (tests/fixtures/fake-pi.mjs), no model calls
npm run smoke     # live: a real Pi calls subagent, which writes a file (a few cents)
```

| Path | Contents |
| --- | --- |
| `extensions/realsubagents/index.ts` | The `subagent` tool |
| `src/subagent.ts` | Runs one `pi --mode json --no-session` child and collects its result |
| `src/pi-cli.ts` | Finds the Pi CLI so children start as `node <cli.js>` (no launcher, works on Windows) |

The earlier design, which had parallel workers in seeded worktrees, merge, checks, steering, resume and the benchmark, is preserved at git tag `split-runtime-v0.1`.
