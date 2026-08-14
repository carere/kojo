---
name: kojo
description: >-
  Drive the Kojo factory in this repository: start a run, see what is waiting on a human, answer
  a gate, apply an answer, and read a run back out of the trace. Use whenever the task is to run,
  resume, unblock, inspect or author a Kojo workflow, or whenever a `.kojo/` directory is present
  and the work touches it.
---

# Driving Kojo

This repository holds a **factory** in `.kojo/`: a roster of agents, one or more workflows, the
envelopes those workflows decode, the checks that grade them, and the commands their code phases
run. The Kojo engine is a versioned dependency, not a copy — nothing under `.kojo/` is engine
source, and upgrading Kojo never means re-stamping.

Read `.kojo/README.md` first. It says which file decides what.

## Two facts about the commands themselves

**`kojo` is probably not on your PATH.** Every example below is written `kojo …` for brevity, but
the engine is a dependency of this repository, not a global install: the binary is
`node_modules/.bin/kojo`. Settle it once and use whatever answers for every command that follows:

```bash
command -v kojo || ls node_modules/.bin/kojo
```

**`kojo watch` and `kojo ui` never exit on their own.** `watch` polls the inbox for ever and `ui`
is an HTTP server. Both hold the terminal until something kills them. Run them in the background,
or under a timeout, and never as the last foreground command you are waiting on — that mistake is
indistinguishable from a hang and has cost this project hours. `--sweep <n>` sets the *seconds
between sweeps*; it does not bound the command and does not make it return. Every other `kojo`
command terminates by itself, `kojo run` included.

## Before you run anything

```bash
kojo doctor
```

It loads every file in `.kojo/`, decodes the roster, imports each workflow, builds a payload
against the engine's own schemas, and exits non-zero with a remedy per fault. It writes nothing
and starts nothing. **A factory that fails `doctor` cannot run**, and the line it prints names
the file to open. Two faults are worth recognising on sight:

- *`.kojo/` cannot resolve kojo or effect* — the repository has not been installed. Install, and
  re-run `kojo init` first if `package.json` does not name both.
- *two copies of `effect`* — the workflow's schemas and the engine's are then different types,
  and a run dies inside the framework at an innocent line. Pin the exact version `doctor` prints.

## Starting a run

```bash
kojo run                       # --help lists the workflows this factory has
kojo run <workflow> "<what the run is about>"
```

The workflow name is the file name under `.kojo/workflows/`, and the module must declare the same
name — Kojo refuses one that does not, so the name typed and the workflow run are never two
different things. Kojo's own demonstrations are all called `demo-something` and cannot shadow a
factory's own name.

The quoted word is the whole payload: it fills the single field the workflow declares.

**Four things about `kojo run` that surprise people, in the order they bite.**

1. **It does not block on a gate, and a suspended run is a success.** The command prints where
   the run stopped and exits 0. Do not read that as a finished run, and do not hold the terminal
   open waiting: the run is holding nothing, and the answer can come days later from anywhere.
2. **A run is deduplicated by its idempotency key**, which is a function of the workflow and the
   payload. Running the same subject again does not start a second run — it returns the recorded
   one, **including a recorded failure**. To retry after a failure, change the subject. That is
   the deduplication working, not a bug.
3. **The trunk has to be checked out and clean.** The merge at the end of a run happens in the
   repository the run was started from, and it refuses — by name, saying which branch it found
   and which it wanted — rather than landing work somewhere nobody expected. Commit or stash
   first.
4. **`--timeout` is how long the command *watches*, not how long the run gets.** The run outlives
   the watching of it. A phase that takes minutes needs a bigger number, or the command stops
   describing a run that is still going.

## Answering a gate

```bash
kojo gate list                                  # what is waiting, on whom, and for how long
kojo gate answer <token> --choice approve       # or reject, with --reason
```

**Recording a verdict and applying it are two different acts, and the second needs a runner.**
`kojo gate answer` does both when it can. Anything that only records — the Console's gate card,
for instance — says so in as many words (*"Recorded — nothing is running"*), and the answer sits
in the queue until a runner picks it up:

```bash
kojo watch                                      # becomes a runner; applies answers as they land
```

**That command does not return** — see the top of this file. Background it, and confirm the answer
was applied by looking at the queue rather than by waiting on the process.

So an answer that appears to do nothing is usually an answer nobody is running. Check `kojo gate
list` — an applied asking leaves the queue.

Every gate carries a **deadline** and a declared branch on expiry: fail, auto-reject, or escalate
to somebody else once. An expired asking is settled by whichever runner next sweeps, and it leaves
the queue like any other.

## Watching a run

```bash
kojo ui                                         # the Console, on http://localhost:4321
```

**That command does not return either**, and it needs a front end to serve. An installed `kojo`
ships the Console already built. If the page instead says *the front end is not built yet*, you
are running the engine from a source checkout, where the Console is build output rather than a
committed file: build it in that checkout, then **restart `kojo ui`** — the server resolves the
directory once at startup, so a build under a running server changes nothing.

The Console is read-mostly: it shows the run list, a waterfall of one run over its scope tree, a
detail panel per phase or sandbox acquisition, and the gate queue — and it can record a verdict.
It deliberately does **not** host a runner, because looking at runs must never be an act of
executing them.

## What not to do

- **Do not edit anything under `.kojo/` as part of the work a run asked for.** The roster, the
  workflows, the envelopes, the checks, the commands and the prompts are the agent's own grader.
  The permission guard fingerprints the tree around every agent call, rolls unauthorised writes
  back, and fails the phase — a breach is not something a better answer can fix, because the
  write already happened.
- **Do not run `git merge`, `git push` or a release by hand to finish a run.** Merging is the
  workflow's last code phase and it hangs on the acceptance — the suite's verdict *and* the
  human's. Doing it by hand lands work that was never accepted.
- **Do not add a side effect to a workflow body outside a phase.** A body replays from the top on
  every resume, and only a recorded phase replays its result instead of re-running. See
  `authoring.md`.

## Authoring or changing a workflow

Read `authoring.md` beside this file. It is short, and three of its rules are the kind that only
fail on the first suspension — days after the mistake.
