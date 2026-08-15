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

**Status:** ready-for-agent

- [ ] Every refinement Effect renders, and every one it does not, is enumerated by a test rather
      than by this list — the same shape as `agentSpawnSites.test.ts`
- [ ] `kojo doctor` names each envelope field whose constraint the contract cannot show, per
      workflow, and says what it costs
- [ ] A factory with no such field is not warned about one, graded against a stamped starter
- [ ] The decision on shape 2 is recorded either way, with its effect on every stamped factory's
      prompt stated
- [ ] `riskNote.ts` and `riskNoteDesign.test.ts` are left working, or ticket 51 is reopened with a
      fourth design

## Comments

*(none yet)*
