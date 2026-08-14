# Authoring a Kojo workflow

A workflow is an ordinary Effect program. Kojo supplies four primitives, the ports they plug
into, and the durability that lets a run wait days for a human — and nothing else. There is no
lane taxonomy, no fixed phase order and no built-in definition of done: those are yours.

| Primitive | What it is | Owns |
|---|---|---|
| `actor` — `gate`, `reviewed` | a human deciding, mid-run | the decision |
| `code` | a known invocation | determinism |
| `agent` | reading and deciding | the judgement call |
| `sandboxed` | an environment around a **region** | the blast radius |

Plain control flow expresses the rest: `Match` on an envelope's discriminant to pick a lane, a
`for` loop for a correction cycle, an early return on a refusal.

## The six rules that only fail later

**1. `sandboxed` goes around the phases, never inside one.** A gate suspends the run by
interrupting it, and a phase retries on interrupt — so a sandbox acquired *inside* a phase turns
waiting for a human into a defect. Around the phases, the container is torn down while the human
thinks and rebuilt from the branch when they answer.

**2. A loop that contains a gate must be `reviewed`, never `while` or `for`.** A durable deferred
is keyed by name and refuses to be overwritten, so a hand-written loop reads the *first* verdict
back forever: five rounds in milliseconds, one human, and a run that believes it was reviewed
five times. `reviewed` names each asking from the engine's own attempt counter, which is the only
counter that advances. Every other loop stays plain control flow.

**3. Nothing irreversible happens outside a phase.** The body replays from the top on every
resume; a completed phase returns its recorded result instead of running again. A `git push` in
body code, not inside a phase, fires again days later when somebody answers.

**4. The work has to reach the branch before a gate.** The branch is the durable state of a run.
A worktree left dirty at a suspension is not merely lost — the rebuild on resume refuses it, and
the run cannot continue at all. Commit before you ask anybody anything.

**5. Preparing the environment is a sandbox hook, never a phase.** Installing dependencies,
starting a database, warming a cache: a phase replays its recorded *result* and does not run
again, so the first phase after a suspension finds a freshly rebuilt worktree that nothing
prepared. Put it in `hooks`, which runs on every acquisition. Mind which slot: a container
provider runs `sandbox.onSandboxReady`, and a no-sandbox provider runs only
`host.onWorktreeReady`.

**6. If the repository enforces a commit convention, the workflow has to satisfy it.** A
`commit-msg` hook runs inside the `commit` phase — and on the **merge** commit too, where git's
default is `Merge branch '<branch>'`. An agent's own summary becomes the commit message, so wrap
it: name the type in code, and pass `message` to `merge`. A hook refusal arrives as
`CommitRefused` or `MergeRefused` after the work is already done, and at the merge it arrives
after a human has already approved.

## The contract

An envelope is **one declaration** — the type at the call site, the decoder, the JSON Schema
rendered into the agent's prompt, and the wire contract. Never write an example of it by hand;
the prompt already carries the schema, and a hand-written example is a second contract to keep in
step.

A **check** compares an envelope's claims against the repository, after the fact, and returns
faults rather than a boolean — the correction turn is written from the fault. Checks never ask the
agent anything.

**Agents propose, code disposes.** An agent puts a commit message on its envelope; a code phase
performs the commit. An agent reports which files it changed; a check verifies it. An agent never
runs the merge — `merge` takes an `Acceptance`, and only a gate and a measurement produce one.

**Acceptance gates the merge**, and it is the conjunction of the mechanical verdict and the human
one. Phases passing is a different question: a test phase that ran a red suite did its job
perfectly. Either half refusing merges nothing, leaves the trunk untouched, and leaves the
branch and worktree intact for inspection.

## Commands

`.kojo/commands.ts` is the one place a factory writes down what its code phases run. A freshly
stamped factory ships obvious placeholders that print `KOJO-PLACEHOLDER` and exit 78, and until
they are replaced the mechanical half of every acceptance refuses. That is deliberate: a
plausible-but-wrong command that exits 0 would report a clean suite that never ran.

Run them through the `Workspace` port, never through a shell directly, or they grade the
repository you are sitting in instead of the one the agent wrote in.
