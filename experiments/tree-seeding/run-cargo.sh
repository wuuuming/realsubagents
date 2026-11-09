#!/usr/bin/env bash
# W-7 experiment: seeded worktrees for a Cargo workspace. Usage: run-cargo.sh <base repo> <trees dir>
set -u
BASE=${1:-D:/rsa-bench/repos/bilinova}
TREES=${2:-D:/rsa-bench/trees}
SEED="node $(dirname "$0")/seed-tree.mjs"
mkdir -p "$TREES"
COMMIT=$(git -C "$BASE" rev-parse HEAD)
MEMBERS=$(cd "$BASE" && cargo metadata --no-deps --format-version 1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).packages.map(p=>p.name).join(" ")))')

tree() { # name, extra cargo args...
	local name=$1; shift
	local T="$TREES/$name"
	git -C "$BASE" worktree remove --force "$T" 2>/dev/null; rm -rf "$T"
	local t0=$(date +%s.%N)
	git -C "$BASE" worktree add -q --detach "$T" "$COMMIT"
	local t1=$(date +%s.%N)
	for d in native native-audio; do cmd //c "mklink /J $(cygpath -w "$T/$d") $(cygpath -w "$BASE/$d")" >/dev/null; done
	echo "== $name: worktree $(awk "BEGIN{printf \"%.1f\", $t1 - $t0}") s"
	$SEED seed --mode cargo --base "$BASE" --dest "$T"
	local t2=$(date +%s.%N)
	(cd "$T" && cargo test --workspace --no-run "$@" > "$TREES/$name.build.log" 2>&1); echo "build exit $?"
	local t3=$(date +%s.%N)
	echo "build $(awk "BEGIN{printf \"%.1f\", $t3 - $t2}") s; units compiled (cargo: $(grep -o "Finished.*" "$TREES/$name.build.log")): $(grep -c '^\s*Compiling' "$TREES/$name.build.log")"
	grep '^\s*Compiling' "$TREES/$name.build.log" | awk '{print $2}' | sort | tr '\n' ' '; echo
	$SEED verify --dest "$T"
}

tree bn-seeded
SLIM=()
for m in $MEMBERS; do SLIM+=(--config "profile.dev.package.$m.debug=\"line-tables-only\""); done
tree bn-seeded-slim "${SLIM[@]}"

echo "== disk (du counts each hard-linked file once, under the first path listed)"
du -sh "$BASE/target" "$TREES/bn-seeded/target" "$TREES/bn-seeded-slim/target"
for n in bn-seeded bn-seeded-slim; do
	echo "$n incremental: $(du -sh "$TREES/$n/target/debug/incremental" | cut -f1)"
done
