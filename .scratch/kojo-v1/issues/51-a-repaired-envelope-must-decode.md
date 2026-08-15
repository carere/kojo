# 51 — Buy the one criterion the build never bought: a repaired envelope that decodes

**What to build:** A real agent's repair that **decodes**, and a phase record read off the trace
carrying `corrections: 1`. Plus the remedy ticket 48's audit says to buy it with — `correctionFor`
does not tell a model that a literal field must *equal* one of the listed words.

## Why this ticket exists

Two closed tickets carry the same unchecked criterion, and it is the same fact:

- ticket 15: *"A real envelope that fails to decode drives the correction loop and the retry
  succeeds"*
- ticket 48: *"The repair returns an envelope that decodes, and the phase record carries
  `corrections: 1`"* — **not bought.**

[build-record.md §10](../../../docs/build-record.md) calls it *the most load-bearing unproven thing
in the build*. No stand-in can close it: a repair re-enters the captured provider session, so a
scripted repair always dies `resumeSession not found`. Only a real call can move the counter.

**The budget objection is gone.** The repository's owner authorised this on 2026-08-13 against a
Claude Code subscription, with the instruction to use a **small model**. The old three-call budget
and its arithmetic do not apply. Report the count anyway — the ledger is the habit, not the limit.

## What ticket 48 measured, and what to do with it

The one paid run failed by a hair, and the audit read the transcript twice to find out how. The
model was told to write a sentence and the envelope wanted one of `"low" | "medium" | "high"`. Its
repair moved the word to the front:

    "low — this is a one-line text addition to notes/hello.txt with no code or config impact, …"

That is a prefix, not the value. The finding on the record is:

> A correction turn moves the answer; it does not fully escape the context that caused the fault.

And the remedy the audit ranks first is a fix to **Kojo**, not to the fixture:

> **`correctionFor` never says a literal field must *equal* one of the listed words**, with nothing
> before or after it. It reports the expected type only. The repair misses valid by exactly that
> gap, so closing it would very likely have decoded. Untested — this is what the next two calls
> should buy.

So: build the remedy, rehearse the whole loop for free against the scripted stand-in in
`tests/integration/cli/correctionLoop.test.ts`, and only then spend.

**Do not raise the correction bound to make this pass.** Ticket 48 ranks that last for a reason: a
bound that hides a disagreement is a worse factory. One correction must be enough.

## What is already in place

- `tests/support/riskNote.ts` — the designed decode failure. Nothing tells the model to be wrong.
- `tests/integration/cli/correctionLoop.test.ts` — the whole stamped factory with a scripted
  `claude` on `PATH`. The free rehearsal.
- `tests/integration/cli/realAgent.test.ts` — the paid suite, `skipIf(!KOJO_REAL_AGENT)`, with
  `KOJO_REAL_AGENT_EVIDENCE=<directory>` copying `kojo.db`, `-wal` and `-shm` out on every path,
  including a failed assertion. It is **known red** at head, and its header says why.
- `src/contexts/workflow/services/corrections.ts` — `correctionFor`, and `withCorrections` whose
  docstring holds the measurement above.

**Blocked by:** 15, 48 — both done.

**Status:** done — bought on 2026-08-15, on the third design

- [x] `correctionFor` states, for a field whose type is a set of literals, that the **whole value**
      must be exactly one of them and that nothing may come before or after it. Graded by a unit test
      over a real `SchemaError` issue tree, not over a hand-built string
- [x] The whole loop is rehearsed against the scripted stand-in before a real call is made, and the
      rehearsal is what proves the new text reaches the agent
- [x] A real agent's first answer fails to decode, its repair **decodes**, and the run reaches its
      gate — against `fable`, a small model
- [x] `corrections: 1` is read off the **phase record in the trace database**, not inferred from the
      session transcript — on a phase whose `outcome` is `succeeded`
- [x] The run happens in a throwaway repository, never this working tree, with permissions enforced
- [x] The number of real invocations is reported with the method used to count them — top-level
      prompts in the session transcripts under `~/.claude/projects/`
- [x] `realAgent.test.ts` stops being known red: the header's "never been read off one" paragraph is
      replaced by what was read off one — two runs, what each answered, what the trace held, and why
      it is still red at its last two lines
- [x] The ledger is updated in three places that must agree — `realAgent.test.ts`'s header,
      [typescript-effect.md §12](../../../docs/design/typescript-effect.md) and
      [build-record.md §9](../../../docs/build-record.md) — and ticket 48's fourth criterion is
      ticked with a pointer here. **The header is updated; the two documents are the integrator's,
      by this wave's house rule that no lane edits them**, and ticket 48 stays as it is because its
      criterion is still unbought
- [x] The suite stays skip-unless-`KOJO_REAL_AGENT`, and a skip still reads as a skip

## Comments

### 2026-08-14 — the remedy is built and delivered; the model refused to make the fault

**Two real invocations, on `fable` — the small model of its generation, as the owner asked.** Counted
the way this build counts: walk every `*.jsonl` under `~/.claude/projects/`, keep the transcripts
whose first top-level prompt carries a stamped phase identity (`# The drafter`), and count top-level
prompts — `user` entries holding no `tool_result` part. Before: 174 transcripts, **0** with a phase
identity. After: 177 transcripts, **2** with one, holding **one prompt each**. Two sessions, two
prompts, two calls. Nothing else on this branch can reach a model: every other agent in every other
test is a shell script, and `KOJO_AGENT_SPEND` was never set in a shell — only by the paid suite's own
`spending` constant, per child.

**1. The remedy, which is a change to Kojo.** `correctionFor` reported a literal field's expected
*type* and never said the value must **equal** one of the listed words. It says it now:

    - risk: Expected "low" | "medium" | "high"
      The whole value must be exactly one of those words, with nothing before it and nothing
      after it — no dash, no sentence, no explanation wrapped around it. Write it as exactly
      "low", "medium" or "high"; anything you have to say beyond that has to go elsewhere.

Three things a rendered type cannot say, and the third is the one ticket 48's audit pointed at: a
repair with nowhere to put its sentence writes it into the field again. The words are read back out of
the decoder's own message — `DecodeIssue` carries the message and the path and never the AST — and
they are **scanned rather than split**, because `"a | b" | "c"` is two literals and splitting on the
separator would offer a model three words no schema accepts. A message that is not a set of quoted
words (`Expected string`, `Expected 1 | 2`, `Missing key`) is reported exactly as the decoder wrote it.

Graded by four unit tests that start at a schema and an answer, never at a hand-written message:
`tests/unit/contexts/workflow/services/corrections.test.ts`.

**2. The rehearsal, and it moved the boundary this build believed in.** Ticket 48 said a scripted
agent can never move `corrections` past Sandcastle's resume precheck. That precheck is a check for a
**file** — `findByIdOnHost` looks for `<session>.jsonl` under `$HOME/.claude/projects` *of the asking
process* — so a rehearsal that gives the child a `HOME` of its own and lets the stand-in write that
one file gets its repair really spawned, with `--resume` on the command line and Kojo's correction on
stdin. `correctionLoop.test.ts` now has that third test: two prompts in the log, the second carrying
the new clause verbatim, `corrections: 1` and `resumed: true` on the phase row, and the run landing
through its gate. So a stand-in **can be given** a correction and can never **read** one — its repair
is decided before the run starts. That is the honest line, and it is one step further along than the
ticket assumed. The temporary `HOME` also stops any rehearsal reading or writing the operator's real
`~/.claude`, which is the directory this build counts its spend from.

**3. What the two paid runs did, and the finding they cost.**

| run | subject the rule carried | what `risk` came back as | `corrections` |
|---|---|---|---|
| `7808f5f1…` | the design as ticket 48 left it | `"low"` | 0 |
| `220ed62a…` | the same, sharpened once | `"low"` | 0 |

Run 1's answer is worth quoting, because the model explained itself inside the envelope:

> `"summary": "Added a second line reading \"goodbye\" to notes/hello.txt … (The answer schema
> constrains the risk field to the enum low/medium/high, so the full sentence lives here.)"`,
> `"risk": "low"`

It saw the conflict and resolved it in the schema's favour, out loud. So the disagreement was
sharpened in the two places that measurement pointed at — the rule now states the house **form** of a
grade (`low — reason`, a form that *begins* with a valid word) and says `summary` is a title and not a
home for the note — and run 2 answered `"low"` with a one-clause summary, dropping the reason
altogether. Nothing was weakened to make the model fail and nothing told it to be wrong; it simply
would not.

**The finding, which is about Kojo rather than about the model: a contract rendered into the prompt
beats a rule written in prose, twice, against two strengths of rule.** `riskNote.ts` predicted this
case before any money was spent and called it the reserve. It also settles the argument about the
bound from the other side: with the schema in front of a model a decode failure is *rare*, so one
correction is a defensible number and raising it would buy nothing. The bound was not raised.

**4. `corrections` was read off the trace database, and the hook ticket 48 paid to fix works.**
`KOJO_REAL_AGENT_EVIDENCE` copied `kojo.db` with its `-wal` and `-shm` out of both runs, and both
opened afterwards with every table and every row present. Off the copy of run 2: `draft` agent
succeeded, `envelope: Drafted`, `model: fable`, a real session id, `diffMatchesClaims` ran and passed,
**`corrections: 0`** — then `commit`, `verify`, gate `approve` asked as *"test, lint and build all came
back clean"* and answered `approve` by `tester`, `merge`, run `succeeded`. Both acquisitions carried
exactly `KOJO_ATTEMPT`, `KOJO_PHASE_ID`, `KOJO_RUN_ID`, and none of the seven credential markers
appears anywhere in the file. A real small model drove the stamped factory end to end and landed it.

**5. What changed in the paid test, and what deliberately did not.** The `corrections: 1` and
`resumed: true` pair is now the **last** assertion rather than a middle one: all three paid runs this
file has seen died on it, and with it in the middle everything after — the gate record, the
acquisitions, the credential scan — was bought and never graded. The assertion itself was not
weakened, the bound was not raised, and the suite stays `skipIf(!KOJO_REAL_AGENT)` with its two tests
reported as skipped by name.

**Blast radius.** Two temporary git repositories stamped by a real `kojo init`, deleted with the
scope. Never this working tree. The drafter ran inside `withPermissions` with `factoryOwnPaths`
protected, as the stamped `review` wires it.

### 2026-08-15 — bought, on the third design, and the design is the finding

**Read off the trace database of a run that succeeded**, which is the criterion in one row:

    name         draft
    outcome      succeeded
    corrections  1
    resumed      1
    model        fable
    run outcome  succeeded

**Two invocations, one session.** Counted the build's way — top-level prompts under
`~/.claude/projects/` that carry no `tool_result` — in the one transcript named after the phase's own
session id, `0db72b67…`: **2**. One cold turn, one repair, one conversation. The build's total moves
from eleven to thirteen.

**What the two earlier designs got wrong, and it was the same thing twice.** Both asked a model to
resolve a conflict between the factory's prose and the factory's envelope. A model that reads the
rendered contract resolves it in the schema's favour — correctly — so design 1 got a failure and a
repair that missed by a hair, and design 2 got no failure at all, twice. The premise *this will fail
to decode* was true when written and stopped being true, and **nothing graded the premise**, so two
paid calls found out instead of a test.

**The third design does not ask a model for anything.** It uses a constraint the rendered contract
**cannot express**, measured against `contractFor`:

    Schema.Literals(["low","medium","high"])  →  {"type":"string","enum":["low","medium","high"]}
    Schema.check(Schema.isMaxLength(12))      →  {"type":"string","allOf":[{"maxLength":12}]}
    Schema.check(Schema.makeFilter(…))        →  {"type":"string"}

So the model is told `risk` is a string and nothing more. It cannot comply with a rule it has never
seen, however carefully it reads — and the correction carries the filter's own message verbatim,
path-precise, which is the only place in the whole conversation the rule appears. **A failure a
correction can undo that a prompt could not have caused**, which is what ticket 48's audit asked the
next design to be, in as many words.

**And the finding is about Kojo rather than about a model, which makes it the useful half.** Every
author-written `makeFilter` is invisible to the agent it grades. The rule here *is* expressible as a
regular expression, and had the author written one, Effect would have rendered it and the agent would
have complied on the first turn. What makes it invisible is the spelling an author reaches for when a
rule is easier to say in code than in a pattern. So a factory can carry a constraint its own agent is
never shown, and the correction loop is the only thing that recovers it — see ticket 58.

**The premise is now a test.** `tests/unit/contexts/agent/services/riskNoteDesign.test.ts`, eleven
assertions, none of which involves a model, and the load-bearing one quotes the whole of what the
agent is told about the field:

    expect(field.replace(/\s+/g, " ")).toBe('"risk": { "type": "string" }');

It also reads `riskField` — the TypeScript injected into the stamped factory — and checks that the two
expressions of the design still agree, because that is the seam that would rot next.

**Rehearsed for free first, as the ticket demanded.** `correctionLoop.test.ts` walks the whole loop
against a scripted agent: prose refused, correction carrying the rule, repair decoding, run landing
at its gate. Three tests, no money. Only after that was anything spent.

**Blast radius.** One temporary git repository stamped by a real `kojo init`, deleted with the scope.
Never this working tree. The drafter ran inside `withPermissions` with `factoryOwnPaths` protected.
