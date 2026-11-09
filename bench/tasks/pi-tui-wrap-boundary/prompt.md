In packages/tui, word wrapping of styled text (`wrapTextWithAnsi` in `src/utils.ts`, and so Markdown rendering) is wrong when a styled word ends exactly at the wrap width:

- The space after the styled word is moved to the start of the next line, so the next line starts with a space.
- The style's closing escape code moves with it, so the style stays open into the right padding of the wrapped line (visible when the Markdown component has a background color).
- Strikethrough that spans a wrap continues into the right padding of the line; underline is already closed at the line end, strikethrough is not.

Example at width 9: `wrapTextWithAnsi("aaaa \x1b[1mbold\x1b[22m next word", 9)` should give `["aaaa \x1b[1mbold\x1b[22m", "next word"]`.

Fix this. Wrapped lines must never be wider than the width, including for runs of styled whitespace longer than a line. Add tests, and keep the rest of the tui test suite passing.
