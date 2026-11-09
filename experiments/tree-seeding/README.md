# Tree seeding experiment (route W-7, W-8; design doc §13.1 Tier B)

Checks whether a new git worktree can reuse a warm base tree's immutable parts through hard links, without ever changing the base tree.

- `seed-tree.mjs seed --mode cargo|npm --base <warm tree> --dest <new worktree>` links the files and writes `<dest>/.rsa-seed-manifest.json`.
- `seed-tree.mjs verify --dest <new worktree>` checks that no linked file changed on the base side (size and mtime). Any change means a tool wrote through a hard link: the rule for that toolchain is unsafe.
- `run-cargo.sh`, `run-npm.sh` run the experiment end to end (defaults: `D:/rsa-bench/repos/{bilinova,pi}`, trees in `D:/rsa-bench/trees`).

Rules found (2026-11-09):

| Toolchain | Linked | Skipped or copied |
| --- | --- | --- |
| Cargo | `target/debug/{deps,build,.fingerprint}` units of non-workspace crates, files ≥ 64 KB | Workspace units (rebuilt anyway: their hash includes the tree path), `incremental/`, uplifted top-level files; small files copied |
| npm | Every file in every `node_modules` | Dot-directories other than `.bin` (vitest writes `.vite/**/results.json` in place: caught by `verify`); dot-files copied; workspace links re-pointed into the new tree |

Results are in `docs/route.md`, rows W-2, W-7, W-8.
