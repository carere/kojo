# 39 — A failed run must say why, and must not exit 0

**What to build:** When a run fails, `kojo run` prints the reason and exits non-zero. Today it
prints the two words `run failed`, discards the typed error that says what went wrong, and **exits
0** — so a human learns nothing and a script learns the opposite of the truth.

Measured on the current tree:

```
$ kojo run demo-hello Kevin --fail
…phase table, `deliver` marked FAIL…
run failed
$ echo $?
0
```

The typed error channel is the thing this design spent its whole error story on — `GreetingRefused`
here, `NotAccepted`, `CheckViolation`, `PermissionBreach`, `AgentInvocationError` in real lanes —
and none of it reaches a surface a person reads. `AbsentAgentInvoker`'s sentence, which exists
precisely to explain why no agent ran, dies in the same place.

**This blocks ticket 15**, which has a budget of five real agent calls. A ticket that cannot see why
a call failed, and cannot script a pass, will spend that budget learning nothing.

**Blocked by:** 12

**Status:** done

- [x] A failed run exits non-zero, and a succeeded run exits 0
- [x] The failure names its typed error and carries whatever that error knows — the agent, the check,
      the breached path, the refusal's own words — rather than a bare tag
- [x] A run that ends suspended still exits 0: a suspended run is a success, not a failure. Only
      `--wait` that times out on a suspended run is its own case, and it says which
- [x] The reason goes to stderr and the phase table to stdout, so a script can separate them
- [x] `--wait` reports the terminal status it actually observed, and its exit code agrees with it
- [x] A test asserts the exit code, not only the output — this is the kind of defect a test that
      greps stdout cannot see

## Comments

Measured on the branch, the same command the ticket opens with:

```
$ kojo run demo-hello Kevin --fail
run b3f6ea271ebbcac0adab4fddb21d5419
run failed

phases this process ran:
PHASE    KIND  OUTCOME  DURATION  DESCRIPTION
compose  code  ok       0ms       Build the greeting that the run exists to deliver
deliver  code  FAIL     0ms       Deliver the greeting, or refuse to when asked to fail
--- stderr ---
run b3f6ea271ebbcac0adab4fddb21d5419 failed — GreetingRefused
  who: Kevin
$ echo $?
1
```

**Three exits, not two.** `RunFailed` carries `Runtime.errorExitCode = 1`; `RunUnsettled` carries
`75` (`EX_TEMPFAIL`). The second exists because `--wait` timing out is not the run failing: the run
is durable and still going, and a script must be able to tell *this failed* from *ask again later*.
Both set `Runtime.errorReported = false` for the reason `CommandFailed` already did — the runtime's
automatic report is a stack trace of the CLI, and the CLI is not where the failure is.

**The reason is walked, not switched on.** `describeFailure` renders a cause by walking the error's
own enumerable fields, because every typed error here is a `Schema.TaggedError` and its fields are
its properties. A table of cases per tag is a table that goes stale — the error added next release
would render as nothing, and nothing looks exactly like an error with no fields. The walk handles
`GreetingRefused`, `AgentInvocationError`, `CheckViolation` (down into the nested `ClaimFault`),
`PermissionBreach` (each path and what became of it), `EnvelopeParseError` and `NotAccepted` without
naming any of them.

**`AbsentAgentInvoker`'s sentence now reaches a person.** `kojo run review "the change"` in a stamped
repository prints, on stderr, `AgentInvocationError` with `agent: drafter`, `fault: provider-failed`
and the whole "no agent provider is wired into this build" sentence, and exits 1. That is graded by
`says why no agent ran, and exits non-zero for it` in `tests/integration/cli/stampedRun.test.ts`.

**The proof grades the exit code itself.** `tests/integration/cli/failedRun.test.ts` spawns a whole
`kojo` process and asserts `ran.status` against the literal `1` and `75` — not `not.toBe(0)`, which
could not tell a failed run from a watch that gave up. Verified by regression: with the exit line in
`run.ts` replaced by `Effect.void`, three of its five tests fail with `expected +0 to be 1` and
`expected +0 to be 75`, and none of them fails on a string. A run that suspends and a run that
succeeds are asserted at `0` in the same file, so the fix cannot over-reach into the design's normal
path.

**One test in another file relied on the defect.** `stampedRun.test.ts`'s first test ran
`kojo run review` through a `succeeded()` helper that throws on a non-zero exit — it passed only
because a failed run exited 0. It now reads `ran.stdout` directly and keeps every assertion it had.

**Left alone deliberately:** `kojo gate answer` prints `run failed` on stdout and still exits 0 when
the run it resumed fails. It shares `describeStop` and `reportPhases` with `run` but not the exit
path, and this ticket's lane is `kojo run`. It is worth its own ticket.
