/**
 * One worker: a `pi --mode rpc` child in its own tree (route R1.2; logic proven in bench/dryrun.ts).
 *
 * - A Report is the worker's `rsa_report` tool call, read from the RPC event stream. It counts only
 *   if it came after the last message sent to the worker, and it is handed over when the worker
 *   settles (the worker may still be finishing its turn when it calls the tool).
 * - A worker that settles without a Report is continued at most twice (Opus 5.5 guidance for
 *   unattended runs), then reported as failed.
 * - `say()` always passes `streamingBehavior: "steer"`; Pi ignores it when the worker is idle and
 *   starts a run, so there is no idle/busy race.
 * - `stop()` aborts, kills the worker's leftover processes (background tasks outlive Pi on
 *   Windows) and closes the client.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findPiCli } from "../pi-cli.ts";
import { RpcClient, type RpcRecord } from "../rpc.ts";
import { killLeftovers } from "./sh.ts";

export type ReportKind = "done" | "blocked" | "needs_decision" | "failed";

export interface WorkerReport {
	kind: ReportKind;
	summary: string;
	evidence: { type: string; ref: string }[];
	asks: string[];
}

export interface WorkerSpec {
	name: string;
	tree: string;
	sessionDir: string;
	model?: string;
	thinking?: string;
	/** Extension and other Pi arguments (the realsubagents extension included). */
	piArgs: string[];
	/** System-prompt files appended with --append-system-prompt (worker contract, overlays). */
	promptFiles: string[];
	env?: NodeJS.ProcessEnv;
	/** Continue the most recent session in `sessionDir` (resume after a coordinator restart). */
	resume?: boolean;
	stderrFile?: string;
}

export interface WorkerHandlers {
	onReport(r: WorkerReport): void;
	onCost?(usd: number): void;
	onExit?(code: number | null, signal: NodeJS.Signals | null): void;
	/** Appended to every message, e.g. "elapsed 42s" (Anthropic multiagent time signal). */
	stamp?(): string;
	log?(s: string): void;
}

export const MAX_CONTINUATIONS = 2;
const CONTINUE =
	"You ended your turn without calling rsa_report, so the orchestrator has not heard from you. Continue your part of the task. When it is done, blocked, needs a decision, or has failed, call rsa_report.";

export class WorkerProcess {
	readonly spec: WorkerSpec;
	private readonly h: WorkerHandlers;
	client?: RpcClient;
	busy = false;
	cost = 0;
	continuations = 0;
	private seq = 0;
	private lastInput = 0;
	private pending?: WorkerReport & { seq: number };
	private stopping = false;

	constructor(spec: WorkerSpec, handlers: WorkerHandlers) {
		this.spec = spec;
		this.h = handlers;
	}

	get pid(): number | undefined {
		return this.client?.child.pid;
	}

	get alive(): boolean {
		return !!this.client && this.client.child.exitCode === null && this.client.child.signalCode === null;
	}

	start(): void {
		const s = this.spec;
		mkdirSync(s.sessionDir, { recursive: true });
		if (s.stderrFile) {
			mkdirSync(dirname(s.stderrFile), { recursive: true });
			writeFileSync(s.stderrFile, "", { flag: "a" });
		}
		this.stopping = false;
		this.client = new RpcClient({
			cwd: s.tree,
			pi: findPiCli(),
			args: [
				"--session-dir",
				s.sessionDir,
				...(s.resume ? ["--continue"] : []),
				...s.piArgs,
				...s.promptFiles.flatMap((p) => ["--append-system-prompt", p]),
				...(s.model ? ["--model", s.model] : []),
				...(s.thinking ? ["--thinking", s.thinking] : []),
			],
			env: { ...process.env, ...s.env, RSA_ROLE: "worker" },
			onStderr: (t) => s.stderrFile && appendFileSync(s.stderrFile, t),
			onEvent: (e) => this.onEvent(e),
			onExit: (code, signal) => {
				this.busy = false;
				if (!this.stopping) this.h.onExit?.(code, signal);
			},
		});
	}

	/** Send a message: starts a run when idle, steers when running. */
	async say(text: string): Promise<void> {
		if (!this.alive) this.start();
		const stamp = this.h.stamp?.();
		const message = stamp ? `${text}\n\n${stamp}` : text;
		this.lastInput = ++this.seq;
		this.busy = true;
		const r = await this.client!.send({ type: "prompt", message, streamingBehavior: "steer" }, 120_000);
		if (!r.success) throw new Error(`${this.spec.name}: prompt rejected: ${JSON.stringify(r).slice(0, 400)}`);
	}

	/** A steer from the orchestrator resets the continuation count. */
	async steer(text: string): Promise<void> {
		this.continuations = 0;
		await this.say(`<steer>\n${text}\n</steer>`);
	}

	async stop(): Promise<number> {
		if (!this.client) return 0;
		this.stopping = true;
		const pid = this.client.child.pid;
		if (this.alive) await this.client.send({ type: "abort" }, 30_000).catch(() => {});
		let killed = killLeftovers(pid, this.spec.tree).length;
		await this.client.close(10_000).catch(() => {});
		killed += killLeftovers(undefined, this.spec.tree).length;
		this.busy = false;
		return killed;
	}

	private onEvent(e: RpcRecord): void {
		if (e.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(e.method))) {
			this.client!.write({ type: "extension_ui_response", id: e.id, cancelled: true } as RpcRecord);
		} else if (e.type === "message_end") {
			const m = e.message as { role?: string; usage?: { cost?: { total?: number } } };
			if (m?.role === "assistant") {
				const usd = m.usage?.cost?.total ?? 0;
				this.cost += usd;
				if (usd) this.h.onCost?.(usd);
			}
		} else if (e.type === "agent_start") {
			this.busy = true;
		} else if (e.type === "tool_execution_start" && e.toolName === "rsa_report") {
			const a = (e.args ?? {}) as Partial<WorkerReport>;
			this.pending = {
				kind: (a.kind as ReportKind) ?? "done",
				summary: String(a.summary ?? ""),
				evidence: Array.isArray(a.evidence) ? a.evidence : [],
				asks: Array.isArray(a.asks) ? a.asks : [],
				seq: ++this.seq,
			};
		} else if (e.type === "agent_settled") {
			this.busy = false;
			void this.onSettled().catch((err) => this.h.log?.(`${this.spec.name}: ${err}`));
		}
	}

	private async onSettled(): Promise<void> {
		if (this.stopping) return;
		const report = this.pending && this.pending.seq > this.lastInput ? this.pending : undefined;
		this.pending = undefined;
		if (report) {
			this.continuations = 0;
			const { seq: _seq, ...r } = report;
			this.h.onReport(r);
			return;
		}
		if (this.continuations < MAX_CONTINUATIONS) {
			this.continuations++;
			this.h.log?.(`${this.spec.name}: continue ${this.continuations}`);
			await this.say(CONTINUE);
			return;
		}
		this.h.onReport({ kind: "failed", summary: "The worker stopped twice without a Report.", evidence: [], asks: [] });
	}
}
