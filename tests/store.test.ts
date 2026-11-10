import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newTaskId, SCHEMA_VERSION, Store } from "../src/store/store.ts";

function fresh(): { store: Store; path: string; done: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "rsa-store-"));
	const path = join(dir, "rsa.sqlite");
	const store = new Store(path);
	return { store, path, done: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

/** A task with two workers that both report done, one merged, plus a steer and a delivery. */
function scenario(s: Store): string {
	const t = newTaskId();
	s.append({ type: "task.created", task: t, actor: "orchestrator", data: { title: "split", goal: "g", base: "abc", branch: `rsa/${t}`, project: "p1" } });
	for (const w of ["w1", "w2"]) {
		s.append({ type: "worker.dispatched", task: t, actor: "orchestrator", data: { worker: w, paths: [`pkg/${w}`], goal: `goal ${w}`, acceptance: "tests", brief: "b" } });
		s.append({ type: "worker.started", task: t, actor: "runtime", data: { worker: w, tree: `/trees/${w}`, branch: `rsa/${t}/${w}`, pid: 100, sessionDir: `/s/${w}` } });
	}
	s.append({ type: "worker.steered", task: t, actor: "orchestrator", data: { worker: "w2", message: "also x" } });
	const r1 = s.append({ type: "worker.reported", task: t, actor: "worker", data: { worker: "w1", kind: "done", summary: "did w1", evidence: [{ type: "test", ref: "npm test: 3 pass" }], commit: "c1" } });
	s.append({ type: "worker.reported", task: t, actor: "worker", data: { worker: "w2", kind: "needs_decision", summary: "which?", asks: ["a or b"], commit: "c2" } });
	s.claimReports([r1.seq], "orchestrator");
	s.append({ type: "worker.merged", task: t, actor: "runtime", data: { worker: "w1", commit: "c1" } });
	return t;
}

test("events update projections in the same transaction", () => {
	const { store, done } = fresh();
	try {
		const t = scenario(store);
		assert.equal(store.task(t)?.state, "running");
		const [w1, w2] = store.workers(t);
		assert.equal(w1.state, "merged");
		assert.equal(w1.merged, "c1");
		assert.deepEqual(w1.paths, ["pkg/w1"]);
		assert.equal(w2.state, "reported");
		assert.equal(w2.lastReport?.kind, "needs_decision");
		const pending = store.pendingReports(t);
		assert.equal(pending.length, 1);
		assert.equal(pending[0].worker, "w2");
		assert.deepEqual(pending[0].asks, ["a or b"]);
	} finally {
		done();
	}
});

test("rebuild from events reproduces the live projections", () => {
	const { store, done } = fresh();
	try {
		const t = scenario(store);
		store.append({ type: "task.integrating", task: t, actor: "runtime" });
		store.append({ type: "task.finished", task: t, actor: "orchestrator", data: { outcome: "success", summary: "ok" } });
		const live = store.snapshot();
		store.rebuild();
		assert.deepEqual(store.snapshot(), live);
		assert.equal(store.task(t)?.state, "done");
	} finally {
		done();
	}
});

test("a failed projection rolls back its event", () => {
	const { store, done } = fresh();
	try {
		const t = newTaskId();
		store.append({ type: "task.created", task: t, actor: "o", data: { title: "x", base: "b", branch: "r" } });
		const before = store.events().length;
		assert.throws(() => store.append({ type: "worker.started", task: t, actor: "runtime", data: { worker: "nope" } }), /unknown worker/);
		assert.equal(store.events().length, before);
	} finally {
		done();
	}
});

test("reports are delivered exactly once across two connections", () => {
	const { store, path, done } = fresh();
	const other = new Store(path);
	try {
		const t = scenario(store);
		const seqs = store.pendingReports(t).map((r) => r.seq);
		const a = store.claimReports(seqs, "orchestrator");
		const b = other.claimReports(seqs, "orchestrator");
		assert.deepEqual(a, seqs);
		assert.deepEqual(b, []);
		assert.equal(other.pendingReports(t).length, 0);
	} finally {
		other.close();
		done();
	}
});

test("a lease excludes a second owner until it expires", async () => {
	const { store, path, done } = fresh();
	const other = new Store(path);
	try {
		assert.equal(store.acquire("coord:p1", "A", 50), true);
		assert.equal(other.acquire("coord:p1", "B", 50), false);
		assert.equal(store.acquire("coord:p1", "A", 50), true, "the owner renews");
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(other.acquire("coord:p1", "B", 50), true, "taken over after expiry");
		other.release("coord:p1", "B");
		assert.equal(store.acquire("coord:p1", "A", 50), true);
	} finally {
		other.close();
		done();
	}
});

test("migration records the schema version and refuses a newer schema", () => {
	const { store, path, done } = fresh();
	try {
		assert.equal(store.schemaVersion(), SCHEMA_VERSION);
		store.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
		assert.throws(() => new Store(path), /newer than this code/);
	} finally {
		done();
	}
});
