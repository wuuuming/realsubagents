/**
 * R0.3 smoke test: start a real Pi in RPC mode with only this extension loaded, check that
 * /rsa is registered and that running it is handled by the extension (no model call).
 * Usage: node bench/smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findPiCli } from "../src/pi-cli.ts";
import { RpcClient, type RpcRecord } from "../src/rpc.ts";

const root = resolve(import.meta.dirname, "..");
const ext = join(root, "extensions", "realsubagents", "index.ts");
const cwd = mkdtempSync(join(tmpdir(), "rsa-smoke-"));
const pi = findPiCli();
const events: RpcRecord[] = [];
let stderr = "";

const client = new RpcClient({
	cwd,
	pi,
	args: ["--no-session", "--no-extensions", "-e", ext],
	onEvent: (e) => events.push(e),
	onStderr: (t) => (stderr += t),
});

function fail(msg: string): never {
	console.error(`SMOKE FAIL: ${msg}`);
	if (stderr) console.error(`--- pi stderr ---\n${stderr}`);
	process.exit(1);
}

try {
	const cmds = await client.send({ type: "get_commands" });
	if (!cmds.success) fail(`get_commands: ${JSON.stringify(cmds)}`);
	const list = ((cmds.data as { commands?: { name: string; source?: string }[] })?.commands ?? []);
	const rsa = list.find((c) => c.name === "rsa");
	if (!rsa) fail(`/rsa not registered; got: ${list.map((c) => c.name).join(", ")}`);

	const res = await client.send({ type: "prompt", message: "/rsa" });
	const disposition = (res.data as { disposition?: string } | undefined)?.disposition;
	if (!res.success || disposition !== "handled") fail(`/rsa not handled: ${JSON.stringify(res)}`);

	const deadline = Date.now() + 5000;
	let note: RpcRecord | undefined;
	while (!note && Date.now() < deadline) {
		note = events.find((e) => e.type === "extension_ui_request" && e.method === "notify" && String(e.message).startsWith("realsubagents"));
		if (!note) await new Promise((r) => setTimeout(r, 50));
	}
	if (!note) fail("no notify from /rsa");
	console.log(`SMOKE OK: pi ${pi.version} (${pi.source}); /rsa → "${note.message}"`);
} finally {
	await client.close();
	rmSync(cwd, { recursive: true, force: true });
}
