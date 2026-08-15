# 48 — Prove the correction loop against a real model

**What to build:** Evidence that Kojo's correction loop works against a real model — an envelope that
genuinely fails to decode, a correction prompt built from the real `SchemaError`, a repair that
re-enters the same session, and a decoded envelope at the end.

**This is the one mechanism in the design that cannot be proven any other way.** Ticket 36's re-walk
established why: a repair resumes the captured provider session, so a scripted stand-in's repair
always dies `resumeSession "…" not found`. **The `corrections` counter can only ever be moved by a
real agent call.** Everything else — the factory, the durability, the trace, the Console, the merge,
permissions, acceptance — is proven without one.

**Blocked by:** 15, 36

**Status:** done — one criterion unbought, and one authorised call deliberately unspent

## The budget, and the arithmetic

**Three real agent calls are authorised. Not four.** Authorised by the repository's owner on
2026-08-13, on top of the five ticket 15 spent.

Count invocations, not runs. A correction is a **second turn in the same session**, so:

| | calls |
|---|---|
| a run whose first answer decodes | 1 |
| a run whose first answer fails and whose repair succeeds | **2** |

So the plan is **one corrected run (2 calls) and one call held in reserve** — for the likely case
that a model returns something valid when you wanted it to fail. Do not spend the reserve on a second
scenario. **Report the exact count, and how you counted it.**

Wave 16's counting method: real `claude` runs leave session transcripts under `~/.claude/projects`;
count **top-level prompts** — user turns that are not tool results. Ticket 15's five were four
sessions of 1, 1, 2, 1.

## How to make a real model fail to decode, cheaply

Do not ask a model to be wrong; ask for something the envelope cannot accept. The reliable shape is
an envelope field with a **narrow** type and a prompt that invites prose — the model answers
naturally and the decoder refuses. Design that before spending anything, and rehearse the whole
mechanism end to end against the scripted stand-in first, so the real calls are spent on the one
thing only they can buy.

- [x] A real agent's first answer fails to decode, and the recorded `SchemaError` names the field
- [x] The correction prompt is built from the real issue tree — not a generic retry — and the
      repair's prompt is shown in the report
- [x] The repair **re-enters the same session**, proven from the captured transcript rather than
      inferred: two top-level prompts in one session file
- [x] The repair returns an envelope that decodes, and the phase record carries `corrections: 1` — bought on 2026-08-15 by ticket 51; the note below is what it took
      — **not bought.** The repair rewrote the sentence with the expected literal moved to the
      front, which is still not the literal, and the phase exhausted its one correction.
      `corrections` did move to 1 (the correction was built and sent, in-session), but a *repaired*
      run needs two calls and one authorisation is left. See the comment below, and the wave-18
      correction under it.
- [x] The whole thing runs against a throwaway repository, never this working tree, with permissions
      still enforced
- [x] The exact number of real invocations is reported with the method used to count them, and it is
      **at most three** — two, counted as top-level prompts in the surviving session transcript
- [x] The evidence is written down where it will be found: the ticket, and §12's "what the showcase
      did not exercise" half amended to say this half now is
- [x] The real-agent test stays skip-unless-`KOJO_REAL_AGENT`, and a skip still reads as a skip

## Comments

### 2026-08-13 — two calls of three spent; three criteria bought, one refused by the model

**The spend, and how it was counted. Two real invocations. One call is left unspent.**

Counted the way wave 16 counts: the surviving session transcripts under `~/.claude/projects/`. The
directory was listed before the run (345 `.jsonl` files) and after (346). The one new file is

    ~/.claude/projects/-private-var-folders-…-T-kojo-throwaway-dkkeDV--sandcastle-worktrees-kojo-7808f5f120f8ad81e247b940c4ceaa7a/0efd7d69-624e-417d-8658-43c5bdebdf21.jsonl

and it holds **two top-level prompts** — `user` entries that are not tool results — both carrying the
same `sessionId`. Two prompts in one session file is two invocations and one conversation, which is
simultaneously the count and the proof of criterion 3. Nothing else was run against a model: the
second test in `realAgent.test.ts` was filtered out with `-t`, and every other agent in every other
test on this branch is a shell script.

**The design, rehearsed before anything was spent.** `tests/support/riskNote.ts`. The throwaway
factory's own `Drafted` gains `risk: Schema.Literals(["low", "medium", "high"])`, and the drafter's own
task template asks for the risk note as *one short sentence naming the path to look at*, in `risk`,
and says a bare word is not a risk note. Nothing tells the model to be wrong and nothing tells it a
correction is coming: the prompt and the envelope disagree, which is an ordinary factory-authoring
fault, and the model resolves it by answering the task.

Rehearsed for free in `tests/integration/cli/correctionLoop.test.ts` — the whole stamped factory with
a scripted `claude` on `PATH`: (1) an answer that fits the envelope drives the run to its gate, through
the gate, and onto the trunk, so a paid failure could only be the model's; (2) a sentence in `risk`
makes the loop spend its correction and stop exactly at Sandcastle's resume precheck
(`resumeSession "scripted-cold" not found under …`), which pins the ticket's premise as an executable
test; (3) the decode of that exact prose names `risk` and `correctionFor` names it back.

**What the two calls bought.**

1. **A real first answer that failed the envelope contract, and a recorded `SchemaError` that names
   the field.** The cold turn answered a well-formed `Drafted`:

       {"_tag":"Drafted","summary":"Appended a second line, \"goodbye\", to notes/hello.txt.",
        "files":["notes/hello.txt"],
        "risk":"This is a low-risk one-line text addition with no code or config impact; check
                notes/hello.txt to confirm only the new goodbye line was added."}

   and the run's own report reads `issues: 1: path: 1: risk — message: Expected "low" | "medium" |
   "high"`. The design provoked the fault on the **first** turn, so the reserve was not needed for it.

2. **The correction prompt Kojo built, quoted from the transcript** — the second top-level prompt in
   that session file, in full:

   > Your last answer was not a valid `Drafted`, so none of it was accepted.
   >
   > These fields are wrong:
   > - risk: Expected "low" | "medium" | "high"
   >
   > Answer again with the whole `Drafted`, with those fields corrected. Send the
   > envelope on its own — nothing before it and nothing after it.

   It names the field and the words it wanted, and it carries no identity block — a repair is one more
   message, not a cold start.

3. **The repair re-entered the same session.** One session file, one `sessionId`, two top-level
   prompts, the second being the correction above.

**What they did not buy.** The repair did not decode either, `withCorrections` exhausted the bound the
stamped phase declares (`corrections: 1`), and the run failed `EnvelopeParseError`. So the criterion
"the repair returns an envelope that decodes, and the phase record carries `corrections: 1`" is
unbought, and it cannot be bought with the one authorisation left: a corrected run is two calls.

*The paragraph that stood here claimed the repair re-sent the same sentence byte for byte. It did not.
See the wave-18 correction below, which is read off the same transcript.*

**A defect of this ticket's own machinery, found by paying for it.** The evidence hook added here
(`KOJO_REAL_AGENT_EVIDENCE=<directory>`, which copies the trace out on every path, including a failed
assertion) first copied `.kojo/kojo.db` alone. The database is in WAL mode, so the copy opened
afterwards reported **no tables at all** while every row sat in the `kojo.db-wal` that went with the
temporary directory. It copies `kojo.db`, `-wal` and `-shm` into one directory now. That is why the
`corrections` claim above rests on the correction *in the transcript* — which only exists because the
counter moved — rather than on the trace row it should also have been read from.

**Blast radius.** A temporary git repository (`kojo-throwaway-dkkeDV`), stamped by a real
`kojo init`, deleted with the scope. Never this working tree. The drafter ran inside
`withPermissions` with `factoryOwnPaths` protected, as the stamped `review` wires it.

### 2026-08-13 — wave 18: the audit read the transcript again, and the central finding was misread

The spend is confirmed at **two**, by a second and independent method: walk all 348 `*.jsonl` files
under `~/.claude/projects/`, keep the seven whose first top-level prompt carries a stamped phase
identity, count top-level prompts. Ticket 48's two are one file, one `sessionId`. The third
authorisation is genuinely unspent. Criteria 1, 2, 3, 5, 6 and 7 all hold.

**But two statements in the comment above were wrong, and both were load-bearing.**

The transcript holds two `risk` values, not one:

| turn | entry | `risk` |
|---|---|---|
| cold | #23, 09:30:59Z | `"This is a low-risk one-line text addition with no code or config impact; check notes/hello.txt to confirm only the new goodbye line was added."` (142 chars) |
| repair | #30, 09:31:06Z | `"low — this is a one-line text addition to notes/hello.txt with no code or config impact, so just confirm only the goodbye line was added there."` (143 chars) |

1. **The quote attributed to the cold turn is the repair.** The comment above quoted entry #30 and
   called it the first answer.
2. **The repair was not "the same sentence byte for byte".** The two strings differ in length and in
   wording, and the repair **moved the expected literal `low` to the front** — the compromise a reader
   of `Expected "low" | "medium" | "high"` would attempt while still obeying the standing rule to write
   a sentence. It failed because a literal must be the *whole* value, not a prefix of it.

**So the finding is rewritten, and it is a better one.** Not *a correction turn does not escape the
context that caused the fault*, but:

> **A correction turn moves the answer; it does not fully escape the context that caused the fault.**
> The rule that produced the sentence is still in the conversation the repair re-enters, so the model
> tried to obey the rule and the correction at once and landed on a value that was valid only as a
> prefix. It failed by a hair, not by stubbornness.

**And that changes which remedy to buy first.** The two written down above are both fixture changes,
and they were chosen because the model appeared to ignore the correction. It did not, which exposes a
third and cheaper candidate that fixes **Kojo** instead:

1. **`correctionFor` never says a literal field must *equal* one of the listed words**, with nothing
   before or after it. It reports the expected type only. The repair misses valid by exactly that gap,
   so closing it would very likely have decoded. Untested — this is what the next two calls should buy.
2. Stop the prompt and the envelope disagreeing (the `summary` clause).
3. Raise the bound. Last: a bound that hides a disagreement is a worse factory, and nothing in the
   transcript suggests a third turn was needed.

The design and the correction text are both left exactly as measured. Corrected in
`corrections.ts`'s `withCorrections` docstring, `riskNote.ts`, `realAgent.test.ts`'s header and §12.
Commit `906e37c`'s own message still carries the superseded sentence; it is superseded here rather
than rewritten, so the audited commit stays intact.

**Two more things the audit put on the record.**

- **The fault was provoked with two hands, not one.** `riskNote.ts` always disclosed that the run's
  subject repeats the instruction (`riskSubject`: *"…and write the risk note as a sentence"*), but the
  report described only the factory rule. The prompt-and-envelope disagreement is still honest — the
  contract is rendered in plain sight and nothing asks the model to be wrong — but the operator's own
  task line asks for the invalid shape too.
- **The build's real-call ledger was wrong by two, and not in ticket 48's favour.** Nine factory
  invocations exist in the transcripts against eight ever authorised; see `realAgent.test.ts`'s header
  for the table. The two unauthorised ones are a dogfood and a demo walk on the evening of
  2026-08-11, on `claude-sonnet-4-6` and `claude-opus-4-8`. Ticket 48 restated the total as seven and
  has been corrected; the calls themselves belong to an earlier wave.

### 2026-08-13 — the unbought criterion has an owner now

*The repair returns an envelope that decodes, and the phase record carries `corrections: 1`* is
ticket [51](51-a-repaired-envelope-must-decode.md), with remedy 1 above — `correctionFor` stating
that a literal field must **equal** one of the listed words — as the thing to build before spending.
The three-call budget no longer bounds it: the owner authorised the spend against a subscription, on
a small model. Report the count anyway.
