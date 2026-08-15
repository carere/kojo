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

So `lane.test.ts` is flaky on both platforms for **two different reasons**, and only one of them is
about time:

| where | what | evidence |
|---|---|---|
| Linux, 2-core runner | killed at ~185 s against a 180 s limit, a different test each run | two CI runs |
| macOS, OrbStack | `WorkspaceUnreachable` exit 127, ~1 in 4, now visible rather than masked | ticket 50's four-run control, and the 209 s run above |

**Blocked by:** none.

**Status:** ready-for-agent

- [ ] The container tier passes on a two-core runner three times in a row, which is what would make
      *slow* the settled answer rather than the current one
- [ ] What those three tests actually spend their time on is measured on a runner — a container
      build, a workspace probe, a rebuild — rather than inferred from the docstring's arithmetic
- [ ] If any run reaches 480 s, the timeout is not raised again: the hang is found
- [ ] `lane.test.ts`'s note and build-record §5 agree about what this is, and neither still blames a
      container runtime the fault has now outlived

## Comments

*(none yet)*
