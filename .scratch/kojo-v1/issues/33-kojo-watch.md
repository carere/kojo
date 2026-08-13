# 33 — Running the factory unattended

**What to build:** A long-lived process that starts runs from the configured trigger and keeps suspended runs alive across a laptop being closed. This is the mode a real factory runs in.

**Blocked by:** 32, 12

**Status:** done

- [x] The watcher drives runs from the configured trigger on the durable engine
- [x] A gate answered by another process is picked up and applied
- [x] Restarting the watcher resumes every suspended run without re-running completed phases
- [x] Two triggers for the same ticket revision produce one run
- [x] Shutting down cleanly deregisters the runner, and a crash leaves a stale registration that ages out rather than lying indefinitely
- [x] Runs suspended past their deadline are surfaced rather than buried

## Comments

`kojo watch <workflow>` is the command. It composes ticket 32's `Trigger` and ticket 12's
record-and-apply rather than rebuilding either: `runFor` starts each event's run, `stopped` says
where that run came to rest, `oneRunner` claims it, and the engine — which this process now *is* —
applies whatever anybody else wrote down.

**The trigger it runs from is a directory.** `ManualTrigger` emits one event and ends, which is
right for `kojo run` and useless for a daemon, so `InboxTrigger` is the other end of the same port:
one JSON file is one unit of work, acknowledging moves the file into `acked/` with the run id and
outcome written beside it, and an unacknowledged file is offered again after a restart — safe,
because the workflow's idempotency key is what makes a redelivery resolve to the run that exists.

**Two loops, and they answer different questions.** *Driving* stays with each event's run until it
reaches a human or ends. *Sweeping* reads the askings back every few seconds, which is how a
restarted watcher announces the runs it has adopted, how a run that ended while nobody was driving
it gets reported, and how a question past its deadline is surfaced (edge 8). `poll` is asked one
question only — has this run ended.

**What is proved by test, and what is only argued**, because they are not the same:

- Proved by `tests/integration/cli/watch.test.ts`: two runs suspend under one watcher; that watcher
  is **SIGKILLed**; a second watcher adopts both from the askings; verdicts written by a process
  holding no runner and registering no body are applied by that second watcher; and the phase table
  it prints for each run holds `land` and not `draft`. The table is the second watcher's own trace,
  so an empty one would mean somebody else applied the answer and a `draft` line would mean the work
  was done twice — the two failure modes are told apart rather than blurred.
- Proved by the same test: registered while alive, the row survives a crash, its heartbeat stops
  advancing (measured against the ten-second refresh interval a live runner keeps), and a clean
  `SIGTERM` leaves the table empty.
- **Argued, not proved:** that the stale row is removed at exactly thirty-five seconds. That window
  is the cluster's own `shardLockExpiration`, applied by `getRunners` to the same column; the test
  measures the mechanism the window is applied to rather than sitting out the window.

Also measured, and worth knowing before the Console's health check is written: every runner
registers at the same address by default, so a short-lived `kojo run` **deletes the live watcher's
row on exit** — the row comes back on the next heartbeat, so "no runner" can be a false negative for
up to ten seconds.
