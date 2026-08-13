# 06 — Checks and the correction loop

**What to build:** A phase's claims are verified after the fact, and a failure re-prompts the same agent in the same session so a correction costs one message rather than a cold start. This is what makes an agent phase trustworthy without trusting the agent.

**Blocked by:** 05

**Status:** done

> **Inherited from ticket 04.** `CheckViolation` was deliberately not defined there, because its
> payload needs `CheckReport`, which this ticket introduces. Define it here as a
> `Schema.TaggedError` in the workflow context. The design record reads as though it already
> exists; it does not.


- [x] A check is a predicate over an envelope's claims, run after the agent returns
- [x] A decode failure and a check violation both re-prompt, and the correction text names the specific fields or claims that failed
- [x] The retry re-enters the same agent session rather than starting a new one
- [x] The correction loop is bounded, and exhausting the bound fails the phase with the original error
- [x] The phase record carries how many corrections it took and which checks failed
- [x] A three-phase chain with a deliberately wrong first envelope runs green after one correction

## Comments

### What landed

- `contexts/workflow/models/CheckReport.ts` — `ClaimFault`, `CheckResult`, `CheckReport`.
- `contexts/workflow/models/CheckViolation.ts` — the error ticket 04 deferred, `{ agent, check,
  report }` as the design record specifies.
- `contexts/workflow/guards/Check.ts` — the `Check<A, R>` port shape, `make`, and `runChecks`.
- `contexts/workflow/guards/checks/{artifactsExist,diffMatchesClaims}.ts` — the two checks the
  design record names. `diffMatchesClaims` reuses `Permissions.snapshot`, so "changed" means one
  thing in this codebase.
- `contexts/workflow/services/corrections.ts` — `correctionFor` and `withCorrections`.
- `contexts/trace/models/Verification.ts` and one appended optional field on `PhaseRecord`.
- The correction loop is wired **inside** the agent phase's activity, so one phase is still one
  trace row however many corrections it took.

### Deviations from the design record

1. **`Effect.catchTags` does not typecheck when the residual channel is generic.** The design
   record writes the loop as `catchTags({ EnvelopeParseError, CheckViolation })`. With
   `E` open — which is exactly what D8 needs, so a `PermissionBreach` travels out — the `Cases`
   constraint becomes a mapped type over `Extract<E, { _tag: string }>["_tag"]`, which TypeScript
   cannot evaluate for a generic `E`, and the call fails with `TS2345`. `Effect.catchTag` accepts a
   **tag list** (`catchTag(["EnvelopeParseError", "CheckViolation"], handler)`), and its constraint
   is `K extends Tags<E>` — a plain assignability check that a partly-generic union satisfies. The
   loop uses that. The D8 guarantee is unchanged and arguably sharper: naming a tag the effect
   cannot raise is still a hard compile error, proved by a `@ts-expect-error` in
   `tests/unit/contexts/workflow/services/corrections.test.ts` that was checked in both directions
   (removing `"PermissionBreach"` makes `bun tsc` report `TS2578: Unused '@ts-expect-error'`).
2. **The agent phase's error channel widened** to
   `EnvelopeParseError | AgentInvocationError | CheckViolation | WorkspaceError`, unconditionally
   rather than only when `checks` is given. A channel whose shape depends on an options list would
   make every author's workflow error union churn when a check is added. This required a one-line
   edit to ticket 05's `tests/unit/.../phase/agent.test.ts` error union, plus one assertion in that
   file that the loop genuinely changed (`resumed: false` -> `resumed: true`, because an agent that
   answers prose every time is now corrected twice before it fails).
3. **`PhaseRecord` gained exactly one appended optional field**, `verification`, per the hot-file
   rule. `corrections`, `failed`, `ran` and `correctable` live inside `Verification` rather than as
   four fields.
4. **Resume-unavailable is explicit, not silent.** `withCorrections` is called with a limit of zero
   when `AgentInvoker.capabilities.resume` is false, and the phase row carries
   `verification.correctable: false`. A cold call carrying only the correction text is a different
   request, so the phase does not make it, and the row says which of the two reasons it stopped.
5. **A shipped check needs its envelope named** — `artifactsExist<Scouted>({ … })`. `A` appears only
   in the selector's parameter, so a context-sensitive arrow leaves TypeScript nothing to infer
   from and the selector's argument silently becomes `unknown`. Documented on `Check`.

### API findings

- `Effect.catchTag` takes `K extends Tags<E> | NonEmptyReadonlyArray<Tags<E>>` — the array form is
  what makes tag dispatch usable inside a generic combinator. `Effect.catchTags`' object form is
  not, for the reason above.
- `Effect.catchTag`'s handler receives `ExtractTag<E, K>`, which for an open `E` still includes
  `ExtractTag<E, K>` — a caller's own error that happens to call itself `CheckViolation` reaches the
  handler. The loop narrows with `instanceof` before writing a correction from it, and lets anything
  else out untouched.
