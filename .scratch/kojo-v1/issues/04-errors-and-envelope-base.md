# 04 — The error module and the envelope base

**What to build:** The two type-level foundations everything else is built on. Every Kojo error is a schema-backed tagged error, so it can be a workflow's error channel and survive being persisted and read back. Every envelope extends a plain schema class and declares its own tag.

This lands before there are call sites on purpose. With code in place it would be a wide refactor; here it is one ticket.

**Blocked by:** 01

**Status:** done

- [x] Errors are schema-backed tagged errors, not plain data tagged errors, and a test round-trips one through the engine's exit encoding
- [x] A workflow declaring a union of Kojo errors as its error channel compiles
- [x] The envelope base is a plain schema class; each envelope declares its own tag field and reports that tag in its type, at runtime, and in its generated JSON Schema
- [x] Extending the base with a tagged base class is proven impossible, with a test or a comment recording why
- [x] One decode helper is the only decode path, and it is fixed at reporting every issue rather than the first
- [x] A decode failure carries the structured issue tree, not a rendered string
- [x] Handling a subset of error tags leaves the remaining tags in the residual channel, asserted by compilation

## Comments

### What landed

| File | What |
|---|---|
| `src/contexts/workflow/models/Envelope.ts` | `EnvelopeBase` — a plain `Schema.Class` with no fields |
| `src/contexts/workflow/models/EnvelopeParseError.ts` | the correction loop's input |
| `src/contexts/workflow/models/NotAccepted.ts` | acceptance refused |
| `src/contexts/gate/models/GateRejected.ts` | a human said no |
| `src/contexts/gate/models/GateExpired.ts` | the deadline passed |
| `src/contexts/shared/lib/decode.ts` | `decodeUnknown` — the one decode path, fixed at `{ errors: "all" }` |
| `src/contexts/shared/models/DecodeIssue.ts` | one path-precise decode fault, persistable |

### Errors skipped, and why

- **`CheckViolation`** — its payload is a `CheckReport`, which ticket 06 owns together with what a
  check *is*. Inventing the report here would have forced 06 to change it.
- **`PermissionBreach`** — its payload is a list of `{ path, outcome: RollbackOutcome }`, and the
  rollback outcomes are ticket 14's to define. 14 is blocked by this ticket only for the error
  *style*, which is now settled; the error itself belongs beside the rollback that produces it.

Both are named in the design's §6 list; neither has a payload type that exists yet.

### Deviations from the design record

- **`EnvelopeParseError.parseError: SchemaError` became `issues: Schema.Array(DecodeIssue)`.**
  `SchemaError` is a `Data.TaggedError`, so it is not a schema and cannot be a field of one; and its
  `SchemaIssue.Issue` tree carries AST nodes and the raw input, neither of which is JSON. The tree
  is flattened at the boundary by `SchemaIssue.makeFormatterStandardSchemaV1`, which accumulates
  `Pointer` paths, into one `{ path, message }` per leaf fault. The path — the part the design says
  the tree is *for*, because it lets the feedback name fields — survives; the AST does not. The live
  `SchemaError` is still what `decodeUnknown` fails with, so a caller that has not persisted
  anything yet still holds the full tree.
- **The base carries no fields.** The design does not say what is in it. An envelope is an agent's
  output, so a field on the base is a field every agent in every factory must produce; the base
  earns its place by fixing the shape, not by levying a tax.
- **`GateRejected.actor` keeps the design's field name**, not gate.md's *answerer*. Ticket 08 owns
  the gate vocabulary and the verdict schema; renaming from here would collide with it.

### API facts found by building

- **`Workflow.Complete.Schema({ success, error })` is reachable and is literally what the engine
  persists a finished run with.** The round-trip test uses it rather than re-deriving
  `Schema.Exit(...)`, so the test cannot drift from the engine. Wrapping it in
  `Schema.toCodecJson(...)` gives the JSON form; `new Workflow.Complete({ exit })` constructs the
  value.
- **`Schema.Duration` has a `toCodecJson` annotation**, so `GateExpired.waited` survives the JSON
  round trip as `{ _tag: "Millis", value }`. A declaration without one would encode to itself and
  break at the store.
- **`Schema.decodeUnknownEffect(schema, options)` lets the *application* call override the creation
  options** ("application options override creation options"). A helper that forwards its second
  argument therefore does not fix anything. `decodeUnknown` is unary on purpose, and a test asserts
  by compilation that a call site cannot pass options.
- **The Effect language service reports its own diagnostics (`TS377003`, `TS377037`) and
  `@ts-expect-error` does not suppress them.** The D8 residual-channel assertion was rewritten from
  a suppressed bad assignment to an exact type-equality witness
  (`Equals<ErrorOf<typeof handled>, NotAccepted> = true`), which is stronger anyway: `extends` alone
  would have accepted `never`. Plain `tsc` errors (`TS2322` for a handler on an impossible tag,
  `TS2509` for an own `_tag` against a tagged base) *are* suppressed by `@ts-expect-error`, so those
  two negative proofs are directives that fail the build if the code ever starts compiling.
- **A tagged base is worse than a compile error alone.** The test also pins the silent half: a child
  of a `Schema.TaggedClass` that does *not* declare a tag answers to the base's tag at runtime and
  in `toJsonSchemaDocument`, so the agent is shown one contract and judged against another.

### Environment note

`moon` and `proto` refuse to run from a git worktree nested inside the main repo: proto locks
`~/Projects/kojo` and then finds the worktree's own tracked `.prototools` below it —
`proto::config::lockfile_already_exists`, "Nested lock files are not supported". No
`PROTO_*` override clears it. `bun install`, `bun tsc --build`, `bun biome check .` and `bun knip`
run with the proto shims taken off `PATH`; `moon run kojo:test` was run with `.prototools` moved
aside and restored immediately after. All four checks pass. Nothing about this is caused by the
ticket, and nothing about it is committed.
