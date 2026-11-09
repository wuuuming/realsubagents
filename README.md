# realsubagents

Long-lived, module-scoped subagent groups for [Pi](https://github.com/earendil-works/pi). A request starts as ordinary direct work; when observation shows a large task, the orchestrator escalates it to group workers that run in parallel in their own git worktrees, report back exactly once, and are reviewed and merged through a queue.

**Status: P0 (prep).** Nothing usable yet. See the route for progress.

- Design: [docs/design.md](docs/design.md)
- Route, metrics and status log: [docs/route.md](docs/route.md)

## Development

Requires Node ≥ 22.13 (TypeScript runs natively, no build step) and Pi 1.5.0.

```bash
npm install
npm run typecheck
npm test
npm run smoke     # starts a real Pi in RPC mode with only this extension and runs /rsa
pi -e ./extensions/realsubagents/index.ts   # try it interactively
```

Set `RSA_PI_CLI` to a Pi `cli.js` to test against a Pi other than the managed install.

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
