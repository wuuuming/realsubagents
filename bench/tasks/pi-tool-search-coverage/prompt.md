Tool search in packages/coding-agent (`src/extensions/tool-search/`, the `Bm25Ranker`) ranks the wrong tool first for multi-word queries (issue #11331, follow-up to #11625). Since #11625 a query term found in a tool's name outweighs any number of matches in descriptions, so a tool whose name matches one term beats a tool that matches every term of the query:

- query `screenshot window`: `mcp__peekaboo__window` ("Move, resize, or close a window of an app.") ranks above `mcp__peekaboo__image` ("Take a screenshot of the screen, an app, or a window.");
- query `describe app`: `mcp__peekaboo__app` ranks above `mcp__peekaboo__see` ("Capture the app window and describe the UI elements of the app.").

A tool that matches more of the query's distinct terms, in any field (name, description, schema, namespace), should rank above one that matches fewer. Among tools matching equally many terms the current scoring should decide, and a query that is exactly a tool's name (`window`) must still rank that tool first.

Fix this, add tests, and keep the rest of the coding-agent test suite passing.
