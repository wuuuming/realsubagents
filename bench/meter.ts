/**
 * R0.0.3 meter and R0.0.5 trace extraction: read Pi session files (format v3) and report what a
 * run cost, per role and per model, in USD from Pi's list prices (D-13) and in raw tokens.
 *
 * Sources of spend, all counted on every branch of the session tree:
 * - assistant messages (`message.usage`): the agent loop; bucket `<role>`
 * - `usage` entries (e.g. kind `cache_warm`): bucket `<role>:<kind>`
 * - `compaction` entries with `usage`: bucket `<role>:compaction`
 * - `custom` entries `rsa-usage` and the sidecar JSONL from extensions/rsa-bench-usage (U-10):
 *   extension model calls such as realctx's historian; bucket `<role>:<caller>`
 *
 * Usage: node bench/meter.ts <session.jsonl>[=role] ... [--sidecar <file>] [--out <file>] [--trace <file>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Bucket extends Tokens {
	costUsd: number;
	calls: number;
	/** Calls whose usage had no cost (model without a list price). */
	unpriced: number;
}

export interface TurnTrace {
	role: string;
	/** 1-based index of the model call within its session. */
	i: number;
	t: string;
	model: string;
	/** Context length the model saw: input + cacheRead + cacheWrite. */
	ctx: number;
	/** New (uncached) tokens Δ: input + cacheWrite. */
	delta: number;
	out: number;
	cacheRead: number;
	costUsd: number;
	/** Not the first call, yet less than half of the previous context was read from cache. */
	cold: boolean;
	/** A compaction happened since the previous call. */
	afterCompaction: boolean;
	stopReason?: string;
}

export interface MeterReport {
	sessions: { file: string; role: string; id?: string; cwd?: string }[];
	startedAt?: string;
	endedAt?: string;
	wallClockMs?: number;
	total: Bucket;
	byRole: Record<string, Bucket>;
	byModel: Record<string, Bucket>;
	/** cacheRead ÷ (input + cacheRead + cacheWrite), per role bucket (H-2). */
	cacheHitRate: Record<string, number>;
	/** Model calls of the agent loop (assistant messages) and user prompts, per role. */
	turns: Record<string, { modelCalls: number; userPrompts: number; errors: number }>;
	compactions: { role: string; t: string; tokensBefore?: number }[];
	coldRestarts: number;
	/** Extension model calls that failed (no usage recorded). */
	extensionCallErrors: number;
	trace: TurnTrace[];
}

interface RawUsage extends Partial<Tokens> {
	cost?: { total?: number };
}

const emptyBucket = (): Bucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0, unpriced: 0 });

function add(b: Bucket, u: RawUsage | undefined): void {
	b.calls++;
	if (!u) return;
	b.input += u.input ?? 0;
	b.output += u.output ?? 0;
	b.cacheRead += u.cacheRead ?? 0;
	b.cacheWrite += u.cacheWrite ?? 0;
	const c = u.cost?.total;
	if (typeof c === "number" && Number.isFinite(c)) b.costUsd += c;
	if (!c && (u.input || u.output || u.cacheRead || u.cacheWrite)) b.unpriced++;
}

export function readJsonl(file: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			out.push(JSON.parse(s));
		} catch {
			// A run killed mid-write leaves a partial last line; skip it.
		}
	}
	return out;
}

export interface MeterInput {
	file: string;
	role?: string;
}

export function meter(inputs: MeterInput[], sidecars: string[] = []): MeterReport {
	const r: MeterReport = {
		sessions: [],
		total: emptyBucket(),
		byRole: {},
		byModel: {},
		cacheHitRate: {},
		turns: {},
		compactions: [],
		coldRestarts: 0,
		extensionCallErrors: 0,
		trace: [],
	};
	let first = Infinity;
	let last = -Infinity;
	const seen = (t: unknown) => {
		const ms = typeof t === "number" ? t : Date.parse(String(t));
		if (Number.isFinite(ms)) {
			first = Math.min(first, ms);
			last = Math.max(last, ms);
		}
	};
	const charge = (bucket: string, model: string, u: RawUsage | undefined) => {
		add((r.byRole[bucket] ??= emptyBucket()), u);
		add((r.byModel[model] ??= emptyBucket()), u);
		add(r.total, u);
	};
	const extensionCall = (role: string, d: Record<string, unknown>) => {
		if (d.error && !d.usage) {
			r.extensionCallErrors++;
			return;
		}
		charge(`${role}:${String(d.caller ?? "extension")}`, `${d.provider}/${d.model}`, d.usage as RawUsage);
	};

	for (const { file, role = "main" } of inputs) {
		const entries = readJsonl(file);
		const head = entries.find((e) => e.type === "session");
		r.sessions.push({ file, role, id: head?.id as string | undefined, cwd: head?.cwd as string | undefined });
		const turns = (r.turns[role] ??= { modelCalls: 0, userPrompts: 0, errors: 0 });
		let i = 0;
		let prevCtx = 0;
		let compactedSince = false;
		for (const e of entries) {
			seen(e.timestamp);
			if (e.type === "message") {
				const m = e.message as Record<string, unknown>;
				if (m.role === "user") turns.userPrompts++;
				if (m.role !== "assistant") continue;
				const u = m.usage as RawUsage | undefined;
				const model = `${m.provider}/${m.model}`;
				charge(role, model, u);
				turns.modelCalls++;
				if (m.stopReason === "error" || m.stopReason === "aborted") turns.errors++;
				i++;
				const cacheRead = u?.cacheRead ?? 0;
				const delta = (u?.input ?? 0) + (u?.cacheWrite ?? 0);
				const ctx = cacheRead + delta;
				const cold = i > 1 && prevCtx > 0 && cacheRead < prevCtx / 2;
				if (cold) r.coldRestarts++;
				r.trace.push({
					role,
					i,
					t: String(e.timestamp),
					model,
					ctx,
					delta,
					out: u?.output ?? 0,
					cacheRead,
					costUsd: u?.cost?.total ?? 0,
					cold,
					afterCompaction: compactedSince,
					stopReason: m.stopReason as string | undefined,
				});
				if (ctx > 0) prevCtx = ctx;
				compactedSince = false;
			} else if (e.type === "usage") {
				charge(`${role}:${e.kind ?? "usage"}`, `${e.provider}/${e.model}`, e.usage as RawUsage);
			} else if (e.type === "compaction") {
				r.compactions.push({ role, t: String(e.timestamp), tokensBefore: e.tokensBefore as number | undefined });
				compactedSince = true;
				if (e.usage) charge(`${role}:compaction`, "compaction", e.usage as RawUsage);
			} else if (e.type === "custom" && e.customType === "rsa-usage") {
				extensionCall(role, e.data as Record<string, unknown>);
			}
		}
	}
	for (const file of sidecars) {
		if (!existsSync(file)) continue;
		for (const d of readJsonl(file)) {
			seen(d.ts);
			extensionCall(String(d.role ?? inputs[0]?.role ?? "main"), d);
		}
	}
	for (const [k, b] of Object.entries(r.byRole)) {
		const denom = b.input + b.cacheRead + b.cacheWrite;
		if (denom > 0) r.cacheHitRate[k] = b.cacheRead / denom;
	}
	if (Number.isFinite(first)) {
		r.startedAt = new Date(first).toISOString();
		r.endedAt = new Date(last).toISOString();
		r.wallClockMs = last - first;
	}
	return r;
}

function main(argv: string[]): void {
	const inputs: MeterInput[] = [];
	const sidecars: string[] = [];
	let out: string | undefined;
	let traceOut: string | undefined;
	for (let k = 0; k < argv.length; k++) {
		const a = argv[k];
		if (a === "--sidecar") sidecars.push(argv[++k]);
		else if (a === "--out") out = argv[++k];
		else if (a === "--trace") traceOut = argv[++k];
		else {
			const eq = a.lastIndexOf("=");
			inputs.push(eq > 2 ? { file: a.slice(0, eq), role: a.slice(eq + 1) } : { file: a });
		}
	}
	if (!inputs.length) {
		console.error("usage: node bench/meter.ts <session.jsonl>[=role] ... [--sidecar f] [--out f] [--trace f]");
		process.exit(2);
	}
	const report = meter(inputs, sidecars);
	if (traceOut) writeFileSync(traceOut, report.trace.map((t) => JSON.stringify(t)).join("\n") + "\n");
	const { trace, ...summary } = report;
	const json = JSON.stringify(traceOut ? summary : report, null, 2);
	if (out) writeFileSync(out, json + "\n");
	else console.log(json);
}

if (import.meta.main) main(process.argv.slice(2));
