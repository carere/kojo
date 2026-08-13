# 31 — Span export

**What to build:** Spans reach an OTLP collector for teams that already have one. Deliberately off the critical path: the phase table is the authority, and spans are a convenience.

**Blocked by:** 24

**Status:** wontfix

- [ ] Export goes through the built-in OTLP tracer; no extra observability packages are added
- [ ] Parent and child nesting comes from the fiber tree, with no identifier threaded by hand
- [ ] Spans across a suspension are linked rather than falsely parented, because a replayed phase re-parents under whoever answered the gate
- [ ] The trace sink is not built as an Effect tracer, since that slot is single-occupancy and would be lost to whichever exporter is layered last
- [ ] Export is off by default and costs nothing when disabled

## Closed as wontfix — 2026-08-13

Decided by the repository's owner, with the reason recorded rather than left to be guessed at.

**It blocks nothing.** It was written as the one deliverable off the critical path, and it stayed
there through seventeen waves.

**The claim it was written under was withdrawn.** The wave-3 API audit measured what happens to spans
across a suspension: replayed phases re-parent under whichever fiber completed the deferred — in
production, the gate-answer HTTP handler — so a run that suspends N times yields N+1 disconnected
fragments with the pre-suspend spans duplicated in each. `typescript-effect.md` §9 no longer claims
that spans and the phase table are one model; it says plainly that **the phase table is the
authority** and spans are a within-segment convenience. That demotion removed the reason for this
ticket.

**Every question the trace exists to answer is already answered without it.** One wide record per
unit of work, joined on `run_id` — which phases needed a container, what each agent cost, how long a
human held a gate, what a breach touched and what became of it. Ticket 26 also found that
`Tracer.Tracer` is a single-slot `Context.Reference` with no fan-out combinator, so building Kojo's
sink as an Effect tracer would have silently lost it to whichever exporter layered last.

**What reopening it would take.** A team that already runs an OTLP collector and wants Kojo's phases
beside their other spans. Then the work is `effect/unstable/observability/OtlpTracer` — never
`@effect/opentelemetry`, whose eight peers are optional and none resolve — plus span links rather
than parent relationships across a suspension, and the phase table staying authoritative regardless.
The audit's findings for all of that are in `docs/research/effect-v4-api-audit.md`.
