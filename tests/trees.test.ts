import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** File content with LF endings (core.autocrlf may write CRLF on checkout and apply). */
const text = (f: string) => readFileSync(f, "utf8").replaceAll("\r\n", "\n");
import { must } from "../src/runtime/sh.ts";
import { commitTree, createTree, land, mergeCommits, removeTree, repoInfo, snapshot } from "../src/runtime/trees.ts";

const ID = "-c user.name=t -c user.email=t@t -c commit.gpgsign=false";

async function repo(): Promise<{ root: string; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "rsa-trees-"));
	const root = join(dir, "repo");
	await must(`mkdir -p '${root}' && git init -q -b main '${root}'`, dir);
	writeFileSync(join(root, "a.txt"), "a1\na2\na3\n");
	writeFileSync(join(root, "b.txt"), "b1\nb2\nb3\n");
	writeFileSync(join(root, ".gitignore"), "ignored/\n");
	await must(`git add -A && git ${ID} commit -q -m init`, root);
	return { root, dir };
}

test("snapshot captures tracked changes and untracked files, and leaves the user's index alone", async () => {
	const { root, dir } = await repo();
	try {
		writeFileSync(join(root, "a.txt"), "a1 changed\na2\na3\n");
		writeFileSync(join(root, "new.txt"), "untracked\n");
		writeFileSync(join(root, "staged.txt"), "staged\n");
		await must("git add staged.txt", root);
		const statusBefore = await must("git status --porcelain", root);
		const snap = await snapshot(root);
		assert.equal(await must(`git show ${snap}:new.txt`, root), "untracked");
		assert.equal((await must(`git show ${snap}:a.txt`, root)).split("\n")[0], "a1 changed");
		assert.equal(await must("git status --porcelain", root), statusBefore);
		const info = await repoInfo(root);
		assert.match(info.project, /^git-[0-9a-f]{12}$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two workers' commits merge without a working tree and land incrementally", async () => {
	const { root, dir } = await repo();
	try {
		writeFileSync(join(root, "untracked-user-file.txt"), "user\n");
		const base = await snapshot(root);
		const w1 = join(dir, "trees", "w1");
		const w2 = join(dir, "trees", "w2");
		await createTree(root, w1, base, "rsa/t1/w1", { seed: "none" });
		await createTree(root, w2, base, "rsa/t1/w2", { seed: "none" });
		writeFileSync(join(w1, "a.txt"), "a1 by w1\na2\na3\n");
		writeFileSync(join(w2, "b.txt"), "b1\nb2\nb3 by w2\n");
		writeFileSync(join(w2, "c.txt"), "new from w2\n");
		const c1 = await commitTree(w1, "w1: a", {});
		const c2 = await commitTree(w2, "w2: b, c", {});
		assert.notEqual(c1, base);
		const m = await mergeCommits(root, base, [c1, c2]);
		if (!m.ok) throw new Error(`conflict: ${m.conflicts}`);
		const baseTree = await must(`git rev-parse ${base}^{tree}`, root);
		const l = await land(root, baseTree, m.tree);
		assert.ok(l.ok, l.error ?? "");
		assert.deepEqual(l.files.sort(), ["a.txt", "b.txt", "c.txt"]);
		assert.equal(text(join(root, "a.txt")), "a1 by w1\na2\na3\n");
		assert.equal(text(join(root, "c.txt")), "new from w2\n");

		// A steer makes w1 change more; landing again applies only the difference.
		writeFileSync(join(w1, "a.txt"), "a1 by w1\na2 again\na3\n");
		const c1b = await commitTree(w1, "w1: more", {});
		const m2 = await mergeCommits(root, base, [c1b, c2]);
		if (!m2.ok) throw new Error(`conflict: ${m2.conflicts}`);
		const l2 = await land(root, m.tree, m2.tree);
		assert.ok(l2.ok, l2.error ?? "");
		assert.deepEqual(l2.files, ["a.txt"]);
		assert.equal(text(join(root, "a.txt")), "a1 by w1\na2 again\na3\n");

		await removeTree(root, w1, {}, "rsa/t1/w1");
		await removeTree(root, w2, {}, "rsa/t1/w2");
		assert.equal(existsSync(w1), false);
		assert.equal((await must("git branch --list 'rsa/*'", root)).trim(), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("conflicting edits are reported with the conflicting files", async () => {
	const { root, dir } = await repo();
	try {
		const base = await snapshot(root);
		const w1 = join(dir, "trees", "w1");
		const w2 = join(dir, "trees", "w2");
		await createTree(root, w1, base, "rsa/t2/w1", { seed: "none" });
		await createTree(root, w2, base, "rsa/t2/w2", { seed: "none" });
		writeFileSync(join(w1, "a.txt"), "a1 from w1\na2\na3\n");
		writeFileSync(join(w2, "a.txt"), "a1 from w2\na2\na3\n");
		const m = await mergeCommits(root, base, [await commitTree(w1, "w1", {}), await commitTree(w2, "w2", {})]);
		assert.equal(m.ok, false);
		if (!m.ok) assert.deepEqual(m.conflicts, ["a.txt"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
