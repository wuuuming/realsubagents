/**
 * Coordinator: runs one split task from `rsa_split` to `rsa_finish` (route v0.1, D-28).
 *
 *   rsa_split  → snapshot the working tree → one seeded worktree + `pi --mode rpc` per worker
 *   Report     → commit the worker's tree → `worker.reported` → delivered to the orchestrator
 *   all done   → `git merge-tree` of the workers' commits → land in the user's tree → run the
 *                check commands → one message with merge and check results
 *   rsa_steer  → steer (or restart) one worker; its next done Report is merged and landed again
 *   rsa_finish → stop workers, remove their trees, close the task
 *
 * State lives in the store (src/store), so a restarted Pi resumes the task: `resume()` restarts
 * workers that were working with `--continue` and delivers Reports that never reached the
 * orchestrator. One coordinator per project holds a lease; Pi, Git and the message channel are
 * injected, so this module is testable without a model.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WorkerProcess, type WorkerReport } from "./runtime/worker.ts";
import { killLeftovers, sh } from "./runtime/sh.ts";
import { commitTree, createTree, land, mergeCommits, removeTree, snapshot, type TreeSetup } from "./runtime/trees.ts";
import { newTaskId, type Store, type Task, type Worker } from "./store/store.ts";

export interface WorkerDispatch {
	goal: string;
	acceptance: string;
	paths: string[];
	brief: string;
}

export interface SplitParams {
	title: string;
	workers: WorkerDispatch[];
	check?: string[];
	budgetUsd?: number;
}

export interface CoordinatorDeps {
	store: Store;
	/** Root of the user's repository (the orchestrator's working tree). */
	root: string;
	project: string;
	/** realsubagents home: worktrees/ and sessions/ live under it. */
	home: string;
	setup: TreeSetup;
	/** Deliver a message to the orchestrator; it should wake the session when idle. */
	deliver(text: string, details: { task: string; reports: number[] }): void;
	/** Called when a task opens or closes (tool surface). */
	onTaskOpen(open: boolean): void;
	/** How to start a worker: model, Pi arguments, prompt files, environment. */
	workerLaunch(): { model?: string; thinking?: string; piArgs: string[]; promptFiles: string[]; env?: NodeJS.ProcessEnv };
	/** Lease owner id of this coordinator (one per Pi process). */
	owner: string;
	log(s: string): void;
	/** For tests: replace the worker process factory. */
	spawnWorker?: (spec: ConstructorParameters<typeof WorkerProcess>[0], h: ConstructorParameters<typeof WorkerProcess>[1]) => WorkerLike;
	checkTimeoutSec?: number;
	/** For tests: replace the stale-process cleanup run on resume. */
	killStale?: (pid: number | undefined, tree: string) => unknown;
}

/** What the coordinator needs from a worker process (WorkerProcess, or a fake in tests). */
export interface WorkerLike {
	readonly pid: number | undefined;
	busy: boolean;
	cost: number;
	start(): void;
	say(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	stop(): Promise<number>;
}

export const MIN_WORKERS = 2;
export const MAX_WORKERS = 3;
const LEASE_MS = 30_000;
const CHECK_TAIL_LINES = 30;

export class CoordinatorError extends Error {}

const norm = (p: string) =>
	p
		.replaceAll("\\", "/")
		.replace(/^\.(\/|$)/, "")
		.replace(/\/+$/, "")
		.toLowerCase();

/** Pairs of overlapping paths across workers (one is the other or contains it). */
export function overlaps(workers: { paths: string[] }[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < workers.length; i++)
		for (let j = i + 1; j < workers.length; j++)
			for (const a of workers[i].paths)
				for (const b of workers[j].paths) {
					const x = norm(a);
					const y = norm(b);
					if (x === "" || y === "" || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) out.push(`w${i + 1}:${a} ↔ w${j + 1}:${b}`);
				}
	return out;
}

export class Coordinator {
	private readonly d: CoordinatorDeps;
	private readonly procs = new Map<string, WorkerLike>();
	private queue: Promise<void> = Promise.resolve();
	private readonly launches = new Set<Promise<void>>();
	private leaseTimer?: ReturnType<typeof setInterval>;
	private budgetHit = false;
	private baseChecks?: Promise<CheckRun[]>;
	taskId?: string;

	constructor(deps: CoordinatorDeps) {
		this.d = deps;
	}

	get task(): Task | undefined {
		return this.taskId ? this.d.store.task(this.taskId) : undefined;
	}

	/** Wait until all queued work (launches, reports, integration) is done. For tests and shutdown. */
	async idle(): Promise<void> {
		for (;;) {
			const q = this.queue;
			await Promise.all([q, ...this.launches]);
			if (q === this.queue && this.launches.size === 0) return;
		}
	}

	private enqueue(fn: () => Promise<void>): void {
		this.queue = this.queue.then(fn).catch((e) => {
			this.d.log(`realsubagents: ${String((e as Error)?.stack ?? e)}`);
			if (this.taskId) this.d.deliver(`<rsa_error>${String((e as Error)?.message ?? e).slice(0, 1500)}</rsa_error>`, { task: this.taskId, reports: [] });
		});
	}

	private stamp(): string {
		const t = this.task;
		return t ? `elapsed ${Math.round((Date.now() - t.createdAt) / 1000)}s` : "";
	}

	private treeOf(name: string): string {
		return join(this.d.home, "worktrees", this.d.project, this.taskId!, name);
	}

	private sessionDirOf(name: string): string {
		return join(this.d.home, "sessions", this.d.project, this.taskId!, name);
	}

	private takeLease(): boolean {
		const ok = this.d.store.acquire(`coord:${this.d.project}`, this.d.owner, LEASE_MS);
		if (ok && !this.leaseTimer) {
			this.leaseTimer = setInterval(() => this.d.store.acquire(`coord:${this.d.project}`, this.d.owner, LEASE_MS), LEASE_MS / 3);
			this.leaseTimer.unref?.();
		}
		return ok;
	}

	private dropLease(): void {
		if (this.leaseTimer) clearInterval(this.leaseTimer);
		this.leaseTimer = undefined;
		this.d.store.release(`coord:${this.d.project}`, this.d.owner);
	}

	// ---- tools ---------------------------------------------------------------------------

	async split(p: SplitParams): Promise<string> {
		if (this.taskId) throw new CoordinatorError(`Task ${this.taskId} is still open. Finish it with rsa_finish before starting another.`);
		if (p.workers.length < MIN_WORKERS || p.workers.length > MAX_WORKERS)
			throw new CoordinatorError(`Give ${MIN_WORKERS} or ${MAX_WORKERS} workers (got ${p.workers.length}). A task that does not split into ${MIN_WORKERS} parts is faster done directly.`);
		const bad = p.workers.findIndex((w) => !w.paths?.length);
		if (bad >= 0) throw new CoordinatorError(`w${bad + 1} has no paths.`);
		const ov = overlaps(p.workers);
		if (ov.length) throw new CoordinatorError(`Workers' paths overlap: ${ov.join("; ")}. Give each path to one worker only.`);
		if (!this.takeLease()) throw new CoordinatorError("Another Pi session is coordinating a task in this repository.");

		const base = await snapshot(this.d.root);
		const id = newTaskId();
		const store = this.d.store;
		store.tx(() => {
			store.append({
				type: "task.created",
				task: id,
				actor: "orchestrator",
				data: { title: p.title, goal: "", base, branch: `rsa/${id}`, project: this.d.project, check: p.check ?? [], budgetUsd: p.budgetUsd },
			});
			p.workers.forEach((w, i) => store.append({ type: "worker.dispatched", task: id, actor: "orchestrator", data: { worker: `w${i + 1}`, ...w } }));
		});
		this.taskId = id;
		this.budgetHit = false;
		this.d.onTaskOpen(true);
		for (const w of store.workers(id)) this.enqueueLaunch(w.name, "fresh");
		// While the workers work, the user's tree is still the base: run the checks there now, so the
		// integration check can tell new failures from ones that were already there.
		this.baseChecks = this.task!.check.length ? this.execChecks(this.task!.check) : undefined;
		const names = p.workers.map((_, i) => `w${i + 1}`).join(", ");
		return `Task ${id}: ${names} are starting in their own trees (setup can take a minute). Their Reports will arrive as messages. End your turn now unless you have something else to tell the user.`;
	}

	async steer(name: string, message: string): Promise<string> {
		const id = this.requireTask();
		const w = this.d.store.worker(id, name);
		if (!w) throw new CoordinatorError(`No worker ${name} in task ${id}.`);
		this.d.store.append({ type: "worker.steered", task: id, actor: "orchestrator", data: { worker: name, message } });
		this.enqueue(async () => {
			await Promise.all(this.launches); // never start a second process for a worker still launching
			const p = this.procs.get(name) ?? this.spawn(name, true);
			await p.steer(message);
		});
		return `Sent to ${name}.`;
	}

	async finish(outcome: "success" | "failure", summary: string): Promise<string> {
		const id = this.requireTask();
		await this.idle();
		const leftovers = await this.stopWorkers();
		const t = this.task!;
		for (const w of this.d.store.workers(id)) {
			if (w.tree && existsSync(w.tree)) await removeTree(this.d.root, w.tree, this.d.setup, w.branch).catch((e) => this.d.log(`remove ${w.tree}: ${e}`));
			if (w.state !== "stopped") this.d.store.append({ type: "worker.stopped", task: id, actor: "orchestrator", data: { worker: w.name, reason: "finished" } });
		}
		this.d.store.append({ type: "task.finished", task: id, actor: "orchestrator", data: { outcome, summary } });
		this.taskId = undefined;
		this.dropLease();
		this.d.onTaskOpen(false);
		const landed = t.landed ? "The merged work is in the working tree (uncommitted)." : "Nothing was applied to the working tree.";
		return `Task ${id} closed (${outcome}). ${landed}${leftovers ? ` Stopped ${leftovers} leftover worker process(es).` : ""}`;
	}

	status(): string {
		const t = this.task;
		if (!t) return "realsubagents: no open task.";
		const ws = this.d.store.workers(t.id);
		const cost = [...this.procs.values()].reduce((s, p) => s + p.cost, 0);
		const lines = ws.map((w) => `  ${w.name} ${w.state}${w.lastReport ? ` (${w.lastReport.kind})` : ""}${this.procs.get(w.name)?.busy ? " working" : ""}  ${w.paths.join(", ")}`);
		return [`realsubagents: task ${t.id} "${t.title}" ${t.state}, ${this.stamp()}, workers $${cost.toFixed(2)} this session`, ...lines].join("\n");
	}

	/** Stop worker processes but keep the task open, so the next Pi session resumes it. */
	async shutdown(): Promise<void> {
		await Promise.race([this.queue.catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
		await this.stopWorkers();
		this.dropLease();
	}

	/**
	 * Resume the project's open task after a restart. `delivered` holds Report seqs that the
	 * orchestrator's session already contains (they are marked delivered, not sent again).
	 */
	async resume(delivered: Iterable<number>): Promise<string | undefined> {
		const open = this.d.store.tasks(this.d.project, true)[0];
		if (!open) return undefined;
		if (!this.takeLease()) return `realsubagents: task ${open.id} is coordinated by another Pi session.`;
		this.taskId = open.id;
		this.d.onTaskOpen(true);
		const seen = new Set(delivered);
		const claim = this.d.store.pendingReports(open.id).filter((r) => seen.has(r.seq)).map((r) => r.seq);
		if (claim.length) this.d.store.claimReports(claim, "orchestrator");
		// After a hard kill the old worker processes may still run (children outlive their parent on
		// Windows); two processes must never write one worker session.
		for (const w of this.d.store.workers(open.id)) if (w.tree && (w.state === "starting" || w.state === "working")) (this.d.killStale ?? killLeftovers)(w.pid, w.tree);
		for (const w of this.d.store.workers(open.id)) {
			if (w.state === "starting") this.enqueueLaunch(w.name, w.tree && existsSync(w.tree) ? "redispatch" : "fresh");
			else if (w.state === "working") this.enqueueLaunch(w.name, hasSession(w.sessionDir) ? "continue" : w.tree && existsSync(w.tree) ? "redispatch" : "fresh");
		}
		this.enqueue(() => this.deliverPending());
		return `realsubagents: resumed task ${open.id} "${open.title}".`;
	}

	private requireTask(): string {
		if (!this.taskId) throw new CoordinatorError("No task is open. Use rsa_split first.");
		return this.taskId;
	}

	// ---- workers -------------------------------------------------------------------------

	private spawn(name: string, resume: boolean): WorkerLike {
		const launch = this.d.workerLaunch();
		const spec = {
			name,
			tree: this.treeOf(name),
			sessionDir: this.sessionDirOf(name),
			model: launch.model,
			thinking: launch.thinking,
			piArgs: launch.piArgs,
			promptFiles: launch.promptFiles,
			env: launch.env,
			resume: resume && hasSession(this.sessionDirOf(name)),
			stderrFile: join(this.d.home, "sessions", this.d.project, this.taskId!, `${name}.stderr.log`),
		};
		const handlers = {
			onReport: (r: WorkerReport) => this.enqueue(() => this.onReport(name, r)),
			onCost: () => this.checkBudget(),
			onExit: (code: number | null) =>
				this.enqueue(() => this.onReport(name, { kind: "failed", summary: `The worker's Pi process exited unexpectedly (code ${code}).`, evidence: [], asks: [] })),
			stamp: () => this.stamp(),
			log: (s: string) => this.d.log(s),
		};
		const p = this.d.spawnWorker ? this.d.spawnWorker(spec, handlers) : new WorkerProcess(spec, handlers);
		this.procs.set(name, p);
		p.start();
		this.d.store.append({ type: "worker.started", task: this.taskId!, actor: "runtime", data: { worker: name, tree: spec.tree, branch: `rsa/${this.taskId}/${name}`, pid: p.pid, sessionDir: spec.sessionDir } });
		return p;
	}

	/** fresh: create the tree and dispatch; redispatch: tree exists, dispatch again; continue: resume the session. */
	private enqueueLaunch(name: string, mode: "fresh" | "redispatch" | "continue"): void {
		const task = this.taskId!;
		const launch = async () => {
			if (this.taskId !== task) return;
			const tree = this.treeOf(name);
			if (mode === "fresh") {
				if (existsSync(tree)) await removeTree(this.d.root, tree, this.d.setup).catch(() => {});
				await createTree(this.d.root, tree, this.task!.base, `rsa/${task}/${name}`, this.d.setup, (s) => this.d.log(`${name}: ${s}`));
			}
			const p = this.spawn(name, mode === "continue");
			if (mode === "continue")
				await p.say(
					"<relay>The orchestrator's Pi session restarted, which stopped your Pi process. Continue your part of the task where you left off, and call rsa_report when it is done, blocked, needs a decision, or has failed.</relay>",
				);
			else await p.say(this.renderDispatch(name));
		};
		// Launches run outside the serial queue, in parallel; failures become failed Reports.
		const run: Promise<void> = launch()
			.catch((e) => this.enqueue(() => this.onReport(name, { kind: "failed", summary: `Worker setup failed: ${String((e as Error)?.message ?? e).slice(0, 600)}`, evidence: [], asks: [] })))
			.finally(() => this.launches.delete(run));
		this.launches.add(run);
	}

	private renderDispatch(name: string): string {
		const ws = this.d.store.workers(this.taskId!);
		const me = ws.find((w) => w.name === name)!;
		const others = ws
			.filter((w) => w.name !== name)
			.map((w) => `${w.name} writes: ${w.paths.join(", ")}\nIts goal: ${w.goal}`)
			.join("\n\n");
		return [
			`<task>\n${me.goal}\n</task>`,
			`<acceptance>\n${me.acceptance}\n</acceptance>`,
			`<brief>\n${me.brief}\n</brief>`,
			`<other_groups>\n${others}\n</other_groups>`,
			`<paths>\n${me.paths.join("\n")}\n</paths>`,
			`You are ${name}. Write only inside the paths above. Call rsa_report when your part is done, blocked, needs a decision, or has failed.`,
		].join("\n\n");
	}

	private async stopWorkers(): Promise<number> {
		let n = 0;
		await Promise.all(
			[...this.procs.values()].map(async (p) => {
				n += await p.stop().catch(() => 0);
			}),
		);
		this.procs.clear();
		return n;
	}

	private checkBudget(): void {
		const t = this.task;
		if (!t?.budgetUsd || this.budgetHit) return;
		const cost = [...this.procs.values()].reduce((s, p) => s + p.cost, 0);
		if (cost <= t.budgetUsd) return;
		this.budgetHit = true;
		this.enqueue(async () => {
			await this.stopWorkers();
			this.d.deliver(
				`<budget>The workers have spent $${cost.toFixed(2)}, over the task budget of $${t.budgetUsd!.toFixed(2)}; they are stopped. Call rsa_finish, or rsa_steer a worker to continue it.</budget>\n\n${this.stamp()}`,
				{ task: t.id, reports: [] },
			);
		});
	}

	// ---- reports and integration -----------------------------------------------------------

	private async onReport(name: string, r: WorkerReport): Promise<void> {
		const id = this.taskId;
		if (!id) return;
		const w = this.d.store.worker(id, name);
		let commit: string | undefined;
		if (w?.tree && existsSync(w.tree)) commit = await commitTree(w.tree, `${name}: ${r.summary.split("\n")[0].slice(0, 120) || r.kind}`, this.d.setup);
		this.d.store.append({ type: "worker.reported", task: id, actor: "worker", data: { worker: name, ...r, commit } });
		await this.deliverPending();
	}

	private async deliverPending(): Promise<void> {
		const id = this.taskId;
		if (!id) return;
		const reports = this.d.store.pendingReports(id);
		if (!reports.length) return;
		const parts = reports.map((r) => {
			const ev = r.evidence.map((e) => `- ${e.type}: ${e.ref}`).join("\n");
			const asks = r.asks.map((a) => `- ${a}`).join("\n");
			return `<report worker="${r.worker}" kind="${r.kind}"${r.commit ? ` commit="${r.commit.slice(0, 9)}"` : ""}>\n${r.summary}${ev ? `\nevidence:\n${ev}` : ""}${asks ? `\nasks:\n${asks}` : ""}\n</report>`;
		});
		const ws = this.d.store.workers(id);
		const allDone = ws.every((w) => w.state === "merged" || (w.state === "reported" && w.lastReport?.kind === "done"));
		if (allDone && ws.some((w) => w.state === "reported")) parts.push(await this.integrate());
		else {
			const working = ws.filter((w) => w.state === "starting" || w.state === "working").map((w) => w.name);
			if (working.length) parts.push(`${working.join(", ")} still working.`);
		}
		this.d.deliver(`${parts.join("\n\n")}\n\n${this.stamp()}`, { task: id, reports: reports.map((r) => r.seq) });
		this.d.store.claimReports(
			reports.map((r) => r.seq),
			"orchestrator",
		);
	}

	private async integrate(): Promise<string> {
		const id = this.taskId!;
		const store = this.d.store;
		const t = this.task!;
		const ws = store.workers(id);
		store.append({ type: "task.integrating", task: id, actor: "runtime" });
		const commits = ws.map((w) => w.commit ?? t.base);
		const m = await mergeCommits(this.d.root, t.base, commits);
		if (!m.ok) {
			const later = ws.find((w) => w.commit === m.between[1]) ?? ws[ws.length - 1];
			const earlier = ws.filter((w) => w !== later);
			store.append({ type: "worker.merge_conflict", task: id, actor: "runtime", data: { worker: later.name, commit: later.commit, files: m.conflicts } });
			return `<merge>Merging ${later.name}'s work with ${earlier.map((w) => w.name).join(", ")} conflicts in: ${m.conflicts.join(", ")}. Nothing new was applied to the working tree. To resolve it, steer ${later.name} to run \`git merge ${earlier.map((w) => w.commit!.slice(0, 12)).join(" ")}\` in its own tree, fix the conflict there and report done again.</merge>`;
		}
		const from = t.landed ?? `${t.base}^{tree}`;
		const l = await land(this.d.root, from, m.tree);
		if (!l.ok) return `<merge>The workers' work merged cleanly, but applying it to the working tree failed (were files changed meanwhile?):\n${l.error}\nThe merged result is commit ${m.commit}.</merge>`;
		store.tx(() => {
			store.append({ type: "task.landed", task: id, actor: "runtime", data: { tree: m.tree, files: l.files } });
			for (const w of ws) if (w.state === "reported") store.append({ type: "worker.merged", task: id, actor: "runtime", data: { worker: w.name, commit: w.commit } });
		});
		const shown = l.files.slice(0, 30).join(", ") + (l.files.length > 30 ? `, … (${l.files.length - 30} more)` : "");
		const merge = `<merge>All workers are done. Their work is merged and applied to the working tree: ${l.files.length} file(s) changed${l.files.length ? `: ${shown}` : ""}.</merge>`;
		const check = await this.runChecks();
		return `${merge}${check ? `\n${check}` : ""}\nCheck further only as needed, then call rsa_finish, or rsa_steer the worker whose paths contain a problem.`;
	}

	private async execChecks(commands: string[]): Promise<CheckRun[]> {
		const out: CheckRun[] = [];
		for (const command of commands) {
			const r = await sh(command, { cwd: this.d.root, timeoutSec: this.d.checkTimeoutSec ?? 1200, keep: 400_000 });
			out.push({ command, code: r.timedOut ? null : r.code, ms: r.ms, output: r.tail });
		}
		return out;
	}

	private async runChecks(): Promise<string> {
		const t = this.task!;
		if (!t.check.length) return "";
		const base = this.baseChecks ? await this.baseChecks.catch(() => undefined) : undefined;
		this.baseChecks = undefined;
		const after = await this.execChecks(t.check);
		this.d.store.append({
			type: "task.checked",
			task: t.id,
			actor: "runtime",
			data: { results: after.map((r) => ({ command: r.command, code: r.code, ms: r.ms })), base: base?.map((r) => ({ command: r.command, code: r.code, ms: r.ms })) },
		});
		return `<check>\n${after.map((r) => describeCheck(r, base?.find((b) => b.command === r.command))).join("\n")}\n</check>`;
	}

}

export interface CheckRun {
	command: string;
	/** null: timed out. */
	code: number | null;
	ms: number;
	output: string;
}

/** Output lines that name failures, normalised (timings removed) so runs can be compared. */
export function failureLines(output: string): string[] {
	const re = /\b(FAIL|FAILED|failed|failing|not ok|error|Error|panicked)\b|✖|✗|×/;
	return [
		...new Set(
			output
				.split(/\r?\n/)
				.filter((l) => re.test(l))
				.map((l) =>
					l
						.replace(/\x1b\[[0-9;]*m/g, "")
						.replace(/\(?\d+(\.\d+)?\s?(ms|s)\)?/g, "")
						.replace(/\s+/g, " ")
						.trim(),
				)
				.filter(Boolean),
		),
	];
}

/** One check's line for the orchestrator, against the same command's run on the base. */
export function describeCheck(after: CheckRun, base?: CheckRun): string {
	const status = (r: CheckRun) => (r.code === null ? "timed out" : `exit ${r.code}`);
	const head = `$ ${after.command} → ${status(after)} (${Math.round(after.ms / 1000)} s)`;
	if (after.code === 0) return `${head}${base && base.code !== 0 ? ", fixed: it failed on the base" : ""}`;
	const tail = (o: string) => o.trimEnd().split("\n").slice(-CHECK_TAIL_LINES).join("\n");
	if (!base) return `${head}\n${tail(after.output)}`;
	if (base.code === 0) return `${head}; it passed on the base, so the workers' changes broke it:\n${tail(after.output)}`;
	const before = new Set(failureLines(base.output));
	const fresh = failureLines(after.output).filter((l) => !before.has(l));
	if (!fresh.length) return `${head}; it failed the same way on the base (${status(base)}) before the workers' changes, with no new failure lines. These failures are not caused by the task; no need to investigate them.`;
	return `${head}; it also failed on the base (${status(base)}). Failure lines that are new since the base:\n${fresh.slice(0, CHECK_TAIL_LINES).join("\n")}`;
}

function hasSession(dir?: string): boolean {
	if (!dir || !existsSync(dir)) return false;
	return readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith(".jsonl"));
}

/** Report seqs already delivered into a session, from its custom messages. */
export function deliveredSeqs(entries: Iterable<{ type?: string; customType?: string; details?: unknown }>): number[] {
	const out: number[] = [];
	for (const e of entries) {
		if (e.type !== "custom_message" || e.customType !== "rsa-report") continue;
		const r = (e.details as { reports?: unknown })?.reports;
		if (Array.isArray(r)) for (const s of r) if (typeof s === "number") out.push(s);
	}
	return out;
}

export type { Worker };
