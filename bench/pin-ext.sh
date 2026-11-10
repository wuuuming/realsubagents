#!/usr/bin/env bash
# Export an extension at a pinned commit for benchmark runs, without touching the installed copy.
# Usage: bench/pin-ext.sh <installed repo dir> <name> <commit>   →  $RSA_PINS_DIR/<name>-<commit>/
set -euo pipefail
src=$1; name=$2; commit=$3
dest="${RSA_PINS_DIR:-D:/rsa-bench/pins}/$name-$commit"
rm -rf "$dest"; mkdir -p "$dest"
git -C "$src" archive "$commit" | tar -x -C "$dest"
if [ -d "$src/node_modules" ]; then
	if [ "$(git -C "$src" diff --quiet "$commit" HEAD -- package.json package-lock.json; echo $?)" != 0 ]; then
		echo "warning: dependencies changed since $commit; linking the installed node_modules anyway" >&2
	fi
	case "$(uname -s)" in MINGW*|MSYS*) cmd //c "mklink /J $(cygpath -w "$dest/node_modules") $(cygpath -w "$src/node_modules")" >/dev/null ;; *) ln -s "$src/node_modules" "$dest/node_modules" ;; esac
fi
echo "$commit" > "$dest/PINNED_COMMIT"
echo "$dest"
