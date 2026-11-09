#!/usr/bin/env bash
# G0.0 baseline batch (D-21): rounds over all tasks, one run at a time (wall clock is a metric).
# Round r runs every task whose label allows N >= r: small N=3, large serial/parallel N=2.
# Resumable: existing <task>/baseline-<n> dirs are skipped. Stops when the budget guard refuses a run.
# Usage: bench/batch.sh [rounds=3]
cd "$(dirname "$0")/.."
RUNS=${RSA_RUNS:-D:/rsa-bench/runs}
ROUNDS=${1:-3}
for r in $(seq 1 "$ROUNDS"); do
	for d in bench/tasks/*/; do
		t=$(basename "$d")
		label=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).label)' "$d/task.json")
		case "$label" in small) n=3; cap=5 ;; *) n=2; cap=8 ;; esac
		[ "$r" -le "$n" ] || continue
		[ -d "$RUNS/$t/baseline-$r" ] && { echo "SKIP $t baseline-$r (exists)"; continue; }
		echo "RUN $(date +%H:%M) $t baseline-$r ($label, cap \$$cap)"
		out=$(node bench/run.ts "$t" --mode agent --n "$r" --cap-usd "$cap" 2>&1 | tail -40)
		if echo "$out" | grep -qi "budget"; then echo "$out" | grep -i budget | head -3; echo "STOP: budget"; exit 2; fi
		echo "$out" | grep -E '"(status|accepted|costUsd|wallClockMs)"' | tr -d ' \n'; echo
		node bench/ledger.ts 2>/dev/null | tail -1
	done
done
echo "BATCH DONE"
