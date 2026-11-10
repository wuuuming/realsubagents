import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import realsubagents from "../extensions/realsubagents/index.ts";
import { describeTool, runSubagent, SUBAGENT_ENV, SUBAGENT_PROMPT } from "../src/subagent.ts";

const pi = { cli: join(import.meta.dirname, "fixtures", "fake-pi.mjs"), version: "fake", source: "env" as const };
const run = (mode: string, extra: Partial<Parameters<typeof runSubagent>[0]> = {}) =>
	runSubagent({ task: "do @x.md\nnow", cwd: tmpdir(), pi, env: { ...process.env, FAKE_PI_MODE: mode }, ...extra });

test("returns the final message, sums usage, passes task on stdin and model/thinking on argv", async () => {
	const seen: string[] = [];
	const r = await run("ok", { model: "anthropic/x", thinking: "high", onActivity: (l) => seen.push(l) });
	assert.equal(r.ok, true, r.error ?? "");
	const echo = JSON.parse(r.output.replace("\u2028", ""));
	assert.equal(echo.task, "do @x.md\nnow");
	assert.equal(echo.sub, "1");
	assert.deepEqual(echo.argv, ["--mode", "json", "--no-session", "--append-system-prompt", SUBAGENT_PROMPT, "--model", "anthropic/x", "--thinking", "high"]);
	assert.equal(r.turns, 2);
	assert.equal(r.usage.input, 30);
	assert.equal(r.usage.cost.total, 0.03);
	assert.deepEqual(seen, ["read a.txt"]);
});

test("a provider error fails with its message", async () => {
	const r = await run("error");
	assert.equal(r.ok, false);
	assert.equal(r.error, "provider overloaded");
	assert.equal(r.usage.input, 15);
});

test("a crash fails with exit code and stderr", async () => {
	const r = await run("crash");
	assert.equal(r.ok, false);
	assert.match(r.error!, /code 3[\s\S]*boom/);
});

test("abort kills the subagent", async () => {
	const ac = new AbortController();
	const p = run("hang", { signal: ac.signal, onActivity: () => ac.abort() });
	const r = await p;
	assert.equal(r.ok, false);
	assert.equal(r.error, "Aborted.");
});

test("describeTool shortens long arguments", () => {
	assert.equal(describeTool("bash", { command: "npm  test" }), "bash npm test");
	assert.equal(describeTool("x", {}), "x");
	assert.equal(describeTool("bash", { command: "a".repeat(200) }).length, 85);
});

function load(env: string | undefined) {
	const tools: { name: string }[] = [];
	const prev = process.env[SUBAGENT_ENV];
	if (env === undefined) delete process.env[SUBAGENT_ENV];
	else process.env[SUBAGENT_ENV] = env;
	try {
		realsubagents({ registerTool: (t: { name: string }) => tools.push(t), on: () => {} } as never);
	} finally {
		if (prev === undefined) delete process.env[SUBAGENT_ENV];
		else process.env[SUBAGENT_ENV] = prev;
	}
	return tools.map((t) => t.name);
}

test("the extension registers only `subagent`, and nothing inside a subagent", () => {
	assert.deepEqual(load(undefined), ["subagent"]);
	assert.deepEqual(load("1"), []);
});
