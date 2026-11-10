/**
 * R.05.3–R.05.5: compare the rsa arm (v0.05 relay) with the single-session baseline, per task.
 *
 * node bench/compare.ts [--arm rsa|rsav1] [--runs D:/rsa-bench/runs] [--json reports/bench/002-dryrun.json]
 *
 * Per task: mean cost and wall time of `baseline-*` and `rsa-*` runs (status ok), acceptance counts,
 * and the ratios rsa ÷ baseline. G0.05: median cost ratio ≤ 0.80 or median time ratio ≤ 0.75.
 * Also per rsa run:
 * - H-3 serial fraction: share of the wall clock in which fewer than two workers were working
 *   (worker working = from its start or last relay message to its Report, from relay.json events).
 * - H-5 overhead share: orchestrator cost ÷ run cost (the orchestrator's brief, dispatch, Report
 *   handling and merge check are the §15.1 overhead terms; the workers' own Report writing is
 *   counted in worker cost and is small).
 * - R.05.4: worker sessions' P and g (cost model, src/costmodel.ts), against the baseline class.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Call, fitClass } from "../src/costmodel.ts";

interface Run {
	task: string;
	arm: string;
	n: number;
	dir: string;
	accepted: boolean | null;
	costUsd: number;
	wallMs: number;
	calls: (Call & { role: string })[];
	byRole: Record<string, { costUsd: number; calls: number }>;
	relay?: { events: { t: number; who: string; what: string }[]; merges: number; conflicts: number; finish?: { outcome: string } };
}

function load(root: string): Run[] {
	const out: Run[] = [];
	for (const task of readdirSync(root)) {
		let dirs: string[];
		try {
			dirs = readdirSync(join(root, task)).filter((d) => /^(baseline|rsa\w*)-\d+$/.test(d));
		} catch {
			continue;
		}
		for (const d of dirs) {
			const dir = join(root, task, d);
			if (!existsSync(join(dir, "result.json")) || !existsSync(join(dir, "meter.json"))) continue;
			const r = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
			if (r.status !== "ok") continue;
			const m = JSON.parse(readFileSync(join(dir, "meter.json"), "utf8"));
			const calls = existsSync(join(dir, "trace.jsonl"))
				? readFileSync(join(dir, "trace.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
				: [];
			out.push({
				task,
				arm: d.split("-")[0],
				n: Number(d.split("-")[1]),
				dir,
				accepted: r.accepted,
				costUsd: r.costUsd,
				wallMs: r.wallClockMs,
				calls,
				byRole: m.byRole ?? {},
				relay: existsSync(join(dir, "relay.json")) ? JSON.parse(readFileSync(join(dir, "relay.json"), "utf8")) : undefined,
			});
		}
	}
	return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : Number.NaN);
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** Share of the run's wall clock in which fewer than two workers were working. */
export function serialFraction(events: { t: number; who: string; what: string }[], wallMs: number): number {
	const busy: Record<string, [number, number][]> = { w1: [], w2: [] };
	const open: Record<string, number | undefined> = {};
	for (const e of events) {
		// Work (re)starts: worker start, relay continuation, orchestrator steer or re-dispatch to it.
		const target = e.who === "orch" ? /^(steer|dispatch) (w[12])$/.exec(e.what)?.[2] : e.who;
		if (!target || !(target in busy)) continue;
		const starts = e.who === "orch" ? busy[target].length > 0 || e.what.startsWith("steer") : e.what === "start" || e.what.startsWith("continue");
		if (starts) open[target] ??= e.t;
		else if (e.who !== "orch" && /^(report|exit)/.test(e.what) && open[target] !== undefined) {
			busy[target].push([open[target]!, e.t]);
			open[target] = undefined;
		}
	}
	for (const w of Object.keys(busy)) if (open[w] !== undefined) busy[w].push([open[w]!, wallMs]);
	let both = 0;
	for (const [a0, a1] of busy.w1) for (const [b0, b1] of busy.w2) both += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
	return wallMs ? 1 - both / wallMs : 1;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
	const ARM = opt("--arm", "rsa");
	const runs = load(opt("--runs", process.env.RSA_RUNS ?? "D:/rsa-bench/runs"));
	const tasks = [...new Set(runs.filter((r) => r.arm === ARM).map((r) => r.task))].sort();

	console.log("| task | baseline runs (acc) | rsa runs (acc) | baseline $ | rsa $ | cost ratio | baseline min | rsa min | time ratio |");
	console.log("|---|---|---|---|---|---|---|---|---|");
	const rows = tasks.map((task) => {
		const b = runs.filter((r) => r.task === task && r.arm === "baseline");
		const s = runs.filter((r) => r.task === task && r.arm === ARM);
		const row = {
			task,
			baseline: { runs: b.length, accepted: b.filter((r) => r.accepted).length, cost: mean(b.map((r) => r.costUsd)), wallMin: mean(b.map((r) => r.wallMs)) / 60000 },
			rsa: { runs: s.length, accepted: s.filter((r) => r.accepted).length, cost: mean(s.map((r) => r.costUsd)), wallMin: mean(s.map((r) => r.wallMs)) / 60000 },
			costRatio: 0,
			timeRatio: 0,
		};
		row.costRatio = row.rsa.cost / row.baseline.cost;
		row.timeRatio = row.rsa.wallMin / row.baseline.wallMin;
		console.log(
			`| ${task} | ${b.length} (${row.baseline.accepted}) | ${s.length} (${row.rsa.accepted}) | ${row.baseline.cost.toFixed(2)} | ${row.rsa.cost.toFixed(2)} | ${pct(row.costRatio)} | ${row.baseline.wallMin.toFixed(1)} | ${row.rsa.wallMin.toFixed(1)} | ${pct(row.timeRatio)} |`,
		);
		return row;
	});
	const mc = median(rows.map((r) => r.costRatio));
	const mt = median(rows.map((r) => r.timeRatio));
	const pass = mc <= 0.8 || mt <= 0.75;
	console.log(`\nG0.05: median cost ratio ${pct(mc)} (≤ 80%), median time ratio ${pct(mt)} (≤ 75%) → ${pass ? "GO" : "NO-GO"}`);

	const rsa = runs.filter((r) => r.arm === ARM);
	const per = rsa.map((r) => ({
		run: `${r.task}/${r.arm}-${r.n}`,
		accepted: r.accepted,
		serial: r.relay ? serialFraction(r.relay.events, r.wallMs) : Number.NaN,
		overhead: (r.byRole.orch?.costUsd ?? 0) / r.costUsd,
		merges: r.relay?.merges ?? 0,
		conflicts: r.relay?.conflicts ?? 0,
		steers: r.relay?.events.filter((e) => /^steer/.test(e.what)).length ?? 0,
		continuations: r.relay?.events.filter((e) => /^continue/.test(e.what)).length ?? 0,
	}));
	console.log("\n| run | accepted | serial fraction | orch share | merges | conflicts | steers | continuations |\n|---|---|---|---|---|---|---|---|");
	for (const p of per) console.log(`| ${p.run} | ${p.accepted} | ${pct(p.serial)} | ${pct(p.overhead)} | ${p.merges} | ${p.conflicts} | ${p.steers} | ${p.continuations} |`);
	const h3 = median(per.map((p) => p.serial));
	const h5 = median(per.map((p) => p.overhead));
	console.log(`\nH-3 serial fraction median ${pct(h3)} (< 25%); H-5 overhead share median ${pct(h5)} (≤ 15%)`);

	// R.05.4: worker and orchestrator session shape vs the baseline class.
	const sessions = (arm: string, roles: string[]) =>
		runs
			.filter((r) => r.arm === arm && tasks.includes(r.task))
			.flatMap((r) => roles.map((role) => ({ calls: r.calls.filter((c) => c.role === role), realctxUsd: 0 })))
			.filter((s) => s.calls.length);
	const shape = (label: string, ss: { calls: Call[]; realctxUsd: number }[]) => {
		const p = fitClass(ss);
		const n = mean(ss.map((s) => s.calls.length));
		console.log(`| ${label} | ${ss.length} | ${n.toFixed(0)} | ${Math.round(p.P)} | ${Math.round(p.g)} | ${Math.round(p.delta)} | ${Math.round(p.out)} |`);
		return { sessions: ss.length, n, P: p.P, g: p.g, delta: p.delta, out: p.out };
	};
	console.log("\n| sessions | count | n (mean) | P | g | Δ/call | O/call |\n|---|---|---|---|---|---|---|");
	const fit = {
		baseline: shape("baseline (same tasks)", sessions("baseline", ["main"])),
		worker: shape("rsa worker", sessions(ARM, ["w1", "w2"])),
		orchestrator: shape("rsa orchestrator", sessions(ARM, ["orch"])),
	};

	const json = opt("--json", "");
	if (json) {
		writeFileSync(json, JSON.stringify({ rows, g005: { medianCostRatio: mc, medianTimeRatio: mt, pass }, runs: per, h3, h5, fit }, null, "\t") + "\n");
		console.log(`\nwrote ${json}`);
	}
}
