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

**Status:** ready-for-agent

- [ ] A switch the **`AgentInvoker` adapter** honours: with it set, any real invocation fails with a
      typed error naming the switch, before a process is spawned. Not a test gate
- [ ] It is on by default in every automated context this repo runs — the browser tier, the
      integration tier, and anything an agent drives — so spending requires an explicit opt-in rather
      than remembering not to
- [ ] The refusal names what would have been called: the agent, the provider, the model, the run
- [ ] A test proves it by attempting a real invocation with the switch set and asserting the typed
      refusal — and a second proves the switch is on by default rather than merely available
- [ ] `kojo doctor` reports whether the switch is set, so a person can see which mode they are in
- [ ] The remaining unspent authorisation (one, from ticket 48's three) is **not** used for this;
      the whole point is that this is provable without spending
