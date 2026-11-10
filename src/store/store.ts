/**
 * State store (route R1.1; design §10–12, simplified per review 2026-11-10).
 *
 * One SQLite file (WAL). The `events` table is the source of truth; `tasks`, `workers` and
 * `reports` are projections updated by `reduce()` in the same transaction as the event, so a
 * crash never leaves an event without its projection. `rebuild()` replays all events into empty
 * projections; tests check that it reproduces the live state.
 *
 * A lease (`leases` table) names the one coordinator allowed to drive a project's tasks, so a
 * restarted `pi` can take over after the old lease expires.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;

export type TaskState = "running" | "integrating" | "done" | "failed" | "abandoned";
export type WorkerState = "starting" | "working" | "reported" | "merged" | "stopped";
export type ReportKind = "done" | "blocked" | "needs_decision" | "failed";

export interface Task {
	id: string;
	project: string;
	title: string;
	goal: string;
	state: TaskState;
	base: string;
	branch: string;
	createdAt: number;
	updatedAt: number;
	outcome?: string;
	summary?: string;
	/** Commands run by code on the merged result (route R1.5). */
	check: string[];
	budgetUsd?: number;
	/** Tree object last applied to the user's working tree (incremental landing). */
	landed?: string;
}

export interface Worker {
	task: string;
	name: string;
	state: WorkerState;
	paths: string[];
	goal: string;
	acceptance: string;
	brief: string;
	tree?: string;
	branch?: string;
	pid?: number;
	sessionDir?: string;
	commit?: string;
	merged?: string;
	lastReport?: { kind: ReportKind; summary: string; seq: number };
}

export interface Report {
	seq: number;
	task: string;
	worker: string;
	kind: ReportKind;
	summary: string;
	evidence: { type: string; ref: string }[];
	asks: string[];
	commit?: string;
	delivered: boolean;
}

/** The v0.1 event catalog. `data` shapes are documented per type. */
export type EventType =
	| "task.created" // { title, goal, base, branch, project, check, budgetUsd }
	| "worker.dispatched" // { worker, paths, goal, acceptance, brief }
	| "worker.started" // { worker, tree, branch, pid, sessionDir }
	| "worker.steered" // { worker, message }
	| "worker.reported" // { worker, kind, summary, evidence, asks, commit }
	| "worker.merged" // { worker, commit }
	| "worker.merge_conflict" // { worker, commit, files }
	| "worker.stopped" // { worker, reason }
	| "task.integrating" // {}
	| "task.landed" // { tree, files }
	| "task.checked" // { results: [{ command, code, ms }] }
	| "task.finished" // { outcome: "success" | "failure", summary }
	| "task.abandoned" // { reason }
	| "report.delivered"; // { report: seq }

export interface EventInput {
	type: EventType;
	task?: string;
	actor: string;
	data?: Record<string, unknown>;
	/** seq of the event that caused this one (idempotency, tracing). */
	causation?: number;
}

export interface Event extends Required<Omit<EventInput, "causation">> {
	seq: number;
	at: number;
	causation: number | null;
}

const MIGRATIONS: string[] = [
	// v1
	`CREATE TABLE events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		type TEXT NOT NULL,
		task TEXT,
		actor TEXT NOT NULL,
		data TEXT NOT NULL,
		causation INTEGER
	);
	CREATE INDEX events_task ON events(task, seq);
	CREATE INDEX events_type ON events(type);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
		state TEXT NOT NULL, base TEXT NOT NULL, branch TEXT NOT NULL,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, outcome TEXT, summary TEXT,
		landed TEXT, data TEXT NOT NULL DEFAULT '{}'
	);
	CREATE INDEX tasks_state ON tasks(project, state);
	CREATE TABLE workers (
		task TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL,
		PRIMARY KEY (task, name)
	);
	CREATE TABLE reports (
		seq INTEGER PRIMARY KEY, task TEXT NOT NULL, worker TEXT NOT NULL, kind TEXT NOT NULL,
		data TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX reports_pending ON reports(task, delivered);
	CREATE TABLE leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
	CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

const PROJECTIONS = ["tasks", "workers", "reports"];

export class StoreError extends Error {}

/** `t` + 8 base36 characters, as in the design (§12). */
export function newTaskId(): string {
	let s = "";
	for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 36).toString(36);
	return `t${s}`;
}

export class Store {
	readonly db: DatabaseSync;
	/** Listeners called after each committed event (same process). */
	private listeners = new Set<(e: Event) => void>();

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path, { timeout: 15_000 });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA busy_timeout = 15000");
		this.db.exec("PRAGMA foreign_keys = ON");
		try {
			this.migrate();
		} catch (e) {
			this.db.close(); // do not hold the file open (Windows locks it)
			throw e;
		}
	}

	close(): void {
		this.db.close();
	}

	schemaVersion(): number {
		try {
			const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
			return row ? Number(row.value) : 0;
		} catch {
			return 0;
		}
	}

	private migrate(): void {
		this.tx(() => {
			const v = this.schemaVersion();
			if (v > SCHEMA_VERSION) throw new StoreError(`state store schema v${v} is newer than this code (v${SCHEMA_VERSION}); update realsubagents`);
			for (let i = v; i < SCHEMA_VERSION; i++) this.db.exec(MIGRATIONS[i]);
			if (v < SCHEMA_VERSION)
				this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
		});
	}

	private depth = 0;
	/** Run `fn` in one IMMEDIATE transaction (nested calls join the outer one). */
	tx<T>(fn: () => T): T {
		if (this.depth > 0) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		this.depth++;
		try {
			const r = fn();
			this.db.exec("COMMIT");
			return r;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		} finally {
			this.depth--;
		}
	}

	onEvent(fn: (e: Event) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Append an event and update the projections in one transaction. */
	append(input: EventInput): Event {
		const e = this.tx(() => {
			const at = Date.now();
			const data = input.data ?? {};
			const r = this.db
				.prepare("INSERT INTO events(at, type, task, actor, data, causation) VALUES (?, ?, ?, ?, ?, ?)")
				.run(at, input.type, input.task ?? null, input.actor, JSON.stringify(data), input.causation ?? null);
			const ev: Event = { seq: Number(r.lastInsertRowid), at, type: input.type, task: input.task ?? "", actor: input.actor, data, causation: input.causation ?? null };
			this.reduce(ev);
			return ev;
		});
		for (const l of this.listeners) {
			try {
				l(e);
			} catch {
				// a listener never breaks the write path
			}
		}
		return e;
	}

	/** Events after `fromSeq`, optionally for one task. */
	events(fromSeq = 0, task?: string): Event[] {
		const rows = (
			task
				? this.db.prepare("SELECT * FROM events WHERE seq > ? AND task = ? ORDER BY seq").all(fromSeq, task)
				: this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq").all(fromSeq)
		) as Record<string, SQLInputValue>[];
		return rows.map((r) => ({
			seq: Number(r.seq),
			at: Number(r.at),
			type: r.type as EventType,
			task: (r.task as string) ?? "",
			actor: r.actor as string,
			data: JSON.parse(r.data as string),
			causation: r.causation === null ? null : Number(r.causation),
		}));
	}

	/** Replay every event into empty projections. */
	rebuild(): void {
		this.tx(() => {
			for (const t of PROJECTIONS) this.db.exec(`DELETE FROM ${t}`);
			for (const e of this.events(0)) this.reduce(e);
		});
	}

	// ---- projections -------------------------------------------------------------------

	private reduce(e: Event): void {
		const d = e.data as Record<string, any>;
		const touch = () => this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(e.at, e.task);
		const setTask = (state: TaskState) => this.db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(state, e.at, e.task);
		const worker = () => {
			const w = this.worker(e.task, String(d.worker));
			if (!w) throw new StoreError(`${e.type}: unknown worker ${d.worker} of task ${e.task}`);
			return w;
		};
		switch (e.type) {
			case "task.created":
				this.db
					.prepare("INSERT INTO tasks(id, project, title, goal, state, base, branch, created_at, updated_at, data) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
					.run(e.task, String(d.project ?? ""), String(d.title), String(d.goal ?? ""), String(d.base), String(d.branch), e.at, e.at, JSON.stringify({ check: d.check ?? [], budgetUsd: d.budgetUsd }));
				return;
			case "worker.dispatched": {
				const w: Worker = { task: e.task, name: String(d.worker), state: "starting", paths: d.paths ?? [], goal: d.goal ?? "", acceptance: d.acceptance ?? "", brief: d.brief ?? "" };
				const old = this.worker(e.task, w.name);
				// A re-dispatch to a live worker is a new instruction: keep its runtime fields.
				this.putWorker(old ? { ...old, paths: w.paths, goal: w.goal, acceptance: w.acceptance, brief: w.brief, state: old.state === "stopped" ? "starting" : old.state } : w);
				setTask("running");
				return;
			}
			case "worker.started":
				this.putWorker({ ...worker(), state: "working", tree: d.tree, branch: d.branch, pid: d.pid, sessionDir: d.sessionDir });
				touch();
				return;
			case "worker.steered":
				this.putWorker({ ...worker(), state: "working" });
				touch();
				return;
			case "worker.reported": {
				const w = worker();
				this.putWorker({ ...w, state: "reported", commit: d.commit ?? w.commit, lastReport: { kind: d.kind, summary: d.summary, seq: e.seq } });
				const report = { summary: d.summary, evidence: d.evidence ?? [], asks: d.asks ?? [], commit: d.commit };
				this.db.prepare("INSERT INTO reports(seq, task, worker, kind, data, delivered) VALUES (?, ?, ?, ?, ?, 0)").run(e.seq, e.task, w.name, d.kind, JSON.stringify(report));
				touch();
				return;
			}
			case "worker.merged":
				this.putWorker({ ...worker(), state: "merged", merged: d.commit });
				touch();
				return;
			case "worker.merge_conflict":
				touch();
				return;
			case "worker.stopped":
				this.putWorker({ ...worker(), state: "stopped", pid: undefined });
				touch();
				return;
			case "task.integrating":
				setTask("integrating");
				return;
			case "task.landed":
				this.db.prepare("UPDATE tasks SET landed = ?, updated_at = ? WHERE id = ?").run(String(d.tree), e.at, e.task);
				return;
			case "task.checked":
				touch();
				return;
			case "task.finished":
				this.db
					.prepare("UPDATE tasks SET state = ?, outcome = ?, summary = ?, updated_at = ? WHERE id = ?")
					.run(d.outcome === "success" ? "done" : "failed", String(d.outcome), String(d.summary ?? ""), e.at, e.task);
				return;
			case "task.abandoned":
				this.db.prepare("UPDATE tasks SET state = 'abandoned', summary = ?, updated_at = ? WHERE id = ?").run(String(d.reason ?? ""), e.at, e.task);
				return;
			case "report.delivered":
				this.db.prepare("UPDATE reports SET delivered = 1 WHERE seq = ?").run(Number(d.report));
				return;
		}
	}

	private putWorker(w: Worker): void {
		const { task, name, state, ...rest } = w;
		this.db
			.prepare("INSERT INTO workers(task, name, state, data) VALUES (?, ?, ?, ?) ON CONFLICT(task, name) DO UPDATE SET state = excluded.state, data = excluded.data")
			.run(task, name, state, JSON.stringify(rest));
	}

	// ---- queries -----------------------------------------------------------------------

	task(id: string): Task | undefined {
		const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any> | undefined;
		return r ? rowToTask(r) : undefined;
	}

	/** Tasks of a project, newest first; `open` = not in a terminal state. */
	tasks(project: string, open = false): Task[] {
		const rows = this.db
			.prepare(`SELECT * FROM tasks WHERE project = ? ${open ? "AND state IN ('running', 'integrating')" : ""} ORDER BY created_at DESC`)
			.all(project) as Record<string, any>[];
		return rows.map(rowToTask);
	}

	worker(task: string, name: string): Worker | undefined {
		const r = this.db.prepare("SELECT * FROM workers WHERE task = ? AND name = ?").get(task, name) as Record<string, any> | undefined;
		return r ? { task: r.task, name: r.name, state: r.state, ...JSON.parse(r.data) } : undefined;
	}

	workers(task: string): Worker[] {
		const rows = this.db.prepare("SELECT * FROM workers WHERE task = ? ORDER BY name").all(task) as Record<string, any>[];
		return rows.map((r) => ({ task: r.task, name: r.name, state: r.state, ...JSON.parse(r.data) }));
	}

	/** Reports not yet delivered to the orchestrator, oldest first. */
	pendingReports(task?: string): Report[] {
		const rows = (
			task
				? this.db.prepare("SELECT * FROM reports WHERE delivered = 0 AND task = ? ORDER BY seq").all(task)
				: this.db.prepare("SELECT * FROM reports WHERE delivered = 0 ORDER BY seq").all()
		) as Record<string, any>[];
		return rows.map((r) => ({ seq: r.seq, task: r.task, worker: r.worker, kind: r.kind, delivered: false, ...JSON.parse(r.data) }));
	}

	/**
	 * Mark reports delivered exactly once: returns only those this call flipped, so two
	 * concurrent deliverers never both send the same report.
	 */
	claimReports(seqs: number[], actor: string): number[] {
		return this.tx(() => {
			const won: number[] = [];
			for (const s of seqs) {
				const r = this.db.prepare("SELECT delivered FROM reports WHERE seq = ?").get(s) as { delivered: number } | undefined;
				if (!r || r.delivered) continue;
				this.append({ type: "report.delivered", task: (this.db.prepare("SELECT task FROM reports WHERE seq = ?").get(s) as { task: string }).task, actor, data: { report: s }, causation: s });
				won.push(s);
			}
			return won;
		});
	}

	// ---- leases ------------------------------------------------------------------------

	/** Take or renew a named lease. Returns false while another owner holds an unexpired one. */
	acquire(name: string, owner: string, ttlMs: number): boolean {
		return this.tx(() => {
			const now = Date.now();
			const r = this.db.prepare("SELECT owner, expires FROM leases WHERE name = ?").get(name) as { owner: string; expires: number } | undefined;
			if (r && r.owner !== owner && r.expires > now) return false;
			this.db.prepare("INSERT INTO leases(name, owner, expires) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires = excluded.expires").run(name, owner, now + ttlMs);
			return true;
		});
	}

	release(name: string, owner: string): void {
		this.db.prepare("DELETE FROM leases WHERE name = ? AND owner = ?").run(name, owner);
	}

	/** Snapshot of all projections, for replay tests. */
	snapshot(): Record<string, unknown[]> {
		const out: Record<string, unknown[]> = {};
		for (const t of PROJECTIONS) out[t] = this.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all();
		return out;
	}
}

function rowToTask(r: Record<string, any>): Task {
	const data = JSON.parse(r.data ?? "{}");
	return {
		check: data.check ?? [],
		...(data.budgetUsd ? { budgetUsd: data.budgetUsd } : {}),
		...(r.landed ? { landed: r.landed } : {}),
		id: r.id,
		project: r.project,
		title: r.title,
		goal: r.goal,
		state: r.state,
		base: r.base,
		branch: r.branch,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		...(r.outcome ? { outcome: r.outcome } : {}),
		...(r.summary ? { summary: r.summary } : {}),
	};
}
