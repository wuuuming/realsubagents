// A stand-in for Pi's CLI in `--mode json`: reads the task from stdin and answers per FAKE_PI_MODE.
// ok: one tool call, then a final answer echoing the task, argv and the subagent env flag.
// error: the final assistant message has stopReason "error". crash: exit 3 with stderr. hang: never ends.
// long: a 3000-line answer.
const mode = process.env.FAKE_PI_MODE ?? "ok";
let task = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (task += c));
process.stdin.on("end", () => {
	const out = (r) => process.stdout.write(`${JSON.stringify(r)}\n`);
	const usage = (n) => ({ input: n, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: n + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 1000 } });
	out({ type: "session", version: 3, id: "x", cwd: process.cwd() });
	if (mode === "crash") {
		process.stderr.write("boom\n");
		process.exit(3);
	}
	if (mode === "hang") {
		out({ type: "tool_execution_start", toolCallId: "t0", toolName: "bash", args: { command: "sleep forever" } });
		setInterval(() => {}, 1000);
		return;
	}
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], stopReason: "toolUse", usage: usage(10) } });
	out({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.txt" } });
	if (mode === "error") {
		out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider overloaded", usage: usage(5) } });
		return;
	}
	if (mode === "long") {
		out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") }], stopReason: "stop", usage: usage(1) } });
		return;
	}
	const text = JSON.stringify({ task, argv: process.argv.slice(2), sub: process.env.RSA_SUBAGENT ?? null, cwd: process.cwd() });
	// U+2028 inside a JSON string must not split the record.
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: `${text}\u2028` }], stopReason: "stop", usage: usage(20) } });
	out({ type: "agent_settled", aborted: false });
});
