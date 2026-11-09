When Pi is provided by a wrapper or another package manager (mise, a `PNPM_HOME` wrapper, Nix), `pi update` cannot update it and prints "pi cannot self-update this installation." Users with several machines have to remember which tool updates Pi where (issues #7756, #5607). Let users configure the command that updates Pi.

Behaviour (packages/coding-agent):
- A new environment variable `PI_SELF_UPDATE_COMMAND` and a new setting `selfUpdateCommand` (an argv array, e.g. `["nix", "profile", "upgrade", "pi"]`). The environment variable takes precedence and is split on whitespace (no quoting); a blank value counts as unset. The setting is read only from global settings, never from a project's `.pi/settings.json`, so a project cannot inject a command.
- The configured command replaces Pi's own update logic for every install method, including installer-managed installs. `pi update` still checks for a newer release first: the command runs only when a newer release exists (or with `--force`), after the release note is printed. Otherwise Pi prints `pi is already up to date (v<version>)` as today.
- Placeholders, filled in every argument from the release being installed: `{packageName}`, `{version}`, `{installSpec}` (= `<packageName>@<version>`). Unknown placeholders stay as they are.
- If the command exits non-zero, print an error containing `<command line> exited with code <n>` and set exit code 1.
- Exit code 0 does not prove an update. Report `Updated pi from <old> to <new>` when Pi's own `package.json` now shows the new version (in-place updates) or `pi --version` from PATH reports it (wrappers that install each version into a new directory). Otherwise print this warning on stdout, like the other `pi update` progress messages: ``Ran <command line>, but `pi --version` reports <old>, not <new>.``
- The "cannot self-update this installation" message mentions the environment variable and the setting.

Interface the tests use, in `src/config.ts`:
- `getConfiguredSelfUpdateArgv(setting: string[] | undefined): string[] | undefined`: the environment variable's argv if set and non-blank, else the setting if non-empty, else `undefined`.
- `makeConfiguredSelfUpdateCommand(argv: string[], release: { packageName: string; version: string })`: returns the same `{ command, args, display }` shape as the existing self-update command steps, with placeholders filled and `display` the space-joined command line.

Document the feature in `docs/cli.md`, `docs/settings.md`, `docs/environment-variables.md` and the `--help` environment list, and update `schemas/settings.schema.json`. Add tests, and keep the rest of the coding-agent test suite passing.
