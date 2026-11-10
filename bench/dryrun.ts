/**
 * v0.05 manual dry run (route R.05.2, design §17.2 step 2): one orchestrator session and two worker
 * sessions, each a plain `pi --mode rpc` in its own worktree, with the hand-written prompts of
 * `prompts/v0/`. The relay is deterministic code and calls no model.
 *
 *   node bench/run.ts <task> --arm rsa --n <n> [--cap-usd ..] [--wall-min ..]
 *
 * - The orchestrator runs in the run's main tree (the integration tree) without edit/write tools.
 *   Its first message is the task prompt. Its rsa_dispatch calls start the workers (both at once
 *   when it dispatches both in one turn).
 * - Each worker runs in its own worktree at the task's base. When it calls rsa_report, the relay
 *   commits its tree (excluding harness files) and delivers the Report to the orchestrator. When
 *   every dispatched worker's latest Report is done, the relay merges their commits into the
 *   integration tree and adds the result to the same message.
 * - A worker that ends its turn without rsa_report is continued at most twice (Opus 5.5 guidance on
 *   unattended runs), then reported as failed. rsa_steer goes to the worker as a steer while it
 *   runs, or as a new prompt when it is idle. Every relay message ends with `elapsed Ns`.
 * - The run ends when the orchestrator calls rsa_finish and settles, at the cost cap or wall limit,
 *   or when everyone is idle and two nudges to the orchestrator change nothing (stalled).
 *   The integration tree is then reset (mixed) to the base, so acceptance sees the merged change
 *   as a working-tree diff, exactly like a baseline run.
 *
 * Time is the wall clock from the orchestrator's first prompt to the end. The relay's own latency
 * (git commit and merge) is included; it is a few seconds per Report.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPiCli } from "../src/pi-cli.ts";
import { RpcClient, type RpcRecord } from "../src/rpc.ts";
import { meter } from "./meter.ts";
import {
	AGENT_DIR,
	DIFF_EXCLUDE,
	EXTENSIONS,
	prepareTree,
	REALCTX_MODEL,
	realctxRunConfig,
	removeTree,
	ROOT,
	type RunOptions,
	type RunResult,
} from "./run.ts";
import { killLeftovers, must, sh } from "./sh.ts";
import type { LoadedTask, RepoDef } from "./task.ts";

const PROMPTS = join(ROOT, "prompts", "v0");
const RELAY_EXT = join(ROOT, "extensions", "rsa-relay-tools", "index.ts");
const GIT_ID = "-c user.name=rsa-relay -c user.email=relay@rsa.local -c commit.gpgsign=false";
const MAX_CONTINUATIONS = 2;
const MAX_NUDGES = 2;

type Role = "orch" | "w1" | "w2";
type WorkerId = "w1" | "w2";
const WORKERS: WorkerId[] = ["w1", "w2"];

interface Dispatch {
	worker: WorkerId;
	goal: string;
	acceptance: string;
	paths: string[];
	brief: string;
}
interface Report {
	kind: "done" | "blocked" | "needs_decision" | "failed";
	summary: string;
	evidence?: { type: string; ref: string }[];
	asks?: string[];
}

interface Agent {
	role: Role;
	tree: string;
	client?: RpcClient;
	busy: boolean;
	cost: number;
	/** Sequence number of the last message sent to this agent. */
	lastInput: number;
	/** Report captured from rsa_report, with the sequence number at which it was captured. */
	pending?: Report & { seq: number };
	continuations: number;
	dispatch?: Dispatch;
	commit?: string;
	merged?: string;
	last?: Report & { commit: string };
}

export interface RelayLog {
	workerSetupMs: number;
	events: { t: number; who: string; what: string; detail?: unknown }[];
	finish?: { outcome: string; summary: string };
	stalled?: boolean;
	merges: number;
	conflicts: number;
}

export async function relayRun(
	task: LoadedTask,
	repo: RepoDef,
	o: RunOptions,
	runDir: string,
	tree: string,
	res: RunResult,
	log: (s: string) => void,
): Promise<void> {
	const relay: RelayLog = { workerSetupMs: 0, events: [], merges: 0, conflicts: 0 };
	(res as RunResult & { relay: RelayLog }).relay = relay;
	const agents: Record<Role, Agent> = {
		orch: { role: "orch", tree, busy: false, cost: 0, lastInput: 0, continuations: 0 },
		w1: { role: "w1", tree: join(runDir, "w1"), busy: false, cost: 0, lastInput: 0, continuations: 0 },
		w2: { role: "w2", tree: join(runDir, "w2"), busy: false, cost: 0, lastInput: 0, continuations: 0 },
	};
	const orch = agents.orch;

	// Worker trees: same base, same seeding and prepare steps as the main tree. Not timed.
	const s0 = Date.now();
	await Promise.all(WORKERS.map((w) => prepareTree(task, repo, agents[w].tree, (s) => log(`[${w}] ${s}`))));
	relay.workerSetupMs = Date.now() - s0;

	const excludes = [...DIFF_EXCLUDE, ...(repo.setup?.link ?? []), ...(repo.setup?.copy ?? [])].map((p) => `':(exclude)${p}'`).join(" ");
	const user = (() => {
		const f = join(AGENT_DIR, "realctx", "config.json");
		return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
	})();
	const provider = o.model.split("/")[0];

	let seq = 0;
	let t0 = 0;
	let finished = false;
	let nudges = 0;
	let stopReason: "cap" | "timeout" | "stalled" | undefined;
	let fatal: Error | undefined;
	let resolveDone!: () => void;
	const done = new Promise<void>((r) => (resolveDone = r));
	const end = (why?: "cap" | "timeout" | "stalled", err?: Error) => {
		if (why) stopReason ??= why;
		if (err) fatal ??= err;
		resolveDone();
	};
	const elapsed = () => `elapsed ${t0 ? Math.round((Date.now() - t0) / 1000) : 0}s`;
	const note = (who: string, what: string, detail?: unknown) => {
		relay.events.push({ t: t0 ? Date.now() - t0 : 0, who, what, ...(detail === undefined ? {} : { detail }) });
		log(`[relay] ${who} ${what}`);
	};

	// All event handling runs through one queue, so git work and deliveries never interleave.
	let queue = Promise.resolve();
	const enqueue = (fn: () => Promise<void> | void) => {
		queue = queue.then(fn).catch((e) => end(undefined, e as Error));
	};

	/** Send a message; while the agent runs it is queued as a steer (workers) or follow-up (orchestrator). */
	const say = async (a: Agent, text: string) => {
		const message = `${text}\n\n${elapsed()}`;
		a.lastInput = ++seq;
		// Pi ignores streamingBehavior when the agent is idle (it starts a run), so always pass it.
		const behavior = a.role === "orch" ? "followUp" : "steer";
		a.busy = true;
		const r = await a.client!.send({ type: "prompt", message, streamingBehavior: behavior }, 120_000);
		if (!r.success) throw new Error(`${a.role}: prompt rejected: ${JSON.stringify(r).slice(0, 400)}`);
	};

	const totalCost = () => Object.values(agents).reduce((s, a) => s + a.cost, 0);

	const start = (a: Agent) => {
		const realctxHome = join(runDir, "realctx", a.role);
		mkdirSync(realctxHome, { recursive: true });
		writeFileSync(join(realctxHome, "config.json"), JSON.stringify(realctxRunConfig(user, o.model, REALCTX_MODEL), null, 2));
		const role = a.role === "orch" ? "orchestrator" : "worker";
		const prompts = [join(PROMPTS, `${role}.md`), join(PROMPTS, "overlays", `${provider}-${role}.md`)].filter(existsSync);
		let stderr = "";
		const client: RpcClient = new RpcClient({
			cwd: a.tree,
			pi: findPiCli(),
			args: [
				"--session-dir", join(runDir, "sessions", a.role),
				"--no-extensions",
				"-e", EXTENSIONS.realctx,
				"-e", EXTENSIONS.realtasks,
				"-e", EXTENSIONS.usage,
				"-e", RELAY_EXT,
				...prompts.flatMap((p) => ["--append-system-prompt", p]),
				...(a.role === "orch" ? ["--exclude-tools", "edit,write"] : []),
				"--model", o.model,
				"--thinking", o.thinking,
			],
			env: {
				...process.env,
				RSA_ROLE: role,
				REALCTX_HOME: realctxHome,
				RSA_USAGE_SIDECAR: join(runDir, `usage-sidecar-${a.role}.jsonl`),
			},
			onStderr: (t) => (stderr += t),
			onEvent: (e) => onEvent(a, e),
		});
		client.child.on("exit", (code) => {
			writeFileSync(join(runDir, `pi-stderr-${a.role}.log`), stderr);
			if (!stopping) end(undefined, new Error(`${a.role}: pi exited (${code})`));
		});
		a.client = client;
	};

	const onEvent = (a: Agent, e: RpcRecord) => {
		if (e.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(e.method))) {
			a.client!.write({ type: "extension_ui_response", id: e.id, cancelled: true } as RpcRecord);
		} else if (e.type === "message_end") {
			const m = e.message as { role?: string; usage?: { cost?: { total?: number } } };
			if (m?.role === "assistant") a.cost += m.usage?.cost?.total ?? 0;
			if (totalCost() > o.capUsd) end("cap");
		} else if (e.type === "agent_start") {
			a.busy = true;
		} else if (e.type === "tool_execution_start") {
			const name = String(e.toolName);
			const args = (e.args ?? {}) as Record<string, unknown>;
			if (a.role === "orch") {
				if (name === "rsa_dispatch") enqueue(() => onDispatch(args as unknown as Dispatch));
				else if (name === "rsa_steer") enqueue(() => onSteer(args.worker as WorkerId, String(args.message ?? "")));
				else if (name === "rsa_finish") {
					finished = true;
					relay.finish = { outcome: String(args.outcome), summary: String(args.summary ?? "") };
					note("orch", "finish", relay.finish);
				}
			} else if (name === "rsa_report") {
				a.pending = { ...(args as unknown as Report), seq: ++seq };
			}
		} else if (e.type === "agent_settled") {
			enqueue(() => onSettled(a));
		}
	};

	const onDispatch = async (d: Dispatch) => {
		const w = agents[d.worker];
		if (!w) return;
		note("orch", `dispatch ${d.worker}`, { paths: d.paths, goalChars: d.goal.length, briefChars: d.brief.length });
		if (w.client) {
			// Already running: a second dispatch is a new instruction.
			await say(w, renderDispatch(d));
			w.dispatch = d;
			return;
		}
		w.dispatch = d;
		if (WORKERS.every((id) => agents[id].dispatch)) await launch();
	};

	const launch = async () => {
		for (const id of WORKERS) {
			const w = agents[id];
			if (!w.dispatch || w.client) continue;
			start(w);
			note(id, "start");
			await say(w, renderDispatch(w.dispatch));
		}
	};

	const renderDispatch = (d: Dispatch) => {
		const other = agents[d.worker === "w1" ? "w2" : "w1"].dispatch;
		const others = other
			? `${other.worker} writes: ${other.paths.join(", ")}\nIts goal: ${other.goal}`
			: "The other worker has not been assigned yet.";
		return [
			`<task>\n${d.goal}\n</task>`,
			`<acceptance>\n${d.acceptance}\n</acceptance>`,
			`<brief>\n${d.brief}\n</brief>`,
			`<other_groups>\n${others}\n</other_groups>`,
			`<paths>\n${d.paths.join("\n")}\n</paths>`,
			`You are ${d.worker}. Write only inside the paths above. Call rsa_report when your part is done, blocked, needs a decision, or has failed.`,
		].join("\n\n");
	};

	const onSteer = async (id: WorkerId, message: string) => {
		const w = agents[id];
		note("orch", `steer ${id}`, { chars: message.length });
		if (!w?.client) {
			await say(orch, `<relay>${id} has not been dispatched; the steer was not delivered. Use rsa_dispatch first.</relay>`);
			return;
		}
		w.continuations = 0;
		await say(w, `<steer>\n${message}\n</steer>`);
	};

	const commitWorker = async (w: Agent, summary: string): Promise<string> => {
		await must(`git add -A -- . ${excludes}`, w.tree);
		const staged = await sh("git diff --cached --quiet", { cwd: w.tree });
		if (staged.code !== 0) {
			const msg = `${w.role}: ${summary.split("\n")[0].slice(0, 120)}`.replaceAll("'", "");
			await must(`git ${GIT_ID} commit -q --no-verify -m '${msg}'`, w.tree);
		}
		return (await must("git rev-parse HEAD", w.tree)).trim();
	};

	const filesChanged = async (from: string, to: string) =>
		(await sh(`git diff --name-only ${from} ${to}`, { cwd: tree })).tail.split("\n").filter(Boolean);

	/** Merge every worker commit not yet in the integration tree. Returns the message part for the orchestrator. */
	const mergeAll = async (): Promise<string> => {
		const lines: string[] = [];
		for (const id of WORKERS) {
			const w = agents[id];
			if (!w.commit || w.commit === w.merged) continue;
			const r = await sh(`git ${GIT_ID} merge --no-edit -q ${w.commit}`, { cwd: tree, timeoutSec: 300 });
			if (r.code === 0) {
				w.merged = w.commit;
				relay.merges++;
				lines.push(`Merged ${id} (${w.commit.slice(0, 9)}).`);
				continue;
			}
			const conflicted = (await sh("git diff --name-only --diff-filter=U", { cwd: tree })).tail.split("\n").filter(Boolean);
			await sh("git merge --abort", { cwd: tree });
			relay.conflicts++;
			const other = agents[id === "w1" ? "w2" : "w1"];
			lines.push(
				conflicted.length
					? `Merging ${id} (${w.commit.slice(0, 9)}) conflicts in: ${conflicted.join(", ")}. To resolve it, steer one worker to run \`git merge ${(other.commit ?? "").slice(0, 12)}\` (the other worker's commit) in its own tree and fix the conflict there; its next done Report is merged again.`
					: `Merging ${id} (${w.commit.slice(0, 9)}) failed: ${r.tail.trim().slice(-600)}`,
			);
			note("relay", `merge ${id} failed`, { conflicted });
		}
		const head = (await must("git rev-parse HEAD", tree)).trim();
		const files = await filesChanged(task.base, head);
		lines.push(`Your tree now contains the merged work: ${files.length} files changed from the base.`);
		return `<merge>\n${lines.join("\n")}\n</merge>\nCheck the merged tree, then call rsa_finish, or steer the worker whose paths contain a problem.`;
	};

	const onSettled = async (a: Agent) => {
		a.busy = false;
		if (stopReasonSet()) return;
		if (a.role === "orch") {
			if (finished) return end();
			if (WORKERS.some((id) => agents[id].dispatch && !agents[id].client)) return launch();
			const started = WORKERS.filter((id) => agents[id].client);
			if (!started.length || started.every((id) => !agents[id].busy)) {
				if (++nudges > MAX_NUDGES) {
					relay.stalled = true;
					note("relay", "stalled");
					return end("stalled");
				}
				note("relay", "nudge orch");
				await say(
					orch,
					started.length
						? "<relay>Both workers are idle and waiting for you. Steer a worker, or call rsa_finish.</relay>"
						: "<relay>No worker has been dispatched. Call rsa_dispatch for w1 and w2.</relay>",
				);
			}
			return;
		}
		// A worker settled.
		const report = a.pending && a.pending.seq > a.lastInput ? a.pending : undefined;
		a.pending = undefined;
		if (!report) {
			if (a.continuations < MAX_CONTINUATIONS) {
				a.continuations++;
				note(a.role, `continue ${a.continuations}`);
				await say(
					a,
					"You ended your turn without calling rsa_report, so the orchestrator has not heard from you. Continue your part of the task. When it is done, blocked, needs a decision, or has failed, call rsa_report.",
				);
				return;
			}
			return deliver(a, { kind: "failed", summary: "The worker stopped twice without a Report (relay)." });
		}
		a.continuations = 0;
		return deliver(a, report);
	};

	const deliver = async (w: Agent, r: Report) => {
		nudges = 0;
		const commit = await commitWorker(w, r.summary);
		w.commit = commit;
		w.last = { ...r, commit };
		const files = await filesChanged(task.base, commit);
		note(w.role, `report ${r.kind}`, { commit: commit.slice(0, 9), files: files.length, summaryChars: r.summary.length });
		const ev = (r.evidence ?? []).map((e) => `- ${e.type}: ${e.ref}`).join("\n");
		const asks = (r.asks ?? []).map((x) => `- ${x}`).join("\n");
		let msg = `<report worker="${w.role}" kind="${r.kind}" commit="${commit.slice(0, 9)}" files_changed="${files.length}">\n${r.summary}${ev ? `\nevidence:\n${ev}` : ""}${asks ? `\nasks:\n${asks}` : ""}\n</report>`;
		const started = WORKERS.filter((id) => agents[id].client);
		const allDone = started.every((id) => agents[id].last?.kind === "done" && !agents[id].busy);
		if (allDone) msg += `\n\n${await mergeAll()}`;
		else {
			const working = started.filter((id) => agents[id].busy || !agents[id].last);
			if (working.length) msg += `\n\n${working.join(", ")} still working.`;
		}
		await say(orch, msg);
	};

	let stopping = false;
	const stopReasonSet = () => stopping || stopReason !== undefined;

	const wallTimer = setTimeout(() => end("timeout"), o.wallMin * 60_000);
	try {
		start(orch);
		t0 = Date.now();
		note("orch", "start");
		await say(orch, `<task>\n${task.prompt}\n</task>\n\nSplit this task between w1 and w2 and dispatch both.`);
		await done;
	} finally {
		clearTimeout(wallTimer);
		stopping = true;
		res.wallClockMs = Date.now() - t0;
		let leftovers = 0;
		for (const a of Object.values(agents)) {
			if (!a.client) continue;
			await a.client.send({ type: "abort" }, 30_000).catch(() => {});
			leftovers += killLeftovers(a.client.child.pid, runDir).length;
		}
		for (const a of Object.values(agents)) if (a.client) await a.client.close(10_000).catch(() => {});
		leftovers += killLeftovers(undefined, runDir).length;
		res.leftoverProcesses = leftovers;
		await queue.catch(() => {});
		writeFileSync(join(runDir, "relay.json"), JSON.stringify(relay, null, 2) + "\n");
		// Acceptance sees the merged change as a working-tree diff against the base.
		await sh("git merge --abort", { cwd: tree });
		await sh(`git reset -q ${task.base}`, { cwd: tree });
		if (!o.keep) for (const w of WORKERS) if (existsSync(agents[w].tree)) await removeTree(repo, agents[w].tree);
	}

	const sessionRoot = join(runDir, "sessions");
	const inputs = (["orch", "w1", "w2"] as Role[]).flatMap((role) => {
		const d = join(sessionRoot, role);
		return existsSync(d)
			? readdirSync(d, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")).map((f) => ({ file: join(d, f), role }))
			: [];
	});
	const sidecars = (["orch", "w1", "w2"] as Role[]).map((r) => join(runDir, `usage-sidecar-${r}.jsonl`));
	const m = meter(inputs, sidecars);
	const { trace, ...summary } = m;
	writeFileSync(join(runDir, "meter.json"), JSON.stringify(summary, null, 2) + "\n");
	writeFileSync(join(runDir, "trace.jsonl"), trace.map((t) => JSON.stringify(t)).join("\n") + "\n");
	res.costUsd = m.total.costUsd;
	res.modelCalls = Object.values(m.turns).reduce((s, t) => s + t.modelCalls, 0);
	res.compactions = m.compactions.length;
	if (fatal) throw fatal;
	res.status = stopReason === "stalled" ? "ok" : (stopReason ?? "ok");
	if (res.status === "ok" && m.total.costUsd > o.capUsd) res.status = "cap";
}
