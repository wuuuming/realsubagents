import assert from "node:assert/strict";
import { test } from "node:test";
import { type Call, fitClass, line, OPUS_5_5, predict, sessionParams } from "../src/costmodel.ts";

/** A synthetic session whose prefix grows exactly linearly, priced with OPUS_5_5. */
function session(n: number, P: number, g: number, delta: number, out: number): Call[] {
	return Array.from({ length: n }, (_, i) => {
		const cacheRead = P + g * i;
		return { cacheRead, delta, out, costUsd: OPUS_5_5.cacheRead * cacheRead + OPUS_5_5.cacheWrite * delta + OPUS_5_5.output * out };
	});
}

test("line recovers slope and intercept", () => {
	const { a, b } = line([0, 1, 2, 3], [5, 7, 9, 11]);
	assert.equal(a, 5);
	assert.equal(b, 2);
});

test("predict reproduces an exactly linear session, including realctx overhead", () => {
	const calls = session(40, 12_000, 1_500, 800, 300);
	const cost = calls.reduce((s, c) => s + c.costUsd, 0) + 0.4;
	const p = sessionParams(calls, 0.4);
	assert.ok(Math.abs(p.g - 1_500) < 1e-6);
	assert.ok(Math.abs(predict(p, 40) - cost) < 1e-9);
});

test("the read term grows with the square of n", () => {
	const p = { P: 10_000, g: 2_000, delta: 0, out: 0, h: 0 };
	const read = (n: number) => predict(p, n) / OPUS_5_5.cacheRead;
	assert.equal(read(10), 10 * 10_000 + (2_000 * 10 * 9) / 2);
	assert.ok(read(80) / read(40) > 3);
});

test("fitClass pools sessions of different lengths", () => {
	const a = session(20, 10_000, 1_000, 500, 200);
	const b = session(60, 10_000, 1_000, 900, 400);
	const p = fitClass([
		{ calls: a, realctxUsd: 0.2 },
		{ calls: b, realctxUsd: 0.6 },
	]);
	assert.ok(Math.abs(p.P - 10_000) < 1e-6 && Math.abs(p.g - 1_000) < 1e-6);
	assert.equal(p.delta, (20 * 500 + 60 * 900) / 80);
	assert.equal(p.h, 0.8 / 80);
});
