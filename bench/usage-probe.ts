/**
 * End-to-end check of extensions/rsa-bench-usage + bench/meter.ts against a real Pi (U-10, R0.0.3).
 *
 * Starts Pi in RPC mode with a per-run session dir and only the usage extension plus a probe
 * extension loaded. The probe's `/rsa-usage-probe` command calls `ctx.modelRegistry.complete()`
 * once, as realctx's historian does; then one ordinary prompt runs so the session file is written.
 * The meter must report both: one agent-loop call and one extension call, both priced.
 * Costs well under one cent with the cheap model.
 *
 * Usage: node bench/usage-probe.ts [provider/model]   (default anthropic/claude-haiku-5-5)
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findPiCli } from "../src/pi-cli.ts";
import { RpcClient, type RpcRecord } from "../src/rpc.ts";
import { meter } from "./meter.ts";

const root = resolve(import.meta.dirname, "..");
const [provider, modelId] = (process.argv[2] ?? "anthropic/claude-haiku-5-5").split("/");
const work = mkdtempSync(join(tmpdir(), "rsa-usage-probe-"));
const sessionDir = join(work, "sessions");
const sidecar = join(work, "usage-sidecar.jsonl");
const probe = join(work, "probe.ts");
writeFileSync(
	probe,
	`export default function (pi) {
	pi.registerCommand("rsa-usage-probe", {
		description: "call ctx.modelRegistry.complete once",
		handler: async (_args, ctx) => {
			const model = ctx.modelRegistry.find(${JSON.stringify(provider)}, ${JSON.stringify(modelId)});
			if (!model) throw new Error("model not found");
			const res = await ctx.modelRegistry.complete(model, {
				messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }], timestamp: Date.now() }],
			}, { maxTokens: 16 });
			ctx.ui.notify("probe:" + res.stopReason, "info");
		},
	});
}
`,
);

const events: RpcRecord[] = [];
let stderr = "";
const client = new RpcClient({
	cwd: work,
	pi: findPiCli(),
	args: ["--session-dir", sessionDir, "--no-extensions", "-e", join(root, "extensions", "rsa-bench-usage", "index.ts"), "-e", probe, "--model", `${provider}/${modelId}`],
	env: { ...process.env, RSA_USAGE_SIDECAR: sidecar },
	onEvent: (e) => events.push(e),
	onStderr: (t) => (stderr += t),
});

async function waitFor(pred: (e: RpcRecord) => boolean, ms: number, what: string): Promise<RpcRecord> {
	const end = Date.now() + ms;
	for (;;) {
		const hit = events.find(pred);
		if (hit) return hit;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- stderr ---\n${stderr}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

let ok = false;
try {
	await client.send({ type: "prompt", message: "/rsa-usage-probe" }, 60_000);
	const note = await waitFor((e) => e.type === "extension_ui_request" && String(e.message).startsWith("probe:"), 60_000, "probe notify");
	await client.send({ type: "prompt", message: "Reply with the single word: ok" }, 60_000);
	await waitFor((e) => e.type === "agent_settled" || e.type === "agent_end", 120_000, "agent end");
	await client.close();
	const files = readdirSync(sessionDir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
	if (files.length !== 1) throw new Error(`expected one session file, got ${files.join(", ")}`);
	const r = meter([{ file: join(sessionDir, files[0]) }], [sidecar]);
	const { trace, ...summary } = r;
	console.log(JSON.stringify({ probe: note.message, ...summary, sessions: undefined, traceTurns: trace.length }, null, 1));
	const main = r.byRole.main;
	// The probe lives in a temp dir, outside every known package, so it must be attributed "extension".
	const ext = r.byRole["main:extension"];
	ok = !!main && main.calls === 1 && main.costUsd > 0 && !!ext && ext.calls === 1 && ext.costUsd > 0;
	console.log(ok ? "USAGE PROBE OK" : "USAGE PROBE FAIL");
} finally {
	await client.close().catch(() => {});
	if (ok) rmSync(work, { recursive: true, force: true });
	else console.log(`kept ${work}`);
}
process.exit(ok ? 0 : 1);
