/**
 * Live smoke test (a few small model calls): a real Pi with only this extension calls `subagent`
 * twice in one message; each child Pi writes a file and answers. Checks both results, both files,
 * and that the two subagents ran at the same time.
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

const prompt = [
	"In one message, call the subagent tool twice, in parallel, with these two tasks:",
	'1. "Create a file named a.txt containing exactly the word alpha, then reply with exactly: done a"',
	'2. "Create a file named b.txt containing exactly the word beta, then reply with exactly: done b"',
	"Then reply with exactly the two answers, comma-separated.",
].join("\n");
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
	const isSub = (e: Rec) => e.toolName === "subagent";
	const starts = recs.flatMap((e, i) => (e.type === "tool_execution_start" && isSub(e) ? [i] : []));
	const ends = recs.flatMap((e, i) => (e.type === "tool_execution_end" && isSub(e) ? [i] : []));
	const calls = recs.filter((e) => e.type === "tool_execution_end" && isSub(e));
	const answer = recs
		.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
		.at(-1)
		?.message?.content?.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
	const read = (f: string) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8").trim() : undefined);
	const files = { a: read("a.txt"), b: read("b.txt") };
	console.log(`pi ${pi.version} (${pi.source}), exit ${code}`);
	for (const c of calls) console.log(`subagent result: ${JSON.stringify(c.result?.content?.[0]?.text)} ${JSON.stringify(c.result?.details)}`);
	console.log(`parent answer: ${JSON.stringify(answer)}; files: ${JSON.stringify(files)}`);
	if (calls.length !== 2) throw new Error(`expected 2 subagent calls, got ${calls.length}`);
	if (calls.some((c) => c.isError)) throw new Error("a subagent returned an error");
	if (!(starts[1] < ends[0])) throw new Error("the two subagents did not overlap");
	if (files.a !== "alpha" || files.b !== "beta") throw new Error("a subagent did not write its file");
	console.log("SMOKE OK");
} catch (e) {
	console.error(`SMOKE FAIL: ${(e as Error).message}`);
	process.exitCode = 1;
} finally {
	rmSync(cwd, { recursive: true, force: true });
}
