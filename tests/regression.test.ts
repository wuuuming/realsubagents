import assert from "node:assert/strict";
import { test } from "node:test";
import { cargoFailures, compare, vitestFailures } from "../bench/regression.ts";
import { validateTask } from "../bench/task.ts";

test("cargo failures: failed tests and compile errors", () => {
	const out = [
		"test a::ok ... ok",
		"test a::bad ... FAILED",
		"test b::slow ... FAILED",
		"test c ... ignored",
		"error: could not compile `x` (lib test) due to 2 previous errors",
	].join("\n");
	assert.deepEqual([...cargoFailures(out)].sort(), ["<compile>", "a::bad", "b::slow"]);
});

test("vitest json: failed assertions and failed suites, paths relative to the tree", () => {
	const json = JSON.stringify({
		testResults: [
			{ name: "D:\\t\\packages\\ai\\test\\a.test.ts", status: "failed", assertionResults: [{ fullName: "x works", status: "failed" }, { fullName: "y", status: "passed" }] },
			{ name: "D:/t/packages/ai/test/b.test.ts", status: "failed", assertionResults: [] },
			{ name: "D:/t/packages/ai/test/c.test.ts", status: "passed", assertionResults: [{ fullName: "z", status: "passed" }] },
		],
	});
	assert.deepEqual([...vitestFailures(json, "D:\\t")].sort(), ["packages/ai/test/a.test.ts::x works", "packages/ai/test/b.test.ts::<suite>"]);
});

test("compare against the baseline list", () => {
	const r = compare(new Set(["a", "b", "new"]), new Set(["a", "b", "gone"]));
	assert.deepEqual(r, { failed: 3, newFailures: ["new"], fixed: ["gone"], ok: false });
	assert.equal(compare(new Set(["a"]), new Set(["a"])).ok, true);
});

test("task validation", () => {
	const ok = { id: "t", repo: "pi", base: "abc1234", label: "small" as const, acceptance: { command: "true" } };
	assert.deepEqual(validateTask(ok, "do it"), []);
	assert.match(validateTask({ ...ok, label: "large-parallel" }, "x").join(), /k >= 2/);
	assert.match(validateTask({ ...ok, withhold: ["t.ts"] }, "x").join(), /withhold needs source/);
	assert.match(validateTask({ ...ok, base: "main" }, "x").join(), /base/);
});

test("node --test TAP: failed leaves with their suite path (real reporter output)", async () => {
	const { readFileSync } = await import("node:fs");
	const { nodeTapFailures } = await import("../bench/regression.ts");
	const tap = readFileSync(new URL("./fixtures/node-tap.txt", import.meta.url), "utf8");
	assert.deepEqual([...nodeTapFailures(tap)].sort(), ["Outer # x > bad two", "Outer # x > inner > bad one", "top bad"]);
});
