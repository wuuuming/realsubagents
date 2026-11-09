/**
 * Phase spend ledger (D-21): sum of `costUsd` over agent-mode runs under the runs root.
 *
 *   node bench/ledger.ts [--runs D:/rsa-bench/runs]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LedgerRow {
	task: string;
	run: string;
	label: string;
	status: string;
	accepted: boolean | null;
	costUsd: number;
}

export function ledger(runsRoot: string): { rows: LedgerRow[]; totalUsd: number } {
	const rows: LedgerRow[] = [];
	if (existsSync(runsRoot)) {
		for (const task of readdirSync(runsRoot)) {
			const tdir = join(runsRoot, task);
			let runs: string[];
			try {
				runs = readdirSync(tdir);
			} catch {
				continue;
			}
			for (const run of runs) {
				const f = join(tdir, run, "result.json");
				if (!existsSync(f)) continue;
				const r = JSON.parse(readFileSync(f, "utf8"));
				if (r.mode !== "agent") continue;
				rows.push({ task, run, label: r.label, status: r.status, accepted: r.accepted, costUsd: r.costUsd ?? 0 });
			}
		}
	}
	return { rows, totalUsd: rows.reduce((a, r) => a + r.costUsd, 0) };
}

if (import.meta.main) {
	const i = process.argv.indexOf("--runs");
	const root = i > 0 ? process.argv[i + 1] : (process.env.RSA_RUNS ?? "D:/rsa-bench/runs");
	const { rows, totalUsd } = ledger(root);
	for (const r of rows) console.log(`${r.task}/${r.run}\t${r.label}\t${r.status}\t${r.accepted ? "✓" : "✗"}\t$${r.costUsd.toFixed(3)}`);
	console.log(`total\t$${totalUsd.toFixed(2)} over ${rows.length} runs`);
}
