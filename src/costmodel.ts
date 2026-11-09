/**
 * Cost model of design doc §15.1 (route R0.0.6), single-session part.
 *
 * A session of n model calls costs
 *   C ≈ r·Σ Rᵢ + w·Σ Δᵢ + o·Σ Oᵢ + h·n,   Rᵢ ≈ P + g·(i − 1)   ⇒   r·(n·P + g·n(n−1)/2) + …
 * where Rᵢ is the cached prefix read by call i (P: the prefix at the first call, g: its net growth per
 * call after realctx drops), Δᵢ new tokens (input + cache write), Oᵢ output, and h the cost of
 * realctx's own model calls (historian, memory edits) per main call. Cold restarts add c·w·L̄; none
 * occurred in v0.0, so the term is kept but not fitted.
 */

/** USD per token. */
export interface Prices {
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

/** anthropic/claude-opus-5-5, recovered from v0.0 traces (5-minute cache writes). */
export const OPUS_5_5: Prices = { cacheRead: 0.2e-6, cacheWrite: 5e-6, output: 20e-6 };

/** One main-session model call, as in bench/meter.ts traces. */
export interface Call {
	cacheRead: number;
	delta: number;
	out: number;
	costUsd: number;
}

/** Parameters of one session, or the average of a task class. */
export interface SessionParams {
	/** Cached prefix at the first call (tokens). */
	P: number;
	/** Growth of the cached prefix per call (tokens). */
	g: number;
	/** Mean new tokens per call. */
	delta: number;
	/** Mean output tokens per call. */
	out: number;
	/** realctx's own cost per main call (USD). */
	h: number;
}

/** Least-squares line y = a + b·x. */
export function line(xs: number[], ys: number[]): { a: number; b: number } {
	const n = xs.length;
	if (n === 0) return { a: 0, b: 0 };
	const mx = xs.reduce((s, x) => s + x, 0) / n;
	const my = ys.reduce((s, y) => s + y, 0) / n;
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
	}
	const b = sxx ? sxy / sxx : 0;
	return { a: my - b * mx, b };
}

/** Parameters of one session from its calls. `realctxUsd` is the session's realctx cost. */
export function sessionParams(calls: Call[], realctxUsd = 0): SessionParams {
	const n = calls.length;
	const { a, b } = line(
		calls.map((_, i) => i),
		calls.map((c) => c.cacheRead),
	);
	return {
		P: a,
		g: b,
		delta: n ? calls.reduce((s, c) => s + c.delta, 0) / n : 0,
		out: n ? calls.reduce((s, c) => s + c.out, 0) / n : 0,
		h: n ? realctxUsd / n : 0,
	};
}

/** Predicted cost of a session of n calls. */
export function predict(p: SessionParams, n: number, prices: Prices = OPUS_5_5): number {
	const read = n * p.P + (p.g * n * (n - 1)) / 2;
	return prices.cacheRead * read + prices.cacheWrite * p.delta * n + prices.output * p.out * n + p.h * n;
}

/** One measured session for class fitting. */
export interface Sample {
	calls: Call[];
	realctxUsd: number;
}

/**
 * Class parameters from several sessions: P and g from one pooled line over all calls (each call's
 * index within its session against its cached prefix), Δ, O and h as per-call means over the pool.
 */
export function fitClass(samples: Sample[]): SessionParams {
	const xs: number[] = [];
	const ys: number[] = [];
	let calls = 0;
	let delta = 0;
	let out = 0;
	let realctx = 0;
	for (const s of samples) {
		s.calls.forEach((c, i) => {
			xs.push(i);
			ys.push(c.cacheRead);
			delta += c.delta;
			out += c.out;
		});
		calls += s.calls.length;
		realctx += s.realctxUsd;
	}
	const { a, b } = line(xs, ys);
	return { P: a, g: b, delta: calls ? delta / calls : 0, out: calls ? out / calls : 0, h: calls ? realctx / calls : 0 };
}

/** Relative error (predicted − actual) ÷ actual. */
export const relErr = (predicted: number, actual: number): number => (predicted - actual) / actual;
