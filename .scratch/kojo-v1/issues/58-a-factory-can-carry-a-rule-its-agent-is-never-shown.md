# 58 — A factory can carry a rule its own agent is never shown

**What to build:** A way for a factory author to find out that their envelope constrains something
the rendered contract cannot express — before an agent spends a turn failing to guess it.

## What was measured

`contractFor` is the whole of what a cold turn is told about the answer's shape. Against it:

    Schema.Literals(["low","medium","high"])  →  {"type":"string","enum":["low","medium","high"]}
    Schema.check(Schema.isMaxLength(12))      →  {"type":"string","allOf":[{"maxLength":12}]}
    Schema.check(Schema.isTrimmed())          →  {"type":"string","allOf":[{"pattern":"…"}]}
    Schema.check(Schema.makeFilter(…))        →  {"type":"string"}

The built-in checks render. **A custom filter renders as nothing.** So an author who writes a house
rule the natural way — as code, because it is easier to say in code than in a pattern — has written
a constraint their agent is never shown and cannot satisfy on a first turn.

Ticket 51 turned that into a *feature* deliberately: it is the only design in three that reliably
produces a decode failure a correction can undo, and it bought the criterion the build had been
missing since ticket 15. But what makes a good test fixture makes a bad factory.

## Why it matters more than it looks

The correction loop **does** recover it — that is exactly what ticket 51 measured, and it is a real
argument that the loop earns its keep. But it recovers it at a price:

- every such field costs one extra turn on **every** run, for ever;
- the phase's `corrections` bound is finite, so two invisible rules in one envelope can exhaust it
  and fail a run that was never going to succeed on the first turn;
- and nothing tells the author. The run succeeds, slowly, and the trace shows `corrections: 1` on a
  phase nobody thought was hard.

`kojo doctor` exists for exactly this shape of fault — a factory that runs and is quietly wrong. It
already refuses a factory whose commands are placeholders and one whose `effect` is doubled.

## Shapes worth weighing

1. **A `doctor` check.** Walk each workflow's envelopes, render each field, and name every field
   whose schema carries a refinement the contract does not show. `skipped` where it cannot tell,
   never `ok` — the rule this repository's doctor already follows.
2. **Say it in the contract instead.** `contractFor` could append the filter's *message* as prose
   beside the schema, so the rule reaches the agent on the cold turn. Cheaper for the author and it
   removes the extra turn — but it changes the prompt every factory sends, and a filter message is
   written for a decoder rather than for an agent.
3. **Both**, with 1 first: knowing costs nothing and changes no prompt.

## What must not happen to ticket 51's fixture

`tests/support/riskNote.ts` depends on this fault. If shape 2 is built, the fixture's premise dies
and `riskNoteDesign.test.ts` will say so — that is what it is for. Whoever builds this owes ticket
51 a fourth design, or an argument that the criterion stays bought by the run already recorded.

**Blocked by:** 51 — done.

**Status:** done

- [x] Every refinement Effect renders, and every one it does not, is enumerated by a test rather
      than by this list — `tests/unit/contexts/agent/guards/invisibleChecks.test.ts`
- [x] `kojo doctor` names each envelope field whose constraint the contract cannot show, and says
      what it costs. Per **envelope** rather than per workflow — see the note below
- [x] A factory with no such field is not warned about one, graded against a stamped starter *and*
      against Kojo's own factory
- [x] The decision on shape 2 is recorded, with its effect on every stamped factory's prompt stated
- [x] `riskNote.ts` and `riskNoteDesign.test.ts` are left working — nothing doctors that fixture,
      and ticket 51's design is untouched

## Comments

### 2026-08-15 — the doctor tells the author, and the guard measures the real contract

**What landed.**

- `src/contexts/agent/guards/invisibleChecks.ts` — the decision, pure, beside the renderer it is
  about. It compares what a schema **declares** against what the contract **shows**.
- `readiness.envelopeContractFinding` + `diagnose.readEnvelopes` — the `envelopes` line on every
  `kojo doctor`, which imports the factory's own `envelopes.ts` exactly as the `commands` check
  imports `commands.ts`.

**The arithmetic, rather than a list of checks that render.** Every check Effect can express becomes
one entry in the field's `allOf`; every check it cannot renders as nothing. So *declared minus shown*
is the number of rules the agent cannot see, and it stays right when Effect teaches an existing check
to render or adds a new one. A list of known-good checks would have to be maintained against a
library nobody here controls, and would be wrong **silently** — which is the failure mode this whole
ticket is about.

**It is `failed`, not a warning.** The run still succeeds; ticket 51 measured the correction loop
recovering exactly this. It recovers it by spending one extra agent turn on every run for ever,
against a `corrections` bound that is finite — so two such rules in one envelope can exhaust it and
fail a run that was never going to succeed on the first turn. A check reporting that as `ok` would
tell a person their factory is fine while it quietly pays twice.

**A false green, caught by the doctor test and not by the unit tests.** The first version of the
guard read `ast.propertySignatures` and the raw JSON Schema document. Both are right for a
`Schema.Struct` and wrong for a `Schema.Class`, which is what `EnvelopeBase.extend` produces and what
every stamped factory holds: a class's AST is a `Declaration` carrying no properties, and its JSON
Schema is a `$ref` into `definitions`. So it answered *nothing hidden* about every real envelope,
and eight unit tests agreed with it because they were all written over `Schema.Struct`. It reads
`.fields` and `contractSchema` now — the latter being the very function `contractFor` renders from,
so the guard asks about the object the agent is actually handed rather than a second rendering that
might one day differ. Two unit tests over an `EnvelopeBase` class were added, and they are the ones
that would have caught it.

**Per envelope, not per workflow, and the ticket asked for the other.** A workflow does not expose
its envelopes — they are used inside the body, at the `agent()` call — so there is nothing to walk
from a `LoadedWorkflow`. What a factory *does* expose is `envelopes.ts`, which is where `kojo init`
puts them and where an author edits them. Every exported schema is graded and everything else is
ignored, so a helper function beside the envelopes is not a fault.

### The decision on shape 2: refused, and here is what it would have cost

The other option was to append each filter's **message** to the rendered contract, so the rule
reaches the agent on the cold turn and no correction is needed. Refused, for four reasons:

1. **A filter's message is written for a decoder, not for an agent.** Ticket 51 measured this
   directly: `correctionFor`'s own wording had to be rewritten — *"The whole value must be exactly
   one of those words, with nothing before it and nothing after it"* — before a model could act on
   it. Pasting decoder messages into every cold prompt ships that unrefined register to every agent
   on every turn.
2. **It changes the prompt every stamped factory sends**, for a fault most factories do not have.
   Measured: Kojo's own three envelopes carry none, and a freshly stamped starter carries none. The
   effect on a factory *with* a filter would be one extra line per filtered field on every cold
   prompt; on a factory without one, nothing — which is to say the change buys nothing for the
   common case and costs a permanent widening of the contract for the rare one.
3. **It would make the contract and the schema two statements of one rule.** The JSON Schema is
   *derived*; prose beside it would not be, and D5 exists to keep exactly that drift
   inexpressible.
4. **It would kill ticket 51's fixture**, whose premise is that the rule is invisible — the one
   design in three that reliably produces a decode failure a correction can undo.

Telling the author costs no prompt at all and lets them say the rule where a human reads it too. If
shape 2 is ever built, `riskNoteDesign.test.ts` is what will say so, loudly, on the same day.

**Proven, and by which mutation.**

| mutation | what went red |
|---|---|
| every declared check counted as shown | 5 of the 16 — every case that names a hidden rule |
| read the AST's `propertySignatures` again, as the first version did | **only** *finds a hidden rule on an EnvelopeBase class*, and nothing else in 16 — which is the measurement, not the anecdote: the fifteen struct-based tests let that false green ship |

**Checks.** `bun tsc --build --force`, `bun biome check .`, `bun knip` clean. Unit **665**,
integration **274 passing** with three named skips, browser **96**. No agent call, and nothing here
could make one.
