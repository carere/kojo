# An absent field is absent on the wire, never null

## Status for the Daemon design

The absent-optional-field contract remains in force for the shared client API.
[Define Daemon context and port boundaries](https://github.com/carere/kojo/issues/62) places its
schemas and types in an independent, browser-safe contract package. The Console, CLI, and Daemon
handlers can all depend on it without making the Console depend on `packages/kojo`. This replaces
the earlier package-dependency reason for rejecting shared schemas; it does not permit `null` for
an absent field. The package split is planned, not implemented.

## Original fault and wire decision

Every record the Console reads carries optional fields — `inFlight`, `sandboxId`, `errorTag`,
`breaches`, `repo`, `agent`, `verification`, `imageDigest`, `contextTokens`, `answerer`. Each of them
means the same thing when it is not there: *this run has no phase in flight*, *this phase ran on the
host*, *nothing resolved an image*. One meaning, and until now **two encodings**.

`Schema.optional(X)` is `optionalKey(UndefinedOr(X))`. A record built without the key encodes to a
document that has no key; the same record built with the key holding `undefined` encodes to
`"inFlight": null`, because that is how the JSON serializer writes `undefined`. Both were legal, both
were produced, and which one a browser received depended on which producer had built the record:

- `console/fixtures.ts` omitted the key, so a fixture document could never contain a `null`.
- `SqliteTraceReader` passed `undefined` — `absentIfNull(row.in_flight_phase_id)` and thirteen
  siblings — so a database document contained six of them.

**So the browser tier could not see a shape bug, because the shape it was shown was not the shape
that ships.** `apps/console` reads the document structurally and guards absence with
`x === undefined` in twenty places. `null === undefined` is false. On every non-terminal run a real
factory has ever produced, `spansOf` fell through its guard and evaluated `inFlight.phaseId`:

```
TypeError: null is not an object (evaluating 'inFlight.phaseId')
```

Eighty-five browser specs were green over it, for the whole life of the Console, until somebody ran
`kojo run` and opened a browser.

## Decision

**Absent.** A field with no value is omitted from the JSON. `null` never appears in a response of the
Console API.

It is enforced by the type system rather than by review:

- Every wire-facing schema declares its optional fields with `Schema.optionalKey`, which is an *exact*
  optional property — `{ readonly f?: A }`, with no `| undefined`.
- The repository compiles with `exactOptionalPropertyTypes`, so `new PhaseRecord({ sandboxId:
  undefined })` **does not type-check**. Fourteen producer sites failed to compile the moment the
  schemas changed, which is the list of every place that could have sent a `null`.
- `contexts/shared/lib/present.ts` is what a producer writes instead — `...present("sandboxId",
  row.sandbox_id)` — and it takes `null` as well as `undefined`, because SQL has no absence and a
  nullable column is how a table writes one down.

The fixtures use the same helper as the readers. That is the point of the record: the two layers no
longer *agree by convention*, they agree because a document either layer can build is built by the
same function through the same schema, and a drift is a compile error.

## Considered Options

- **`null` everywhere instead.** Rejected. Making the wire always carry `null` means the key must
  always be present, which means the field cannot be an optional key at all — it becomes
  `Schema.NullOr(X)` as a *required* field, and every reader in the engine goes from
  `record.imageDigest === undefined` to `=== null` while every constructor has to state ten fields it
  has nothing to say about. The domain model would be paying, permanently, for a wire detail.
- **Normalise in the responder.** Strip `null`s from the encoded body inside `console/responses.ts`.
  Rejected: it is one chokepoint and it works, but it is invisible to the type system, it makes the
  schema and the bytes disagree, and the next producer to be added is not told anything.
- **Make the Console tolerant of both.** An optional chain at each of the twenty guards, or one
  recursive null-stripper at `fetchJson`. Rejected as the *primary* fix: it leaves two shapes on the
  wire and buys nothing for the next reader of this API — and there is one, because `kojo ui` serves
  JSON that a person can `curl`. The Console is not made defensive against a shape the server is now
  unable to send.
- **Build both sides from one schema.** Originally not taken: `apps/console` deliberately depends on
  nothing in `packages/kojo` — `tests/browser/harness.ts` records why — and `packages/kojo:build`
  already depends on `console:build`, so a dependency the other way is a cycle in the project graph.
  The original check is `tests/browser/realRun.spec.ts`: a run produced by `kojo run` against a
  stamped factory, rendered in a browser. A drift between the two layers stops that page rendering,
  which is the same defect stated as the thing a person would actually meet. The planned independent
  contract package removes that cycle, so shared schemas are now accepted. Wire validation must
  still verify the encoded response; shared types alone do not prove the bytes are correct.

## Consequences

- One shape on the wire. `curl /api/runs/:id` on a fresh run returns a document with no `null` in it
  at any depth.
- The twenty `=== undefined` guards in `apps/console` are correct as written, and were audited
  against this decision rather than patched one at a time.
- **Decoding got stricter.** `optionalKey` refuses a key that is present holding `null`, where
  `optional` accepted it. Nothing in this build decodes these records from JSON — the SQLite readers
  decode *rows* and construct records — so the only exposure is a database written by a build older
  than this one whose *persisted workflow state* held one of these records. The engine's own activity
  payloads are unaffected: `AgentAnswer`, `RosterEntry` and the trigger models keep `Schema.optional`,
  because they are decode-side contracts with inputs from outside this process, and this decision is
  about what the Console API sends.
- A new optional field on a wire record is `Schema.optionalKey`, and a producer that fills it writes
  `present`. Anything else fails to compile.
