# 49 — A factory must be able to refuse to call a real model at all

**What to build:** A switch that makes an agent invocation structurally impossible, honoured by the
**invoker** rather than by a test. Today there is no such thing, and its absence cost two
unauthorised calls on the owner's account.

## What happened

`KOJO_REAL_AGENT` gates the real-agent **test**. Checked: it appears nowhere in
`packages/kojo/src/`. It has never gated the CLI.

So an agent driving a walk-through can honestly report *"`KOJO_REAL_AGENT` was never set"* and
*"no real agent call was made"* — and be wrong. Stamping a factory with `--agent claude` and running
`kojo run` invokes the real binary, flag or no flag. Two walk-throughs did exactly that:

| when (UTC) | model | output tokens | which walk |
|---|---|---|---|
| 2026-08-11 22:01 | `claude-sonnet-4-6` | 2401 | the wave-15 loop walk (`--model claude-sonnet-4-6`) |
| 2026-08-11 22:37 | `claude-opus-4-8` | 3364 | the wave-16 loop walk (`--model claude-opus-4-8`) |

Both walks intended a stand-in and put a shell script named `claude` on the child's `PATH`. The agent
is spawned by Sandcastle as a child process, and in these two runs it resolved the **real** binary
instead. A `PATH` override is not a guarantee, and nothing downstream noticed.

The ledger is recorded at the top of `tests/integration/cli/realAgent.test.ts` and in
`typescript-effect.md` §12: **nine invocations spent, eight ever authorised.**

## Why a test flag was the wrong shape

The thing being protected is *somebody's money*, and the thing that spends it is the **invoker**. A
guard that lives in the test tier protects the test tier. Every other invariant in this build that
mattered was made structural — a `PermissionBreach` the correction loop cannot catch because the
compiler refuses the handler; a wire contract the record constructor refuses to build. This one was
left to a convention, and a convention is what failed.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] A switch the **`AgentInvoker` adapter** honours: with it set, any real invocation fails with a
      typed error naming the switch, before a process is spawned. Not a test gate
- [x] It is on by default in every automated context this repo runs — the browser tier, the
      integration tier, and anything an agent drives — so spending requires an explicit opt-in rather
      than remembering not to
- [x] The refusal names what would have been called: the agent, the provider, the model, the run
- [x] A test proves it by attempting a real invocation with the switch set and asserting the typed
      refusal — and a second proves the switch is on by default rather than merely available
- [x] `kojo doctor` reports whether the switch is set, so a person can see which mode they are in
- [x] The remaining unspent authorisation (one, from ticket 48's three) is **not** used for this;
      the whole point is that this is provable without spending

## Comments

### 2026-08-13 — the guard is a value the invoker reads, and no call was spent proving it

**What landed.**

- `src/contexts/agent/models/AgentSpend.ts` — the switch and its decoder. `KOJO_AGENT_SPEND`, three
  modes, and `spendFrom({declared, attended})` as a pure function of a string and a boolean.
- `src/contexts/agent/guards/maySpawn.ts` — the decision. Given the mode, who would be called, the
  binary the provider's command names, a **resolver**, and the sandbox kind, it answers `Spawn` or
  `Refused` with the sentence.
- `SandcastleAgentInvoker` consults it after the roster and **before `sandbox.agent`**, and raises
  `AgentInvocationError{fault: "refused-to-spend"}`.
- `readiness.spendFinding` + `diagnose` — one `spend` line on every `kojo doctor`, beside `runtime`
  rather than with the factory, because it is a fact about the process and is reported even where no
  factory exists.
- The stamped README gained *Unattended runs do not call an agent unless you say so*.

**Three modes, and the third is the one that matters.** `refuse` and `allow` alone would have forced
every test that needs a scripted binary to declare `allow` — which is exactly the sentence the two
lost walk-throughs would have written, and it would have bought nothing. So:

    stand-in:<absolute path>

means *a process may run, and here is the only file it may be*. The invoker resolves the binary name
itself (`Bun.which`) and refuses anything else. **Both unauthorised calls in this build would have
been refused by it**: each put a script named `claude` on the child's `PATH` and each resolved the
real binary, and the guard compares the resolution rather than the intention. A relative stand-in is
refused rather than resolved, because "resolved somewhere other than you thought" is the fault.

`stand-in` on a container sandbox is **refused**, not approved: a container's `PATH` is not this
machine's, and answering *the stand-in is in place* about an image nobody looked inside is the same
false assurance in a new costume.

**On by default, and what "default" means.** Unset is not one answer. A person at a terminal typed
`kojo run` and is watching it; an unattended process is where both unauthorised calls happened. So
attendance decides — `process.stdin.isTTY` — and no Vitest worker, Playwright fixture, CI step or
agent-driven shell has a terminal. Nothing had to be configured for the guard to be on in every
automated context this repository runs; it is on because of what those contexts *are*.

**Where the seam is, and where it deliberately is not.** `layer({spend})` takes an override so
Kojo's own adapter test can drive a provider it constructed on the page. `fromConfig` — what every
**stamped** workflow calls — takes none, so no factory can turn the guard off from a workflow file.

**Graded, then broken to prove the grading.** 30 new unit tests over the switch and the guard, two
new integration tests over the real adapter, one over `kojo doctor`. Every refusal path asserts the
prompt log is **empty**, which is what makes *"before a process was spawned"* a measurement rather
than a claim. Three mutations, each reddening its named test and nothing else:

| mutation | what went red |
|---|---|
| delete the `resolved !== spend.binary` comparison | `refuses a stand-in that is not what the name really resolves to`, and the naming property |
| make the unattended default `Allow` | `defaults to allow when a person is attached and to refuse when nobody is`, and the integration `refuses by default in an unattended process` |
| move the refusal to **after** `sandbox.agent` | `refuses before anything is spawned when the switch says refuse` — the prompt log is no longer empty |

**Spend: nothing.** No agent call was made. Ticket 48's remaining authorisation is untouched, which
was the last criterion.

**What the suite had to say out loud.** Four CLI suites drove a scripted `claude` through a `PATH`
and now declare `stand-in:<absolute path>` instead — `correctionLoop`, `landsOnTrunk`,
`initInstructions`, and `throwawayRepo`'s shared helper. They lost nothing and gained a check: what
they used to assume is now verified on every run. `realAgent.test.ts` declares `allow`, in one
constant with the reason written beside it, and that is now the only place in this repository that
says it may spend.

`stampedRun.test.ts` is the one deliberate change of an assertion: its *says why the agent never
answered* case now reads `fault: refused-to-spend` rather than `provider-failed`. The reporting path
it grades is unchanged — a whole typed error, from the invocation through the engine to stderr, field
by field. What changed is that the missing binary is now found **before** a spawn instead of by one.
Declaring `allow` there instead would have left the suite one stray `/usr/bin/claude` away from
spending money on every CI run, which is the trade this ticket exists to remove.

**Verification.** `bun tsc --build --force --verbose` (three projects, all rebuilt),
`bun biome check .`, `bun knip`, and every moon task run by name. Unit **612**, integration
**255 passed with 3 named skips**, browser **91**.

One integration test was red for the whole of this ticket and was **not** this ticket's:
`ownFactory.test.ts > carries exactly the skill a stamped repository gets` could not read
`.claude/skills/kojo/SKILL.md`, because this working copy had no `.claude/`. Confirmed against a
baseline run with every change stashed, which failed identically. The owner restored both files at
`.agents/skills/` — byte-identical to what `kojo init` writes, checked rather than assumed — and
`.claude/skills/kojo` is now a symlink to that directory. `skillsDirectory` is unchanged, so nothing
about what a stamped factory carries moved.

**One flake, identified rather than rerun-until-green.** A second full integration run took
`lane.test.ts > builds a container, tears it down at the gate, and builds another one on the answer`
red with `WorkspaceUnreachable{containers: 3, exit 127 — chdir to cwd … no such file or directory}`.
That is §5 rung 7 of the build record exactly: stale containers, measured there at 4.5× slower with
the timeout reading as a failure. `docker container prune -f` reclaimed 229 MB and the next run was
254 passing again. The lane suite touches no agent invocation, so it is outside this ticket's reach
either way — but *"it passed the third time"* is not a finding, and this one has a cause.
