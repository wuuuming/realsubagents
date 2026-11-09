/**
 * D-18 regression check: which tests failed in a full-suite run, compared with the baseline
 * failure list of the task's base commit.
 */
import { existsSync, readFileSync } from "node:fs";

/** `cargo test` text output: `test <name> ... FAILED`; a crate that does not compile is one failure `<compile>`. */
export function cargoFailures(output: string): Set<string> {
	const out = new Set<string>();
	for (const m of output.matchAll(/^test (\S+) \.\.\. FAILED\s*$/gm)) out.add(m[1]);
	if (/^error(\[E\d+\])?: could not compile/m.test(output)) out.add("<compile>");
	return out;
}

/** vitest `--reporter=json --outputFile=<file>` output: `<file relative to cwd>::<full name>` per failed test. */
export function vitestFailures(json: string, cwd = ""): Set<string> {
	const out = new Set<string>();
	const report = JSON.parse(json) as {
		testResults?: { name: string; status?: string; message?: string; assertionResults?: { fullName: string; status: string }[] }[];
	};
	const norm = (p: string) => p.replaceAll("\\", "/").replace(cwd.replaceAll("\\", "/").replace(/\/?$/, "/"), "");
	for (const f of report.testResults ?? []) {
		const failed = (f.assertionResults ?? []).filter((a) => a.status === "failed");
		for (const a of failed) out.add(`${norm(f.name)}::${a.fullName}`);
		if (!failed.length && f.status === "failed") out.add(`${norm(f.name)}::<suite>`);
	}
	return out;
}

/**
 * `node --test --test-reporter=tap` output: `Suite > test` per failed leaf test. Nesting comes from
 * `# Subtest:` lines (4 spaces per level); a failed parent whose failure is explained by a failed
 * child is dropped.
 */
export function nodeTapFailures(output: string): Set<string> {
	const stack: string[] = [];
	const failed: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		const sub = /^( *)# Subtest: (.*)$/.exec(line);
		if (sub) {
			const depth = sub[1].length / 4;
			stack.length = depth;
			stack[depth] = sub[2].trim().replaceAll("\\#", "#");
			continue;
		}
		const nok = /^( *)not ok \d+ - (.*?)(?: # .*)?$/.exec(line);
		if (nok) {
			const depth = nok[1].length / 4;
			failed.push([...stack.slice(0, depth), nok[2].trim().replaceAll("\\#", "#")].join(" > "));
		}
	}
	return new Set(failed.filter((f) => !failed.some((g) => g !== f && g.startsWith(`${f} > `))));
}

export function readList(file: string): Set<string> {
	if (!existsSync(file)) return new Set();
	return new Set(
		readFileSync(file, "utf8")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#")),
	);
}

export interface RegressionResult {
	/** New failures that passed on the re-run (D-18 flake rule); not counted. */
	flaky?: string[];
	failed: number;
	/** Failures not in the baseline list: the run broke these. */
	newFailures: string[];
	/** Baseline failures that now pass (informational). */
	fixed: string[];
	ok: boolean;
}

export function compare(failures: Set<string>, baseline: Set<string>): RegressionResult {
	const newFailures = [...failures].filter((f) => !baseline.has(f)).sort();
	const fixed = [...baseline].filter((f) => !failures.has(f)).sort();
	return { failed: failures.size, newFailures, fixed, ok: newFailures.length === 0 };
}
