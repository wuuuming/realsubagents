#!/usr/bin/env bash
# W-8 experiment: seeded worktree for an npm-workspaces repository. Usage: run-npm.sh <base repo> <trees dir>
set -u
BASE=${1:-D:/rsa-bench/repos/pi}
TREES=${2:-D:/rsa-bench/trees}
SEED="node $(dirname "$0")/../../src/runtime/seed-tree.mjs"
T="$TREES/pi-seeded"
mkdir -p "$TREES"
git -C "$BASE" worktree remove --force "$T" 2>/dev/null; rm -rf "$T"
t0=$(date +%s.%N)
git -C "$BASE" worktree add -q --detach "$T" HEAD
t1=$(date +%s.%N)
echo "== worktree $(awk "BEGIN{printf \"%.1f\", $t1 - $t0}") s"
$SEED seed --mode npm --base "$BASE" --dest "$T"
# Tree setup (D-15): generated, git-ignored model catalogs; copied, and the build runs offline.
cp -r "$BASE/packages/ai/src/providers/data" "$T/packages/ai/src/providers/"
echo "== workspace links resolve into:"
node -e 'const fs=require("fs");for(const n of ["pi-ai","pi-tui","chord"]){try{console.log(n,"->",fs.realpathSync(process.argv[1]+"/node_modules/@earendil-works/"+n))}catch(e){console.log(n,e.code)}}' "$T"
t2=$(date +%s.%N)
(cd "$T" && npm run build:offline > "$TREES/pi-seeded.build.log" 2>&1); echo "build exit $?"
t3=$(date +%s.%N)
echo "build $(awk "BEGIN{printf \"%.1f\", $t3 - $t2}") s"
for p in agent ai; do
	(cd "$T/packages/$p" && npx vitest --run > "$TREES/pi-seeded.$p.test.log" 2>&1); echo "$p tests exit $?"
	grep -E "Test Files|^\s+Tests " "$TREES/pi-seeded.$p.test.log"
done
$SEED verify --dest "$T"
echo "== disk (hard-linked files counted once, under the first path)"
du -sh "$BASE/node_modules" "$T/node_modules"
du -sh --exclude=node_modules --exclude=.git "$T"
