# 52 — Prove a real `pi` session resumes, and that the second call costs one message

**What to build:** The last unchecked criterion of ticket 18, run rather than skipped. The test is
already written; nothing has ever executed it.

## Why this ticket exists

Ticket 18 is done with one box open:

> - [ ] An integration test resumes a real session and proves the second call costs one message

The test exists — `tests/integration/contexts/agent/adapters/kojoPiRealSession.test.ts` — and its own
header says what it is for:

> This grades the claim the whole capture half exists for: **a second call re-enters the conversation
> instead of starting a new one** […] A stub cannot fail that claim; only pi can.

It is gated on two things and **both are absent here**:

    const binary = Bun.which("pi");
    const credentialed = (process.env.ANTHROPIC_API_KEY ?? "") !== "";

So it prints `NOT PROVEN: kojoPi resuming a real pi session.` and skips. The gate is honest — a skip
reads as a skip, and the file's first test asserts the two spellings of "runnable" agree. But a skip
is not a pass, and `kojoPi` exists only because of this claim.

## What this one costs, and why it is not free

**`pi` is not `claude`, and this cannot be bought with a Claude Code subscription.** `kojoPi` runs
the `pi` binary from `@mariozechner/pi-coding-agent`, and the test reads `ANTHROPIC_API_KEY`. That is
metered API spend, not subscription usage.

`KOJO_PI_MODEL` overrides the model and defaults to `claude-sonnet-4-6`. **Set it to the smallest
model that can answer at all** — the test asks for a session id and a second turn, not for
judgement. Two turns of a small model is the whole bill.

If no key can be had, this ticket does not become a pass by argument. It stays open, and the honest
outcome is to say so — or to decide that `kojoPi` is unproven and let that decide whether it ships.

**Blocked by:** 18 — done.

**Status:** ready-for-agent

- [ ] `pi` is installed, a key is available, and the suite runs rather than skips — the first test's
      `runnable` assertion is what proves the gate opened
- [ ] The second call **re-enters the session**: one session id across two calls, proven from the
      captured transcript rather than inferred from an exit code
- [ ] The second call carries **one message**, not the whole conversation replayed — measured, and
      the measurement stated
- [ ] The captured transcript lands under the encoded directory `pi --session <id>` consults from
      that cwd, which is the fault the capture half exists to prevent
- [ ] The model is the smallest one that can answer, named in the report, with the spend stated
- [ ] Ticket 18's sixth criterion is ticked with a pointer here, and §12's list of what is not proven
      loses this line
- [ ] If it cannot be run, this ticket stays open and `kojoPi` is recorded as unproven in
      [typescript-effect.md §12](../../../docs/design/typescript-effect.md). Do not close it by
      arguing the stub is enough — the header of the test already refuses that argument

## Comments

*(none yet)*
