# 26 — The Console server

**What to build:** A command that serves the Console: the static build plus a JSON API over one factory's trace. No second runtime, no daemon between the run and the screen.

**Blocked by:** 25

**Status:** done

- [x] The command serves the built assets and the API from one process
- [x] Deep links resolve to the application shell unconditionally — including paths with dots and requests that do not ask for HTML
- [x] Handler errors are handled rather than surfacing as unsatisfied requirements at startup
- [x] Health reports the database path, the versions, and whether a runner is alive
- [x] Finished-run artifacts are cacheable indefinitely, because a phase is immutable once it has exited
- [x] Reads are polled; there is no streaming read path on this driver and the server does not pretend otherwise

## Comments

`kojo ui` is one command, one factory, one process: `BunHttpServer.layer({ port })` serves
`console.md §7`'s endpoint table and the static build on one router. The Console lives in
`src/console/`, beside `src/cli/` rather than under `contexts/`, because console.md §1 says it is a
delivery mechanism for the trace context and not a bounded context of its own.

**What was measured rather than assumed.**

- **The requirement-channel claim does not reproduce on `effect@4.0.0-beta.106`.** console.md and the
  brief both say an unhandled route error becomes an unsatisfied requirement at `serve`. It does not:
  `HttpRouter.serve`'s `R` is `Request.Without<R> | Request.Only<"Requires", R>`, which **drops** the
  `Request<"Error", E>` marker entirely. A probe route with an unhandled `Schema.TaggedError`
  compiled to `Layer<never, never, HttpServer>` and answered `500` with an **empty body** at request
  time. So the criterion still holds — every handler here ends with an error channel of `never` — but
  the failure it prevents is a silent 500 rather than a server that will not start. Worth correcting
  in console.md §7.
- **The SPA fallback is hand-rolled**, and both measured cases are graded over a real socket: a deep
  link with no `Accept: text/html`, and a deep link whose segment contains a dot. `fileResponse` sets
  no content type, so the explicit `setHeader` is load-bearing and is asserted.
- **A phase id is several path segments**, so it travels percent-encoded in one `:phaseId` segment.
  The router leaves `%2F` alone when it splits the path and decodes it when it fills the parameter,
  which is why this works without a wildcard route. Asserted rather than assumed.
- **Artifacts are cacheable forever because the phase record exists.** The handler reads the run
  document first — which it needs anyway, for the commits `ArtifactReader.diff` takes — and a record
  exists only for a phase that has **exited**. A phase in flight has no record, so it is a 404 with
  no `Cache-Control` at all.
- **The Console registers no runner.** Its engine is `SingleNodeEngine.layer({ shardingConfig: {
  runnerAddress: Option.none() } })`, the client-only Sharding adr/gate/0001 names. The integration
  tier asserts `select address from cluster_runners` is empty while the Console holds an engine —
  which is what stops `/api/health` finding its own row and reporting the "approved ✓ that means
  nothing".
- **The `--assets` default is `<package>/console`**, where `console:build` output lands for somebody
  who installed Kojo. Until ticket 27 exists there is no directory, and a placeholder page says so.
- **An optional field encodes two ways.** A key never set encodes to nothing; a key set to
  `undefined` encodes to an explicit `null`. `healthOf` therefore omits `notice` with the repo's own
  `...(x === undefined ? {} : { x })` idiom, so the Console has one absence to recognise.
- **`kojo ui` announced its URL before it bound the port.** Caught by the CLI integration test as a
  refused connection. The announcement is now a layer requiring `HttpServer`, which forces the order.

**Degraded states.** No database file: the command still serves, `/api/health` says
`factory: "absent"` with *"No factory in this repo. Run `kojo init`."*, and every list is empty. The
file is **not opened** to find that out — the driver would create it, and looking must never be an
act of writing; an integration test asserts the file still does not exist afterwards. A schema older
than this build warns loudly with both migration numbers; a newer one is silent, which is what the
additive-migration promise buys. The ledger is read with a `select` **before any layer is built**,
because a failing migration is `Effect.die`.

**Known gap, outside this ticket.** `src/cli/factory.ts` still wires `InMemoryTracer`, so no `kojo`
command writes the durable trace yet and `kojo_migrations` is unwritten on a real factory. A Console
over one therefore reports `schema: "unwritten"` and an empty run list, while `/api/gates` and
`/api/health` are fully live. Wiring `SqliteTracer` into `factory()` is the ticket that closes it.

**Files.** `src/console/{api,server,shell,responses,answer,FactoryHealth,schemaLedger}.ts`,
`src/cli/ui.ts`, `src/contexts/workflow/adapters/InMemoryRunnerRepository.ts`, and one line each in
`src/cli/kojo.ts`'s import list and subcommand list.

**Tests.** Unit 428 (was 392): `tests/unit/console/{api,application,FactoryHealth,ui}.test.ts`.
Integration 171 + 1 pre-existing skip (was 156 + 1):
`tests/integration/console/{api,shell,gateAnswer}.test.ts` and `tests/integration/cli/ui.test.ts`.
No new Moon task and no new Vitest project.
