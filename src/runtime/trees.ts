/**
 * Worker trees and integration (route R1.3, R1.5; design §13, simplified per D-28).
 *
 * - `snapshot()`: the user's working tree (tracked changes and untracked, non-ignored files) as a
 *   commit, built through a temporary index, so the user's index and files are untouched. It is the
 *   base of every worker tree: workers start from exactly what the user sees.
 * - `createTree()`: a git worktree on `rsa/<task>/<worker>` at the base, plus the project's tree
 *   setup: linked directories (junctions on Windows), copied paths, hard-link seeding of
 *   dependencies and build outputs (`seed-tree.mjs`), prepare commands.
 * - `commitTree()`: commits a worker's work (harness paths excluded).
 * - `mergeCommits()`: `git merge-tree --write-tree` of the workers' commits; no working tree needed.
 * - `land()`: applies the difference between the last landed tree and a new merged tree to the
 *   user's working tree, so repeated landings (after a steer) are incremental.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { must, sh } from "./sh.ts";

export const SEED_SCRIPT = join(import.meta.dirname, "seed-tree.mjs");
const GIT_ID = "-c user.name=realsubagents -c user.email=rsa@localhost -c commit.gpgsign=false";
/** Files the harness writes into a tree that never belong in a worker's commit. */
const HARNESS_PATHS = [".rsa-seed-manifest.json"];

export const q = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;

export interface TreeSetup {
	/** Directories linked read-only from the user's tree (untracked SDKs, samples). */
	link?: string[];
	/** Paths copied from the user's tree (small generated files). */
	copy?: string[];
	/**
	 * Ignored build outputs copied from the user's tree, so workers need not rebuild. `*` matches one
	 * path segment, e.g. "packages/*\/dist". Copied, not hard-linked: a rebuild in the worker writes
	 * files in place, which would change the user's files through a shared link.
	 */
	build?: string[];
	/** Hard-link seeding of dependencies and build outputs; "auto" detects npm or Cargo. */
	seed?: "npm" | "cargo" | "none" | "auto";
	/** Commands run in a new tree after setup and seeding. */
	prepare?: string[];
	prepareTimeoutSec?: number;
}

export interface RepoInfo {
	root: string;
	/** `git-<root commit>`, as realctx derives its project key. */
	project: string;
}

export async function repoInfo(cwd: string): Promise<RepoInfo> {
	const root = resolve((await must("git rev-parse --show-toplevel", cwd)).split("\n").pop()!.trim());
	const first = (await must("git rev-list --max-parents=0 HEAD", root)).split("\n").filter(Boolean).pop()!.trim();
	return { root, project: `git-${first.slice(0, 12)}` };
}

/**
 * Tree setup: `RSA_TREE_SETUP` (JSON, set by the benchmark) wins, then `<root>/.pi/rsa.json`
 * (`{ "trees": { ... } }`), then `{ seed: "auto" }`.
 */
export function loadTreeSetup(root: string): TreeSetup {
	if (process.env.RSA_TREE_SETUP) return JSON.parse(process.env.RSA_TREE_SETUP);
	const f = join(root, ".pi", "rsa.json");
	if (existsSync(f)) {
		const c = JSON.parse(readFileSync(f, "utf8"));
		if (c.trees) return c.trees;
	}
	return { seed: "auto" };
}

function seedMode(root: string, setup: TreeSetup): "npm" | "cargo" | undefined {
	const s = setup.seed ?? "auto";
	if (s === "none") return undefined;
	if (s !== "auto") return s;
	if (existsSync(join(root, "node_modules")) && existsSync(join(root, "package.json"))) return "npm";
	if (existsSync(join(root, "target")) && existsSync(join(root, "Cargo.toml"))) return "cargo";
	return undefined;
}

/** Commit the user's working tree, untracked files included, without touching their index. */
export async function snapshot(root: string): Promise<string> {
	const index = join(tmpdir(), `rsa-index-${process.pid}-${Date.now()}`);
	const env = { ...process.env, GIT_INDEX_FILE: index };
	try {
		const run = async (cmd: string) => {
			const r = await sh(cmd, { cwd: root, env, timeoutSec: 300 });
			if (r.code !== 0) throw new Error(`snapshot: ${cmd} failed: ${r.tail.slice(-1500)}`);
			return r.tail.trim();
		};
		await run("git read-tree HEAD");
		await run("git add -A");
		const tree = await run("git write-tree");
		const head = await run("git rev-parse HEAD");
		if ((await run("git rev-parse HEAD^{tree}")) === tree) return head;
		return await run(`git ${GIT_ID} commit-tree ${tree} -p ${head} -m 'rsa: snapshot of the working tree'`);
	} finally {
		rmSync(index, { force: true });
	}
}

/** Expand patterns whose segments may be `*` (one directory level) against `root`. */
export function expandGlobs(root: string, patterns: string[]): string[] {
	const out: string[] = [];
	for (const pat of patterns) {
		let paths = [""];
		for (const seg of pat.split("/").filter(Boolean)) {
			const next: string[] = [];
			for (const p of paths) {
				if (seg === "*") {
					let names: string[] = [];
					try {
						names = readdirSync(join(root, p), { withFileTypes: true })
							.filter((d) => d.isDirectory())
							.map((d) => d.name);
					} catch {
						// missing directory: no match
					}
					for (const n of names) next.push(p ? `${p}/${n}` : n);
				} else next.push(p ? `${p}/${seg}` : seg);
			}
			paths = next;
		}
		out.push(...paths.filter((p) => existsSync(join(root, p))));
	}
	return [...new Set(out)];
}

function linkDir(src: string, dst: string): void {
	mkdirSync(dirname(dst), { recursive: true });
	symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
}

export async function createTree(root: string, dest: string, base: string, branch: string, setup: TreeSetup, log: (s: string) => void = () => {}): Promise<void> {
	mkdirSync(dirname(dest), { recursive: true });
	await must(`git worktree add -q -B ${q(branch)} ${q(dest)} ${base}`, root, 300);
	for (const rel of setup.link ?? []) {
		const src = join(root, rel);
		if (!existsSync(join(dest, rel)) && existsSync(src)) linkDir(src, join(dest, rel));
	}
	for (const rel of [...(setup.copy ?? []), ...expandGlobs(root, setup.build ?? [])]) {
		const src = join(root, rel);
		if (existsSync(src)) cpSync(src, join(dest, rel), { recursive: true });
	}
	const mode = seedMode(root, setup);
	if (mode) {
		const r = await sh(`node ${q(SEED_SCRIPT)} seed --mode ${mode} --base ${q(root)} --dest ${q(dest)}`, { cwd: root, timeoutSec: 900 });
		log(`seed ${mode}: ${r.code === 0 ? r.tail.trim().split("\n").pop() : `failed: ${r.tail.slice(-800)}`}`);
	}
	for (const cmd of setup.prepare ?? []) {
		const r = await sh(cmd, { cwd: dest, timeoutSec: setup.prepareTimeoutSec ?? 1800 });
		log(`prepare: ${cmd} → ${r.timedOut ? "timeout" : r.code} (${Math.round(r.ms / 1000)} s)`);
		if (r.code !== 0) log(r.tail.slice(-2000));
	}
}

export async function removeTree(root: string, dest: string, setup: TreeSetup, branch?: string): Promise<void> {
	// Links first, so a recursive delete can never follow them into the user's tree.
	for (const rel of setup.link ?? []) {
		const p = join(dest, rel);
		try {
			unlinkSync(p);
		} catch {
			if (existsSync(p)) rmSync(p, { recursive: false, force: true });
		}
	}
	await sh(`git worktree remove --force ${q(dest)}`, { cwd: root, timeoutSec: 600 });
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	await sh("git worktree prune", { cwd: root });
	if (branch) await sh(`git branch -D ${q(branch)}`, { cwd: root });
}

/** Commit everything the worker changed; returns HEAD (unchanged when there was nothing to commit). */
export async function commitTree(tree: string, message: string, setup: TreeSetup): Promise<string> {
	await must("git add -A", tree);
	// Unstage harness paths; `git add` with exclude pathspecs fails when such a path is ignored.
	const harness = [...HARNESS_PATHS, ...(setup.link ?? []), ...(setup.copy ?? []), ...(setup.build ?? [])].map(q).join(" ");
	await sh(`git reset -q -- ${harness}`, { cwd: tree });
	if ((await sh("git diff --cached --quiet", { cwd: tree })).code !== 0) {
		const msgFile = join(tmpdir(), `rsa-msg-${process.pid}-${Date.now()}`);
		writeFileSync(msgFile, message);
		try {
			await must(`git ${GIT_ID} commit -q --no-verify -F ${q(msgFile)}`, tree);
		} finally {
			rmSync(msgFile, { force: true });
		}
	}
	return (await must("git rev-parse HEAD", tree)).trim();
}

export type MergeResult = { ok: true; tree: string; commit: string } | { ok: false; conflicts: string[]; between: [string, string] };

/** Merge commits (each based on `base`) without a working tree. */
export async function mergeCommits(root: string, base: string, commits: string[]): Promise<MergeResult> {
	if (!commits.length) throw new Error("mergeCommits: nothing to merge");
	let acc = commits[0];
	for (const c of commits.slice(1)) {
		const r = await sh(`git merge-tree --write-tree --name-only --merge-base=${base} ${acc} ${c}`, { cwd: root, timeoutSec: 300 });
		const lines = r.tail.split("\n").map((l) => l.trim());
		if (r.code === 1) {
			const blank = lines.indexOf("", 1);
			const files = lines.slice(1, blank < 0 ? undefined : blank).filter(Boolean);
			return { ok: false, conflicts: [...new Set(files)], between: [acc, c] };
		}
		if (r.code !== 0) throw new Error(`git merge-tree failed: ${r.tail.slice(-1500)}`);
		acc = (await must(`git ${GIT_ID} commit-tree ${lines[0]} -p ${acc} -p ${c} -m 'rsa: merge'`, root)).trim();
	}
	const tree = (await must(`git rev-parse ${acc}^{tree}`, root)).trim();
	return { ok: true, tree, commit: acc };
}

export interface LandResult {
	ok: boolean;
	files: string[];
	error?: string;
}

/** Apply `from`..`to` (tree-ish) to the user's working tree. */
export async function land(root: string, from: string, to: string): Promise<LandResult> {
	const files = (await must(`git diff --name-only ${from} ${to}`, root)).split("\n").filter(Boolean);
	if (!files.length) return { ok: true, files };
	const patch = join(tmpdir(), `rsa-land-${process.pid}-${Date.now()}.patch`);
	try {
		await must(`git diff --binary ${from} ${to} > ${q(patch)}`, root);
		// Plain apply works on untracked files too (the snapshot includes them); fall back to a
		// three-way apply when the user changed a file after the task started.
		let r = await sh(`git apply --whitespace=nowarn ${q(patch)}`, { cwd: root });
		if (r.code !== 0) r = await sh(`git apply --3way --whitespace=nowarn ${q(patch)}`, { cwd: root });
		return r.code === 0 ? { ok: true, files } : { ok: false, files, error: r.tail.slice(-1500) };
	} finally {
		rmSync(patch, { force: true });
	}
}
