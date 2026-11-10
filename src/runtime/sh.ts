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

/**
 * Processes left behind by an agent run: descendants of `rootPid` (listed while it is still alive) and
 * any process whose command line or executable mentions `dir`. Pi's background tasks outlive Pi on
 * Windows (killing a parent does not kill its children), and would load the CPU during acceptance and
 * the next runs. Returns the killed PIDs.
 */
export function killLeftovers(rootPid: number | undefined, dir: string): number[] {
	if (process.platform !== "win32") {
		if (rootPid) killTree(rootPid);
		return [];
	}
	const back = dir.replace(/\//g, "\\").replace(/'/g, "''");
	const fwd = back.replace(/\\/g, "/");
	const ps = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath
$kill = New-Object System.Collections.Generic.HashSet[int]
$root = ${rootPid ?? -1}
$frontier = @($root)
while ($frontier.Count) { $next = @(); foreach ($p in $all) { if ($frontier -contains $p.ParentProcessId -and $kill.Add([int]$p.ProcessId)) { $next += $p.ProcessId } }; $frontier = $next }
foreach ($p in $all) { $c = "$($p.CommandLine)|$($p.ExecutablePath)"; if ($c.Contains('${back}') -or $c.Contains('${fwd}')) { [void]$kill.Add([int]$p.ProcessId) } }
[void]$kill.Remove($PID); [void]$kill.Remove(${process.pid}); [void]$kill.Remove($root)
foreach ($k in $kill) { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue; $k }`;
	const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
	return (r.stdout ?? "").split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
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
