/**
 * realsubagents: one tool, `subagent`, that delegates a task to a fresh Pi process and returns its
 * final message. That is all it does:
 * - no steering: the call blocks until the subagent is done (abort cancels it);
 * - no reuse: every call is a new process with no session;
 * - no nesting: subagents don't get the tool (they run with RSA_SUBAGENT=1);
 * - no policy: whether and how to split work is the user's or the main agent's decision.
 *
 * Subagents run in the main agent's working directory, with its model and thinking level. Several
 * `subagent` calls in one assistant message run in parallel (Pi runs tool calls in parallel).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { capOutput, MAX_BYTES, MAX_LINES, runSubagent, SUBAGENT_ENV } from "../../src/subagent.ts";

export interface SubagentDetails {
	status: "running" | "done" | "failed";
	ms: number;
	/** Running: the tool the subagent just started. */
	activity?: string;
	/** Done or failed: assistant turns and cost. */
	turns?: number;
	costUsd?: number;
	/** The full report, when the result holds only its head. */
	fullOutput?: string;
}

/** Subagents still running in this process; aborted when the session shuts down or Pi exits. */
const RUNNING_KEY = Symbol.for("realsubagents.running");
const g = globalThis as { [RUNNING_KEY]?: Set<AbortController> };
const running = (g[RUNNING_KEY] ??= (() => {
	const set = new Set<AbortController>();
	// Children outlive their parent on Windows; kill them when Pi exits (abort kills synchronously).
	process.once("exit", () => {
		for (const ac of set) ac.abort();
	});
	return set;
})());

const COLLAPSED_LINES = 6;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

export default function realsubagents(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_ENV]) return;

	pi.on("session_shutdown", async () => {
		for (const ac of running) ac.abort();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a subagent: a fresh Pi agent in the same working directory, with the same model and tools, but none of this conversation. It works on its own and its final message is returned as the result.",
		promptSnippet: "Delegate a self-contained task to a fresh subagent and get its final report",
		promptGuidelines: [
			"The subagent tool starts with none of this conversation: put everything it needs into the task (goal, relevant files, constraints, how to verify, what to report back).",
			"Several subagent calls in one message run in parallel in the same working tree; give parallel subagents work that does not write the same files.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete, self-contained task for the subagent." }),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const t0 = Date.now();
			const ac = new AbortController();
			const forward = () => ac.abort();
			if (signal?.aborted) ac.abort();
			else signal?.addEventListener("abort", forward, { once: true });
			running.add(ac);
			try {
				const r = await runSubagent({
					task: params.task,
					cwd: ctx.cwd,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinking: pi.getThinkingLevel(),
					signal: ac.signal,
					onActivity: (activity) =>
						onUpdate?.({
							content: [{ type: "text", text: activity }],
							details: { status: "running", ms: Date.now() - t0, activity } satisfies SubagentDetails,
						}),
				});
				const details: SubagentDetails = { status: r.ok ? "done" : "failed", ms: r.ms, turns: r.turns, costUsd: r.usage.cost.total };
				let report = r.output;
				const cap = capOutput(report);
				if (cap.truncated) {
					const file = join(mkdtempSync(join(tmpdir(), "pi-subagent-")), `${toolCallId.replace(/[^\w-]/g, "_")}.md`);
					writeFileSync(file, report);
					details.fullOutput = file;
					report = `${cap.text}\n\n[The report was cut to ${MAX_LINES} lines / ${MAX_BYTES / 1024} KB. Full report: ${file}]`;
				}
				const text = r.ok ? report || "(The subagent finished without a final message.)" : `Subagent failed: ${r.error}${report ? `\n\nIts last message:\n${report}` : ""}`;
				return { content: [{ type: "text", text }], details, usage: r.usage, isError: !r.ok };
			} finally {
				running.delete(ac);
				signal?.removeEventListener("abort", forward);
			}
		},

		renderCall(args, theme, context) {
			const task = String((args as { task?: unknown })?.task ?? "").trim();
			const first = task.split("\n")[0];
			const short = first.length > 100 ? `${first.slice(0, 97)}...` : first;
			let s = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("muted", short)}`;
			if (context.expanded && task !== short) s += `\n${theme.fg("dim", task)}`;
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(s);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const d = result.details as SubagentDetails | undefined;
			const state = context.state as { start?: number; timer?: ReturnType<typeof setInterval> };
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) {
				// Tick the elapsed time between tool starts; stops when the final result renders.
				state.start ??= Date.now() - (d?.ms ?? 0);
				if (!state.timer) {
					state.timer = setInterval(() => context.invalidate(), 1000);
					state.timer.unref?.();
				}
				text.setText(`${theme.fg("warning", "⋯")} ${theme.fg("dim", `${secs(Date.now() - state.start)}${d?.activity ? ` · ${d.activity}` : ""}`)}`);
				return text;
			}
			if (state.timer) clearInterval(state.timer);
			state.timer = undefined;
			const ok = d?.status === "done" && !context.isError;
			const stats = d ? [d.turns !== undefined ? `${d.turns} turns` : "", secs(d.ms), d.costUsd ? `$${d.costUsd.toFixed(2)}` : ""].filter(Boolean).join(" · ") : "";
			const body = result.content
				.map((c) => (c.type === "text" ? c.text : ""))
				.join("\n")
				.trim();
			const lines = body.split("\n");
			const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
			let s = `${ok ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${theme.fg("dim", stats)}`;
			if (body) s += `\n${theme.fg(ok ? "toolOutput" : "error", shown.join("\n"))}`;
			if (!expanded && lines.length > COLLAPSED_LINES) s += `\n${theme.fg("dim", `… ${lines.length - COLLAPSED_LINES} more lines (${context.keyHint("app.tools.expand", "to expand")})`)}`;
			text.setText(s);
			return text;
		},
	});
}
