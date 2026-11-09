/** Run a bash command with a timeout that kills the whole process tree (Windows: taskkill /T). */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ShResult {
	code: number | null;
	timedOut: boolean;
	ms: number;
	/** Combined stdout + stderr, last `keep` characters. */
	tail: string;
}

let bashPath: string | undefined;
export function findBash(): string {
	if (bashPath) return bashPath;
	const candidates =
		process.platform === "win32"
			? [process.env.RSA_BASH, "C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"]
			: [process.env.RSA_BASH, "/bin/bash", "/usr/bin/bash"];
	bashPath = candidates.find((c): c is string => !!c && existsSync(c)) ?? "bash";
	return bashPath;
}

function killTree(pid: number): void {
	if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
	else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

export function sh(
	command: string,
	opts: { cwd: string; timeoutSec?: number; env?: NodeJS.ProcessEnv; keep?: number; onOutput?: (t: string) => void },
): Promise<ShResult> {
	const keep = opts.keep ?? 20_000;
	const t0 = Date.now();
	return new Promise((res) => {
		const child = spawn(findBash(), ["-c", command], {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		let tail = "";
		const onData = (b: Buffer) => {
			const t = b.toString("utf8");
			opts.onOutput?.(t);
			tail = (tail + t).slice(-keep);
		};
		child.stdout!.on("data", onData);
		child.stderr!.on("data", onData);
		let timedOut = false;
		const timer = opts.timeoutSec
			? setTimeout(() => {
					timedOut = true;
					if (child.pid) killTree(child.pid);
				}, opts.timeoutSec * 1000)
			: undefined;
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			res({ code, timedOut, ms: Date.now() - t0, tail });
		});
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			res({ code: -1, timedOut, ms: Date.now() - t0, tail: tail + String(err) });
		});
	});
}

/** sh() that throws on failure; returns trimmed output. */
export async function must(command: string, cwd: string, timeoutSec = 600): Promise<string> {
	const r = await sh(command, { cwd, timeoutSec });
	if (r.code !== 0) throw new Error(`command failed (${r.timedOut ? "timeout" : `exit ${r.code}`}): ${command}\n${r.tail.slice(-4000)}`);
	return r.tail.trim();
}
