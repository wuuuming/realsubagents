/**
 * Live smoke test (makes a few small model calls): a real Pi with only this extension calls
 * `subagent`, whose child Pi writes a file and answers; checks the tool result and the file.
 * Usage: node scripts/smoke.ts [--model provider/id]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findPiCli, piChildEnv } from "../src/pi-cli.ts";
import { SUBAGENT_ENV } from "../src/subagent.ts";

const ext = join(resolve(import.meta.dirname, ".."), "extensions", "realsubagents", "index.ts");
const i = process.argv.indexOf("--model");
const model = i > 0 ? process.argv[i + 1] : undefined;
const cwd = mkdtempSync(join(tmpdir(), "rsa-smoke-"));
const pi = findPiCli();
const env = piChildEnv(pi);
delete env[SUBAGENT_ENV];

const prompt =
	'Call the subagent tool exactly once with this task: "Create a file named smoke.txt containing exactly the word pong, then reply with exactly: done". Then reply with exactly the subagent\'s answer.';
const child = spawn(process.execPath, [pi.cli, "--mode", "json", "--no-session", "--no-extensions", "-e", ext, ...(model ? ["--model", model] : [])], {
	cwd,
	env,
	stdio: ["pipe", "pipe", "inherit"],
	windowsHide: true,
});
child.stdin.end(prompt);

type Rec = { type?: string; toolName?: string; isError?: boolean; result?: { content?: { text?: string }[]; details?: unknown }; message?: { role?: string; content?: { type: string; text?: string }[] } };
const recs: Rec[] = [];
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c: string) => {
	buf += c;
	let nl: number;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (line) recs.push(JSON.parse(line) as Rec);
	}
});
const code = await new Promise<number | null>((r) => child.on("close", r));

try {
	const call = recs.find((e) => e.type === "tool_execution_end" && e.toolName === "subagent");
	const answer = recs
		.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
		.at(-1)
		?.message?.content?.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
	const file = join(cwd, "smoke.txt");
	const content = existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
	console.log(`pi ${pi.version} (${pi.source}), exit ${code}`);
	console.log(`subagent result: ${JSON.stringify(call?.result?.content?.[0]?.text)} ${JSON.stringify(call?.result?.details)}`);
	console.log(`parent answer: ${JSON.stringify(answer)}; smoke.txt: ${JSON.stringify(content)}`);
	if (!call) throw new Error("the parent did not call subagent");
	if (call.isError) throw new Error("subagent returned an error");
	if (content !== "pong") throw new Error("the subagent did not write smoke.txt");
	console.log("SMOKE OK");
} catch (e) {
	console.error(`SMOKE FAIL: ${(e as Error).message}`);
	process.exitCode = 1;
} finally {
	rmSync(cwd, { recursive: true, force: true });
}
