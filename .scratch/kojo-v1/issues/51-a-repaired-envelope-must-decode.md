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

**Status:** ready-for-agent

- [ ] `correctionFor` states, for a field whose type is a set of literals, that the **whole value**
      must be exactly one of them and that nothing may come before or after it. Graded by a unit test
      over a real `SchemaError` issue tree, not over a hand-built string
- [ ] The whole loop is rehearsed against the scripted stand-in before a real call is made, and the
      rehearsal is what proves the new text reaches the agent
- [ ] A real agent's first answer fails to decode, its repair **decodes**, and the run reaches its
      gate — against a **small model**, named in the report
- [ ] `corrections: 1` is read off the **phase record in the trace database**, not inferred from the
      session transcript. Ticket 48 could not do this because the WAL sidecar was left behind; that
      hole is closed, so use it
- [ ] The run happens in a throwaway repository, never this working tree, with permissions enforced
- [ ] The number of real invocations is reported with the method used to count them — top-level
      prompts in the session transcripts under `~/.claude/projects/`
- [ ] `realAgent.test.ts` stops being known red: the header's "never been read off one" paragraph is
      replaced by what was read off one
- [ ] The ledger is updated in three places that must agree — `realAgent.test.ts`'s header,
      [typescript-effect.md §12](../../../docs/design/typescript-effect.md) and
      [build-record.md §9](../../../docs/build-record.md) — and ticket 48's fourth criterion is
      ticked with a pointer here
- [ ] The suite stays skip-unless-`KOJO_REAL_AGENT`, and a skip still reads as a skip

## Comments

*(none yet)*
