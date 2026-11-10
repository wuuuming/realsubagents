/**
 * v0.05 dry-run tools (route R.05.2). The relay (`bench/dryrun.ts`) reads these calls from the RPC
 * event stream (`tool_execution_start`) and does the work. The tools only acknowledge, so the
 * extension holds no state and needs no channel back to the relay.
 *
 * RSA_ROLE=orchestrator: rsa_dispatch, rsa_steer, rsa_finish. RSA_ROLE=worker: rsa_report.
 * Descriptions are short and say when to use each tool (prompts/v0/GUIDANCE.md, rule 13).
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKER = Type.Union([Type.Literal("w1"), Type.Literal("w2")], { description: "Which worker: w1 or w2." });
const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function (pi: ExtensionAPI) {
	const role = process.env.RSA_ROLE;
	if (role === "orchestrator") {
		pi.registerTool({
			name: "rsa_dispatch",
			label: "Dispatch",
			description: "Give one worker its part of the task. Call it once for w1 and once for w2, in the same turn.",
			parameters: Type.Object({
				worker: WORKER,
				goal: Type.String({ description: "What this worker must achieve, including the parts of the task description that apply to it." }),
				acceptance: Type.String({ description: "What done means for this worker: behaviour that must work, tests that must pass." }),
				paths: Type.Array(Type.String(), { description: "Directories or files this worker may write, relative to the repository root.", minItems: 1 }),
				brief: Type.String({ description: "What you learned that saves the worker time: file and function references, conventions, the shared interface, pitfalls. No pasted code." }),
			}),
			async execute(_id, p) {
				return ok(`Dispatched to ${p.worker}. Its Report will arrive as a message.`);
			},
		});
		pi.registerTool({
			name: "rsa_steer",
			label: "Steer",
			description: "Send an instruction or a decision to a worker. Use it to answer a Report or to correct a worker's work.",
			parameters: Type.Object({ worker: WORKER, message: Type.String({ description: "The instruction, with any evidence the worker needs." }) }),
			async execute(_id, p) {
				return ok(`Sent to ${p.worker}.`);
			},
		});
		pi.registerTool({
			name: "rsa_finish",
			label: "Finish",
			description: "End the task. Call it once, when the merged tree is right or when the task cannot be completed.",
			parameters: Type.Object({
				outcome: Type.Union([Type.Literal("success"), Type.Literal("failure")]),
				summary: Type.String({ description: "At most 3 lines: what was done, and anything left open." }),
			}),
			async execute() {
				return ok("Finished. End your turn now.");
			},
		});
	} else if (role === "worker") {
		pi.registerTool({
			name: "rsa_report",
			label: "Report",
			description: "Report to the orchestrator when you are done, blocked, need a decision, or have failed. Call it last in your turn.",
			parameters: Type.Object({
				kind: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs_decision"), Type.Literal("failed")]),
				summary: Type.String({ description: "At most 3 lines: what you changed, the result, what the orchestrator must know." }),
				evidence: Type.Array(
					Type.Object({
						type: Type.Union([Type.Literal("test"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("file")]),
						ref: Type.String({ description: "Something the orchestrator can check: a test command with its pass/fail counts, a file path, a commit." }),
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
}
