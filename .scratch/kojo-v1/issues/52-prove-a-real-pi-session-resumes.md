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

**Status:** done — bought on 2026-08-15, after ticket 56 made it worth buying

- [x] `pi` is installed, a credential is available, and the suite runs rather than skips
- [x] The second call **re-enters the session**: one session id across two calls
- [x] The second call carries **one message**, not the whole conversation replayed
- [x] The captured transcript lands where `pi --session <id>` consults from that cwd — which after
      ticket 56 is the root itself, because `--session-dir` makes pi's layout flat
- [x] The model is the smallest one that can answer — `claude-haiku-4-5`, pi's smallest Anthropic
      entry — and the spend is stated below
- [x] Ticket 18's sixth criterion is ticked with a pointer here, and §12 loses this line
- [x] It could be run, so this ticket does not stay open on the argument that a stub is enough

## Comments

**The code half landed** on `lane/52-pi-session-gate`; **the paid half is still unbought.** No
credential was exported into this lane and none was looked for, so every criterion above stays
unticked. What changed is the gate, the model, and — worth more than either — what a reading of pi
0.80.10 and two free probes say about whether a credential is the only thing missing. It is not.

**The gate takes either credential.** The owner authenticates pi with `ANTHROPIC_OAUTH_TOKEN`, and
`pi --help` lists it beside `ANTHROPIC_API_KEY` as an alternative pi accepts. The gate read only the
first, so the suite would have skipped on the owner's own machine and named a reason that was not
their reason. `credentialVariables` is now the list of the two, `hasCredential` asks whether either
carries a non-empty value, and the `NOT PROVEN` line is built from the list rather than written out:
`neither ANTHROPIC_API_KEY nor ANTHROPIC_OAUTH_TOKEN is set`.

**The honesty of the gate is unchanged.** `runnable` and `missing` are still derived separately, so
`expect(runnable).toBe(missing.length === 0)` still has content — flipping `&&` to `||` in `runnable`
reddens it. The new test grades the half this machine cannot exercise: `missingIn` is a function of
an environment rather than of `process.env`, so "accepts the OAuth token" is measured against a
synthetic environment on a machine that has no token, instead of being a claim nobody can check
until the day somebody exports one.

**`KOJO_PI_MODEL` now defaults to `claude-haiku-4-5`.** `pi --list-models` on 0.80.10 lists nothing
smaller from Anthropic. The docstring says why the size buys nothing here: the assertions read a
session id, one word held across two turns, and a second command carrying one message.

**Two things other than the credential stop this suite**, both measured against pi 0.80.10 without
spending, both faults in the thing under test rather than in the test, and both left unfixed because
this lane is the gate:

1. **`--session-dir` makes pi's layout flat, and `piSessionStorage` reads an encoded subdirectory.**
   pi encodes the cwd into a directory name only for its *default* root: `SessionManager.create`
   reads `sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd)`, and
   `listSessionsFromDir` is a single non-recursive `readdir`. Probed: with `--session-dir S` the
   transcript landed at `S/2026-08-14T15-48-44-573Z_<id>.jsonl`, not under `S/--…--/`. `kojoPi`
   passes `--session-dir` whenever `sessions` is given, so `existsOnHost` at line 124 asks a
   directory pi never wrote — and, worse than a red test, `resumeIntoSandbox` lands a captured
   transcript under `<sandbox root>/<encoded cwd>/` where pi will not look. That is the silent cold
   start this whole capture half exists to prevent, arriving through the flag added to prevent it.
2. **A macOS temp path is not the path pi records.** `mkdtemp(tmpdir())` returns `/var/folders/…`; a
   child started there reports `/private/var/folders/…`, which is what pi writes into the session
   line and encodes. So the `cwd` this file hands `existsOnHost` and the one pi used are two strings
   for one directory. It would also stop `rewritePiSessionCwd` matching the line it exists to rewrite.

Both are recorded in the file's header docstring so the next reader meets them before the bill.

**The paid test is outside the spend guard.** `KOJO_AGENT_SPEND` is honoured by
`SandcastleAgentInvoker`; this file spawns `pi` itself, so nothing refuses the call. Found the hard
way: mutating `runnable` to prove the first test still bites un-skipped the paid describe and made a
real pi call. It cost nothing — this machine's pi carries its own stored auth, and Anthropic refused
with `400 … out of extra usage`, zero tokens, zero cost, reported in pi's own usage line — but the
lesson stands, and so does a second one: **pi is authenticated without either environment variable**,
so the gate measures "somebody exported a credential for this suite", not "pi can reach a model".
Conservative in the right direction, and left that way on purpose: reading pi's credential store to
decide would be both a worse gate and a thing a lane must not do.

**Checks:** `bun tsc --build --force --verbose` (both projects rebuilt), `bun biome check .` (7
pre-existing infos, none in this file), `bun knip` (silent), `moon run kojo:test --force`
(76 files, 612 tests, no skips), `moon run kojo:test-integration --force` (43 files passed, 1
skipped; 256 passed, 3 skipped — 255 before this lane). The three skips are the two in
`cli/realAgent.test.ts`, gated on `KOJO_REAL_AGENT`, and the one paid test here.

### 2026-08-15 — bought, and it passed first time

**Two real `pi` invocations, `claude-haiku-4-5`, and the suite went green.**

    bun node_modules/.bin/vitest run --project integration \
      tests/integration/contexts/agent/adapters/kojoPiRealSession.test.ts
    → Test Files 1 passed (1) · Tests 3 passed (3) · 4.04s

**Three passed and none skipped, which is the proof the paid test ran** rather than the gate quietly
closing. Confirmed independently and for free with `vitest list`, which collects `describe.skipIf`
against the environment it is given:

    without the credential → 2 tests collected
    with the credential    → 3, the third being
                             `kojoPi against the real pi binary > re-enters the session it opened,
                              and the second call carries one message`

**What the two calls bought**, each an assertion in that test rather than a claim here:

| the claim | how it was graded |
|---|---|
| the second call re-enters rather than reopens | `sessionIdOf(resumed)` equals the id the cold turn reported |
| the conversation survived the gap | the model answered `ORCHID`, a word that appears only in the first turn |
| the second call carries one message | its `stdin` is the second question and nothing else, and `ORCHID` is nowhere in the command |
| the transcript grew rather than restarted | both turns are in **one** file, longer after than before |
| Kojo finds that file where pi actually put it | `findByIdOnHost` returns the path whose contents equal what `readHostSession` read |

**The credential is `ANTHROPIC_OAUTH_TOKEN`, and it was never read by anything that could keep it.**
It lives in the repository's own gitignored `.env`, sourced into the environment at the moment the
task was invoked — `set -a && . ./.env && set +a` — because `moon` runs this project's tasks with
`packages/kojo` as the working directory and bun loads `.env` from the working directory, so the
root file would not otherwise reach the child.

**Order mattered, and it is the finding worth keeping.** Ticket 56 was fixed first, on purpose. Had
this been bought before it, both calls would have been spent on a red test whose failure looked like
a credential problem — the transcript would have landed in a directory pi never reads, and the
resume would have started cold while still exiting 0. The two faults were found by *reading* pi and
cost nothing; buying the test before reading the binary would have cost money and taught the wrong
lesson.
