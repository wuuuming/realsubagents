/**
 * R0.0.2 runner and R0.0.4 acceptance: one benchmark run of one task.
 *
 *   node bench/run.ts <task> [--mode agent|base|reference] [--arm baseline] [--n 1] [--keep] [--write-baseline]
 *                            [--model anthropic/claude-opus-5-5] [--thinking high] [--cap-usd 5] [--budget-usd 100] [--wall-min 90]
 *
 * Modes:
 * - agent:     the measured run. A single Pi session (realctx + realtasks, D-14) gets prompt.md once
 *              and works until it settles; then acceptance.
 * - base:      no agent; acceptance must FAIL (the task is not already done).
 * - reference: no agent; the historical change(s) (`source` or `parts`) are applied; acceptance must PASS.
 *              base + reference together validate a task without spending anything.
 *
 * Every run gets a fresh worktree at the task's base commit with the repository's tree setup
 * (D-15) and Tier B seeding (D-17), a fresh REALCTX_HOME and session dir (D-14). Results go to
 * `$RSA_RUNS/<task>/<arm>-<n>/` (default D:/rsa-bench/runs): result.json, meter.json,
 * trace.jsonl, diff.patch, acceptance.log, pi-stderr.log, sessions/.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findPiCli } from "../src/pi-cli.ts";
import { RpcClient, type RpcRecord } from "../src/rpc.ts";
import { ledger } from "./ledger.ts";
import { meter } from "./meter.ts";
import { cargoFailures, compare, nodeTapFailures, readList, vitestFailures, type RegressionResult } from "./regression.ts";
import { killLeftovers, must, sh } from "./sh.ts";
import { type LoadedTask, loadRepos, loadTask, partsOf, regressionChecks, type RepoDef } from "./task.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const GIT_PKGS = join(AGENT_DIR, "git", "github.com");
/** D-14: the only extensions loaded in benchmark runs (both arms). */
export const EXTENSIONS = {
	realctx: process.env.RSA_REALCTX_EXT ?? join(GIT_PKGS, "WtzLAS", "realctx", "extensions", "realctx", "index.ts"),
	realtasks: process.env.RSA_REALTASKS_EXT ?? join(GIT_PKGS, "st0nie", "realtasks", "index.ts"),
	usage: join(ROOT, "extensions", "rsa-bench-usage", "index.ts"),
};
const SEED = join(ROOT, "experiments", "tree-seeding", "seed-tree.mjs");
/** D-13: cheap model for realctx's historian and memory rewrites. */
/** D-24: empty = realctx's own calls (memory edits, history) use the session model, as in the user's setup. */
export const REALCTX_MODEL = process.env.RSA_REALCTX_MODEL ?? "";
/** Files the harness itself writes into the tree: the seed manifest and realctx's project-shared memories. */
export const DIFF_EXCLUDE = [".rsa-seed-manifest.json", ".pi/realctx"];
/** D-23: extension commits the phase's runs must use (`RSA_ALLOW_DRIFT=1` to override). */
const PINS: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "bench", "pins.json"), "utf8"));

/**
 * D-20, D-23: the per-run realctx config. Only endpoints, keys and the like come from the user's config;
 * Context and History use realctx's own (v3) defaults, except the historian model and the cache lifetime,
 * which is fixed for the session model instead of fetched from models.dev.
 */
export function realctxRunConfig(user: Record<string, unknown>, sessionModel: string, realctxModel: string, retention = process.env.PI_CACHE_RETENTION): Record<string, unknown> {
	const { context: _c, history: _h, ...rest } = user;
	return {
		...rest,
		version: 3,
		rewriteModel: realctxModel,
		history: { model: realctxModel },
		context: { cacheTtlAuto: false, cacheTtlByModel: { [sessionModel]: retention === "long" ? "1h" : "5m" } },
	};
}

export type Mode = "agent" | "base" | "reference";

export interface RunOptions {
	mode: Mode;
	arm: string;
	n: number;
	keep: boolean;
	/** reference mode: record the regression failures as the task's baseline list (D-18). */
	writeBaseline: boolean;
	model: string;
	thinking: string;
	capUsd: number;
	/** D-21: phase budget; an agent run is refused if spend so far + capUsd would exceed it. */
	budgetUsd: number;
	wallMin: number;
	runsRoot: string;
}

export interface RunResult {
	task: string;
	label: string;
	mode: Mode;
	arm: string;
	n: number;
	/** ok: settled normally; cap / timeout: stopped by the runner; error: setup or Pi failure. */
	status: "ok" | "cap" | "timeout" | "error";
	error?: string;
	accepted: boolean | null;
	regression?: RegressionResult;
	costUsd?: number;
	wallClockMs?: number;
	modelCalls?: number;
	compactions?: number;
	setupMs: number;
	acceptanceMs?: number;
	baseIntact?: boolean;
	/** Processes the agent left running (background tasks, test servers), killed before acceptance. */
	leftoverProcesses?: number;
	/** Set by `--rescore`: the verdict before the harness fix. */
	rescored?: { at: string; harness: string; previous: Pick<RunResult, "status" | "accepted" | "regression" | "error"> };
	versions: Record<string, string>;
	startedAt: string;
	runDir: string;
}

const gitHead = async (dir: string) => (await sh("git rev-parse --short HEAD", { cwd: dir })).tail.trim();
export const q = (p: string) => `'${p.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

/** Junction on Windows (no admin needed), symlink elsewhere. */
function linkDir(target: string, path: string): void {
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

export async function prepareTree(task: LoadedTask, repo: RepoDef, tree: string, log: (s: string) => void): Promise<void> {
	await must(`git worktree add --detach ${q(tree)} ${task.base}`, repo.base, 300);
	for (const rel of repo.setup?.link ?? []) {
		const src = join(repo.setup!.from, rel);
		if (!existsSync(join(tree, rel)) && existsSync(src)) linkDir(src, join(tree, rel));
	}
	for (const rel of repo.setup?.copy ?? []) {
		const src = join(repo.setup!.from, rel);
		if (existsSync(src)) cpSync(src, join(tree, rel), { recursive: true });
	}
	if (repo.seed) log(await must(`node ${q(SEED)} seed --mode ${repo.seed} --base ${q(repo.base)} --dest ${q(tree)}`, ROOT, 900));
	for (const cmd of repo.prepare ?? []) {
		const r = await sh(cmd, { cwd: tree, timeoutSec: repo.prepareTimeoutSec ?? 1800 });
		log(`prepare: ${cmd} → ${r.timedOut ? "timeout" : r.code} (${Math.round(r.ms / 1000)} s)`);
		// A prepare step that fails at an old base commit is recorded, not fatal: the agent sees the same tree in every arm.
		if (r.code !== 0) log(r.tail.slice(-3000));
	}
}

export async function removeTree(repo: RepoDef, tree: string): Promise<void> {
	// Junctions first, so a recursive delete can never follow them into the user's tree.
	for (const rel of repo.setup?.link ?? []) {
		const p = join(tree, rel);
		if (existsSync(p)) rmSync(p, { recursive: false, force: true });
	}
	await sh(`git worktree remove --force ${q(tree)}`, { cwd: repo.base, timeoutSec: 600 });
	if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
	await sh("git worktree prune", { cwd: repo.base });
}

async function agentRun(task: LoadedTask, o: RunOptions, runDir: string, tree: string, res: RunResult): Promise<void> {
	const realctxHome = join(runDir, "realctx");
	mkdirSync(realctxHome, { recursive: true });
	const realctxConfig = join(AGENT_DIR, "realctx", "config.json");
	// The user's realctx config (embedding / semif endpoints), with D-13's cheap model for realctx's own
	// model calls: the historian and the memory edit/merge (`rewriteModel`, else the session model).
	const user = existsSync(realctxConfig) ? JSON.parse(readFileSync(realctxConfig, "utf8")) : {};
	const cfg = realctxRunConfig(user, o.model, REALCTX_MODEL);
	writeFileSync(join(realctxHome, "config.json"), JSON.stringify(cfg, null, 2));
	const sidecar = join(runDir, "usage-sidecar.jsonl");
	const sessionDir = join(runDir, "sessions");
	let stderr = "";
	let cost = 0;
	let settled: RpcRecord | undefined;
	let stopReason: "cap" | "timeout" | undefined;
	const client: RpcClient = new RpcClient({
		cwd: tree,
		pi: findPiCli(),
		args: [
			"--session-dir", sessionDir,
			"--no-extensions",
			"-e", EXTENSIONS.realctx,
			"-e", EXTENSIONS.realtasks,
			"-e", EXTENSIONS.usage,
			"--model", o.model,
			"--thinking", o.thinking,
		],
		env: { ...process.env, REALCTX_HOME: realctxHome, RSA_USAGE_SIDECAR: sidecar },
		onStderr: (t) => (stderr += t),
		onEvent: (e) => {
			if (e.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(e.method))) {
				client.write({ type: "extension_ui_response", id: e.id, cancelled: true } as RpcRecord);
			} else if (e.type === "message_end") {
				const m = e.message as { role?: string; usage?: { cost?: { total?: number } } };
				if (m?.role === "assistant") cost += m.usage?.cost?.total ?? 0;
				if (cost > o.capUsd && !stopReason) {
					stopReason = "cap";
					void client.send({ type: "abort" }, 120_000).catch(() => {});
				}
			} else if (e.type === "agent_settled") settled = e;
		},
	});
	const wallTimer = setTimeout(() => {
		stopReason ??= "timeout";
		void client.send({ type: "abort" }, 120_000).catch(() => {});
	}, o.wallMin * 60_000);
	try {
		const r = await client.send({ type: "prompt", message: task.prompt }, 120_000);
		if (!r.success) throw new Error(`prompt rejected: ${JSON.stringify(r).slice(0, 500)}`);
		while (!settled) {
			if (client.child.exitCode !== null) throw new Error(`pi exited (${client.child.exitCode})`);
			await new Promise((r) => setTimeout(r, 500));
		}
	} finally {
		clearTimeout(wallTimer);
		// Descendants first, while Pi is alive (their parent link is lost once it exits), then Pi itself.
		const early = killLeftovers(client.child.pid, runDir);
		await client.close(10_000).catch(() => {});
		const late = killLeftovers(undefined, runDir);
		res.leftoverProcesses = early.length + late.length;
		writeFileSync(join(runDir, "pi-stderr.log"), stderr);
	}
	res.status = stopReason ?? "ok";
	const sessions = existsSync(sessionDir)
		? readdirSync(sessionDir, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"))
		: [];
	const m = meter(sessions.map((f) => ({ file: join(sessionDir, f) })), [sidecar]);
	const { trace, ...summary } = m;
	writeFileSync(join(runDir, "meter.json"), JSON.stringify(summary, null, 2) + "\n");
	writeFileSync(join(runDir, "trace.jsonl"), trace.map((t) => JSON.stringify(t)).join("\n") + "\n");
	res.costUsd = m.total.costUsd;
	res.wallClockMs = m.wallClockMs;
	res.modelCalls = Object.values(m.turns).reduce((a, t) => a + t.modelCalls, 0);
	res.compactions = m.compactions.length;
	if (res.status === "ok" && m.total.costUsd > o.capUsd) res.status = "cap";
}

/** Reset withheld paths to their base version, then apply each part's change to them. */
async function addWithheldTests(task: LoadedTask, tree: string): Promise<void> {
	for (const p of partsOf(task)) {
		if (!p.withhold.length) continue;
		for (const w of p.withhold) {
			const atBase = await sh(`git cat-file -e ${task.base}:${q(w)}`, { cwd: tree });
			if (atBase.code === 0) await must(`git checkout ${task.base} -- ${q(w)}`, tree);
			else {
				// New in source. If the agent created it, `git add -A -N` left an index entry that blocks --3way.
				await must(`git rm -r -q --cached --ignore-unmatch -- ${q(w)}`, tree);
				rmSync(join(tree, w), { recursive: true, force: true });
			}
		}
		await must(`git diff --binary ${p.from} ${p.source} -- ${p.withhold.map(q).join(" ")} | git apply --3way --whitespace=nowarn`, tree);
	}
}

async function acceptance(task: LoadedTask, tree: string, runDir: string, res: RunResult, writeBaseline = false): Promise<void> {
	// Snapshot the agent's change before withheld files are added.
	await sh("git add -A -N", { cwd: tree });
	const excludes = DIFF_EXCLUDE.map((p) => `':(exclude)${p}'`).join(" ");
	writeFileSync(join(runDir, "diff.patch"), (await sh(`git diff --binary -- . ${excludes}`, { cwd: tree, keep: 50_000_000 })).tail);
	await addWithheldTests(task, tree);
	const t0 = Date.now();
	const a = await sh(task.acceptance.command, { cwd: tree, timeoutSec: task.acceptance.timeoutSec ?? 1800 });
	writeFileSync(join(runDir, "acceptance.log"), `$ ${task.acceptance.command}\nexit ${a.timedOut ? "timeout" : a.code} in ${a.ms} ms\n\n${a.tail}`);
	res.accepted = a.code === 0 && !a.timedOut;
	const checks = regressionChecks(task);
	const results: RegressionResult[] = [];
	const flaky: string[] = [];
	const runCheck = async (check: (typeof checks)[number], sfx: string): Promise<Set<string>> => {
		const vitestJson = join(runDir, `vitest${sfx}.json`);
		const r = await sh(check.command, {
			cwd: tree,
			timeoutSec: check.timeoutSec ?? 3600,
			env: { ...process.env, RSA_VITEST_JSON: vitestJson },
			keep: 5_000_000,
		});
		const log = join(runDir, `regression${sfx}.log`);
		writeFileSync(log, `$ ${check.command}\n\n${r.tail}`);
		const p = check.parser;
		const failures =
			p === "cargo"
				? cargoFailures(r.tail)
				: p === "node-tap"
					? nodeTapFailures(r.tail)
					: existsSync(vitestJson)
						? vitestFailures(readFileSync(vitestJson, "utf8"), tree)
						: new Set(["<no vitest json>"]);
		if (r.timedOut) failures.add("<timeout>");
		return failures;
	};
	for (const [i, check] of checks.entries()) {
		const sfx = checks.length > 1 ? `-${i + 1}` : "";
		let failures = await runCheck(check, sfx);
		const baselineFile = join(task.dir, check.baselineFailures);
		if (writeBaseline) {
			const sources = partsOf(task).map((x) => x.source).join(" + ");
			const header = `# Failures of the reference solution (${sources}) at ${new Date().toISOString().slice(0, 10)}; written by run.ts --mode reference --write-baseline\n`;
			writeFileSync(baselineFile, header + [...failures].sort().join("\n") + "\n");
		}
		// D-18 flake rule: re-run a check once when it shows new failures; only failures seen twice count.
		const ignore = (loadRepos()[task.repo]?.ignoreFailures ?? []).map((r) => new RegExp(r));
		if (ignore.length) failures = new Set([...failures].filter((f) => !ignore.some((r) => r.test(f))));
		const first = compare(failures, readList(baselineFile));
		if (!writeBaseline && first.newFailures.length) {
			const again = await runCheck(check, `${sfx}-retry`);
			for (const f of first.newFailures) if (!again.has(f)) flaky.push(f);
			failures = new Set([...failures].filter((f) => !first.newFailures.includes(f) || again.has(f)));
		}
		results.push(compare(failures, readList(baselineFile)));
	}
	if (checks.length) {
		res.regression = {
			failed: results.reduce((n, x) => n + x.failed, 0),
			newFailures: results.flatMap((x) => x.newFailures),
			fixed: results.flatMap((x) => x.fixed),
			ok: results.every((x) => x.ok),
			...(flaky.length ? { flaky } : {}),
		};
		if (!res.regression.ok) res.accepted = false;
	}
	res.acceptanceMs = Date.now() - t0;
}

export async function runOnce(taskId: string, o: RunOptions): Promise<RunResult> {
	const task = loadTask(taskId);
	if (o.mode === "agent") {
		const spent = ledger(o.runsRoot).totalUsd;
		if (spent + o.capUsd > o.budgetUsd)
			throw new Error(`phase budget: spent $${spent.toFixed(2)} + cap $${o.capUsd} > budget $${o.budgetUsd} (D-21); raise --budget-usd to override`);
		const realctxHead = await gitHead(resolve(EXTENSIONS.realctx, "../../.."));
		if (PINS.realctx && !realctxHead.startsWith(PINS.realctx) && !PINS.realctx.startsWith(realctxHead) && process.env.RSA_ALLOW_DRIFT !== "1")
			throw new Error(`realctx is at ${realctxHead}, the phase pins ${PINS.realctx} (bench/pins.json, D-23); update realctx or set RSA_ALLOW_DRIFT=1`);
	}
	const repo = loadRepos()[task.repo];
	if (!repo) throw new Error(`unknown repo ${task.repo} (bench/repos.json)`);
	const runDir = join(o.runsRoot, task.id, `${o.mode === "agent" ? o.arm : o.mode}-${o.n}`);
	if (existsSync(runDir)) throw new Error(`${runDir} exists; remove it or pick another --n`);
	mkdirSync(runDir, { recursive: true });
	const tree = join(runDir, "tree");
	const lines: string[] = [];
	const log = (s: string) => {
		lines.push(s);
		console.error(`[${task.id}] ${s}`);
	};
	const res: RunResult = {
		task: task.id,
		label: task.label,
		mode: o.mode,
		arm: o.arm,
		n: o.n,
		status: "ok",
		accepted: null,
		setupMs: 0,
		versions: {},
		startedAt: new Date().toISOString(),
		runDir,
	};
	try {
		res.versions = {
			pi: findPiCli().version,
			realctx: await gitHead(resolve(EXTENSIONS.realctx, "../../..")),
			realctxModel: REALCTX_MODEL,
			realtasks: await gitHead(resolve(EXTENSIONS.realtasks, "..")),
			realsubagents: await gitHead(ROOT),
			model: o.mode === "agent" ? `${o.model}:${o.thinking}` : "-",
		};
		const t0 = Date.now();
		await prepareTree(task, repo, tree, log);
		res.setupMs = Date.now() - t0;
		if (o.mode === "reference") {
			const parts = partsOf(task);
			if (!parts.length) throw new Error("reference mode needs task.source or task.parts");
			// Apply each historical change except its withheld paths (acceptance adds those itself).
			for (const p of parts) {
				// Changelog entries are not part of a task and make composite parts conflict.
				const excludes = [...p.withhold, "**/CHANGELOG.md"].map((w) => `':(exclude)${w}'`).join(" ");
				await must(`git diff --binary ${p.from} ${p.source} -- . ${excludes} | git apply --3way --whitespace=nowarn`, tree);
			}
		} else if (o.mode === "agent" && o.arm === "rsa") {
			// v0.05 dry run (R.05.2): orchestrator + 2 workers; leaves the merged change in `tree`.
			const { relayRun } = await import("./dryrun.ts");
			await relayRun(task, repo, o, runDir, tree, res, log, { AGENT_DIR, DIFF_EXCLUDE, EXTENSIONS, REALCTX_MODEL, prepareTree, removeTree, realctxRunConfig });
		} else if (o.mode === "agent") {
			await agentRun(task, o, runDir, tree, res);
		}
		await acceptance(task, tree, runDir, res, o.writeBaseline && o.mode === "reference");
		if (repo.seed) {
			const v = await sh(`node ${q(SEED)} verify --dest ${q(tree)}`, { cwd: ROOT });
			res.baseIntact = v.code === 0;
			log(`seed verify: ${v.tail.trim()}`);
		}
	} catch (err) {
		res.status = "error";
		res.error = String((err as Error)?.stack ?? err).slice(0, 4000);
		log(res.error);
	} finally {
		writeFileSync(join(runDir, "runner.log"), lines.join("\n") + "\n");
		writeFileSync(join(runDir, "result.json"), JSON.stringify(res, null, 2) + "\n");
		if (!o.keep && existsSync(tree)) await removeTree(repo, tree);
	}
	return res;
}

/**
 * Re-check a finished agent run with the current harness: rebuild the tree at base, apply the run's
 * saved diff.patch, run acceptance again. Cost and time stay as measured; the old verdict is kept
 * under `rescored.previous`. Used after a harness fix (no model calls, free).
 */
export async function rescore(runDir: string): Promise<RunResult> {
	const res = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as RunResult;
	const task = loadTask(res.task);
	const repo = loadRepos()[task.repo];
	const tree = join(runDir, "tree");
	if (existsSync(tree)) throw new Error(`${tree} exists`);
	const patch = join(runDir, "diff.patch");
	if (!existsSync(patch)) throw new Error(`${patch} missing; cannot rescore`);
	const previous = { status: res.status, accepted: res.accepted, regression: res.regression, error: res.error?.split("\n")[0] };
	const lines: string[] = [];
	const log = (s: string) => {
		lines.push(s);
		console.error(`[${task.id} rescore] ${s}`);
	};
	try {
		await prepareTree(task, repo, tree, log);
		if (statSync(patch).size) await must(`git apply --whitespace=nowarn ${q(patch)}`, tree);
		res.status = "ok";
		delete res.error;
		delete res.regression;
		await acceptance(task, tree, runDir, res);
		if (repo.seed) res.baseIntact = (await sh(`node ${q(SEED)} verify --dest ${q(tree)}`, { cwd: ROOT })).code === 0;
	} catch (err) {
		res.status = "error";
		res.error = String((err as Error)?.stack ?? err).slice(0, 4000);
		log(res.error);
	} finally {
		res.rescored = { at: new Date().toISOString(), harness: await gitHead(ROOT), previous };
		writeFileSync(join(runDir, "rescore.log"), lines.join("\n") + "\n");
		writeFileSync(join(runDir, "result.json"), JSON.stringify(res, null, 2) + "\n");
		if (existsSync(tree)) await removeTree(repo, tree);
	}
	return res;
}

function parseArgs(argv: string[]): { task: string; o: RunOptions } {
	const o: RunOptions = {
		mode: "agent",
		arm: "baseline",
		n: 1,
		keep: false,
		writeBaseline: false,
		model: "anthropic/claude-opus-5-5",
		thinking: "high",
		capUsd: 5,
		budgetUsd: Number(process.env.RSA_PHASE_BUDGET ?? 100),
		wallMin: 90,
		runsRoot: process.env.RSA_RUNS ?? "D:/rsa-bench/runs",
	};
	let task = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const v = () => argv[++i];
		if (a === "--mode") o.mode = v() as Mode;
		else if (a === "--arm") o.arm = v();
		else if (a === "--n") o.n = Number(v());
		else if (a === "--keep") o.keep = true;
		else if (a === "--write-baseline") o.writeBaseline = true;
		else if (a === "--model") o.model = v();
		else if (a === "--thinking") o.thinking = v();
		else if (a === "--cap-usd") o.capUsd = Number(v());
		else if (a === "--budget-usd") o.budgetUsd = Number(v());
		else if (a === "--wall-min") o.wallMin = Number(v());
		else if (a === "--runs") o.runsRoot = v();
		else task = a;
	}
	if (!task || !["agent", "base", "reference"].includes(o.mode)) {
		console.error("usage: node bench/run.ts <task> [--mode agent|base|reference] [--n 1] [--keep] [--cap-usd 5] ...");
		process.exit(2);
	}
	return { task, o };
}

if (import.meta.main) {
	const rs = process.argv.indexOf("--rescore");
	const r = rs > 0 ? await rescore(process.argv[rs + 1]) : await runOnce(parseArgs(process.argv.slice(2)).task, parseArgs(process.argv.slice(2)).o);
	console.log(JSON.stringify({ task: r.task, mode: r.mode, status: r.status, accepted: r.accepted, costUsd: r.costUsd, wallClockMs: r.wallClockMs, regression: r.regression && { ok: r.regression.ok, newFailures: r.regression.newFailures.slice(0, 20) }, baseIntact: r.baseIntact, runDir: r.runDir, error: r.error?.split("\n")[0] }, null, 1));
	process.exit(r.status === "error" ? 1 : 0);
}
