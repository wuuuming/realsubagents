In packages/coding-agent, `stripAnsi` (`src/utils/ansi.ts`) leaves fragments of some escape sequences in tool output (issue #11377). It treats `<`, `=` and `>` right after `ESC [` as the final byte of the sequence, so an SGR mouse report `\x1b[<35;59;1M` becomes `35;59;1M` in the output instead of disappearing. The same happens for `\x1b[>0;276;0c`, `\x1b[=5h`, and for the 8-bit CSI introducer `\x9b` followed by `<`.

Required behaviour:
- `stripAnsi("\x1b[<35;59;1Mstep 1")` is `"step 1"`; `stripAnsi("a\x1b[>cb")` and `stripAnsi("a\x9b<35;59;1Mb")` are `"ab"`.
- After a bare `ESC` (no `[`), `=`, `>` and `<` are still final bytes: `\x1b=` and `\x1b>` (keypad modes) must not swallow the digits that follow, e.g. `stripAnsi("\x1b[?1h\x1b=123 tests passed")` is `"123 tests passed"`.
- `splitIncompleteAnsiSuffix` must hold back an unfinished private-parameter CSI sequence: for `"x\x1b[<35;59"` it returns `{ complete: "x", pending: "\x1b[<35;59" }`, while `"x\x1b="` is complete (`pending: ""`).

Fix this, add tests, and keep the rest of the coding-agent test suite passing.
