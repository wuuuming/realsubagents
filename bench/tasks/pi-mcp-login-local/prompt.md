`pi mcp login` and `pi mcp logout` (packages/coding-agent, `src/extensions/mcp/cli.ts`) do not accept `-l` / `--local`, although `pi mcp add` and `pi mcp remove` do. Users who just added a project server with `pi mcp add -l ...` naturally type `pi mcp login -l <server>` and get an error. The error is also confusing: it reports the option under its long name (`Unknown option --local.`) rather than as typed.

Required behaviour:
- `login` and `logout` accept `-l` / `--local`. With it, the server must be defined in the project's `.pi/mcp.json`; for a server defined elsewhere they fail (exit code 1) with: `MCP server "<name>" is defined in <path of the file that defines it>, not in the project; omit --local.`
- An unknown option is reported as the user typed it: `pi mcp list -l` prints `Unknown option -l.` (plus the usual help hint).
- When `login`/`logout` get a server name that is not configured but is close to a configured one (edit distance at most 2), suggest it: `No MCP server named "fixtures". Did you mean "fixture"? Configured: fixture, broken, parked.`
- Update the command's help text and `docs/cli.md`.

Add tests, and keep the rest of the coding-agent test suite passing.
