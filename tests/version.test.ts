import assert from "node:assert/strict";
import { test } from "node:test";
import { statusLine } from "../extensions/realsubagents/index.ts";
import { VERSION } from "../src/version.ts";

test("status line names the version", () => {
	assert.match(statusLine(), new RegExp(VERSION.replaceAll(".", "\\.")));
});
