# 55 — A test that spawns a provider binary itself is outside the spend guard

**What to build:** The other half of ticket 49. `KOJO_AGENT_SPEND` is honoured by
`SandcastleAgentInvoker`, and it is honoured **only** there. A test that spawns an agent binary
directly never passes through the invoker, so nothing refuses it — and one did, twice, on the day
ticket 49 landed.

## What happened

`tests/integration/contexts/agent/adapters/kojoPiRealSession.test.ts` builds a command with
`provider.buildPrintCommand(...)` and spawns it with `node:child_process`. It does not use
`AgentInvoker`, `Sandbox`, or any Kojo layer. So:

- `maySpawn` is never called;
- `KOJO_AGENT_SPEND` is never read;
- the only thing between an edit and a real call is the file's own `describe.skipIf`.

An agent working ticket 52 hit both paths in one session:

| what it ran | why | what Anthropic answered |
|---|---|---|
| `pi -p --mode json --model claude-haiku-4-5 --session-dir <tmp>` in a scratch directory | a layout probe, run in the belief that no credential existed | `400 invalid_request_error: "You're out of extra usage…"`, 0 in / 0 out, cost 0 |
| the suite itself, with a mutation that flipped `runnable` to true | mutation testing the gate — which un-skipped the paid `describe` | the same refusal, the same zero cost |

Both were refused, so this cost nothing. **That is luck, not a mechanism.** With credit on the
account, mutating a boolean in a test file would have spent real money, and the mutation was a
*correct* thing to do — the verification ladder demands it.

## The finding under the finding

**`pi` on this machine authenticates with its own stored credential**, not with
`ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`. Measured: neither variable is in the environment
(`env | grep -c` returns 0 for both) and the call still reached Anthropic and was answered.

So the gate on that suite does not measure what it says it measures. It reads *somebody exported a
credential for this suite*, while what decides whether a process reaches a model is a credential
store the test never looks at. A gate that can be true when a call is impossible and false when a
call is certain is the wrong question asked twice.

## What the shape probably is

Ticket 49's own reasoning applies unchanged, one level out: *the thing being protected is somebody's
money, and the thing that spends it is whatever spawns the process.* Candidates, cheapest first:

1. **One helper that every test spawning an agent binary must go through**, which calls `maySpawn`
   with the same switch. A test that spawns `child_process` directly then becomes reviewable by
   grep, and the grep can be a test.
2. **Make the gate ask the real question** — can this binary reach a model — rather than *is a
   variable set*. Harder, and possibly not answerable without spending.
3. Leave `skipIf` as the gate and accept that mutation testing this file is unsafe, **written down
   where the mutation would be attempted.** Last: the ladder's rung 3 is not optional here.

**Blocked by:** 49 — done.

**Status:** ready-for-agent

- [ ] Every place in this repository that can spawn an agent binary is enumerated, by a check that
      keeps being true — not by a list in a comment
- [ ] A spawn that the switch refuses is refused wherever it is made, not only through
      `SandcastleAgentInvoker`
- [ ] A test proves it by attempting the spawn from a test that does not use the invoker
- [ ] `kojoPiRealSession.test.ts`'s gate stops claiming a credential decides whether a call is
      possible, or is shown to be right about this machine and says which store it means
- [ ] The ledger in `realAgent.test.ts`'s header gains the two refused `pi` calls. They cost nothing
      and they are still calls that were made and not authorised — the whole discipline of that
      table is that it records what happened rather than what was meant

## Comments

*(none yet)*
