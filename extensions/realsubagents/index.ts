/**
 * realsubagents: split large tasks across parallel worker agents (route v0.1, D-28; design rev 2.2).
 *
 * One extension, two roles (design §5):
 * - coordinator (the user's Pi): `rsa_split`, plus `rsa_steer` and `rsa_finish` while a task is
 *   open; a stable system-prompt section with the splitting rules; Reports arrive as follow-up
 *   messages that wake the session; `/rsa` shows the status. An open task survives a restart.
 * - worker (`RSA_ROLE=worker`, set for the children the coordinator starts): `rsa_report`.
 *
 * Environment: `RSA_HOME` (default ~/.pi/agent/realsubagents) holds the state store, worktrees and
 * worker sessions; `RSA_WORKER_PI_ARGS` (JSON array) replaces the extension arguments workers get
 * (default: none, so workers load the user's configured packages, plus this extension);
 * `RSA_TREE_SETUP` (JSON) or `<repo>/.pi/rsa.json` `{ "trees": {...} }` configures worker trees.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Coordinator, CoordinatorError, deliveredSeqs } from "../../src/coordinator.ts";
import { loadTreeSetup, repoInfo } from "../../src/runtime/trees.ts";
import { Store } from "../../src/store/store.ts";
import { STATE_VERSION, VERSION } from "../../src/version.ts";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "..", "..", "..");
const PROMPTS = join(ROOT, "prompts", "v1");
export const OPEN_TASK_TOOLS = ["rsa_steer", "rsa_finish"];

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function statusLine(): string {
	return `realsubagents ${VERSION} (state v${STATE_VERSION})`;
}

export function rsaHome(): string {
	return process.env.RSA_HOME ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "realsubagents");
}

export default function realsubagents(pi: ExtensionAPI): void {
	if (process.env.RSA_ROLE === "worker") return workerRole(pi);
	coordinatorRole(pi);
}

// ---- worker role ---------------------------------------------------------------------------

function workerRole(pi: ExtensionAPI): void {
	// The extension may be loaded twice in a worker (a configured package and `-e`); register once.
	const g = globalThis as { __rsaWorkerLoaded?: boolean };
	if (g.__rsaWorkerLoaded) return;
	g.__rsaWorkerLoaded = true;
	pi.registerTool({
		name: "rsa_report",
		label: "Report",
		description: "Report to the orchestrator when you are done, blocked, need a decision, or have failed. Call it last in your turn.",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs_decision"), Type.Literal("failed")]),
			summary: Type.String({ description: "At most 3 lines: what you changed, the result, what the orchestrator must know.", maxLength: 500 }),
			evidence: Type.Array(
				Type.Object({
					type: Type.Union([Type.Literal("test"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("file")]),
					ref: Type.String({ description: "Something the orchestrator can check: a test command with its pass/fail counts, a file path." }),
				}),
				{ description: "References, not pasted content." },
			),
			asks: Type.Optional(Type.Array(Type.String(), { description: "Questions for the orchestrator (needs_decision, blocked)." })),
		}),
		async execute() {
			return ok("Report sent. End your turn now; the orchestrator answers by message.");
		},
	});
}

// ---- coordinator role ----------------------------------------------------------------------

function coordinatorRole(pi: ExtensionAPI): void {
	let store: Store | undefined;
	let coord: Coordinator | undefined;
	let setupError: string | undefined;
	const prompt = readFileSync(join(PROMPTS, "coordinator.md"), "utf8").trim();

	const setOpenTools = (open: boolean) => {
		const active = new Set(pi.getActiveTools());
		for (const t of OPEN_TASK_TOOLS) open ? active.add(t) : active.delete(t);
		pi.setActiveTools([...active]);
	};

	const need = (): Coordinator => {
		if (!coord) throw new CoordinatorError(setupError ?? "realsubagents is not ready (no session yet).");
		return coord;
	};

	const run = async (fn: () => Promise<string>) => {
		try {
			return ok(await fn());
		} catch (e) {
			if (e instanceof CoordinatorError) return { content: [{ type: "text" as const, text: e.message }], details: {}, isError: true };
			throw e;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		setupError = undefined;
		let info: Awaited<ReturnType<typeof repoInfo>>;
		try {
			info = await repoInfo(ctx.cwd);
		} catch {
			setupError = "rsa_split needs a git repository with at least one commit.";
			setOpenTools(false);
			return;
		}
		store = new Store(join(rsaHome(), "rsa.sqlite"));
		coord = new Coordinator({
			store,
			root: info.root,
			project: info.project,
			home: rsaHome(),
			setup: loadTreeSetup(info.root),
			owner: `${process.pid}-${Date.now().toString(36)}`,
			deliver: (text, details) =>
				pi.sendMessage({ customType: "rsa-report", content: text, display: true, details }, { triggerTurn: true, deliverAs: "followUp" }),
			onTaskOpen: setOpenTools,
			workerLaunch: () => {
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const provider = ctx.model?.provider;
				const extra = process.env.RSA_WORKER_PI_ARGS ? (JSON.parse(process.env.RSA_WORKER_PI_ARGS) as string[]) : [];
				const overlay = provider ? join(PROMPTS, "overlays", `${provider}-worker.md`) : "";
				return {
					model,
					thinking: pi.getThinkingLevel(),
					piArgs: [...extra, "-e", SELF],
					promptFiles: [join(PROMPTS, "worker.md"), ...(overlay && existsSync(overlay) ? [overlay] : [])],
				};
			},
			log: (s) => {
				if (process.env.RSA_DEBUG) console.error(s);
			},
		});
		setOpenTools(false);
		const delivered = deliveredSeqs(ctx.sessionManager.getEntries() as Iterable<{ type?: string; customType?: string; details?: unknown }>);
		const resumed = await coord.resume(delivered);
		if (resumed && ctx.hasUI) ctx.ui.notify(resumed, "info");
	});

	pi.on("session_shutdown", async () => {
		await coord?.shutdown();
		store?.close();
		coord = undefined;
		store = undefined;
	});

	pi.on("before_agent_start", async (event) => {
		// Byte-identical for the life of the session (prompt cache).
		event.systemPromptOptions.sections.realsubagents = prompt;
	});

	const WORKER_NAME = Type.String({ description: "w1, w2 or w3." });

	pi.registerTool({
		name: "rsa_split",
		label: "Split",
		description:
			"Split a large task between 2 or 3 worker agents that work in parallel, each in its own copy of the repository; their merged work is applied to this working tree. Only for tasks with separable parts of comparable size (see the realsubagents section).",
		parameters: Type.Object({
			title: Type.String({ description: "A short title for the task." }),
			workers: Type.Array(
				Type.Object({
					goal: Type.String({ description: "What this worker must achieve, including the parts of the task description that apply to it." }),
					acceptance: Type.String({ description: "What done means for it, with the exact command for the tests of its part." }),
					paths: Type.Array(Type.String(), { description: "Directories or files it may write, relative to the repository root.", minItems: 1 }),
					brief: Type.String({ description: "What you learned that saves it time: file and function references, conventions, the shared interface, pitfalls. No pasted code." }),
				}),
				{ minItems: 2, maxItems: 3 },
			),
			check: Type.Optional(Type.Array(Type.String(), { description: "Repo-wide commands run once on the merged result (type check, the changed packages' test suites)." })),
			budget_usd: Type.Optional(Type.Number({ description: "Stop the workers when they have spent more than this (USD)." })),
		}),
		async execute(_id, p) {
			return run(() => need().split({ title: p.title, workers: p.workers, check: p.check, budgetUsd: p.budget_usd }));
		},
	});

	pi.registerTool({
		name: "rsa_steer",
		label: "Steer",
		description: "Send an instruction or a decision to a worker of the open task; it restarts the worker if it had stopped.",
		parameters: Type.Object({ worker: WORKER_NAME, message: Type.String({ description: "The instruction, with any evidence the worker needs." }) }),
		async execute(_id, p) {
			return run(() => need().steer(p.worker, p.message));
		},
	});

	pi.registerTool({
		name: "rsa_finish",
		label: "Finish",
		description: "Close the open task: stops the workers and removes their trees. Call it when the merged result is right, or when the task cannot be completed.",
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("success"), Type.Literal("failure")]),
			summary: Type.String({ description: "At most 3 lines: what was done, and anything left open." }),
		}),
		async execute(_id, p) {
			return run(() => need().finish(p.outcome, p.summary));
		},
	});

	pi.registerCommand("rsa", {
		description: "realsubagents: status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${statusLine()}\n${coord ? coord.status() : (setupError ?? "not started")}`, "info");
		},
	});
}
