/**
 * Run one subagent: a fresh `pi --mode json --no-session` child in the given directory. The task
 * goes in on stdin (no argv length limit, no `@file` expansion). The result is the text of the
 * child's last assistant message. Nothing persists: no session, no state, no reuse.
 */
import { spawn, spawnSync } from "node:child_process";
import { findPiCli, type PiCli, piChildEnv } from "./pi-cli.ts";

/** Set in every subagent's environment; the extension registers nothing there (no nesting). */
export const SUBAGENT_ENV = "RSA_SUBAGENT";

/** Appended to the subagent's system prompt. */
export const SUBAGENT_PROMPT = [
	"You are a subagent. Another agent delegated the task in the user message to you. It cannot see your work and cannot answer questions while you run, so complete the task on your own.",
	"Your final message is returned to that agent as the result: end with a concise report of what you did and found (files changed, commands run and their results, anything left open).",
].join(" ");

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface SubagentOptions {
	task: string;
	cwd: string;
	/** `provider/id`; default: Pi's default model. */
	model?: string;
	thinking?: string;
	signal?: AbortSignal;
	/** Called with a short line whenever the subagent starts a tool. */
	onActivity?: (line: string) => void;
	pi?: PiCli;
	env?: NodeJS.ProcessEnv;
}

export interface SubagentResult {
	ok: boolean;
	/** The subagent's final message (may be partial or empty when not ok). */
	output: string;
	error?: string;
	usage: Usage;
	turns: number;
	ms: number;
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsage(a: Usage, b: Partial<Usage> | undefined): void {
	if (!b) return;
	a.input += b.input ?? 0;
	a.output += b.output ?? 0;
	a.cacheRead += b.cacheRead ?? 0;
	a.cacheWrite += b.cacheWrite ?? 0;
	a.totalTokens += b.totalTokens ?? 0;
	for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) a.cost[k] += b.cost?.[k] ?? 0;
}

interface AssistantMessage {
	role: "assistant";
	content?: { type: string; text?: string; name?: string }[];
	stopReason?: string;
	errorMessage?: string;
	usage?: Partial<Usage>;
}

/** One-line description of a tool call for progress display. */
export function describeTool(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const arg = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url;
	const s = typeof arg === "string" ? arg.replace(/\s+/g, " ") : "";
	return s ? `${name} ${s.length > 80 ? `${s.slice(0, 77)}...` : s}` : name;
}

function killTree(pid: number): void {
	if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
	else
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// already gone
		}
}

export function runSubagent(o: SubagentOptions): Promise<SubagentResult> {
	const t0 = Date.now();
	const usage = emptyUsage();
	let turns = 0;
	let last: AssistantMessage | undefined;
	let stderr = "";
	let aborted = false;

	return new Promise((resolve) => {
		let pi: PiCli;
		try {
			pi = o.pi ?? findPiCli(o.env);
		} catch (e) {
			resolve({ ok: false, output: "", error: (e as Error).message, usage, turns, ms: 0 });
			return;
		}
		const args = [pi.cli, "--mode", "json", "--no-session", "--append-system-prompt", SUBAGENT_PROMPT];
		if (o.model) args.push("--model", o.model);
		if (o.thinking) args.push("--thinking", o.thinking);
		const child = spawn(process.execPath, args, {
			cwd: o.cwd,
			env: { ...piChildEnv(pi, o.env), [SUBAGENT_ENV]: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});

		const onAbort = () => {
			aborted = true;
			if (child.pid) killTree(child.pid);
		};
		if (o.signal?.aborted) onAbort();
		else o.signal?.addEventListener("abort", onAbort, { once: true });

		let buf = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			// LF-only framing: U+2028/2029 are valid inside JSON strings (so no readline).
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).replace(/\r$/, "");
				buf = buf.slice(nl + 1);
				if (line.trim()) onRecord(line);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (t: string) => {
			stderr = (stderr + t).slice(-4000);
		});
		child.stdin.on("error", () => {}); // a child that dies early closes stdin (EPIPE)
		child.stdin.end(o.task);

		function onRecord(line: string): void {
			let e: { type?: string; message?: AssistantMessage; toolName?: string; args?: unknown };
			try {
				e = JSON.parse(line);
			} catch {
				return;
			}
			if (e.type === "message_end" && e.message?.role === "assistant") {
				turns++;
				addUsage(usage, e.message.usage);
				last = e.message;
			} else if (e.type === "tool_execution_start" && e.toolName) {
				o.onActivity?.(describeTool(e.toolName, e.args));
			}
		}

		const finish = (code: number | null, spawnError?: Error) => {
			o.signal?.removeEventListener("abort", onAbort);
			const output = (last?.content ?? [])
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text)
				.join("\n")
				.trim();
			let error: string | undefined;
			if (aborted) error = "Aborted.";
			else if (spawnError) error = spawnError.message;
			else if (last?.stopReason === "error" || last?.stopReason === "aborted") error = last.errorMessage ?? `The subagent stopped (${last.stopReason}).`;
			else if (code !== 0) error = `The subagent's Pi exited with code ${code}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`;
			else if (!last) error = `The subagent produced no answer.${stderr.trim() ? `\n${stderr.trim()}` : ""}`;
			resolve({ ok: !error, output, error, usage, turns, ms: Date.now() - t0 });
		};
		child.on("error", (err) => finish(null, err));
		child.on("close", (code) => finish(code));
	});
}
