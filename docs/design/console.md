# Kojo — the Console

> The Console is how a human reads a run. One job: **drill into one run and investigate every aspect
> of it.** It is a delivery mechanism for the trace context, not a bounded context of its own.

The model is in [architecture.md](architecture.md). The engine is in
[typescript-effect.md](typescript-effect.md). This is the surface a person looks at.

---

## 1. What the Console is, and what it refuses to be

`kojo ui` serves it. It reads one factory's trace, it renders one run at a time in full depth, and
it answers gates.

It is **not** an analytics product. Token spend across two hundred runs, human-latency
distributions, per-agent success rates — all of that is real and none of it is here. A fleet view is
a separate view built on the same records, and it is deferred until the drill-down is right.

It is **not** the orchestrator. That word already names the engine
([typescript-effect.md §3](typescript-effect.md)), and one word means one thing
([architecture.md §6](architecture.md)). A console is the face of a control plane, and Kojo's control
plane is the engine behind it.

Three decisions carry the design, and each has its own record:

- [The run view is a waterfall, not the authored graph](../adr/trace/0001-run-view-is-a-waterfall-not-the-authored-graph.md)
- [The in-flight phase lives on the run record](../adr/trace/0002-in-flight-phase-lives-on-the-run-row.md)
- [The Console answers a gate by recording it, not by resolving it](../adr/gate/0001-the-console-answers-by-record-and-apply.md)

---

## 2. Scope

One factory per server instance. `kojo ui` runs in a repo and reads that repo's `.kojo/data/`. The
trace transport rule fixes one SQLite file in the read path, so one file is the unit. Several
factories is a later concern, and when it arrives it is a list of database paths and a switcher in
the header — not a redesign.

| In v1 | Deferred |
|---|---|
| the run list | the fleet view — token spend, latency distributions, per-agent rates |
| **the run view — the product** | cost in currency (see [architecture.md §8](architecture.md), edge 10) |
| the phase detail panel | authentication and non-loopback binding |
| the sandbox detail panel | several factories in one Console |
| answering a gate | editing anything at all |
| the gate queue | |

---

## 3. Views and routes

| Route | View |
|---|---|
| `/` | every run — id, workflow, status, open gate, deadline |
| `/runs/:runId` | the run view |
| `/runs/:runId/phases/:name/:attempt` | the run view, with a phase in the detail panel |
| `/runs/:runId/sandboxes/:name/:acquisition` | the run view, with a sandbox acquisition in the detail panel |
| `/runs/:runId/gates/:gate/:asking` | the run view, with one asking of a gate in the detail panel |
| `/gates` | what waits on a human, and for how long |

The detail routes are **nested routes rendering into a docked panel**, not pages. A phase detail must
be deep-linkable, because it is the thing a person pastes into a chat when they ask a colleague why a
run died. But replacing the waterfall with a full page throws away the position they clicked from,
and the whole job is investigation in context.

**A detail route addresses the identifier's suffix, not the whole identifier.** A phase id is
`<run>/<name>/<attempt>`, so spelling it as one `:phaseId` segment needs percent-encoding and gives
`/runs/run-merged/phases/run-merged%2Fhotfix%2F1` — the run named twice, the second time unreadably.
Three reasons decided it, in order of weight: the URL is read by a human; a suffix cannot contradict
its own prefix, whereas `/runs/A/phases/B/x/1` is well-formed and names two different runs; and every
segment of a Kojo identifier is `[A-Za-z0-9._-]+` by the trace's own path guard, so nothing needs
escaping by construction. The cost is that the browser knows the identifier grammar — written down
once, in `contexts/trace/models/ids.ts`. A sandbox id splits the same way, with `:acquisition` being
its `<millis>-<sequence>` discriminator taken whole.

Note that the **API** keeps the identifier whole in one segment (§9) — it is read by programs, and an
encoded id round-trips there without a reader ever seeing it.

**A gate gets its own route, `/runs/:runId/gates/:gate/:asking`, and the panel gets a third subject.**

The `:asking` segment is the **one parameter on this surface that is percent-encoded**, and the
reason is the rule above rather than an exception to it. A phase id and a sandbox id are Kojo
identifiers, held to `[A-Za-z0-9._-]+` by the trace's path guard, so their segments need no escaping.
An asking is not one: it is the engine's durable deferred name, built as
`gate/<lane>/<name>/<round>`, and it carries slashes because nothing ever writes it to disk. It
travels whole and **unparsed** — the Console could read the round off the end and print something
shorter, and it would be inventing a grammar the engine never promised.

This corrects what this section said until ticket 29 — *"a gate is a phase of kind `actor`, so its
detail panel is the phase detail panel, plus the answer form."* That was written during the design
session and the engine never backed it. Checked: only `agent.ts` and `code.ts` construct a
`PhaseRecord`; `gate.ts` writes a `GateRecord` through `tracer.gate(…)` and never imports
`PhaseRecord`. Nothing anywhere writes `kind: "actor"`. And `GateRecord` carries **no `phaseId`** —
only `runId`, `gate` and `asking` — so even a hand-made actor phase would have no recorded link to
the gate it stood for.

The record was always the better answer, because it is richer than a phase row could be: the token,
the choices, the deadline and its expiry branch, the answerer, and the latency. And the identity is
already there — an **asking** is what a gate record is keyed by
([context/gate.md](../context/gate.md)), because a gate answered on the third round says nothing
about how long the first two waited.

`PhaseKind` still declares `"actor"`. It is unwritten today, and a value nothing produces is a value
a reader will wrongly assume they can filter on — worth removing, or worth a comment saying what
would write one.

---

## 4. The run view

Three parts, in descending order of how fast they answer a question.

**The header — what now.** Run id, workflow, status, branch, elapsed, and what produced the run:
engine version and commit, config digest, host, image digest. When the run is suspended, a gate card
sits directly beneath it, carrying what is being decided, how long it has waited, the deadline and
its expiry branch, and the answer controls. If you deleted the waterfall the page would still be
useful. If you deleted the header it would not.

**The waterfall — what happened.** §5.

**The detail panel — everything else.** §6.

A **table toggle** renders the same phase records as rows. The wide record is sometimes best read as
a row, and the toggle costs nothing because it is the same data.

---

## 5. The waterfall

Time runs left to right. **Rows are the scope tree, not concurrency lanes** — the host is the root
row, and each sandbox acquisition is a child row. A phase is one span on the row of the scope it ran
in.

This matters more than it looks. A run is mostly sequential, so a conventional gantt would spend the
whole vertical plane drawing a staircase. Using the vertical axis for *scope* makes it answer a
question nothing else answers — which phases needed a container — and it makes two costs visible as
geometry rather than as numbers someone has to go looking for:

- **The host / sandbox boundary.** The router runs on the root row; the builder runs inside a band.
- **The rebuild after a gate.** [§9](typescript-effect.md) already writes one sandbox record *per
  acquisition*, so a rebuild is a second row. Nobody designed a rebuild indicator. The row model
  surfaces [edge 2](architecture.md) for free.

### The axis breaks

A realistic hotfix run: `in_progress` 0.2 s, `route` 8 s, sandbox setup 90 s, `scout` 3 min,
`hotfix` 6 min, **gate 41 h**, `test` 2 min, `merge` 1 s. On a linear axis sized to 41 hours,
everything worth reading is a hairline.

So any span or gap above a threshold collapses to a fixed-width **break**, labelled with its real
duration, drawn across every row so a gate reads as a wall through the whole run. This is more
informative than a linear axis, not a compromise with one: a 41-hour bar reads as "long" and cannot
be measured, while a break states *41h 12m*. Wall-clock remains available behind a toggle.

The same break applies to dead time *between* phases, so a run that sat idle for an hour cannot hide
inside the gaps.

### Grammar

| Element | Drawn as |
|---|---|
| phase kind | span colour — agent, code, actor |
| scope | row; sandbox rows carry a band behind their spans |
| corrections | segment marks inside the one span, never separate spans |
| failure | span outline, plus the terminal error tag on the span label |
| permission breach | its own mark; a breach is not a check violation and must not read like one |
| the in-flight phase | a span that grows to *now*, replaced by the real span on exit |
| gate wait | a break carrying its duration |

Two consequences of choosing a gantt component to render this:

1. **Add second, minute, and hour scales.** Day-to-year is wrong by three orders of magnitude for
   phases that last seconds.
2. **Do not port the editing surface.** Drag, resize, snapping, `canDropEvent`, `onEventUpdate`, and
   `addEvent` have no meaning over immutable history. A draggable trace bar is a bug shaped like a
   feature.

---

## 6. The detail panel

The panel has **three subjects**: a phase, a sandbox acquisition, or one asking of a gate. The
sandbox band is not scenery — it is a whole sandbox record — and a gate is not a phase, whatever §3
used to say.

### A phase

From the phase record, which already carries all of it:

- **summary** — attempt, start, end, duration, and the workflow's description
- **agent** — only for an agent phase: name, model, session id, cold or resumed, tokens in and out,
  reported context-window occupancy, and correction turns when there were any
- **errors** — only when there are errors: a plain explanation of the terminal error and the checks
  that failed. Envelope and verification details are trace internals, not the question a person asks
  here
- **repository changes** — only when the record carries them: files the phase reported, files that
  actually changed, commits produced, and permission breaches with their rollback outcomes
- **where it ran** — the sandbox acquisition, or the host

Three artifacts are **not** in the trace and are fetched on demand:

- **the prompt sent to the agent** — only for an agent phase: system and user, as received
- **the agent conversation** — only for an agent phase: the transcript, including corrections
- **the code diff** — only when the phase produced a commit; read from git on the run's branch

**Agent activity** is the user-facing name for the trace's occurrences. Tool calls, `exec`
invocations, and iterations stream into the panel while an agent phase is in flight and are listed
once it is not. Code phases do not fetch or show this agent-only information.

### A sandbox acquisition

Provider, image digest, branch, worktree path, hooks that ran, acquisition and release timestamps,
outcome, and which phases ran inside it. A second acquisition of the same branch shows the rebuild
cost that a mid-lane gate imposed.

### An asking of a gate

What is being decided, who was asked, the choices, the token, the deadline and its expiry branch, how
long the question has been with a human, and the answer controls when it is still open.

**It is read from two sources, and it needs both.** `GET /api/gates` carries the request and whether
a verdict has been **recorded**; the run document carries the **settled** gate record, which is the
only proof the answer was applied. A gate that settled long ago has a record and no asking, and one
answered a minute ago has an asking and no record. The panel renders from whichever half it has and
says what the other one was carrying — see §9 for why the difference is the whole point.

---

## 7. The data path

**A static build, served by Kojo's own server.** `apps/console` builds in TanStack Start's SPA mode:
a prerendered shell plus the client bundle, no server functions. `kojo ui` starts an
`effect/unstable/http` server — `BunHttpServer.layer({ port })`, which also satisfies
`HttpStaticServer` — that serves those files and a JSON API.

**Hand-roll the SPA fallback.** The built-in one is conditional: it serves the shell only when the
stat failed `NotFound` *and* `spa: true` *and* the path has no extension *and* `Accept` contains
`text/html`. Verified — `curl /runs/r1` bare returns 404, and any deep-link segment containing a dot
404s. Catching `RouteNotFound` and serving the shell unconditionally is four lines, and
`fileResponse` does not set a content type, so the explicit `setHeader` is load-bearing.

Two more framework facts that shape the server:

- **Route errors surface in the requirement channel, not the error channel.** `HttpRouter.add`
  returns a Layer carrying the handler's error as a requirement, so an unhandled error becomes an
  unsatisfied requirement at `serve` rather than a Layer failure. `HttpServerResponse.json` alone
  puts `HttpBodyError` there.
- **`HttpStaticServer` already has the path-traversal guard**, plus byte ranges and ETag. So the
  guard ported from SSSF protects `ArtifactReader`'s id segments — it is not what protects the
  static build.

The alternative — TanStack Start's SSR server *being* `kojo ui` — was rejected. The published package
already ships the build output ([§2](typescript-effect.md)), and under SPA mode that is a directory
of files, while under SSR it is a second runtime living inside a CLI whose whole discipline is that
every side effect goes through a port and every `Promise` lives in one module
([§7](typescript-effect.md)). The cost of the choice, stated plainly: TanStack **Start** then buys
little over TanStack **Router** plus Vite. It keeps file-based routing and leaves SSR available
later.

### Two read ports

```ts
// contexts/trace/ports/TraceReader.ts — the query side of the trace
// contexts/trace/ports/ArtifactReader.ts — prompts, sessions, diffs
```

`TraceReader` is the read counterpart of `Tracer`, and it exists so the browser tier can run against
an in-memory adapter with no SQLite at all — the same pairing every other port has.
`ArtifactReader` is separate because it touches the filesystem and git rather than the database, and
because its failures are survivable in a way a missing trace record is not.

**Port SSSF's path guard verbatim.** Run ids, phase ids, and agent names are path segments on disk.
Reject any segment that is not `^[A-Za-z0-9._-]+$`, and reject `.` and `..` outright, rather than
sanitising into something that might still escape.

### The surface

| Endpoint | Shape |
|---|---|
| `GET /api/runs` | the list, polled whole |
| `GET /api/runs/:runId` | **the whole run document** — run record with its in-flight phase, every phase record, gate records, sandbox records |
| `GET /api/runs/:runId/phases/:phaseId/occurrences?since=<rowid>` | the only cursor |
| `GET /api/runs/:runId/phases/:phaseId/{prompt,session,diff}` | `ArtifactReader`, one-shot |
| `GET /api/gates` | the queue |
| `POST /api/gates/:token/answer` | the only mutation |
| `GET /api/health` | database path, kojo version, schema version, **is a runner live** |

**The cursor is used only where the stream is unbounded.** §9's poll-a-monotonic-cursor rule was
written for occurrences, which are genuinely unbounded inside a phase. A run's *phase* list is not:
ten to forty records, a few kilobytes. Polling the whole run document and replacing it removes every
merge concern, and occurrences are polled by cursor only while a phase detail is open and its phase
is in flight.

**Cadence: one second while the run is live; stop entirely at a terminal status.** A finished run
then costs nothing to leave open on screen — the mirror of §9's *"a run that has no reader pays
nothing"*.

Reads go through `SqlSchema.findAll` and friends, which decode rows through `Schema` and put failures
in the typed channel — the single-contract rule of §5 extends to the read side, and no row mapping is
written by hand. **There are no streaming reads on this driver**, so the cursor is polled, never
subscribed. `SqlClient.reactive` exists but is process-local, so it cannot serve a Console in its own
process.

Artifacts are cacheable **forever**: a phase is immutable once it has exited.

---

## 8. State

Two libraries, one rule, so the boundary does not rot.

- **TanStack Query loads data.** Every read above, and the gate-answer mutation. It owns the server
  cache, the polling, the retry, and the invalidation.
- **Solux is local to a highly interactive component.** It is not a global store and it does not
  fetch. It is event programming: the waterfall's zoom, pan, hover, selection, break thresholds, and
  the synchronisation between the axis, the rows, and the detail panel.

Everything else — route state, the timeline-or-table toggle, filters — belongs to the URL, because
the URL is what a person pastes to a colleague.

---

## 9. Answering a gate

The gate card in the run header, and the `/gates` queue, both post to
`POST /api/gates/:token/answer`. The Console persists the token, verdict, reason, and answerer; a
live runner applies it. The reasoning and the rejected alternatives are in
[the ADR](../adr/gate/0001-the-console-answers-by-record-and-apply.md).

The rule the UI must not break: **a recorded answer is never rendered as an applied one.** After a
click the card resolves to one of three states, and it says which:

- *Recorded — applying…* — the answer is persisted and a runner is alive. This state is normal and
  can last **ten seconds**, because a runner picks up a message written by another process on its
  entity poll interval. A spinner that gives up sooner would be lying in the other direction.
- *Applied — the run resumed.*
- *Recorded — no runner is running. Start `kojo watch` to apply it.*

Three after a click, and **six in all** — the two before anybody has clicked, *waiting* and
*overdue*, and one that no click produces at all: *expired — the run moved on without an answer*.

### *Applied* is read from the run's own record, and from nothing else

Which of the six a card says is decided by three questions in this order, and the order is the order
of certainty.

**Has the run settled this asking?** The trace's `GateRecord` is written by the run itself, in the
activity that follows the suspension — `phase/gate.ts` records the settlement the moment the durable
deferred resolves. So a record keyed by this asking is the run's own account of having woken up and
carried on, and its absence is the account of not having. Nothing weaker will do: a `200` on the
answer proves a verdict was written, and a run whose outcome left `suspended` may have suspended
again on a second gate. Only the record is about *this* asking.

**And how did it settle?** The record is not proof that anybody *decided* — only that the run moved.
`phase/gate.ts` writes the same `<asking>/record` activity for whichever half of
`DurableDeferred.raceAll` won, so a gate that ran out of time leaves a record exactly as an answered
one does, with `outcome: "expired"` and no answerer. **Reading a record's mere presence as *applied*
is the same failure as reading a `200` that way, pointed the other way**: it puts *"a runner picked
the answer up"* in front of a person over a question nobody ever answered, beside a panel already
saying `expired`. Only `outcome: "answered"` may be drawn as *applied*; an expiry gets its own
sentence and no answer controls, because the run has already taken its branch and there is nothing
left to decide.

*Expired* is not *overdue*, and the difference is what the run has done. **Overdue** means the
deadline has passed and the run has not reached it yet — an answer given now may still land, so the
buttons stay. **Expired** means the run has settled it, and no answer can change anything.

**If it has not settled, is anybody alive to apply the verdict?** From the answer receipt, which reads the runner table at
the moment the verdict is written and so needs no second round trip, and from `/api/health`
afterwards — polled while, and only while, a verdict is recorded and nothing has applied it. A
watcher can be killed while a card sits on screen, and a card still saying *applying…* half an hour
later is the same lie in slow motion. When neither source has answered yet the card says *nothing is
running*: the two errors are not equal, and guessing *live* is the one that lies.

A card therefore **outlives the suspension it belongs to**. One that showed only while the run was
`suspended` would disappear at the instant a runner applied the answer, which is the instant *applied
— the run resumed* becomes the only sentence worth reading.

### Liveness comes from `cluster_runners`, and not from `RunnerHealth`

The framework already answers the question this ADR needs. `SqlRunnerStorage` maintains
`cluster_runners(machine_id, address, runner, healthy, last_heartbeat)`, refreshed every ten seconds
by the shard-lock loop — **including for a runner holding zero shards** — and `getRunners` already
applies the staleness filter `last_heartbeat > now - 35 seconds`. So `/api/health` is a read against
that table, through a read-only `SqlRunnerStorage` over the same client. **Kojo writes no heartbeat
of its own.**

Two traps, and the first one is the whole point of the ADR:

- **Do not implement liveness through `RunnerHealth`.** `SingleRunner.layer()` wires
  `RunnerHealth.layerNoop`, whose `isAlive` returns `true` for any address. A Console built on that
  always reports a live runner — producing precisely the *"approved ✓"* that means nothing.
- **No rows is the normal idle state.** Sharding unregisters on graceful shutdown, so a cleanly
  stopped `kojo watch` leaves the table empty. Empty is "nothing running", not "something is wrong".
  A crashed runner leaves a stale row for up to 35 seconds, which is why the timestamp filter is
  mandatory rather than an optimisation.

Localhost only in v1, no authentication, the OS user recorded as the answerer.

---

## 10. When the world is broken

| Condition | What the Console does |
|---|---|
| no `.kojo/data/kojo.db` in this repo | *"No factory in this repo. Run `kojo init`."* Not an error page |
| no runs yet | *"No runs yet. Run `kojo run <workflow>`."* |
| no runner live | the gate card states *recorded*, not *applied*. See §9 |
| the branch is gone, so no diff | the phase record still lists the files it changed; the diff pane says the branch is gone. One missing artifact never fails the whole panel |
| database schema newer than the Console | ignore unknown columns silently — this is what §9's additive-migration promise buys |
| database schema older than the Console | warn loudly. The asymmetry is the point — and this is implemented by **reading the migration table before building the layer**, because a failing migration is `Effect.die`, not something a handler can catch |
| the API is unreachable | keep the last data on screen, show a retrying banner. Never blank the view |

---

## 11. Testing

Browser tier only, `@playwright/test`, per [§10](typescript-effect.md).

Tests run against **in-memory `TraceReader` and `ArtifactReader` adapters behind the real HTTP
server**, selected by a flag. The tests then exercise the real routes, the real Query wiring, and the
real waterfall; only the data source is fake. This is the direct analogue of the unit tier's
`InMemoryTracer`, and it keeps the rule intact: browser tests touch no real adapter.

Two seams make this cheap: `BunHttpServer.layerTest` starts on an ephemeral port with a preconfigured
client, and `HttpRouter.toWebHandler` returns a fetch handler bound to no port at all, for the cases
that do not need a socket.

**Fixtures must contain the states a UI gets wrong**: a run with a 41-hour gate; a correction loop
that took three attempts; a `PermissionBreach` with its rollback outcome; a phase interrupted
mid-flight; a sandbox acquired twice; and a run with no phases yet.

**One design requirement follows.** A waterfall of timestamps is untestable unless *now* is
injectable. The Console reads the current time from an injected source, never `Date.now()` inside a
component. Playwright freezes it, the fixtures use fixed timestamps, and screenshots become stable.

---

## 12. Stack

| Piece | Choice |
|---|---|
| framework | SolidJS |
| app framework | [TanStack Start](https://tanstack.com/start) (Solid), **SPA mode**, no server functions |
| routing | TanStack Router — nested routes render the detail panel |
| server data | TanStack Query |
| tables | TanStack Table — the run list and the phase table toggle |
| components | [Zaidan](https://github.com/carere/zaidan) |
| waterfall widget | a Zaidan port of the [reui gantt](https://reui.io/components/gantt), read-only, with second/minute/hour scales |
| interactive state | [Solux](https://github.com/carere/solux), scoped to the waterfall |
| browser tests | `@playwright/test` |
| server | `effect/unstable/http`, inside `packages/kojo` |

`apps/console` is a moon project. `console:build` is a build dependency of the published package, so
`kojo ui` works for anyone who installed Kojo rather than only for people who cloned this repo.
