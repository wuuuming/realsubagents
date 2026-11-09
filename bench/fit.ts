/**
 * R0.0.6: fit the §15.1 single-session cost model to the v0.0 baseline runs and measure H-1.
 *
 * node bench/fit.ts [--runs D:/rsa-bench/runs] [--json reports/bench/fit-v0.0.json]
 *
 * Uses every `<task>/baseline-<n>/` run with status ok (accepted or not: the model predicts cost).
 * 1. Linearity: R² of each run's cached prefix against its call index (the model assumes Rᵢ ≈ P + g·i).
 *    (Predicting a run from its own fitted parameters is exact by construction, so that is no test.)
 * 2. H-1 (route D-25): leave one task out. Its class's parameters are fitted on the other tasks of the
 *    class, then each held-out run is predicted at its measured n. A task's error compares its mean
 *    prediction with its mean measured cost. H-1 = median absolute task error; the gate is ≤ 15%.
 *    The same is reported for one pooled fit over all classes, and the aggregate error (sum of held-out
 *    predictions against measured spend, per class and overall) and the noise floor (within-task
 *    spread of repeated runs) are reported next to it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Call, fitClass, line, predict, relErr, type Sample, type SessionParams } from "../src/costmodel.ts";

interface Run extends Sample {
	task: string;
	label: string;
	n: number;
	dir: string;
	costUsd: number;
}

export function loadRuns(root: string): Run[] {
	const runs: Run[] = [];
	for (const task of readdirSync(root)) {
		const tdir = join(root, task);
		let entries: string[];
		try {
			entries = readdirSync(tdir).filter((d) => /^baseline-\d+$/.test(d));
		} catch {
			continue;
		}
		for (const d of entries) {
			const dir = join(tdir, d);
			if (!existsSync(join(dir, "result.json")) || !existsSync(join(dir, "trace.jsonl"))) continue;
			const res = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
			if (res.status !== "ok") continue;
			const meter = JSON.parse(readFileSync(join(dir, "meter.json"), "utf8"));
			const calls: Call[] = readFileSync(join(dir, "trace.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
				.filter((e) => e.role === "main");
			const main = meter.byRole?.main?.costUsd ?? 0;
			runs.push({ task, label: res.label, n: calls.length, dir, costUsd: meter.total.costUsd, calls, realctxUsd: meter.total.costUsd - main });
		}
	}
	return runs;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const round = (p: SessionParams) => ({ P: Math.round(p.P), g: Math.round(p.g), delta: Math.round(p.delta), out: Math.round(p.out), h: +p.h.toFixed(5) });

interface TaskErr {
	task: string;
	label: string;
	runs: number;
	actual: number;
	predicted: number;
	err: number;
}

function heldOut(runs: Run[], groupOf: (r: Run) => string): TaskErr[] {
	const out: TaskErr[] = [];
	for (const task of [...new Set(runs.map((r) => r.task))].sort()) {
		const mine = runs.filter((r) => r.task === task);
		const group = groupOf(mine[0]);
		const train = runs.filter((r) => r.task !== task && groupOf(r) === group);
		if (!train.length) continue;
		const p = fitClass(train);
		const actual = mean(mine.map((r) => r.costUsd));
		const predicted = mean(mine.map((r) => predict(p, r.n)));
		out.push({ task, label: mine[0].label, runs: mine.length, actual, predicted, err: relErr(predicted, actual) });
	}
	return out;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
	const runs = loadRuns(opt("--runs", process.env.RSA_RUNS ?? "D:/rsa-bench/runs"));
	const labels = [...new Set(runs.map((r) => r.label))].sort();

	// 1. Linearity of prefix growth.
	const r2 = runs.map((r) => {
		const y = r.calls.map((c) => c.cacheRead);
		const { a, b } = line(y.map((_, i) => i), y);
		const my = mean(y);
		const res = y.reduce((s, v, i) => s + (v - a - b * i) ** 2, 0);
		const tot = y.reduce((s, v) => s + (v - my) ** 2, 0);
		return tot ? 1 - res / tot : 1;
	});
	console.log(`## Prefix growth linearity, ${runs.length} runs`);
	console.log(`R² median ${median(r2).toFixed(3)}, min ${Math.min(...r2).toFixed(3)}\n`);

	// Class parameters on all data.
	const classes = Object.fromEntries(labels.map((l) => [l, round(fitClass(runs.filter((r) => r.label === l)))]));
	console.log("## Class parameters (all runs)");
	console.log("| class | runs | n (mean) | P | g | Δ/call | O/call | realctx $/call |\n|---|---|---|---|---|---|---|---|");
	for (const l of labels) {
		const rs = runs.filter((r) => r.label === l);
		const c = classes[l];
		console.log(`| ${l} | ${rs.length} | ${mean(rs.map((r) => r.n)).toFixed(0)} | ${c.P} | ${c.g} | ${c.delta} | ${c.out} | ${c.h} |`);
	}

	// 2. H-1.
	const byClass = heldOut(runs, (r) => r.label);
	const pooled = heldOut(runs, () => "all");
	const h1 = median(byClass.map((t) => Math.abs(t.err)));
	const h1p = median(pooled.map((t) => Math.abs(t.err)));
	console.log("\n## Held-out tasks (leave one task out)");
	console.log("| task | class | runs | measured $ | per-class fit $ | err | pooled fit $ | err |\n|---|---|---|---|---|---|---|---|");
	for (const t of byClass) {
		const p = pooled.find((x) => x.task === t.task)!;
		console.log(`| ${t.task} | ${t.label} | ${t.runs} | ${t.actual.toFixed(2)} | ${t.predicted.toFixed(2)} | ${pct(t.err)} | ${p.predicted.toFixed(2)} | ${pct(p.err)} |`);
	}
	const within = (xs: TaskErr[]) => xs.filter((t) => Math.abs(t.err) <= 0.15).length;
	const aggregate = (xs: TaskErr[]) => {
		const out: Record<string, number> = {};
		for (const l of [...labels, "all"]) {
			const sel = xs.filter((t) => l === "all" || t.label === l);
			out[l] = relErr(sel.reduce((s, t) => s + t.predicted * t.runs, 0), sel.reduce((s, t) => s + t.actual * t.runs, 0));
		}
		return out;
	};
	const agg = aggregate(byClass);
	const cv = [...new Set(runs.map((r) => r.task))].map((t) => {
		const c = runs.filter((r) => r.task === t).map((r) => r.costUsd);
		if (c.length < 2) return 0;
		const m = mean(c);
		return Math.sqrt(c.reduce((s, x) => s + (x - m) ** 2, 0) / (c.length - 1)) / m;
	});
	console.log(`\nH-1 per-class fit: median |err| ${pct(h1)}, ${within(byClass)}/${byClass.length} tasks within ±15% → ${h1 <= 0.15 ? "PASS" : "FAIL"}`);
	console.log(`H-1 pooled fit:    median |err| ${pct(h1p)}, ${within(pooled)}/${pooled.length} tasks within ±15%`);
	console.log(`Aggregate (per-class fit, held out): ${Object.entries(agg).map(([l, e]) => `${l} ${pct(e)}`).join(", ")}`);
	console.log(`Noise floor: median within-task cost spread (cv) ${pct(median(cv))}`);

	const json = opt("--json", "");
	if (json) {
		writeFileSync(
			json,
			JSON.stringify({ runs: runs.length, linearity: { medianR2: median(r2), minR2: Math.min(...r2) }, classes, heldOut: { perClass: byClass, pooled, h1, h1Pooled: h1p, aggregate: agg }, withinTaskCvMedian: median(cv) }, null, "\t") + "\n",
		);
		console.log(`\nwrote ${json}`);
	}
}
