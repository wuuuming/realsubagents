/**
 * Benchmark-only extension (route U-10 workaround, R0.0.3).
 *
 * Extensions call models through `ctx.modelRegistry.complete()` (realctx's historian and rewrites,
 * later our own judges). Pi does not record that usage in the session file, so a meter reading
 * only the session file under-counts. This extension wraps `ModelRegistry.prototype.complete`
 * and appends one custom entry per call:
 *
 *   {"type":"custom","customType":"rsa-usage","data":{caller, provider, model, usage, stopReason, durationMs}}
 *
 * Calls that finish after `session_shutdown`, or whose entry cannot be appended, go to the JSONL
 * file named by `RSA_USAGE_SIDECAR` instead (same record shape, one per line). Each record lands
 * in exactly one place; the meter reads both.
 *
 * Pi's own model calls (the agent loop: `streamSimple`; compaction: `completeSimple`) never go
 * through `ModelRegistry.complete`, so nothing is counted twice. Load it with `-e` in both
 * benchmark arms. Remove once Pi offers an extension API for usage entries (U-10).
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const USAGE_ENTRY = "rsa-usage";

export interface UsageRecord {
	caller: string;
	provider: string;
	model: string;
	usage?: unknown;
	stopReason?: string;
	error?: string;
	durationMs: number;
}

type Sink = (rec: UsageRecord) => void;
type CompleteFn = (this: unknown, model: { provider: string; id: string }, ...rest: unknown[]) => Promise<unknown>;

const STATE = Symbol.for("rsa-bench-usage");
interface GlobalState {
	sink?: Sink;
	patched: WeakSet<object>;
}
function state(): GlobalState {
	const g = globalThis as { [STATE]?: GlobalState };
	return (g[STATE] ??= { patched: new WeakSet() });
}

const KNOWN = ["realctx", "realtasks", "realsubagents"];

/** Which extension made the call: the innermost stack frame from a known package, skipping this extension's own frames. */
export function callerFromStack(stack: string | undefined): string {
	for (const raw of (stack ?? "").split("\n")) {
		const line = raw.replaceAll("\\", "/").toLowerCase();
		if (line.includes("/rsa-bench-usage/")) continue;
		const hit = KNOWN.find((name) => line.includes(`/${name}/`));
		if (hit) return hit;
	}
	return "extension";
}

/** Wrap `complete` on the given prototype once (idempotent). */
export function patchComplete(proto: { complete: CompleteFn }): void {
	const st = state();
	if (st.patched.has(proto)) return;
	st.patched.add(proto);
	const original = proto.complete;
	proto.complete = async function (this: unknown, model, ...rest) {
		const caller = callerFromStack(new Error().stack);
		const t0 = Date.now();
		const base = { caller, provider: model.provider, model: model.id };
		try {
			const res = (await original.call(this, model, ...rest)) as { usage?: unknown; stopReason?: string };
			st.sink?.({ ...base, usage: res?.usage, stopReason: res?.stopReason, durationMs: Date.now() - t0 });
			return res;
		} catch (err) {
			st.sink?.({ ...base, error: String((err as Error)?.message ?? err), durationMs: Date.now() - t0 });
			throw err;
		}
	};
}

function toSidecar(rec: UsageRecord): void {
	const file = process.env.RSA_USAGE_SIDECAR;
	if (!file) {
		process.stderr.write(`rsa-bench-usage: unrecorded usage (set RSA_USAGE_SIDECAR): ${JSON.stringify(rec)}\n`);
		return;
	}
	appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...rec })}\n`);
}

export default function (pi: ExtensionAPI) {
	let open = false;
	state().sink ??= toSidecar;
	pi.on("session_start", (_event, ctx) => {
		patchComplete(Object.getPrototypeOf(ctx.modelRegistry));
		open = true;
		state().sink = (rec) => {
			if (!open) return toSidecar(rec);
			try {
				pi.appendEntry(USAGE_ENTRY, rec);
			} catch {
				toSidecar(rec);
			}
		};
	});
	pi.on("session_shutdown", () => {
		open = false;
	});
}
