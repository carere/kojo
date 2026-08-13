# 25 — The trace and artifact read ports

**What to build:** The query side of the trace, plus access to the three things the trace deliberately does not store — the rendered prompt, the captured agent session, and the diff. Both ship an in-memory adapter, which is what lets the Console be tested without a database.

**Blocked by:** 24

**Status:** done

- [x] The trace reader answers every question the Console asks: the run list, one whole run, and a phase's occurrences from a cursor
- [x] The cursor is explicit rather than implicit, so a reader can actually advance it
- [x] Rows are decoded through the same schema machinery as everything else, so failures are typed rather than silently wrong
- [x] The artifact reader serves prompts, sessions, and diffs, reading the diff from git on demand rather than storing blobs
- [x] Identifier path segments are validated against a strict pattern and rejected outright rather than sanitised
- [x] Both ports have in-memory adapters sufficient to render a full run with no database present

## Comments

**The shape the Console lives with.** `TraceReader` has three methods and no more, one per read
endpoint in console.md §7 that touches the trace. `/api/gates` is deliberately not one of them: a
gate that is still waiting has no trace record, and `GateRepository.all` already answers the queue —
a second source for one list is a second answer.

**Only occurrences take a cursor.** A run is one `RunDocument`: the run summary, every phase, every
settled asking, every acquisition, in one value, polled whole and replaced. Occurrences are the one
unbounded stream, so `OccurrenceCursor` is a branded number that travels on the page it produced,
and an empty page returns the cursor it was asked with rather than zero.

**What the run row cannot yet say.** adr/trace/0002 puts the in-flight phase on the run record, and
the schema ticket 24 shipped has no column for it. `RunSummary` therefore carries the run record,
the outcome, and `finishedAt`, and says in its own comment that the in-flight phase arrives when the
column does. A reader cannot serve a column that is not written, and inventing one would be the
Console rendering a field nothing fills.

**Where artifacts live.** `WorkspaceArtifactReader` reads `.kojo/artifacts/<phase id>/prompt.md` and
`session.jsonl`, and the diff from `git show` over the commits the *caller* passes in. The commits
are passed rather than looked up on purpose: they are on the phase record the caller already read,
and fetching them here would make the artifact port depend on the trace port — the coupling that
would stop the browser tier running with no database. Nothing writes these files yet; the layout is
this ticket's, and the capture ticket follows it.

**Two guards, not one.** `safeSegments` is SSSF's rule ported verbatim — `^[A-Za-z0-9._-]+$`, with
`.` and `..` refused by name — applied to *every* segment of an identifier, because `makePhaseId`
builds `<run>/<name>/<attempt>` and a phase id is a path of identifiers rather than one.
`isObjectName` is a second, stricter guard on commits: `-` is legal in a path segment, so
`--upload-pack=…` passes the first guard and is also a git flag, and `argv` being an array makes
that argument injection rather than command injection — a smaller hole, and still one.

A consequence worth writing down: **a phase whose name is not a safe segment has no artifacts on
disk.** Every phase name in the codebase is one word today; an author who names a phase `bun install`
would get a refusal rather than a traversal, which is the right direction to fail in.

**Proved by test, and what each test grades**

- The identifier guard, unit — every allow-list case, both segments the pattern cannot refuse, and
  the repair-versus-refuse distinction (`....//`).
- `InMemoryTraceReader`, unit — run list order, the run document filtered and sorted per run, `None`
  for an unknown run, the cursor advancing and standing still, and one phase's occurrences when
  another run's are interleaved between them. Plus: the reader over `RecordedTrace` sees records
  written *after* the layer was built, which is the snapshot bug `InMemoryTracer` warns about.
- `InMemoryArtifactReader`, unit — the three artifacts with their media types, `absent` for a phase
  that kept nothing and for one that committed nothing, and the guard refusing a traversal **even
  when the fixture holds an artifact under that key**.
- `SqliteTraceReader`, integration — the round trip through the real writer on one file: the wide
  phase row back into its three nested blocks, the breach list back into its tagged union, both
  acquisitions in the order they happened, and a corrupt `outcome` landing in the typed channel as
  `TraceReadError` naming the column.
- `WorkspaceArtifactReader`, integration — a real git repository: the patch of a real commit, an
  unknown commit as `absent`, and both guards refusing.

**Proved by mutation, not only by assertion.** The traversal test was checked against a build with
`safeSegments` neutered to accept everything: the reader then resolved
`.kojo/artifacts/../../src/prompt.md` and served a seeded file that is not an artifact, and the test
failed with *"the reader answered where it was expected to refuse"*. The guard is load-bearing, and
the workspace's own escape check does not cover it — that path never leaves the root.

**Argued, not proved.** That the additive-migration promise holds — that a column a future engine
adds is one this reader ignores — follows from every query naming its table and every row schema
naming only what it needs, and no test adds a column and re-reads. That `Artifact.mediaType` is what
an HTTP response should carry is a claim about ticket 26, which has not been written.
