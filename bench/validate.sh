#!/usr/bin/env bash
# D-19 validation of tasks: reference run (writes the baseline failure lists) must be accepted,
# base run must be rejected. Free (no agent). Usage: bench/validate.sh <task>...
# Earlier validation runs of the same task (reference-1, base-1) are replaced.
cd "$(dirname "$0")/.."
RUNS=${RSA_RUNS:-D:/rsa-bench/runs}
for t in "$@"; do
	rm -rf "$RUNS/$t/reference-1" "$RUNS/$t/base-1"
	ref=$(node bench/run.ts "$t" --mode reference --write-baseline 2>&1 | tail -40)
	base=$(node bench/run.ts "$t" --mode base 2>&1 | tail -40)
	ra=$(echo "$ref" | grep -m1 '"accepted"' | grep -o 'true\|false')
	ba=$(echo "$base" | grep -m1 '"accepted"' | grep -o 'true\|false')
	verdict=FAIL; [ "$ra" = true ] && [ "$ba" = false ] && verdict=OK
	echo "VALIDATE $t reference=${ra:-error} base=${ba:-error} => $verdict"
	[ "$verdict" = OK ] || { echo "--- reference:"; echo "$ref" | tail -15; echo "--- base:"; echo "$base" | tail -15; }
done
