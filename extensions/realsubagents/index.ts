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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runSubagent, SUBAGENT_ENV } from "../../src/subagent.ts";

export interface SubagentDetails {
	status: "running" | "done" | "failed";
	ms: number;
	/** Running: the tool the subagent just started. */
	activity?: string;
	/** Done or failed: assistant turns and cost. */
	turns?: number;
	costUsd?: number;
}

export default function realsubagents(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_ENV]) return;

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
		async execute(_id, params, signal, onUpdate, ctx) {
			const t0 = Date.now();
			const r = await runSubagent({
				task: params.task,
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinking: pi.getThinkingLevel(),
				signal,
				onActivity: (activity) => {
					onUpdate?.({
						content: [{ type: "text", text: activity }],
						details: { status: "running", ms: Date.now() - t0, activity } satisfies SubagentDetails,
					});
				},
			});
			const details: SubagentDetails = { status: r.ok ? "done" : "failed", ms: r.ms, turns: r.turns, costUsd: r.usage.cost.total };
			const text = r.ok ? r.output || "(The subagent finished without a final message.)" : `Subagent failed: ${r.error}${r.output ? `\n\nIts last message:\n${r.output}` : ""}`;
			return { content: [{ type: "text", text }], details, usage: r.usage, isError: !r.ok };
		},
	});
}
