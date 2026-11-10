/**
 * Minimal Pi RPC client (docs: rpc.md). Strict LF framing (not readline: U+2028/2029 are valid
 * inside JSON strings), id-correlated responses, and an event stream for everything else.
 * Used by the smoke test and the benchmark runner; GroupRuntime "subprocess" builds on it later.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { findPiCli, type PiCli, piChildEnv } from "./pi-cli.ts";

export type RpcRecord = Record<string, unknown> & { type: string };

export interface RpcOptions {
	cwd: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	pi?: PiCli;
	/** Called for every stdout record that is not a command response. */
	onEvent?: (rec: RpcRecord) => void;
	onStderr?: (text: string) => void;
	/** Called once when the process exits (code, signal). */
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class RpcClient {
	readonly child: ChildProcess;
	private buf = "";
	private nextId = 1;
	private pending = new Map<string, { resolve: (r: RpcRecord) => void; reject: (e: Error) => void }>();
	private exited: Promise<number | null>;
	private readonly opts: RpcOptions;

	constructor(opts: RpcOptions) {
		this.opts = opts;
		const pi = opts.pi ?? findPiCli(opts.env);
		this.child = spawn(process.execPath, [pi.cli, "--mode", "rpc", ...opts.args], {
			cwd: opts.cwd,
			env: piChildEnv(pi, opts.env),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdout!.setEncoding("utf8");
		this.child.stdout!.on("data", (chunk: string) => this.onData(chunk));
		this.child.stderr!.setEncoding("utf8");
		this.child.stderr!.on("data", (t: string) => opts.onStderr?.(t));
		// Writing to a process that has died raises EPIPE on stdin. Without a listener that error
		// crashes the parent; the exit event and the pending-request rejections report it instead.
		this.child.stdin!.on("error", (e) => opts.onStderr?.(`[rpc stdin error] ${e.message}\n`));
		this.exited = new Promise((res) => {
			this.child.on("exit", (code, signal) => {
				opts.onExit?.(code, signal);
				for (const p of this.pending.values()) p.reject(new Error(`pi exited (${code}) before responding`));
				this.pending.clear();
				res(code);
			});
		});
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			let line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			let rec: RpcRecord;
			try {
				rec = JSON.parse(line) as RpcRecord;
			} catch {
				this.opts.onStderr?.(`[non-JSON stdout] ${line}\n`);
				continue;
			}
			const id = typeof rec.id === "string" ? rec.id : undefined;
			if (rec.type === "response" && id && this.pending.has(id)) {
				this.pending.get(id)!.resolve(rec);
				this.pending.delete(id);
			} else {
				this.opts.onEvent?.(rec);
			}
		}
	}

	/** Send a command and wait for its response record. */
	send(cmd: RpcRecord, timeoutMs = 30_000): Promise<RpcRecord> {
		const id = `c${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${cmd.type} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (r) => (clearTimeout(t), resolve(r)),
				reject: (e) => (clearTimeout(t), reject(e)),
			});
			if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.stdin!.writable) {
				this.pending.delete(id);
				clearTimeout(t);
				reject(new Error(`RPC ${cmd.type}: pi is not running (exit ${this.child.exitCode ?? this.child.signalCode})`));
				return;
			}
			this.child.stdin!.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	}

	/** Write a record that has no response (e.g. extension_ui_response). */
	write(rec: RpcRecord): void {
		if (this.child.stdin!.writable) this.child.stdin!.write(`${JSON.stringify(rec)}\n`);
	}

	async close(graceMs = 3000): Promise<number | null> {
		this.child.stdin!.end();
		const t = setTimeout(() => this.child.kill(), graceMs);
		const code = await this.exited;
		clearTimeout(t);
		return code;
	}
}
