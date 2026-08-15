# 62 — A container test's timeout was calibrated on the machine that wrote it

**What to build:** Either a `lane.test.ts` that finishes inside its limit on a two-core runner, or
the measurement showing that what looks like slowness is a hang.

## What was measured

The first two CI runs of the container tier after ticket 59 removed the last environment assumption:

| run | test that died | at |
|---|---|---|
| 1 | `leaves one sandbox record per rebuild, each with its own id and its own cost` | 184.8 s |
| 2 | `replays the completed phases in milliseconds, and asks the agent once per asking` | 185.5 s |

**274 passed both times.** A different test each run, both in `lane.test.ts`, both just past the
180 s limit those three tests carry. The whole tier finishes in ~150 s on the machine this was
written on.

## Why the shape matters

A **different** test each run, each dying a few seconds past the limit, is the signature of a limit
that is slightly too small. A hang would kill the same test every time, at exactly the limit, and
would not care which one it was.

The file's own docstring already carries the arithmetic that explains it:

> Each occurrence costs a whole extra container build — roughly 40 s here — and these tests carry a
> 180 s timeout.

That is 180 s chosen against a ~40 s container build on a ten-core Mac. A two-core GitHub runner
builds the same image several times slower, so one recovery through edge 11 — the workspace probe
rebuilding a container that did not answer, which is *correct behaviour* — is enough to overrun it.

**And it is not OrbStack.** The build record's §5 attributes this timeout shape to Docker Desktop's
file sharing and then to OrbStack's; it now reproduces on Linux with plain Docker, on hardware that
has nothing in common with either. That entry is corrected.

## What was done, and what it does not settle

The timeout is now `laneTimeout = 480_000`, named once, with the reasoning beside it. That is the
same arithmetic against a slower build — **a number to be measured again rather than one anybody
knows.**

It does not prove the tests are merely slow. If a run ever spends the whole 480 s, that is the
evidence this is a hang after all, and it is worth more than the eight minutes it costs to learn.

**And raising it immediately showed one thing the old limit was hiding.** The next local run failed
`builds a container, tears it down at the gate, and builds another one on the answer` at **209 s** —
*inside* the new limit, so not a timeout at all. That is the `WorkspaceUnreachable{exit 127 … chdir
to cwd}` fault ticket 37 and edge 11 already carry, which ticket 50's lane measured at **1 failure
in 4 with its change and 1 in 4 with the whole ticket stashed**. At 180 s it was being killed before
it could say that; at 480 s it fails on its own assertion and names the cause.

### The measurement that refuted this ticket's own reading

The run at 480 s **passed**, and its log carries the number that matters:

    ✓ tests/integration/contexts/workflow/services/lane.test.ts (8 tests) 53347ms

**Fifty-three seconds for the whole file, on the same two-core runner** where a single test had
burned 185 s and been killed. So the runner is not slow, and *"a limit slightly too small"* — the
reading this ticket was opened under — is wrong. A healthy file is 53 s; a failing test alone is
three and a half times that.

**What the time goes into is `containerLimit`.** `sandboxed.ts` rebuilds the container when the
workspace it gets back does not answer, up to **three** times, and the local failure names exactly
that exhaustion: `WorkspaceUnreachable{… "containers": 3 …}`. So a failing test is not slow work; it
is the edge-11 recovery running its full course and losing.

**Which makes it one fault, not two.** The table that stood here said Linux and macOS were flaky for
different reasons. They are the same reason at different rates: the workspace-unreachable fault
fires, the scope rebuilds up to three containers, and the run either recovers or exhausts. macOS
shows the exhaustion (`containers: 3`, ~1 in 4 by ticket 50's four-run control); the Linux runs were
killed part-way through the same recovery, so they showed a timeout instead of a cause.

That is the **third** diagnosis this cluster of failures has produced and the third correction —
after ticket 60's `catchAll` and ticket 61's git version. The pattern is worth naming: every one was
a theory about *why the machine differed*, and every one was refuted by measuring the thing itself.

### What is still not known

How long one rebuild costs **on a runner**. Locally it is ~40 s; the image is four lines of alpine,
so it ought to be quick there too, and three quick rebuilds do not obviously add up to 185 s. Until
that is measured, the timeout stays at 480 s — not because 480 is right, but because lowering it
would be a fourth theory, and this ticket has already paid for three.

**Blocked by:** none.

**Status:** ready-for-agent

- [ ] The container tier passes on a two-core runner three times in a row, which is what would make
      *slow* the settled answer rather than the current one
- [x] What the time goes into is measured rather than inferred: the edge-11 recovery rebuilding up
      to `containerLimit` = 3 containers, named by `WorkspaceUnreachable{containers: 3}`. A healthy
      file is 53 s for eight tests on the same runner
- [ ] How long **one rebuild** costs on a runner, which is the number that would justify any
      timeout at all. Locally ~40 s; on CI unmeasured
- [ ] If any run reaches 480 s, the timeout is not raised again: the hang is found
- [ ] `lane.test.ts`'s note and build-record §5 agree about what this is, and neither still blames a
      container runtime the fault has now outlived

## Comments

*(none yet)*
