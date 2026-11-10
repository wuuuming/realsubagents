# realsubagents

Parallel worker agents for [Pi](https://github.com/earendil-works/pi). You work with Pi as usual; when a task has two or three separable parts of comparable size, Pi can call `rsa_split` to hand them to worker agents. Each worker runs in its own seeded git worktree. Their work is merged with `git merge-tree` and applied to your working tree, and the check commands run once on the merged result.

**Status: v0.1 (split runtime) in progress.** In the manual dry run, two workers finished large parallel tasks in 63% of a single session's time at 89% of its cost (`reports/gates/v0.05.md`). Splitting buys time, not money, so small tasks stay direct.

- Design: [docs/design.md](docs/design.md) (rev 2.2; §0 summarises what the data changed)
- Route, metrics and status log: [docs/route.md](docs/route.md)
- Architecture review after the dry run: [reports/review-2026-11-10.md](reports/review-2026-11-10.md)

## Use

```bash
pi -e ./extensions/realsubagents/index.ts
```

- Tools: `rsa_split` (always), plus `rsa_steer` and `rsa_finish` while a task is open. Worker Reports arrive as messages. `/rsa` shows the status.
- An open task survives a restart of Pi: workers are resumed with their sessions.
- State, worker trees and worker sessions live in `~/.pi/agent/realsubagents/` (override with `RSA_HOME`).
- Worker trees: dependencies and build outputs are hard-linked from your tree (npm and Cargo are detected). Configure links, copies and prepare commands in `<repo>/.pi/rsa.json`:

```json
{ "trees": { "link": ["native"], "copy": [".env"], "seed": "auto", "prepare": ["npm run build"] } }
```

## Development

Requires Node ≥ 22.13 (TypeScript runs natively, no build step) and Pi 1.5.x, with git ≥ 2.38 (`merge-tree --write-tree`).

```bash
npm install
npm run typecheck
npm test
npm run smoke     # starts a real Pi in RPC mode with only this extension and runs /rsa
pi -e ./extensions/realsubagents/index.ts   # try it interactively
```

Set `RSA_PI_CLI` to a Pi `cli.js`, or `RSA_PI_VERSION` to an installed managed release, to test against another Pi. The benchmark pins Pi, realctx and realtasks (`bench/pins.json`; pinned exports via `bench/pin-ext.sh`).

## Layout

| Path | Contents |
| --- | --- |
| `extensions/realsubagents/` | Pi extension entry |
| `src/` | Implementation |
| `tests/` | `node --test` tests |
| `bench/` | Benchmark task set, runner, meter, smoke test |
| `prompts/` | Versioned prompts with their evaluations |
| `reports/` | Benchmark, gate and tuning reports |
| `docs/` | Design doc and route |
