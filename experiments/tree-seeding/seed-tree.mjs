#!/usr/bin/env node
/**
 * Tier B tree seeding experiment (design doc §13.1, route W-2 / W-7).
 *
 *   node seed-tree.mjs seed   --mode cargo|npm --base <warm tree> --dest <new worktree>
 *   node seed-tree.mjs verify --dest <new worktree>
 *
 * seed: hard-links the base tree's immutable parts into dest and writes
 *       dest/.rsa-seed-manifest.json (base path, size and mtime of every linked file).
 *   cargo: target/debug/{deps,build,.fingerprint}, minus every unit of a workspace target
 *          (those get a new hash in a tree at another path anyway); incremental/ and the
 *          uplifted top-level files are skipped.
 *   npm:   every node_modules directory; workspace links that point into the base tree are
 *          re-created to point into dest.
 *   Files smaller than LINK_MIN are copied, not linked: small files (fingerprints, dep-info,
 *   JSON) are the ones a tool may rewrite in place, and copying them costs nothing.
 * verify: re-stats every linked file on the base side. A changed size or mtime means a tool
 *         wrote through a hard link into the base tree: seeding is then unsafe for that toolchain.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Files below this size are copied. Cargo: small files (fingerprints, dep-info) may be rewritten in place. npm: package files are not, so link all. */
const LINK_MIN_BY_MODE = { cargo: 64 * 1024, npm: 0 };
let LINK_MIN = 64 * 1024;
const MANIFEST = ".rsa-seed-manifest.json";

function args() {
	const [cmd, ...rest] = process.argv.slice(2);
	const o = { cmd };
	for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, "")] = rest[i + 1];
	return o;
}

const stats = { linked: 0, linkedBytes: 0, copied: 0, copiedBytes: 0, relinked: 0, skipped: 0 };
const manifest = [];

function placeFile(src, dst, forceCopy = false) {
	const st = fs.statSync(src);
	if (!forceCopy && st.size >= LINK_MIN) {
		fs.linkSync(src, dst);
		stats.linked++;
		stats.linkedBytes += st.size;
		manifest.push([src, st.size, st.mtimeMs]);
	} else {
		fs.copyFileSync(src, dst);
		stats.copied++;
		stats.copiedBytes += st.size;
	}
}

/** Recursive seed; `keep(rel, dirent)` filters, `relink` handles symlinks/junctions. */
function walk(srcRoot, dstRoot, rel, keep, relink) {
	const src = path.join(srcRoot, rel);
	fs.mkdirSync(path.join(dstRoot, rel), { recursive: true });
	for (const d of fs.readdirSync(src, { withFileTypes: true })) {
		const r = path.join(rel, d.name);
		if (!keep(r, d)) {
			stats.skipped++;
			continue;
		}
		const s = path.join(srcRoot, r);
		const t = path.join(dstRoot, r);
		if (d.isSymbolicLink()) relink(s, t);
		else if (d.isDirectory()) walk(srcRoot, dstRoot, r, keep, relink);
		else if (d.isFile()) placeFile(s, t, d.name.startsWith("."));
	}
}

function workspaceTargetNames(base) {
	const out = execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: base, maxBuffer: 64 << 20 });
	const m = JSON.parse(out);
	const names = new Set();
	for (const p of m.packages) {
		names.add(p.name.replace(/-/g, "_"));
		for (const t of p.targets) names.add(t.name.replace(/-/g, "_"));
	}
	return names;
}

/** `libfoo_bar-0123abcd.rlib` / `foo-bar-0123abcd` → `foo_bar` */
function unitName(file) {
	const m = file.match(/^(?:lib)?(.+?)-[0-9a-f]{16}(?:\..*)?$/);
	return m ? m[1].replace(/-/g, "_") : undefined;
}

function seedCargo(base, dest) {
	const first = workspaceTargetNames(base);
	const root = path.join("target", "debug");
	for (const sub of ["deps", "build", ".fingerprint"]) {
		const rel = path.join(root, sub);
		if (!fs.existsSync(path.join(base, rel))) continue;
		walk(
			base,
			dest,
			rel,
			(r, d) => {
				// Only filter at the first level below deps/build/.fingerprint.
				if (path.dirname(r) !== rel) return true;
				const n = unitName(d.name);
				return n === undefined || !first.has(n);
			},
			(s, t) => fs.symlinkSync(fs.readlinkSync(s), t),
		);
	}
}

function seedNpm(base, dest) {
	const baseAbs = path.resolve(base);
	const inBase = (p) => {
		const rel = path.relative(baseAbs, p);
		return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : undefined;
	};
	const relink = (s, t) => {
		let target = fs.readlinkSync(s).replace(/^\\\\\?\\/, "");
		if (!path.isAbsolute(target)) target = path.resolve(path.dirname(s), target);
		const rel = inBase(target);
		if (rel !== undefined) {
			target = path.join(path.resolve(dest), rel);
			stats.relinked++;
		}
		fs.symlinkSync(target, t, process.platform === "win32" ? "junction" : "dir");
	};
	// Dot-directories in node_modules are tool caches written in place (.vite, .vite-temp, .cache), except .bin.
	const keep = (r, d) => !(d.isDirectory() && d.name.startsWith(".") && d.name !== ".bin");
	// Every node_modules directory outside node_modules itself (workspace packages may have their own).
	const dirs = [];
	const find = (rel, depth) => {
		for (const d of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
			if (!d.isDirectory() || d.name === ".git") continue;
			const r = path.join(rel, d.name);
			if (d.name === "node_modules") dirs.push(r);
			else if (depth < 4) find(r, depth + 1);
		}
	};
	find("", 0);
	for (const rel of dirs) walk(base, dest, rel, keep, relink);
}

function verify(dest) {
	const m = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), "utf8"));
	let changed = 0;
	for (const [file, size, mtime] of m.files) {
		const st = fs.statSync(file, { throwIfNoEntry: false });
		if (!st) continue; // removed and re-created by the tool: the base keeps its own inode? report separately
		if (st.size !== size || st.mtimeMs !== mtime) {
			changed++;
			if (changed <= 20) console.log("CHANGED", file);
		}
	}
	const missing = m.files.filter(([f]) => !fs.existsSync(f)).length;
	console.log(JSON.stringify({ linkedFiles: m.files.length, changedInBase: changed, missingInBase: missing }));
	process.exitCode = changed || missing ? 1 : 0;
}

const o = args();
if (o.cmd === "seed") {
	const t0 = Date.now();
	LINK_MIN = Number(process.env.RSA_LINK_MIN ?? LINK_MIN_BY_MODE[o.mode] ?? LINK_MIN);
	if (o.mode === "cargo") seedCargo(o.base, o.dest);
	else if (o.mode === "npm") seedNpm(o.base, o.dest);
	else throw new Error("--mode cargo|npm");
	fs.writeFileSync(path.join(o.dest, MANIFEST), JSON.stringify({ base: path.resolve(o.base), mode: o.mode, files: manifest }));
	const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;
	console.log(
		JSON.stringify({ ms: Date.now() - t0, linked: stats.linked, linkedSize: mb(stats.linkedBytes), copied: stats.copied, copiedSize: mb(stats.copiedBytes), relinked: stats.relinked, skipped: stats.skipped }),
	);
} else if (o.cmd === "verify") verify(o.dest);
else console.error("usage: seed-tree.mjs seed --mode cargo|npm --base <dir> --dest <dir> | verify --dest <dir>");
