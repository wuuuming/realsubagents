import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Coordinator, type CoordinatorDeps, deliveredSeqs, overlaps, type WorkerLike } from "../src/coordinator.ts";
import { must } from "../src/runtime/sh.ts";
import type { WorkerHandlers, WorkerSpec } from "../src/runtime/worker.ts";
import { Store } from "../src/store/store.ts";

const ID = "-c user.name=t -c user.email=t@t -c commit.gpgsign=false";
/** Wait until `cond()` holds (fake workers report on a later tick than `idle()` covers). */
async function until(cond: () => boolean, ms = 20_000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 20));
	}
}

const text = (f: string) => readFileSync(f, "utf8").replaceAll("\r\n", "\n");

/** A fake worker: on each message it runs `act(tree, message)` and then reports done. */
class FakeWorker implements WorkerLike {
	busy = false;
	cost = 0.1;
	pid = 1;
	started = 0;
	messages: string[] = [];
	readonly spec: WorkerSpec;
	private readonly h: WorkerHandlers;
	private readonly act: (tree: string, msg: string, n: number) => { kind?: "done" | "needs_decision"; summary: string } | undefined;
	constructor(spec: WorkerSpec, h: WorkerHandlers, act: FakeWorker["act"]) {
		this.spec = spec;
		this.h = h;
		this.act = act;
	}
	start() {
		this.started++;
	}
	async say(msg: string) {
		this.messages.push(msg);
		this.busy = true;
		setImmediate(() => {
			this.busy = false;
			const r = this.act(this.spec.tree, msg, this.messages.length);
			if (r) this.h.onReport({ kind: r.kind ?? "done", summary: r.summary, evidence: [{ type: "test", ref: "fake: 1 pass" }], asks: [] });
		});
	}
	async steer(msg: string) {
		await this.say(`<steer>${msg}</steer>`);
	}
	async stop() {
		return 0;
	}
}

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "rsa-coord-"));
	const root = join(dir, "repo");
	await must(`mkdir -p '${root}/pkg-a' '${root}/pkg-b' && git init -q -b main '${root}'`, dir);
	writeFileSync(join(root, "pkg-a", "a.txt"), "a\n");
	writeFileSync(join(root, "pkg-b", "b.txt"), "b\n");
	await must(`git add -A && git ${ID} commit -q -m init`, root);
	const store = new Store(join(dir, "rsa.sqlite"));
	const delivered: { text: string; reports: number[] }[] = [];
	const open: boolean[] = [];
	const workers = new Map<string, FakeWorker>();
	const acts: Record<string, FakeWorker["act"]> = {
		w1: (tree, msg) => {
			if (msg.includes("<steer>")) writeFileSync(join(tree, "pkg-a", "a.txt"), "a by w1, steered\n");
			else writeFileSync(join(tree, "pkg-a", "a.txt"), "a by w1\n");
			return { summary: "w1 done" };
		},
		w2: (tree) => {
			writeFileSync(join(tree, "pkg-b", "new.txt"), "new by w2\n");
			return { summary: "w2 done" };
		},
	};
	const deps = (owner: string): CoordinatorDeps => ({
		store,
		root,
		project: "git-test",
		home: join(dir, "home"),
		setup: { seed: "none" },
		deliver: (t, d) => delivered.push({ text: t, reports: d.reports }),
		onTaskOpen: (o) => open.push(o),
		workerLaunch: () => ({ piArgs: [], promptFiles: [] }),
		owner,
		log: () => {},
		spawnWorker: (spec, h) => {
			const w = new FakeWorker(spec, h, acts[spec.name]);
			workers.set(spec.name, w);
			return w;
		},
	});
	return { dir, root, store, delivered, open, workers, deps, done: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("overlapping paths are found, case- and slash-insensitively", () => {
	assert.deepEqual(overlaps([{ paths: ["packages/tui"] }, { paths: ["packages/coding-agent"] }]), []);
	assert.equal(overlaps([{ paths: ["packages/tui"] }, { paths: ["Packages\\TUI\\src"] }]).length, 1);
	assert.equal(overlaps([{ paths: ["."] }, { paths: ["x"] }]).length, 1);
});

test("split → reports → merge, land and check → steer → re-land → finish", async () => {
	const s = await setup();
	try {
		const c = new Coordinator(s.deps("A"));
		const msg = await c.split({
			title: "two parts",
			workers: [
				{ goal: "change a", acceptance: "a changed", paths: ["pkg-a"], brief: "see pkg-a/a.txt" },
				{ goal: "add new", acceptance: "new exists", paths: ["pkg-b"], brief: "" },
			],
			check: ["test -f pkg-b/new.txt && echo CHECK-OK"],
		});
		assert.match(msg, /w1, w2 are starting/);
		await until(() => s.delivered.some((d) => d.text.includes("<merge>")));
		await c.idle();
		assert.deepEqual(s.open, [true]);
		// Each worker got its dispatch with the other's paths.
		assert.match(s.workers.get("w1")!.messages[0], /<other_groups>\nw2 writes: pkg-b/);
		// The last message carries both merge and check results; both reports were delivered once.
		const last = s.delivered.at(-1)!.text;
		assert.match(last, /<merge>All workers are done.*2 file\(s\) changed/s);
		assert.match(last, /CHECK-OK|exit 0/);
		assert.equal(s.store.pendingReports().length, 0);
		assert.equal(new Set(s.delivered.flatMap((d) => d.reports)).size, 2);
		assert.equal(text(join(s.root, "pkg-a", "a.txt")), "a by w1\n");
		assert.equal(text(join(s.root, "pkg-b", "new.txt")), "new by w2\n");

		const n = s.delivered.length;
		await c.steer("w1", "change a again");
		await until(() => s.delivered.length > n);
		await c.idle();
		assert.equal(text(join(s.root, "pkg-a", "a.txt")), "a by w1, steered\n");
		assert.match(s.delivered.at(-1)!.text, /1 file\(s\) changed: pkg-a\/a.txt/);

		const trees = s.store.workers(c.taskId!).map((w) => w.tree!);
		const out = await c.finish("success", "ok");
		assert.match(out, /closed \(success\)/);
		assert.deepEqual(s.open, [true, false]);
		for (const t of trees) assert.equal(existsSync(t), false);
		assert.equal((await must("git worktree list", s.root)).split("\n").length, 1);
		assert.equal(s.store.tasks("git-test")[0].state, "done");
	} finally {
		s.done();
	}
});

test("a second split while a task is open is refused; overlapping paths are refused", async () => {
	const s = await setup();
	try {
		const c = new Coordinator(s.deps("A"));
		await assert.rejects(c.split({ title: "x", workers: [{ goal: "", acceptance: "", paths: ["pkg-a"], brief: "" }, { goal: "", acceptance: "", paths: ["pkg-a/sub"], brief: "" }] }), /overlap/);
		await c.split({ title: "x", workers: [{ goal: "", acceptance: "", paths: ["pkg-a"], brief: "" }, { goal: "", acceptance: "", paths: ["pkg-b"], brief: "" }] });
		await until(() => s.delivered.some((d) => d.text.includes("<merge>")));
		await assert.rejects(c.split({ title: "y", workers: [{ goal: "", acceptance: "", paths: ["a"], brief: "" }, { goal: "", acceptance: "", paths: ["b"], brief: "" }] }), /still open/);
		await c.idle();
		await c.finish("failure", "test");
	} finally {
		s.done();
	}
});

test("a restarted coordinator resumes the open task and does not re-deliver what the session has", async () => {
	const s = await setup();
	try {
		const first = new Coordinator(s.deps("A"));
		await first.split({ title: "r", workers: [{ goal: "g1", acceptance: "", paths: ["pkg-a"], brief: "" }, { goal: "g2", acceptance: "", paths: ["pkg-b"], brief: "" }] });
		await until(() => s.delivered.flatMap((d) => d.reports).length === 2);
		await first.idle();
		const delivered = s.delivered.flatMap((d) => d.reports);
		assert.equal(delivered.length, 2);
		// Simulate a crash before the delivery was recorded: un-claim one report in the store.
		const seq = delivered[0];
		s.store.db.prepare("UPDATE reports SET delivered = 0 WHERE seq = ?").run(seq);
		await first.shutdown();
		s.delivered.length = 0;

		const killed: string[] = [];
		const second = new Coordinator({ ...s.deps("B"), killStale: (_pid, tree) => killed.push(tree) });
		const sessionEntries = [{ type: "custom_message", customType: "rsa-report", details: { reports: [seq] } }];
		const out = await second.resume(deliveredSeqs(sessionEntries));
		assert.match(out!, /resumed task/);
		await second.idle();
		assert.equal(s.delivered.length, 0, "the report found in the session is not sent again");
		assert.equal(s.store.pendingReports().length, 0);
		await second.finish("success", "");
	} finally {
		s.done();
	}
});

test("check results separate new failures from ones already on the base", async () => {
	const { describeCheck, failureLines } = await import("../src/coordinator.ts");
	const base = { command: "t", code: 1, ms: 1000, output: "✓ a\n✖ old test fails (12 ms)\nTests 1 failed" };
	assert.deepEqual(failureLines(base.output), ["✖ old test fails"]);
	const same = describeCheck({ command: "t", code: 1, ms: 900, output: "✖ old test fails (30 ms)\nTests 1 failed" }, base);
	assert.match(same, /failed the same way on the base/);
	const worse = describeCheck({ command: "t", code: 1, ms: 900, output: "✖ old test fails\n✖ new test fails\nTests 2 failed" }, base);
	assert.match(worse, /with 1 failure\(s\); now 2\. New failure lines:\n✖ new test fails$/);
	// The wsl pilot: the same failures, but random temp paths and a higher passed count.
	const b2 = { command: "v", code: 1, ms: 1, output: "Error: EPERM: operation not permitted, symlink 'C:\\Temp\\pi-env-111-abc\\t.txt' -> 'C:\\Temp\\pi-env-111-abc\\l.txt'\nTests 7 failed | 1850 passed (1860)" };
	const a2 = { command: "v", code: 1, ms: 1, output: "Error: EPERM: operation not permitted, symlink 'C:\\Temp\\pi-env-999-xyz\\t.txt' -> 'C:\\Temp\\pi-env-999-xyz\\l.txt'\nTests 7 failed | 1855 passed (1868)" };
	assert.match(describeCheck(a2, b2), /failed the same way on the base/);
	assert.match(describeCheck({ command: "t", code: 1, ms: 1, output: "x" }, { ...base, code: 0 }), /passed on the base/);
	assert.match(describeCheck({ command: "t", code: 0, ms: 1, output: "" }, base), /fixed/);
});
