/**
 * Benchmark task and repository definitions (R0.0.1, route D-19).
 *
 * A task lives in `bench/tasks/<id>/`:
 * - `task.json`: the fields of `TaskDef`
 * - `prompt.md`: the request given to the agent, verbatim
 *
 * Repositories are described once in `bench/repos.json` (`RepoDef`): where the warm base clone is,
 * how a new tree is set up (D-15) and seeded (D-17), and how it is prepared before the timed run.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type TaskLabel = "small" | "large-serial" | "large-parallel";

export interface TaskDef {
	id: string;
	repo: string;
	/** Commit the tree is checked out at. */
	base: string;
	/** Historical commit the task was reconstructed from, if any; withheld files are taken from it. */
	source?: string;
	label: TaskLabel;
	/** For large-parallel tasks: independent subtasks a decomposition should find. */
	k?: number;
	/** Module groups a partition is expected to touch (design doc §6). */
	expectedGroups?: string[];
	/**
	 * Paths (files or directories) checked out from `source` only at acceptance time: the tests the
	 * agent must make pass without seeing them. If a path exists at `base`, the agent sees the old version.
	 */
	withhold?: string[];
	acceptance: {
		/** Bash command run in the tree root; exit 0 = the task's named tests pass. */
		command: string;
		timeoutSec?: number;
	};
	/** D-18: full-suite regression check against a baseline failure list. Optional per task. */
	regression?: {
		command: string;
		parser: "cargo" | "vitest-json" | "node-tap";
		/** File (relative to the task dir) listing baseline failures, one test id per line. */
		baselineFailures: string;
		timeoutSec?: number;
	};
	/** Free-form notes: why the task has its label, what it touches. */
	notes?: string;
}

export interface RepoDef {
	/** Warm base clone (also the seeding source). */
	base: string;
	/** Tree setup (D-15): directories linked read-only from `from`, paths copied from `from`. */
	setup?: { from: string; link?: string[]; copy?: string[] };
	/** Tier B seeding mode (D-17); omitted = no seeding. */
	seed?: "cargo" | "npm";
	/** Commands run in the tree after setup and seeding and before the timed run (not metered). */
	prepare?: string[];
	prepareTimeoutSec?: number;
}

export const BENCH_DIR = resolve(import.meta.dirname);

export function loadRepos(file = join(BENCH_DIR, "repos.json")): Record<string, RepoDef> {
	return JSON.parse(readFileSync(file, "utf8"));
}

export interface LoadedTask extends TaskDef {
	dir: string;
	prompt: string;
}

export function loadTask(idOrDir: string): LoadedTask {
	const dir = existsSync(join(idOrDir, "task.json")) ? resolve(idOrDir) : join(BENCH_DIR, "tasks", idOrDir);
	const def = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as TaskDef;
	const prompt = readFileSync(join(dir, "prompt.md"), "utf8").trim();
	const problems = validateTask(def, prompt);
	if (problems.length) throw new Error(`task ${dir}: ${problems.join("; ")}`);
	return { ...def, dir, prompt };
}

export function validateTask(t: TaskDef, prompt: string): string[] {
	const p: string[] = [];
	if (!t.id) p.push("id missing");
	if (!t.repo) p.push("repo missing");
	if (!/^[0-9a-f]{7,40}$|^v[\d.]+$/.test(t.base ?? "")) p.push("base must be a commit or a version tag");
	if (!["small", "large-serial", "large-parallel"].includes(t.label)) p.push("bad label");
	if (t.label === "large-parallel" && !(t.k && t.k >= 2)) p.push("large-parallel needs k >= 2");
	if (t.withhold?.length && !t.source) p.push("withhold needs source");
	if (!t.acceptance?.command) p.push("acceptance.command missing");
	if (!prompt) p.push("prompt.md empty");
	return p;
}

export function listTasks(): string[] {
	const root = join(BENCH_DIR, "tasks");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(root, d.name, "task.json")))
		.map((d) => d.name)
		.sort();
}
