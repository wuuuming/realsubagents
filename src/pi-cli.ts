/**
 * Locate the Pi CLI entry script, so child Pi processes can be started as `node <cli.js> ...`
 * directly: one process per subagent (not the launcher's two), no shell, works on Windows.
 *
 * Order: RSA_PI_CLI env override → the managed install (~/.pi/agent/install/current-version)
 * → the locally installed @earendil-works/pi-coding-agent package.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PKG = "@earendil-works/pi-coding-agent";

export interface PiCli {
	/** Absolute path to the CLI entry script. */
	cli: string;
	/** Pi version from the package's package.json. */
	version: string;
	/** Where it was found. */
	source: "env" | "managed" | "local";
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function fromPackageDir(packageDir: string, source: PiCli["source"]): PiCli | undefined {
	const pj = join(packageDir, "package.json");
	if (!existsSync(pj)) return undefined;
	const pkg = JSON.parse(readFileSync(pj, "utf8")) as { version: string; bin?: string | Record<string, string> };
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	if (!bin) return undefined;
	const cli = resolve(packageDir, bin);
	return existsSync(cli) ? { cli, version: pkg.version, source } : undefined;
}

export function findPiCli(env: NodeJS.ProcessEnv = process.env): PiCli {
	if (env.RSA_PI_CLI) {
		const cli = resolve(env.RSA_PI_CLI);
		if (!existsSync(cli)) throw new Error(`RSA_PI_CLI does not exist: ${cli}`);
		return { cli, version: "unknown", source: "env" };
	}
	const installRoot = join(agentDir(env), "install");
	const current = join(installRoot, "current-version");
	// RSA_PI_VERSION picks an installed managed release (the benchmark pins one, bench/pins.json).
	if (env.RSA_PI_VERSION) {
		const found = fromPackageDir(join(installRoot, "releases", env.RSA_PI_VERSION, "node_modules", ...PKG.split("/")), "managed");
		if (!found) throw new Error(`RSA_PI_VERSION=${env.RSA_PI_VERSION} is not installed under ${join(installRoot, "releases")}`);
		return found;
	}
	if (existsSync(current)) {
		const v = readFileSync(current, "utf8").trim();
		if (/^[0-9A-Za-z._+-]+$/.test(v) && v !== "." && v !== "..") {
			const found = fromPackageDir(join(installRoot, "releases", v, "node_modules", ...PKG.split("/")), "managed");
			if (found) return found;
		}
	}
	try {
		const req = createRequire(import.meta.url);
		const found = fromPackageDir(dirname(req.resolve(`${PKG}/package.json`)), "local");
		if (found) return found;
	} catch {
		// not installed locally
	}
	throw new Error("Pi CLI not found: set RSA_PI_CLI, or install Pi");
}

/** Environment for a child Pi process started directly (what the managed launcher would add). */
export function piChildEnv(pi: PiCli, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (pi.source !== "managed") return { ...env };
	return { ...env, PI_MANAGED_INSTALL_ROOT: join(agentDir(env), "install") };
}
