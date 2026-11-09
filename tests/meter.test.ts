import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { meter } from "../bench/meter.ts";
import { callerFromStack, patchComplete } from "../extensions/rsa-bench-usage/index.ts";

const dir = mkdtempSync(join(tmpdir(), "rsa-meter-"));
const u = (input: number, cacheRead: number, cacheWrite: number, output: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const asst = (t: string, usage: object, stopReason = "toolUse") => ({
	type: "message",
	timestamp: t,
	message: { role: "assistant", provider: "anthropic", model: "opus", usage, stopReason },
});

function writeSession(name: string, entries: object[]): string {
	const f = join(dir, name);
	writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n{\"type\":\"mess"); // torn last line
	return f;
}

const session = writeSession("a.jsonl", [
	{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "D:\\w" },
	{ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } },
	asst("2026-01-01T00:00:02.000Z", u(4, 0, 10_000, 100, 0.06)),
	asst("2026-01-01T00:00:03.000Z", u(2, 10_000, 500, 50, 0.01)),
	{ type: "usage", timestamp: "2026-01-01T00:00:04.000Z", kind: "cache_warm", provider: "anthropic", model: "opus", usage: u(0, 10_500, 0, 0, 0.005) },
	{ type: "compaction", timestamp: "2026-01-01T00:00:05.000Z", tokensBefore: 10_500, usage: u(10_500, 0, 0, 300, 0.02) },
	asst("2026-01-01T00:00:06.000Z", u(3, 0, 2_000, 40, 0.015), "stop"),
	{ type: "custom", customType: "rsa-usage", timestamp: "2026-01-01T00:00:07.000Z", data: { caller: "realctx", provider: "anthropic", model: "haiku", usage: u(800, 0, 0, 120, 0.002) } },
	{ type: "custom", customType: "rsa-usage", timestamp: "2026-01-01T00:00:08.000Z", data: { caller: "realctx", provider: "anthropic", model: "haiku", error: "timeout" } },
]);
const sidecar = join(dir, "side.jsonl");
writeFileSync(sidecar, JSON.stringify({ ts: Date.parse("2026-01-01T00:00:10.000Z"), caller: "realctx", provider: "anthropic", model: "haiku", usage: u(500, 0, 0, 60, 0.001) }) + "\n");

test("meter sums every spend source into role and model buckets", () => {
	const r = meter([{ file: session }], [sidecar]);
	assert.equal(r.byRole.main.calls, 3);
	assert.ok(Math.abs(r.byRole.main.costUsd - 0.085) < 1e-9);
	assert.ok(Math.abs(r.byRole["main:cache_warm"].costUsd - 0.005) < 1e-9);
	assert.ok(Math.abs(r.byRole["main:compaction"].costUsd - 0.02) < 1e-9);
	assert.equal(r.byRole["main:realctx"].calls, 2, "session entry + sidecar");
	assert.ok(Math.abs(r.byRole["main:realctx"].costUsd - 0.003) < 1e-9);
	assert.ok(Math.abs(r.total.costUsd - 0.113) < 1e-9);
	assert.equal(r.byModel["anthropic/haiku"].calls, 2);
	assert.equal(r.extensionCallErrors, 1);
	assert.equal(r.wallClockMs, 10_000);
	assert.deepEqual(r.turns.main, { modelCalls: 3, userPrompts: 1, errors: 0 });
	assert.equal(r.compactions.length, 1);
	assert.equal(r.sessions[0].id, "s1");
});

test("trace marks cold restarts and calls after compaction", () => {
	const r = meter([{ file: session, role: "worker" }]);
	assert.deepEqual(
		r.trace.map((t) => [t.i, t.ctx, t.delta, t.out, t.cold, t.afterCompaction]),
		[
			[1, 10_004, 10_004, 100, false, false],
			[2, 10_502, 502, 50, false, false],
			[3, 2_003, 2_003, 40, true, true],
		],
	);
	assert.equal(r.coldRestarts, 1);
	assert.ok(r.cacheHitRate.worker > 0.4 && r.cacheHitRate.worker < 0.5);
	assert.ok(r.byRole["worker:realctx"]);
});

test("caller is taken from the call stack", () => {
	assert.equal(callerFromStack("at x (C:\\Users\\a\\.pi\\agent\\git\\github.com\\WtzLAS\\realctx\\src\\rewrite.ts:143:3)"), "realctx");
	assert.equal(callerFromStack("at y (/home/a/realsubagents/src/judge.ts:1:1)"), "realsubagents");
	assert.equal(callerFromStack("at z (/tmp/other.ts:1:1)"), "extension");
	// The wrapper's own frame (inside this repository) comes first and must be skipped; innermost known frame wins.
	const stack = [
		"Error",
		"    at R.complete (D:\\Projects\\realsubagents\\extensions\\rsa-bench-usage\\index.ts:60:17)",
		"    at c (C:\\Users\\a\\.pi\\agent\\git\\github.com\\WtzLAS\\realctx\\src\\rewrite.ts:143:3)",
		"    at d (D:\\Projects\\realsubagents\\src\\judge.ts:1:1)",
	].join("\n");
	assert.equal(callerFromStack(stack), "realctx");
	assert.equal(callerFromStack(stack.split("\n").slice(0, 2).join("\n")), "extension");
});

test("patchComplete records usage and errors once, without double wrapping", async () => {
	const records: unknown[] = [];
	class Registry {
		async complete(model: { provider: string; id: string }, ok: boolean) {
			if (!ok) throw new Error("boom");
			return { usage: { input: 1, output: 2, cost: { total: 0.5 } }, stopReason: "stop", model: model.id };
		}
	}
	patchComplete(Registry.prototype as never);
	patchComplete(Registry.prototype as never);
	(globalThis as Record<symbol, { sink?: (r: unknown) => void }>)[Symbol.for("rsa-bench-usage")]!.sink = (r) => records.push(r);
	const reg = new Registry();
	const res = await reg.complete({ provider: "p", id: "m" }, true);
	assert.equal(res.model, "m");
	await assert.rejects(reg.complete({ provider: "p", id: "m" }, false), /boom/);
	assert.equal(records.length, 2);
	assert.deepEqual({ ...(records[0] as object), durationMs: 0 }, {
		caller: "realsubagents",
		provider: "p",
		model: "m",
		usage: { input: 1, output: 2, cost: { total: 0.5 } },
		stopReason: "stop",
		durationMs: 0,
	});
	assert.equal((records[1] as { error: string }).error, "boom");
});
