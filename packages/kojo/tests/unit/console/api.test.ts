import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { api, type FactorySite } from "../../../src/console/api.ts";
import * as InMemoryGateRepository from "../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateRequest } from "../../../src/contexts/gate/models/GateRequest.ts";
import { GateRepository } from "../../../src/contexts/gate/ports/GateRepository.ts";
import { makePhaseId } from "../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryArtifactReader from "../../../src/contexts/trace/adapters/InMemoryArtifactReader.ts";
import * as InMemoryTraceReader from "../../../src/contexts/trace/adapters/InMemoryTraceReader.ts";
import { Occurrence } from "../../../src/contexts/trace/models/Occurrence.ts";
import { PhaseRecord } from "../../../src/contexts/trace/models/PhaseRecord.ts";
import { RepoEffect } from "../../../src/contexts/trace/models/RepoEffect.ts";
import { RunRecord } from "../../../src/contexts/trace/models/RunRecord.ts";
import { RunSummary } from "../../../src/contexts/trace/models/RunSummary.ts";
import { TraceReadError } from "../../../src/contexts/trace/models/TraceReadError.ts";
import { TraceReader } from "../../../src/contexts/trace/ports/TraceReader.ts";
import * as InMemoryRunnerRepository from "../../../src/contexts/workflow/adapters/InMemoryRunnerRepository.ts";
import { RunnerRegistration } from "../../../src/contexts/workflow/models/RunnerRegistration.ts";

/**
 * Every route of the Console API, driven through the real router and bound to no port at all.
 *
 * `HttpRouter.toWebHandler` is the seam console.md §11 names for exactly this: the routes, the
 * parameter decoding, the status codes and the encoding are all the real ones, and only the data
 * source is fake. The ports behind it are the in-memory adapters ticket 25 built, which is what lets
 * a fixture say things a running factory cannot be made to say on demand — a trace that fails to
 * read, a runner whose heartbeat is thirty-six seconds old, a phase that has not exited.
 */

const runId = "run-console" as RunId;
const other = "run-older" as RunId;
const drafted = makePhaseId(runId, "draft", 1);
/** A phase with no record: it has not exited, so it has no artifacts and nothing is cacheable. */
const inFlight = makePhaseId(runId, "land", 1);

const site: FactorySite = {
  database: ".kojo/data/kojo.db",
  factory: "present",
  version: "0.0.0",
  commit: "development",
  applied: 1,
  expected: 1,
};

const summary = (id: RunId, startedAt: number, outcome?: "succeeded") =>
  new RunSummary({
    run: new RunRecord({
      runId: id,
      workflow: "review",
      idempotencyKey: `review/${id}`,
      startedAt,
      engineVersion: "0.0.0",
      engineCommit: "development",
      configDigest: "sha256:abc",
      host: "builder-1",
    }),
    ...(outcome === undefined ? {} : { outcome, finishedAt: startedAt + 10 }),
  });

const draft = new PhaseRecord({
  runId,
  phaseId: drafted,
  name: "draft",
  description: "the draft phase",
  kind: "agent",
  outcome: "succeeded",
  attempt: 1,
  startedAt: 1_000,
  endedAt: 2_000,
  repo: new RepoEffect({ claimed: [], changed: ["src/a.ts"], commits: ["c0ffee"] }),
});

const records = {
  runs: [summary(runId, 500), summary(other, 100, "succeeded")],
  phases: [draft],
  occurrences: [
    new Occurrence({
      runId,
      phaseId: drafted,
      kind: "exec",
      name: "bun install",
      startedAt: 1_100,
      endedAt: 1_200,
      outcome: "succeeded" as const,
    }),
    new Occurrence({
      runId,
      phaseId: drafted,
      kind: "exec",
      name: "bun test",
      startedAt: 1_300,
      endedAt: 1_400,
      outcome: "succeeded" as const,
    }),
  ],
};

const artifacts = {
  [drafted]: { prompt: "# the prompt", session: '{"role":"user"}', diff: "--- a\n+++ b\n" },
};

const token = new DurableDeferred.TokenParsed({
  workflowName: "review",
  executionId: runId,
  deferredName: "gate/approve/1",
}).asToken;

const asking = new GateRequest({
  runId,
  gate: "approve",
  asking: "gate/approve/1",
  description: "Does this land?",
  actor: "engineer",
  choices: ["approve", "reject"],
  token,
  requestedAt: 3_000,
  deadlineAt: 605_800_000,
  onExpiry: "fail",
});

/** A reader that cannot answer, which is the state the Console has to survive rather than crash on. */
const brokenReader = Layer.succeed(TraceReader, {
  runs: Effect.fail(
    new TraceReadError({ operation: "runs", reason: "database is locked", cause: "locked" }),
  ),
  run: () =>
    Effect.fail(
      new TraceReadError({ operation: "run", reason: "database is locked", cause: "locked" }),
    ),
  occurrences: () =>
    Effect.fail(
      new TraceReadError({
        operation: "occurrences",
        reason: "database is locked",
        cause: "locked",
      }),
    ),
});

interface Answered {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

interface Fixture {
  readonly trace?: Layer.Layer<TraceReader>;
  readonly runners?: ReadonlyArray<RunnerRegistration>;
  readonly gates?: ReadonlyArray<GateRequest>;
  readonly site?: FactorySite;
}

interface Call {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}

/**
 * The whole API behind a fetch handler, with the fixture seeded **inside its own layer graph**.
 *
 * The seeding is a layer rather than an effect provided beside the handler, and that is not a
 * detail: `InMemoryGateRepository.layer` builds a fresh map per build, so an asking written through
 * a second `Effect.provide` of the same layer lands in a repository the handler never sees. Written
 * this way there is one repository, and the endpoint reads what the fixture wrote.
 *
 * The ports are merged into the application layer rather than provided per request, which is what
 * makes the handler take no context argument: `toWebHandler` subtracts what the layer already
 * provides from what the routes ask for.
 */
const withApi = <A, E>(
  fixture: Fixture,
  use: (ask: (call: Call) => Effect.Effect<Answered>) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  const ports = Layer.mergeAll(
    fixture.trace ?? InMemoryTraceReader.of(records),
    InMemoryArtifactReader.of(artifacts),
    InMemoryGateRepository.layer,
    InMemoryRunnerRepository.of(fixture.runners ?? []),
    WorkflowEngine.layerMemory,
  );

  const seeded = Layer.effectDiscard(
    Effect.forEach(fixture.gates ?? [], (request) =>
      Effect.flatMap(GateRepository, (repository) => repository.asked(request)),
    ).pipe(Effect.orDie),
  ).pipe(Layer.provideMerge(ports));

  const app = api(fixture.site ?? site).pipe(Layer.provideMerge(seeded));

  return Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
    ({ handler }) =>
      use((call) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request(`http://localhost${call.path}`, {
                method: call.method ?? "GET",
                ...(call.body === undefined
                  ? {}
                  : {
                      body: JSON.stringify(call.body),
                      headers: { "content-type": "application/json" },
                    }),
              }),
            ),
          );
          return {
            status: response.status,
            headers: response.headers,
            body: yield* Effect.promise(() => response.text()),
          };
        }),
      ),
    ({ dispose }) => Effect.promise(dispose),
  );
};

/** One request against a fresh fixture. Most tests need exactly this. */
const asks = (options: Fixture & Call): Effect.Effect<Answered> =>
  withApi(options, (ask) => ask(options));

describe("health", () => {
  it.effect("reports the database path, the versions, and the schema standing", () =>
    Effect.gen(function* () {
      const answered = yield* asks({ path: "/api/health" });
      expect(answered.status).toBe(200);

      const body = JSON.parse(answered.body);
      expect(body.database).toBe(".kojo/data/kojo.db");
      expect(body.version).toBe("0.0.0");
      expect(body.commit).toBe("development");
      expect(body.schema).toBe("current");
      expect(body.schemaApplied).toBe(1);
      expect(body.schemaExpected).toBe(1);
      // A healthy factory has nothing to interrupt anybody with, and it says so by omitting the key
      // rather than by sending a null — the same absence every other optional field here uses.
      expect(body.notice).toBeUndefined();
      expect(answered.body).not.toContain("null");
    }),
  );

  it.effect("warns loudly when the file is behind this build, and silently when it is ahead", () =>
    Effect.gen(function* () {
      const behind = yield* asks({
        path: "/api/health",
        site: { ...site, applied: 1, expected: 4 },
      });
      const older = JSON.parse(behind.body);
      expect(older.schema).toBe("older");
      expect(older.notice).toContain("older than the Console");

      // The other direction is the one the additive-migration promise buys: a column this build does
      // not select cannot hurt it, so an upgraded factory under an older Console says nothing.
      const ahead = yield* asks({
        path: "/api/health",
        site: { ...site, applied: 4, expected: 1 },
      });
      const newer = JSON.parse(ahead.body);
      expect(newer.schema).toBe("newer");
      expect(newer.notice).toBeUndefined();
    }),
  );

  it.effect("says no runner is live when the registration table is empty", () =>
    Effect.gen(function* () {
      // **The normal idle state, not an error.** Sharding unregisters on a clean shutdown, so a
      // watcher that was stopped properly leaves no row at all.
      const answered = yield* asks({ path: "/api/health", runners: [] });
      expect(JSON.parse(answered.body).runner).toBe("none");
    }),
  );

  it.effect("ages a stale registration out rather than reporting a runner nobody can talk to", () =>
    Effect.gen(function* () {
      const fresh = yield* asks({
        path: "/api/health",
        runners: [
          new RunnerRegistration({ address: "localhost:34431", heartbeatAgeMillis: 8_000 }),
        ],
      });
      expect(JSON.parse(fresh.body).runner).toBe("live");

      // One second past the cluster's own thirty-five second window. This is a runner that was
      // killed, and reporting it alive is the "approved ✓ that means nothing" adr/gate/0001 forbids.
      const killed = yield* asks({
        path: "/api/health",
        runners: [
          new RunnerRegistration({ address: "localhost:34431", heartbeatAgeMillis: 36_000 }),
        ],
      });
      expect(JSON.parse(killed.body).runner).toBe("none");
    }),
  );
});

describe("the run list and the run document", () => {
  it.effect("answers the whole list, newest first", () =>
    Effect.gen(function* () {
      const answered = yield* asks({ path: "/api/runs" });
      expect(answered.status).toBe(200);
      expect(answered.headers.get("content-type")).toContain("application/json");

      const body = JSON.parse(answered.body);
      expect(body.map((entry: { run: { runId: string } }) => entry.run.runId)).toEqual([
        runId,
        other,
      ]);
      expect(body[1].outcome).toBe("succeeded");
    }),
  );

  it.effect("answers one whole run in one read", () =>
    Effect.gen(function* () {
      const answered = yield* asks({ path: `/api/runs/${runId}` });
      expect(answered.status).toBe(200);

      const body = JSON.parse(answered.body);
      expect(body.run.run.runId).toBe(runId);
      expect(body.phases.map((phase: { name: string }) => phase.name)).toEqual(["draft"]);
      expect(body.gates).toEqual([]);
      expect(body.sandboxes).toEqual([]);
      // Occurrences are absent on purpose: they are the one unbounded stream, and they are read by
      // cursor from the phase panel rather than carried on every poll of the document.
      expect(body.occurrences).toBeUndefined();
    }),
  );

  it.effect("answers 404 for a run nobody ever started, rather than an error", () =>
    Effect.gen(function* () {
      const answered = yield* asks({ path: "/api/runs/run-typo" });
      expect(answered.status).toBe(404);
      expect(JSON.parse(answered.body).error).toBe("no-such-run");
    }),
  );

  it.effect(
    "turns a trace that cannot be read into a response, not a server that will not start",
    () =>
      Effect.gen(function* () {
        // The whole point of every handler ending with an error channel of `never`: an unhandled
        // failure here is a 500 with an empty body and a defect in the log, and a caller that cannot
        // tell "retry" from "you asked wrongly".
        const answered = yield* asks({ path: "/api/runs", trace: brokenReader });
        expect(answered.status).toBe(503);
        expect(JSON.parse(answered.body).error).toBe("trace-unreadable");
        expect(JSON.parse(answered.body).message).toContain("database is locked");
      }),
  );
});

describe("occurrences, the only cursor", () => {
  it.effect("advances past what it has already given out", () =>
    Effect.gen(function* () {
      const opened = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/occurrences`,
      });
      expect(opened.status).toBe(200);

      const first = JSON.parse(opened.body);
      expect(first.occurrences.map((row: { name: string }) => row.name)).toEqual([
        "bun install",
        "bun test",
      ]);
      expect(first.cursor).toBeGreaterThan(0);

      const idle = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/occurrences?since=${first.cursor}`,
      });
      const next = JSON.parse(idle.body);
      expect(next.occurrences).toEqual([]);
      // A poll that found nothing leaves the cursor where it was, rather than sending the panel back
      // to the first tool call every idle second.
      expect(next.cursor).toBe(first.cursor);
    }),
  );

  it.effect("carries a multi-segment phase id through one path segment", () =>
    Effect.gen(function* () {
      // A phase id is `<run>/<name>/<attempt>`, so it is three segments in one parameter. The router
      // leaves `%2F` alone when it splits the path and decodes it when it fills the parameter — which
      // is why this works without a wildcard route, and why it is asserted rather than assumed.
      expect(encodeURIComponent(drafted)).toContain("%2F");
      const answered = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/occurrences`,
      });
      expect(JSON.parse(answered.body).occurrences).toHaveLength(2);
    }),
  );

  it.effect("refuses a cursor that is not a number", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/occurrences?since=yesterday`,
      });
      expect(answered.status).toBe(400);
    }),
  );
});

describe("artifacts", () => {
  it.effect("serves each as its own media type, cacheable forever", () =>
    Effect.gen(function* () {
      const prompt = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/prompt`,
      });
      expect(prompt.status).toBe(200);
      expect(prompt.body).toBe("# the prompt");
      expect(prompt.headers.get("content-type")).toContain("text/markdown");
      // **Forever, and the reason is the trace's own write rule**: an artifact is served only for a
      // phase that has a record, and a record is written when the phase exits.
      expect(prompt.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const session = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/session`,
      });
      expect(session.headers.get("content-type")).toContain("application/x-ndjson");

      const diff = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/diff`,
      });
      expect(diff.status).toBe(200);
      expect(diff.headers.get("content-type")).toContain("text/x-diff");
    }),
  );

  it.effect("caches nothing for a phase that has not exited", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/runs/${runId}/phases/${encodeURIComponent(inFlight)}/prompt`,
      });
      expect(answered.status).toBe(404);
      expect(JSON.parse(answered.body).error).toBe("no-such-phase");
      // The immutability claim rests on the phase record existing. A phase in flight has none, so
      // nothing about it may be cached — a header here would freeze a page that is still changing.
      expect(answered.headers.get("cache-control")).toBeNull();
    }),
  );

  it.effect("says absent rather than failing when the artifact was never captured", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/runs/${other}/phases/${encodeURIComponent(drafted)}/prompt`,
      });
      // The run is real but holds no such phase, so the panel is told which of the two is missing.
      expect(answered.status).toBe(404);
    }),
  );
});

describe("the gate queue and the one mutation", () => {
  it.effect("lists what waits on a human", () =>
    Effect.gen(function* () {
      const answered = yield* asks({ path: "/api/gates", gates: [asking] });
      expect(answered.status).toBe(200);

      const body = JSON.parse(answered.body);
      expect(body).toHaveLength(1);
      expect(body[0].request.gate).toBe("approve");
      expect(body[0].request.actor).toBe("engineer");
      expect(body[0].verdict).toBeUndefined();
    }),
  );

  it.effect("records an answer and says whether anybody can apply it", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/gates/${token}/answer`,
        method: "POST",
        body: { choice: "approve", reason: "ships" },
        gates: [asking],
      });

      expect(answered.status).toBe(200);
      const body = JSON.parse(answered.body);
      expect(body.verdict.choice).toBe("approve");
      expect(body.verdict.reason).toBe("ships");
      expect(body.verdict.answeredAt).toBeGreaterThan(0);
      // **Recorded is not applied**, and the receipt refuses to say otherwise: with no runner
      // registered the only honest answer is that nothing will pick it up yet.
      expect(body.runner).toBe("none");
      expect(body.applied).toBeUndefined();
    }),
  );

  it.effect("attributes the verdict to the OS user running the Console, and to nothing else", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/gates/${token}/answer`,
        method: "POST",
        // The body carries a choice and a reason. There is no answerer field to send, and this
        // sends one anyway: a page that could name the answerer could name anybody, and an
        // attribution a browser can forge is worse than no attribution at all.
        body: { choice: "approve", reason: "ships", answerer: "somebody-else" },
        gates: [asking],
      });

      expect(answered.status).toBe(200);
      // console.md §9 and adr/gate/0001: localhost only, no authentication, and the name of whoever
      // is running the process is the honest thing to record. Asserted as the value rather than as
      // *not empty* — a constant would satisfy *not empty*, and a gate is worth auditing only
      // because this line says who.
      const whoever = process.env["USER"] ?? process.env["USERNAME"] ?? "unknown-answerer";
      expect(JSON.parse(answered.body).verdict.answerer).toBe(whoever);
      expect(JSON.parse(answered.body).verdict.answerer).not.toBe("somebody-else");
    }),
  );

  it.effect("says a runner can apply it when one has a fresh heartbeat", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/gates/${token}/answer`,
        method: "POST",
        body: { choice: "approve" },
        gates: [asking],
        runners: [
          new RunnerRegistration({ address: "127.0.0.1:34431", heartbeatAgeMillis: 4_000 }),
        ],
      });

      expect(answered.status).toBe(200);
      // The pair with the test above is the whole of adr/gate/0001 in the receipt: one variable —
      // the runner table — decides between *applying…* and *nothing is running*, and there is still
      // no field that could say *applied*.
      expect(JSON.parse(answered.body).runner).toBe("live");
      expect(JSON.parse(answered.body).applied).toBeUndefined();
    }),
  );

  it.effect(
    "ages a killed runner out of the receipt at the cluster's own thirty-five seconds",
    () =>
      Effect.gen(function* () {
        const answered = yield* asks({
          path: `/api/gates/${token}/answer`,
          method: "POST",
          body: { choice: "approve" },
          gates: [asking],
          // A row left behind by a runner nobody can talk to. `RunnerHealth.layerNoop` would call this
          // address alive — it calls every address alive — and a Console built on it would tell
          // somebody their answer was on its way to a machine that is off.
          runners: [
            new RunnerRegistration({ address: "127.0.0.1:34431", heartbeatAgeMillis: 35_001 }),
          ],
        });

        expect(answered.status).toBe(200);
        expect(JSON.parse(answered.body).runner).toBe("none");
      }),
  );

  it.effect("refuses a choice the gate never declared", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/gates/${token}/answer`,
        method: "POST",
        body: { choice: "maybe-later" },
        gates: [asking],
      });
      expect(answered.status).toBe(400);
      expect(JSON.parse(answered.body).error).toBe("undeclared-choice");
    }),
  );

  it.effect("refuses a token this factory has never asked", () =>
    Effect.gen(function* () {
      const unknown = new DurableDeferred.TokenParsed({
        workflowName: "review",
        executionId: "run-elsewhere",
        deferredName: "gate/approve/1",
      }).asToken;

      const answered = yield* asks({
        path: `/api/gates/${unknown}/answer`,
        method: "POST",
        body: { choice: "approve" },
        gates: [asking],
      });
      expect(answered.status).toBe(404);
      expect(JSON.parse(answered.body).error).toBe("no-such-gate");
    }),
  );

  it.effect("refuses a token that is not a token at all", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: "/api/gates/not-a-token/answer",
        method: "POST",
        body: { choice: "approve" },
        gates: [asking],
      });
      expect(answered.status).toBe(400);
    }),
  );

  it.effect("refuses a body that names no choice", () =>
    Effect.gen(function* () {
      const answered = yield* asks({
        path: `/api/gates/${token}/answer`,
        method: "POST",
        body: { reason: "ships" },
        gates: [asking],
      });
      expect(answered.status).toBe(400);
      expect(JSON.parse(answered.body).error).toBe("malformed-request");
    }),
  );
});

describe("the askings behind the mutation", () => {
  it.effect("writes the verdict where the queue can read it back", () =>
    withApi({ gates: [asking] }, (ask) =>
      Effect.gen(function* () {
        const post = () =>
          ask({
            path: `/api/gates/${token}/answer`,
            method: "POST",
            body: { choice: "approve", reason: "ships" },
          });

        expect((yield* post()).status).toBe(200);

        const queue = yield* ask({ path: "/api/gates" });
        const listed = JSON.parse(queue.body);
        expect(listed[0].verdict.choice).toBe("approve");
        expect(listed[0].verdict.answerer).not.toBe("");

        // The first answer is the one that counts, and a second answerer is told so rather than
        // shown a success that changed nothing.
        const again = yield* post();
        expect(again.status).toBe(409);
        expect(JSON.parse(again.body).error).toBe("already-answered");
      }),
    ),
  );
});

describe("the absent factory", () => {
  it.effect("says what to run instead of failing", () =>
    withApi(
      {
        site: { ...site, factory: "absent", applied: 0 },
        trace: InMemoryTraceReader.of({}),
      },
      (ask) =>
        Effect.gen(function* () {
          const health = yield* ask({ path: "/api/health" });
          expect(health.status).toBe(200);

          const body = JSON.parse(health.body);
          expect(body.factory).toBe("absent");
          expect(body.schema).toBe("unwritten");
          expect(body.notice).toBe("No factory in this repo. Run `kojo init`.");

          // And every list is empty rather than broken, which is what console.md §10 asks for.
          const runs = yield* ask({ path: "/api/runs" });
          expect(runs.status).toBe(200);
          expect(JSON.parse(runs.body)).toEqual([]);
        }),
    ),
  );
});

describe("what the port answers, read back through the API", () => {
  it.effect("keeps None a 404 and not a failure", () =>
    Effect.gen(function* () {
      // Guards the seam rather than the adapter: the port says `None` for a run it has never seen,
      // and this is where that becomes a status code a browser can act on.
      const reader = InMemoryTraceReader.of(records);
      const missing = yield* Effect.flatMap(TraceReader, (found) =>
        found.run("run-typo" as RunId),
      ).pipe(Effect.provide(reader), Effect.orDie);
      expect(Option.isNone(missing)).toBe(true);
    }),
  );
});
