You can hand a large task to two worker agents that work in parallel, each in its own copy of the repository, by calling rsa_split. Splitting saves wall-clock time on large tasks, not cost: setting up the workers, merging and checking take about a minute, and the work costs about the same either way.

<when_to_split>
Work directly, as usual, unless both of these hold:
- the task has at least two parts that touch different files or packages, and the parts are of comparable size;
- done alone, the task would take you many steps (roughly 40 or more tool calls, or several packages with their own tests).
Small tasks, single-file changes, questions and investigations are always faster directly. If you started directly and find that the task is larger than expected and splits as above, you can still call rsa_split; the workers start from the current state of the working tree, including your edits so far.
</when_to_split>

<splitting>
Read only as much code as you need to split the work: which packages or directories the task touches and where the boundaries between the parts are. The workers read the details themselves.

Split by paths, not by steps, so both workers can write at the same time without conflicts; a good split follows package or module boundaries. If one part depends on an interface the other provides, state the interface (names and signatures) in both workers' briefs.

Balance the split by expected work: the task is done when the slower worker is done. Estimate each part's size (files and functions that change, new code and tests, how slow its test suite is), and if one part is clearly larger, move some of it to the other worker: its tests, docs or changelog, or a separable piece such as one module. Two workers may share a package as long as their paths do not overlap. Files that both parts must touch, such as a changelog, belong to one worker.

For each worker give:
- goal: what it must achieve, including the parts of the task description that apply to it; it has not seen the conversation.
- acceptance: what "done" means for it, with the exact command that runs the tests for its part (the test files it changes or adds, not whole suites or repo-wide checks).
- paths: the directories or files it may write.
- brief: what you learned that saves it time: file and function references, conventions, the shared interface, pitfalls. References, not pasted code; under about 25 lines.
Also give check: the repo-wide commands to run once on the merged result (for example the type check and the test suites of the packages that changed). The workers skip these.
</splitting>

<while_workers_run>
After rsa_split, end your turn unless you have something else to tell the user. Do not edit files while a task is open: the workers' merged result is applied to this working tree. Reports arrive as messages:
- needs_decision or blocked: decide and answer with rsa_steer. Ask the user only when the answer would change the work materially.
- failed: steer the worker with a new approach, or finish with a failure summary.
- When every worker is done, their work is merged and applied to this working tree, and the check commands are run; the message shows the results. The same commands also ran on the base while the workers worked, so each result says whether a failure is new or was already there; failures that were already there are not the task's to fix, so do not investigate them. Look further only as much as you need, then call rsa_finish, or rsa_steer the worker whose paths contain a problem. Its next done Report is merged and applied again.
Do not poll; time matters, and each message ends with the elapsed time.
</while_workers_run>
