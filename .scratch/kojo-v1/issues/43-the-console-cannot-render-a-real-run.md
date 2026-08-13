# 43 — The Console shows nothing for a real run, and 85 specs are green over it

**What to build:** The run view renders a run the CLI actually produced. Today it renders the header
and then *"No phases yet"* over a run with three recorded phases — no waterfall, no gate card, an
empty docked panel. **A human cannot answer a gate from a browser against a real factory.**

Found by walking the whole loop after ticket 30, not by a test. Reproduced deterministically at
`apps/console/src/contexts/trace/models/waterfall.ts:251`:

```ts
if (inFlight === undefined || isTerminal(doc) || exited.has(inFlight.phaseId)) return spans;
```

`doc.run.inFlight` is `undefined` in the fixtures and **`null`** from the real API. `null === undefined`
is false, so on any non-terminal run the guard falls through and evaluates `inFlight.phaseId`:

```
TypeError: null is not an object (evaluating 'inFlight.phaseId')
```

**The bug is the shape disagreement, not the guard.** `fixtures.ts` builds every optional with
`...(x === undefined ? {} : { x })`, so a fixture document never contains a `null`. The real server
emits `"inFlight": null`, `"errorTag": null`, `"breaches": null`, `"repo": null`,
`"imageDigest": null`, `"contextTokens": null`. **The fixture layer and the HTTP layer disagree about
shape, so no browser test can catch a shape bug** — there are 20 `=== undefined` guards across the
Console and `inFlight` is merely the one that throws today.

**Do not close this with a lone `?.`.** That fixes one symptom and leaves the contract broken.

**Blocked by:** 30

**Status:** done

- [x] The run view renders a run produced by `kojo run` against a real factory — waterfall, gate
      card, and panel — asserted end to end from the command to the browser
- [x] The fixture layer and the HTTP layer agree about shape by construction, so a fixture cannot be
      a document the server would never send. Decide it once: absent, or `null`, not both
- [x] The remaining `=== undefined` guards are audited against that decision rather than patched
      one at a time
- [x] A browser spec would fail if the two layers drifted apart again — that is the real defect, and
      it is what 85 green specs missed

## Comments

**The contract is *absent*, and it is the type system that keeps it** —
[adr/trace/0003](../../../docs/adr/trace/0003-an-absent-field-is-absent-on-the-wire-never-null.md).

Every wire-facing record moved from `Schema.optional` to `Schema.optionalKey`. That is an *exact*
optional property, so with this repository's `exactOptionalPropertyTypes` a producer that writes
`{ inFlight: undefined }` no longer compiles — and a key that is never present holding `undefined` is
a key the JSON serializer can never write as `null`. Flipping the schemas reddened **fourteen**
construction sites in one pass, which is exactly the list of places that could have sent the wrong
shape: seven in `SqliteTraceReader`, three in `phase/agent.ts`, two in `phase/code.ts`, one in
`workflow.ts`, one in a test. Each now spreads `present("field", value)` — one helper,
`contexts/shared/lib/present.ts`, taking `null` as well as `undefined` because SQL has no absence.
`console/fixtures.ts` calls the same helper, so the two layers no longer agree by convention.

**What the guards audit found: nothing to change.** All twenty `=== undefined` guards across
`apps/console` are guards over an absent key, and every one of them is correct once the server can
only send an absent key. The audit is written into `RunDoc.ts`, where a reader decides what `?` means.

**What was seen by hand, before and after.** A factory stamped in a throwaway directory, `kojo run`
on a gated workflow with no agent in it, `kojo ui` over that database:

- before — `"inFlight": null, "imageDigest": null, "sandboxId": null, "errorTag": null, "breaches":
  null, "repo": null, "agent": null, "verification": null`, and the page a person met was the header,
  *"No phases yet"*, no waterfall and no gate card. The `TypeError` never reached the browser console;
  Solid swallowed it, which is why nothing looked broken.
- after, over **the same database file** — not one `null` at any depth on any route, and the page
  draws the waterfall, the span, the gate card with `approve`/`reject`, and the deadline.

**Three tests, and what each of them actually grades.**

- `apps/console/tests/browser/realRun.spec.ts` (5 specs) — the acceptance test: `kojo init`, `kojo
  run`, `kojo ui`, a browser. Its server is `tests/browser/realFactory.ts`, the only web server in the
  suite with no `--fixtures` flag. Reverting `RunSummary.inFlight` to `Schema.optional` and the
  reader to `inFlight: inFlightOf(row)` turns its first spec red on the assertion that the waterfall
  is drawn. It grades the thing itself.
- `tests/integration/console/api.test.ts` — two specs over the real SQLite writer, reader and router:
  no `null` on any of the four routes, and the in-flight key **missing** rather than null.
  `toBeUndefined` would have passed on both shapes, which is the whole bug in one assertion.
- `tests/unit/console/fixtures.test.ts` — the same two claims over the fixture layer, encoded through
  `responses.sends`, the function every route answers with. Two producers, one rule; neither can
  drift without reddening its own tier.

**What was not done.** The strongest version — `apps/console` importing the schema so that a drift is
a type error in the Console — was refused rather than forgotten: `apps/console` depends on nothing in
`packages/kojo` on purpose, and `packages/kojo:build` already depends on `console:build`, so the
dependency the other way is a cycle. The acceptance spec stands in for it, and the reasoning is in
the ADR's options list.

The one integration test that fails, `lane.test.ts > builds a container, tears it down at the gate`,
fails identically on this branch with every change stashed. It is a pre-existing flake: its assertion
is `docker ps --filter name=^sandcastle-` returning nothing, which is machine-global state.
