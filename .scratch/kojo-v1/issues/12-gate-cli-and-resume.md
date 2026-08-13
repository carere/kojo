# 12 — Answering a gate from the CLI

**What to build:** The full loop a human lives in: start a run, watch it stop at a gate, close the terminal, come back later, answer, and see it continue exactly where it stopped. This is the phase-2 payoff and the proof the design works.

**Blocked by:** 10, 11

**Status:** done

- [x] A run suspends, the process exits, the answer command resumes it, and nothing re-runs
- [x] Listing gates shows what waits on a human and for how long
- [x] The verdict is a single choice flag, so contradictory or missing decisions are rejected by the parser rather than by a handler
- [x] Starting a run reports where it stopped and exits successfully; a suspended run is a success, not a hang
- [x] An opt-in flag blocks until the run reaches a terminal status, for scripts that want that
- [x] Runs suspended past their deadline are visible in the run list rather than buried

## Comments

### The loop, measured

Three real processes, on nothing but one SQLite file:

```
$ kojo run review "the change" --database kojo.db
run a4d9cbd77ca46d75fed70f58b66ce186
gate "approve" waits on engineer  ·  run a4d9cbd77ca46d75fed70f58b66ce186
suspended at gate "approve" — waiting on engineer, 1d 23h left
  kojo gate answer WyJyZXZpZXci… --choice approve --reason "<why>"
phases this process ran:
PHASE  KIND  OUTCOME  DURATION  DESCRIPTION
draft  code  ok       0ms       Prepare the change the human is asked about

$ kojo gate list --database kojo.db
STATE    RUN                               GATE     ACTOR     WAITING  DEADLINE   TOKEN
waiting  a4d9cbd77ca46d75fed70f58b66ce186  approve  engineer  9s       in 1d 23h  WyJyZXZpZXci…

$ kojo gate answer WyJyZXZpZXci… --choice approve --reason ships --database kojo.db
recorded approve on run a4d9cbd77ca46d75fed70f58b66ce186, attributed to kabatan
run succeeded
phases this process ran:
PHASE  KIND  OUTCOME  DURATION  DESCRIPTION
land   code  ok       0ms       Land what the human approved
```

**`draft` is in the first table and not in the second.** That is "nothing re-runs", printed by the
CLI itself: the second process replays the whole body, and the phase before the gate comes back as a
recorded activity result without its body running again. The whole answer-and-resume took 0.28 s of
wall time.

### What landed

**Gate context — the askings, which are the other half of the reference adapter.**

- `models/AskedGate.ts` — one asking as a surface that never ran the workflow sees it: the request,
  the verdict if one was written, `waitedMillis`, `remainingMillis`, and a `waiting | overdue |
  recorded` state. Plus `waitingFirst`, which sorts overdue above waiting and long waits above short
  ones. This is **not** `GateRecord`: that is written once when an asking *settles*, and a gate still
  waiting has no settlement to write. This exists for the interval between the two, which is the
  interval a human lives in.
- `models/GateStoreError.ts` — `ask | record | read`, the three ways the store fails.
- `ports/GateRepository.ts` — `asked`, `recorded`, `byToken`, `all`.
- `adapters/InMemoryGateRepository.ts`, `adapters/SqliteGateRepository.ts`.
- `adapters/RecordingGate.ts` — the `Gate` the CLI ships: write the asking down, then print how to
  answer it. A store that cannot be written becomes `GateUnreachable`, because an asking nobody can
  list is an asking nobody will answer.
- `adapters/TerminalGate.ts` — `describe` is now exported, so both adapters give a human the same
  words. Nothing else changed.
- `services/answerGate.ts` — returns the `Verdict` it wrote instead of discarding it, so the askings
  list records the *same* verdict with the same clock rather than a second one built from the same
  arguments.

**Workflow context.**

- `services/stopped.ts` — `stopped` and `askingsSoFar`. Waits for **this** execution of the body to
  stop and says where. Driven by the durable askings, never by `poll`; the engine is still asked, and
  asked **first**, so a run whose gate expired and then failed is reported as failed rather than as
  waiting on a human who can no longer affect it.

**CLI.**

- `root.ts` — the root and its `--database` shared flag, split from `kojo.ts` so a subcommand can do
  `yield* root` without an import cycle.
- `gate.ts` — `kojo gate list` and `kojo gate answer`.
- `run.ts` — rewritten: `{ discard: true }`, prints where it stopped, exits 0, and `--wait` for
  scripts.
- `review.ts` — the smallest workflow that waits on a human: draft, gate, land.
- `workflows.ts` — the registry, with the four generic parameters erased. **The layer in it is
  load-bearing**: recording a verdict needs no workflow body, but *applying* it needs the runner in
  that process to have one, so a CLI that answered without registering the workflow would record a
  real verdict and leave the run exactly where it was.
- `factory.ts`, `gateTable.ts`, `stopLine.ts`, `reportPhases.ts`, `CommandFailed.ts`.

### Decisions worth arguing with

- **`kojo gate list` builds no engine.** The engine would make the process a runner, and a runner
  applies every verdict written since one last ran — so *listing* what is waiting would resume runs.
  Looking must never be an act of execution; same reason `kojo ui` does not host the engine
  (adr/gate/0001).
- **The askings table is created with `create table if not exists`, not through
  `SqliteDatabase.migrated`.** The migrator writes one ledger and **ticket 24 owns that ledger this
  wave**; two migrator layers over one ledger disagree about which migration `0001` is. This is a
  deliberate, temporary dodge of a merge conflict, flagged here so it is folded into the ledger the
  moment there is one to fold into.
- **`--choice`, one `Flag.choice`, values `approve | reject`.** A gate declaring other choices is
  refused with a message naming what it does accept, rather than answered with a verdict the workflow
  would read as a rejection. Widening the flag is one line; inventing a decision is not.
- **The CLI's poll intervals are 250 ms, not the cluster's 10 s.** `kojo gate answer` is also the
  runner that applies the answer, so the default would make every answer sit for ten seconds before
  the run moved.
- **The trace is still `InMemoryTracer`** — the durable trace is ticket 24. So `phases this process
  ran` is exactly that, and the limitation is also the cheapest replay witness there is.

### API findings, each with how it was checked

- **`--help` short-circuits the whole parse.** `Command.runWith` returns *success* for
  `["gate","answer","tok","--choice","approve","--nonsense","y","--help"]` — an argv carrying an
  unrecognised flag. Nothing about flag visibility can be read from a run with `--help` in it, which
  is why the shared-flag test asserts on *what the parser complains about* instead. Measured with a
  throwaway probe test.
- **`ShowHelp` carries `errors`,** so a parse failure can be asserted precisely:
  `["gate","answer","--database","x"]` fails with one complaint, `Missing required argument: token`,
  and none about `--database` — which is the proof that `withSharedFlags` reaches a grandchild
  command.
- **`Effect.catchAll` is v3.** The language service names it: *Renamed to catch*. It also poisons
  inference downstream — the first symptom was an `unknown` requirement in `main.ts`, three files
  away.
- **`Runtime.errorReported = false`** on an error class suppresses the runtime's automatic report,
  which is what `CliError` itself does. Without it, `unknown workflow: nope` prints with a stack
  trace.
- **`Flag.choice` rejects a bad value with exit 1 and no handler runs** (`Invalid value for flag
  --choice: "maybe"`), and `--approve --reject` is two `Unrecognized flag` errors. Both run against
  the real binary.
- **Biome's `useIterableCallbackReturn` fires on the curried `Effect.forEach(fn)`** and not on the
  two-argument `Effect.forEach(rows, fn)`.

### Checks

All by moon task: `kojo:check`, `kojo:tsc`, `kojo:check-public-types`, `kojo:test`,
`kojo:test-integration`, `root:check`, `root:tsc`. Plus `bun tsc --build`, `bun biome check .`,
`bun knip`.

- Unit: **254 passed** (was 222). Integration: **102 passed, 1 skipped** across 16 files (was 92 + 1
  across 14).
- **`bun knip` is a check that does no work here, and it was proved so.** A brand-new file exporting
  an unused symbol under `packages/kojo/src` is reported as nothing at all. The cause is
  `package.json`'s `"exports": { "./*": "./src/*.ts" }`: every file under `src` is an entry point, so
  nothing under it can ever be unused. Green, and worth nothing.
- **`moon run kojo:tsc` replays a cache** and prints `up to date` / `cached` even after its buildinfo
  is deleted. `bun tsc --build` was proved to do real work instead: a deliberate
  `const wrong: number = "not a number"` in `src/cli/` produced `TS2322`, and removing it went clean.
- No Moon task and no Vitest project were added. `tests/integration/**/*` is already an input of
  `kojo:test-integration`.

### The one thing that is not clean

`tests/integration/contexts/workflow/services/lane.test.ts` — **ticket 19's container lane — failed
three times while this ticket was being built, and it is flaky rather than broken by this work.**
The evidence, all measured here:

- Three failures, three *different* symptoms: a session-id mismatch, and two 180-second timeouts on
  two different tests of that file.
- The file passes in isolation, both on the base branch and with this branch's changes (50 s each).
- A JSON reporter run gives the execution order: **`lane.test.ts` runs first, at t=0**, and this
  branch's new integration file runs **last**. Nothing added here can precede it.
- The final two full-tier runs on this branch both pass: 16 files, 102 passed, 1 skipped, 65 s.

Ticket 19 already recorded this file as fragile — *"3 of 4 failed under `$TMPDIR`… a large reduction
and is not a cure"*. The failures here were during a stretch of repeatedly re-running the Docker lane.
Nothing about it was changed.
