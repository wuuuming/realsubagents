/**
 * R1.7 kill/resume test with a real Pi (H-10): kill the user's Pi while workers run, start it again
 * on the same session, and check that the task completes with every Report delivered exactly once.
 *
 *   node bench/killtest.ts [--model anthropic/claude-opus-5-5] [--keep]
 *
 * A scratch repository with two independent packages; the prompt asks for rsa_split explicitly.
 * Cost: two small workers and a short orchestrator session, about $0.5.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findPiCli } from "../src/pi-cli.ts";
import { RpcClient, type RpcRecord } from "../src/rpc.ts";
import { killLeftovers, must } from "../src/runtime/sh.ts";
import { Store } from "../src/store/store.ts";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const model = opt("--model", "anthropic/claude-opus-5-5");
const ID = "-c user.name=t -c user.email=t@t -c commit.gpgsign=false";

const dir = mkdtempSync(join(tmpdir(), "rsa-kill-"));
const repo = join(dir, "repo");
const home = join(dir, "rsa-home");
const sessions = join(dir, "sessions");
mkdirSync(join(repo, "alpha"), { recursive: true });
mkdirSync(join(repo, "beta"), { recursive: true });
writeFileSync(join(repo, "alpha", "alpha.mjs"), "export function alpha() {\n\treturn 1;\n}\n");
writeFileSync(join(repo, "beta", "beta.mjs"), "export function beta() {\n\treturn 2;\n}\n");
await must(`git init -q -b main . && git add -A && git ${ID} commit -q -m init`, repo);

const PROMPT = `This repository has two independent packages, alpha/ and beta/. Use rsa_split with two workers (it is a test of the split runtime, so split even though the task is small):
- w1, paths ["alpha"]: add an exported function \`alphaTwice()\` to alpha/alpha.mjs that returns alpha() * 2, and a test alpha/alpha.test.mjs using node:test that checks it returns 2. Acceptance: \`node --test alpha/alpha.test.mjs\` passes.
- w2, paths ["beta"]: the same for beta: \`betaTwice()\` returning 4, test beta/beta.test.mjs. Acceptance: \`node --test beta/beta.test.mjs\` passes.
check: ["node --test alpha/alpha.test.mjs beta/beta.test.mjs"]. When the merged result passes, call rsa_finish.`;

function startPi(resume: boolean, onEvent: (e: RpcRecord) => void): RpcClient {
	return new RpcClient({
		cwd: repo,
		pi: findPiCli(),
		args: [
			"--session-dir",
			sessions,
			...(resume ? ["--continue"] : []),
			"--no-extensions",
			"-e",
			join(ROOT, "extensions", "realsubagents", "index.ts"),
			"--model",
			model,
			"--thinking",
			"low",
		],
		env: { ...process.env, RSA_HOME: home, RSA_WORKER_PI_ARGS: JSON.stringify(["--no-extensions"]), RSA_TREE_SETUP: JSON.stringify({ seed: "none" }) },
		onEvent: (e) => {
			if (e.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(e.method))) return;
			onEvent(e);
		},
	});
}

const store = () => new Store(join(home, "rsa.sqlite"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms: number): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
		await wait(500);
	}
}
const count = (type: string): number => {
	if (!existsSync(join(home, "rsa.sqlite"))) return 0;
	const s = store();
	try {
		return (s.db.prepare("SELECT count(*) AS n FROM events WHERE type = ?").get(type) as { n: number }).n;
	} finally {
		s.close();
	}
};

let failed = false;
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
	if (!ok) failed = true;
};

try {
	// 1. First Pi: split, then kill hard once both workers have started.
	const first = startPi(false, () => {});
	await first.send({ type: "prompt", message: PROMPT }, 120_000);
	await until("both workers started", () => count("worker.started") >= 2, 300_000);
	const firstPid = first.child.pid!;
	console.log(`killing pi ${firstPid} while workers run (reported so far: ${count("worker.reported")})`);
	killLeftovers(undefined, "__none__"); // no-op warm-up of PowerShell
	if (process.platform === "win32") await must(`taskkill //F //PID ${firstPid}`, dir).catch(() => {});
	else process.kill(firstPid, "SIGKILL");
	await wait(3_000);

	// 2. Second Pi on the same session: resume, deliver Reports, integrate, finish.
	let resumed = false;
	const second = startPi(true, (e) => {
		if (e.type === "extension_ui_request" && e.method === "notify" && /resumed task/.test(String(e.message))) resumed = true;
	});
	await until("task finished", () => count("task.finished") >= 1, 900_000);
	check(resumed, "the second Pi resumed the open task");

	const s = store();
	try {
		const reported = s.db.prepare("SELECT seq FROM events WHERE type = 'worker.reported'").all() as { seq: number }[];
		const delivered = s.db.prepare("SELECT json_extract(data, '$.report') AS r FROM events WHERE type = 'report.delivered'").all() as { r: number }[];
		const dup = delivered.length !== new Set(delivered.map((d) => d.r)).size;
		check(!dup, `no Report delivered twice (${delivered.length} deliveries, ${reported.length} reports)`);
		check(s.pendingReports().length === 0, "no Report left undelivered");
		const t = s.db.prepare("SELECT state, outcome FROM tasks").get() as { state: string; outcome: string };
		check(t.state === "done", `task state ${t.state} (${t.outcome})`);
	} finally {
		s.close();
	}
	const r = await must("node --test alpha/alpha.test.mjs beta/beta.test.mjs", repo).then(
		() => true,
		() => false,
	);
	check(r, "the merged work is in the user's tree and its tests pass");
	check((await must("git worktree list", repo)).trim().split("\n").length === 1, "worker trees removed");
	const leftover = readdirSync(join(home, "worktrees"), { recursive: true }).length;
	check(leftover === 0 || !existsSync(join(home, "worktrees")), `no files left under worktrees/ (${leftover})`);
	await second.close();
	// Session files: one for the user, one per worker (resume continued them, not new ones).
	const files = readdirSync(home, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
	console.log(`worker session files: ${files.length}`);
	check(files.length === 2, "each worker kept one session across the restart");
} catch (e) {
	console.log(`FAIL ${(e as Error).message}`);
	failed = true;
} finally {
	killLeftovers(undefined, dir);
	if (!argv.includes("--keep")) rmSync(dir, { recursive: true, force: true });
	else console.log(`kept ${dir}`);
	console.log(failed ? "KILLTEST FAILED" : "KILLTEST OK");
	process.exit(failed ? 1 : 0);
}

