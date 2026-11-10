#!/usr/bin/env bash
# G0.0 baseline batch (D-21): rounds over all tasks, one run at a time (wall clock is a metric).
# Round r runs every task whose label allows N >= r: small N=3, large serial/parallel N=2.
# Resumable: existing <task>/baseline-<n> dirs are skipped. Stops when the budget guard refuses a run.
# Usage: [ARM=baseline|rsa] [TASKS="glob"] bench/batch.sh [rounds=3]
# ARM=ext (v0.1 G0.1): the real extension; large-parallel N=3, small N=1.
# ARM=rsa* (v0.05 arms: rsa = prompts v0, rsav1 = prompts v1): only large-parallel tasks, N=3 each.
cd "$(dirname "$0")/.."
RUNS=${RSA_RUNS:-D:/rsa-bench/runs}
ROUNDS=${1:-3}
ARM=${ARM:-baseline}
TASKS=${TASKS:-*}
for r in $(seq 1 "$ROUNDS"); do
	for d in bench/tasks/$TASKS/; do
		t=$(basename "$d")
		label=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).label)' "$d/task.json")
		case "$label" in small) n=3; cap=5 ;; *) n=2; cap=8 ;; esac
		if [ "${ARM#rsa}" != "$ARM" ]; then [ "$label" = large-parallel ] || continue; n=3; cap=8; fi
		# ARM=ext (G0.1, real extension): large-parallel N=3, small N=1 (escalation must not fire), no large-serial.
		if [ "$ARM" = ext ]; then case "$label" in large-parallel) n=3; cap=6 ;; small) n=1; cap=4 ;; *) continue ;; esac; fi
		[ "$r" -le "$n" ] || continue
		[ -d "$RUNS/$t/$ARM-$r" ] && { echo "SKIP $t $ARM-$r (exists)"; continue; }
		echo "RUN $(date +%H:%M) $t $ARM-$r ($label, cap \$$cap)"
		out=$(node bench/run.ts "$t" --mode agent --arm "$ARM" --n "$r" --cap-usd "$cap" 2>&1 | tail -40)
		if echo "$out" | grep -qi "budget"; then echo "$out" | grep -i budget | head -3; echo "STOP: budget"; exit 2; fi
		echo "$out" | grep -E '"(status|accepted|costUsd|wallClockMs)"' | tr -d ' \n'; echo
		node bench/ledger.ts 2>/dev/null | tail -1
	done
done
echo "BATCH DONE"
