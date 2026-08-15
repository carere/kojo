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

**Status:** done

- [x] Every place in this repository that can spawn an agent binary is enumerated, by a check that
      keeps being true — `tests/unit/contexts/agent/guards/agentSpawnSites.test.ts`
- [x] A spawn that the switch refuses is refused wherever it is made, not only through
      `SandcastleAgentInvoker`
- [x] A test proves it by attempting the spawn from a test that does not use the invoker
- [x] `kojoPiRealSession.test.ts`'s gate names the spend switch as a third reason to skip, and says
      which store pi may also be reading
- [x] The ledger in `realAgent.test.ts`'s header gains the two refused `pi` calls, in a second table
      of its own — because that header's counting method never covered `pi` at all

## Comments

*(none yet)*

## Comments

### 2026-08-15 — the guard moved to the thing that spawns

**Two lines, and the second is the one that survives a mutation.**

1. **The gate reads the switch**, so a suite nobody has authorised *skips* honestly instead of
   failing with a message about a refusal. `KOJO_AGENT_SPEND` is now a third reason in
   `missingIn`, beside the binary and the credential, and it hides neither.
2. **The spawn asks again.** `tests/support/spawnAgent.ts` calls the product's own `maySpawn` before
   it starts anything. So flipping the gate constant by hand — which is exactly what mutating
   `runnable` did, and exactly how one of the two unauthorised `pi` calls happened — cannot spend.

It calls `maySpawn` rather than reimplementing the rule. A guard that agreed with the invoker by
resemblance is a guard that will one day disagree with it.

**The enumeration is a test, not a list.** The invariant: building a command is free and *spawning*
is what costs, so a file is a spawn site when it **calls** `buildPrintCommand` and uses a
child-process primitive. A *call* and not a mention — the first draft flagged five files, three of
which merely explain `buildPrintCommand` in prose while spawning a `kojo` child or a `printf`, and a
guard that fired on those would have been switched off within the week. `SandcastleAgentInvoker`
calls it and spawns nothing itself, so it is not a site either; it is the other end of the same rule.
What is left is exactly one file.

The guard asserts its own search too — over a hundred files walked, the allowed file present, the
file this ticket was opened over present — because the way a scanner fails quietly is by scanning
nothing.

**What it does not cover, written into the docstring rather than left to be discovered.** A file
that hard-codes `pi` or `claude` as a command without going through a provider is not caught.
Nothing does that today, and a check broad enough to catch it would fire on every test that writes a
shell script named `claude` onto a `PATH` — and those scripts are the stand-ins, reached by a `kojo`
child that goes through the guarded invoker.

**Proven, and by which mutation.**

| mutation | what went red |
|---|---|
| the helper ignores its own refusal and spawns anyway | 3 of the 5 guard tests, each on the evidence file the command would have written |
| the pi suite spawns for itself again, as ticket 55 found it | `is the guarded helper, and nowhere else` — the enumeration, and nothing else in 638 |

**The consequence to know about.** Running the paid pi suite now needs `KOJO_AGENT_SPEND=allow` as
well as a credential. The run on 2026-08-15 that bought ticket 52 was made *before* this landed and
needed only the credential; the same run today would skip, and say so naming the switch.

**Spend: none.** Nothing here can reach a model — the provider in the guard's own test is a shell
command that writes a file, and that file is the evidence a refusal came before the spawn.
