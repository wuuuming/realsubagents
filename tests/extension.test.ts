import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import realsubagents, { type SubagentDetails } from "../extensions/realsubagents/index.ts";
import { capOutput, SUBAGENT_ENV } from "../src/subagent.ts";

process.env.RSA_PI_CLI = join(import.meta.dirname, "fixtures", "fake-pi.mjs");
delete process.env[SUBAGENT_ENV];

type Result = { content: { type: string; text?: string }[]; details: SubagentDetails; usage?: { input: number }; isError?: boolean };
type Tool = {
	name: string;
	execute(id: string, p: { task: string }, signal: AbortSignal | undefined, onUpdate: ((r: Result) => void) | undefined, ctx: unknown): Promise<Result>;
	renderCall(args: unknown, theme: unknown, ctx: unknown): { render(w: number): string[] };
	renderResult(r: unknown, o: unknown, theme: unknown, ctx: unknown): { render(w: number): string[] };
};

function load() {
	let tool: Tool | undefined;
	const handlers: Record<string, () => Promise<void>> = {};
	realsubagents({
		registerTool: (t: Tool) => (tool = t),
		on: (event: string, h: () => Promise<void>) => (handlers[event] = h),
		getThinkingLevel: () => "high",
	} as never);
	return { tool: tool!, handlers };
}

const ctx = { cwd: tmpdir(), model: { provider: "anthropic", id: "m" } };

async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
	process.env.FAKE_PI_MODE = mode;
	try {
		return await fn();
	} finally {
		delete process.env.FAKE_PI_MODE;
	}
}

test("execute: returns the report, usage and details; passes the session's model and thinking", async () => {
	const { tool } = load();
	const updates: Result[] = [];
	const r = await withMode("ok", () => tool.execute("call-1", { task: "hello" }, undefined, (u) => updates.push(u), ctx));
	assert.equal(r.isError, false);
	const echo = JSON.parse(r.content[0].text!.replace("\u2028", ""));
	assert.equal(echo.task, "hello");
	assert.deepEqual(echo.argv.slice(-4), ["--model", "anthropic/m", "--thinking", "high"]);
	assert.equal(r.details.status, "done");
	assert.equal(r.details.turns, 2);
	assert.equal(r.usage?.input, 30);
	assert.equal(updates[0].details.activity, "read a.txt");
});

test("execute: a failure is an error result", async () => {
	const { tool } = load();
	const r = await withMode("error", () => tool.execute("c", { task: "x" }, undefined, undefined, ctx));
	assert.equal(r.isError, true);
	assert.match(r.content[0].text!, /^Subagent failed: provider overloaded/);
});

test("execute: a long report is cut, and the full one saved to a file", async () => {
	const { tool } = load();
	const r = await withMode("long", () => tool.execute("c/1", { task: "x" }, undefined, undefined, ctx));
	const text = r.content[0].text!;
	assert.match(text, /^line 0\n/);
	assert.ok(!text.includes("line 2000"));
	assert.ok(r.details.fullOutput && existsSync(r.details.fullOutput));
	assert.ok(text.includes(r.details.fullOutput!));
	assert.equal(readFileSync(r.details.fullOutput!, "utf8").split("\n").length, 3000);
});

test("session_shutdown aborts running subagents", async () => {
	const { tool, handlers } = load();
	const r = await withMode("hang", () => tool.execute("c", { task: "x" }, undefined, () => void handlers.session_shutdown(), ctx));
	assert.equal(r.isError, true);
	assert.match(r.content[0].text!, /Aborted/);
});

test("capOutput keeps the head within lines and bytes", () => {
	assert.deepEqual(capOutput("a\nb\nc", 2), { text: "a\nb", truncated: true });
	assert.deepEqual(capOutput("abc"), { text: "abc", truncated: false });
	const cut = capOutput("ééé", 100, 5);
	assert.equal(cut.text, "éé");
	assert.equal(cut.truncated, true);
});

test("renderers: task header, running line, collapsed report", () => {
	const { tool } = load();
	const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
	const rctx = (over: object) => ({ state: {}, expanded: false, isError: false, invalidate() {}, keyHint: (_k: string, d: string) => `ctrl+o ${d}`, ...over });
	const call = tool.renderCall({ task: "Fix the bug\nmore detail" }, theme, rctx({})).render(80).join("\n");
	assert.match(call, /subagent Fix the bug/);
	assert.ok(!call.includes("more detail"));

	const state = {};
	const partial = tool.renderResult({ content: [], details: { status: "running", ms: 3000, activity: "bash npm test" } }, { expanded: false, isPartial: true }, theme, rctx({ state }));
	assert.match(partial.render(80).join(""), /3s · bash npm test/);
	const body = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
	const done = tool
		.renderResult({ content: [{ type: "text", text: body }], details: { status: "done", ms: 8000, turns: 3, costUsd: 0.12 } }, { expanded: false, isPartial: false }, theme, rctx({ state }))
		.render(80)
		.map((l) => l.trimEnd());
	assert.equal(done[0], "✓ 3 turns · 8s · $0.12");
	assert.equal(done.length, 1 + 6 + 1);
	assert.match(done.at(-1)!, /4 more lines \(ctrl\+o to expand\)/);
	assert.equal((state as { timer?: unknown }).timer, undefined);
});
