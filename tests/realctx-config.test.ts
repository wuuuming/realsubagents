import assert from "node:assert/strict";
import { test } from "node:test";
import { realctxRunConfig } from "../bench/run.ts";

const user = {
	version: 2,
	embedding: { url: "http://x" },
	rewriteModel: "",
	context: { applyThreshold: 0.65, protectTurns: 4, cacheTtl: "5m" },
	history: { model: "openai/gpt-6-luna", prepareThreshold: 0.5 },
};

test("per-run realctx config: v3, user's Context/History dropped, endpoints kept (D-23)", () => {
	const c = realctxRunConfig(user, "anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5", undefined);
	assert.equal(c.version, 3);
	assert.deepEqual(c.embedding, { url: "http://x" });
	assert.equal(c.rewriteModel, "anthropic/claude-haiku-5-5");
	assert.deepEqual(c.history, { model: "anthropic/claude-haiku-5-5" });
	assert.deepEqual(c.context, { cacheTtlAuto: false, cacheTtlByModel: { "anthropic/claude-opus-5-5": "5m" } });
});

test("empty realctx model leaves both fields empty: realctx falls back to the session model (D-24)", () => {
	const c = realctxRunConfig(user, "anthropic/claude-opus-5-5", "", undefined);
	assert.equal(c.rewriteModel, "");
	assert.deepEqual(c.history, { model: "" });
});

test("cache lifetime follows PI_CACHE_RETENTION=long", () => {
	const c = realctxRunConfig(user, "anthropic/claude-opus-5-5", "m", "long");
	assert.deepEqual((c.context as { cacheTtlByModel: object }).cacheTtlByModel, { "anthropic/claude-opus-5-5": "1h" });
});
