# 41 — `kojo gate answer` must report a failed resume, and not exit 0

**What to build:** When answering a gate resumes a run that then fails, `kojo gate answer` says why
and exits non-zero — the same contract `kojo run` now honours.

Ticket 39 fixed `kojo run` and deliberately stopped at its own lane. `gate answer` shares
`describeStop` and `reportPhases` with it but not the exit path, so it still prints `run failed` on
stdout with no reason and exits **0**. Answering a gate is the moment a human hands the run back to
the machine; learning nothing about what happened next is the same defect in the more important
place.

**Blocked by:** 39

**Status:** done

- [x] A resume that ends in failure exits non-zero and names its typed error, as `kojo run` does
- [x] A resume that suspends again at the next gate still exits 0 — that is a success
- [x] The reason goes to stderr, the phase table to stdout
- [x] The exit code is asserted by a test, not only the output
- [x] `run` and `gate answer` share one description of a failure rather than two that can drift

## Comments

Measured on the branch, `demo-review` answered with a rejection:

```
$ kojo gate answer WyJkZW1vLXJldmlldyIsIjg3M… --choice reject --reason "not yet" --database …
recorded reject on run 8730b127ff86ef76923b02dd754694c8, attributed to kabatan
run failed

phases this process ran:
no phases recorded
--- stderr ---
run 8730b127ff86ef76923b02dd754694c8 failed — GateRejected
  gate: approve
  actor: engineer
  reason: not yet
$ echo $?
1
```

The same command with only `cli/gate.ts` reverted to its state before this branch prints the same
first four lines, prints nothing on stderr, and exits **0**. That is the whole defect, and it is what
the exit-code assertions below grade.

**One exit path, in `cli/ends.ts`.** `ends` and `reachedStatus` moved out of `cli/run.ts` unchanged
and both commands now call them; nothing was copied. The rule is small enough that two copies would
have looked harmless and drifted silently — which is exactly what happened between ticket 39 and this
one. `ends` takes the failure lookup **pre-bound to the run**, the way `stopped` already takes its
status, so the rule is one function over a `RunStatus` and a `Cause` and is gradeable without an
engine behind it.

**`--wait` did not spread.** `ends` takes `promisedToWait`, true only for `kojo run --wait`.
`kojo gate answer` passes `false`: its `--timeout` bounds the watching, and the run outlives the
watching of it, so a command that stops looking has nothing to report as a fault. `RunUnsettled` and
its `75` therefore stay where ticket 39 put them.

**A resume that suspends again is a success.** No workflow this build ships has two gates — every one
of them ends or fails on the far side of its only gate — so nothing already here could tell a resume
that suspended from a resume that went wrong. `gateAndResume.test.ts` writes a two-gate workflow
(`sign-off`, then `counter-sign`) into a temp repository's `.kojo/workflows/`, answers the first, and
asserts the answering process exits **0** while the run waits on the second actor.

**What grades what:**

| Property | Test |
|---|---|
| A resume that fails exits `1` and names its typed error on stderr | `exits non-zero and names the error when the answer ends the run` — `tests/integration/cli/gateAndResume.test.ts`, a real `spawnSync`, asserting `status` against the literal `1` |
| A resume that stops at the next gate exits `0` | `suspends at the second gate and exits 0` — same file, same spawn |
| A resume that finishes the run exits `0` | `exits 0 when the answer carries the run through to success` — same file |
| The rule itself: which status fails, which code each failure carries | `tests/unit/cli/ends.test.ts`, asserting `Runtime.errorExitCode` on the raised error |

The exit code is asserted as a number in every case, never as `not.toBe(0)`: `1` and `75` are a pair,
and an assertion that cannot tell them apart passes on either.
