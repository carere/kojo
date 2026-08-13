import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { DurableDeferred } from "effect/unstable/workflow";
import { AskedGate } from "../contexts/gate/models/AskedGate.ts";
import type { GateStoreError } from "../contexts/gate/models/GateStoreError.ts";
import { GateRepository } from "../contexts/gate/ports/GateRepository.ts";
import { answerGate, parseToken } from "../contexts/gate/services/answerGate.ts";
import { decodeUnknown } from "../contexts/shared/lib/decode.ts";
import { PhaseId } from "../contexts/shared/models/PhaseId.ts";
import { RunId } from "../contexts/shared/models/RunId.ts";
import type { Artifact } from "../contexts/trace/models/Artifact.ts";
import type { ArtifactUnavailable } from "../contexts/trace/models/ArtifactUnavailable.ts";
import {
  beginning,
  OccurrenceCursor,
  OccurrencePage,
} from "../contexts/trace/models/OccurrencePage.ts";
import type { PhaseRecord } from "../contexts/trace/models/PhaseRecord.ts";
import { RunDocument } from "../contexts/trace/models/RunDocument.ts";
import { RunSummary } from "../contexts/trace/models/RunSummary.ts";
import type { TraceReadError } from "../contexts/trace/models/TraceReadError.ts";
import { ArtifactReader } from "../contexts/trace/ports/ArtifactReader.ts";
import { TraceReader } from "../contexts/trace/ports/TraceReader.ts";
import { live } from "../contexts/workflow/models/RunnerRegistration.ts";
import { RunnerRepository } from "../contexts/workflow/ports/RunnerRepository.ts";
import { GateAnswer, GateAnswerReceipt } from "./answer.ts";
import { FactoryHealth, type FactoryPresence, healthOf } from "./FactoryHealth.ts";
import { forever, problem, sends } from "./responses.ts";

/**
 * The JSON API of the Console: console.md §7's table, and nothing beside it.
 *
 * Three rules run through every route here, and each of them is a framework fact that costs a
 * debugging session if it is met the other way round:
 *
 * - **Every handler's error channel is `never`.** `HttpRouter.add` returns a Layer that carries the
 *   handler's error as a *requirement*, so an unhandled error is not a 500 at request time — it is
 *   an unsatisfied requirement at `serve`, which is a server that will not start. Each handler
 *   therefore ends in `Effect.catchTag`s that turn every failure it can have into a response, and
 *   `responses.sends` absorbs the `HttpBodyError` that `HttpServerResponse.json` would otherwise
 *   leave behind.
 * - **Nothing here queries SQL.** Reads go through `TraceReader` and `ArtifactReader`, which is what
 *   lets the whole surface run against in-memory adapters with no database at all (console.md §11).
 * - **Reads are polled, and only occurrences carry a cursor.** There is no streaming read on this
 *   driver — `executeStream` is `Stream.die` and `SqlClient.reactive` is process-local — so the
 *   server offers no subscription and does not pretend to. The run document is fetched whole.
 *
 * A phase id is `<run>/<name>/<attempt>`, so it is several path segments. It travels percent-encoded
 * in the one `:phaseId` segment: the router leaves `%2F` alone when it splits the path and decodes it
 * when it fills the parameter, so the whole id arrives intact without a wildcard route.
 */

/** What this Console is and where it is reading, measured once, before any layer was built. */
export interface FactorySite {
  /** The SQLite file this Console reads, as the command was given it. */
  readonly database: string;
  readonly factory: FactoryPresence;
  readonly version: string;
  readonly commit: string;
  /**
   * The migration the file had applied when the command started.
   *
   * **Read before the layers were built, and kept.** A failing migration is `Effect.die` rather than
   * a typed error, so discovering an old schema by running the migrator would take the process down
   * instead of putting a banner on screen. It is also not a moving quantity: a file does not migrate
   * under a Console that is already reading it without something restarting first.
   */
  readonly applied: number;
  /** The migration this build of Kojo expects. */
  readonly expected: number;
}

const sendsHealth = sends(FactoryHealth);
const sendsRuns = sends(Schema.Array(RunSummary));
const sendsRun = sends(RunDocument);
const sendsOccurrences = sends(OccurrencePage);
const sendsGates = sends(Schema.Array(AskedGate));
const sendsReceipt = sends(GateAnswerReceipt);

/**
 * The trace could not be read, or answered in a shape the schema refuses.
 *
 * `503` rather than `500`, because console.md's answer to it is *keep the last data on screen and
 * show a retrying banner*: this is the class of failure a Console is expected to survive by asking
 * again, and a status that says "try later" is the one that says so to a cache and a proxy too.
 */
const traceFailed = (error: TraceReadError) =>
  Effect.succeed(
    problem(
      503,
      "trace-unreadable",
      `the trace could not answer ${error.operation}: ${error.reason}`,
    ),
  );

/** The askings could not be read or written. Same class of failure, same answer. */
const askingsFailed = (error: GateStoreError) =>
  Effect.succeed(problem(503, "askings-unreadable", error.message));

/** A path segment or a body that is not what it claims. The caller asked wrongly; nothing was read. */
const malformed = (what: string) => (error: { readonly message: string }) =>
  Effect.succeed(problem(400, "malformed-request", `${what}: ${error.message}`));

/** One path parameter, decoded through the schema that owns it rather than cast into place. */
const segment = <S extends Schema.Constraint>(schema: S, name: string) =>
  Effect.flatMap(HttpRouter.params, (params) => decodeUnknown(schema)(params[name]));

/**
 * Whether an answer given right now would move a run.
 *
 * The same read the health document makes, because it is the same question — and it is read at the
 * moment the answer is written rather than left to a later request, so the gate card resolves to
 * *recorded — applying…* or *recorded — nothing is running* without a second round trip.
 */
const runnerPresence = Effect.map(
  Effect.flatMap(RunnerRepository, (repository) => repository.registered),
  (registered) => (live(registered).length === 0 ? ("none" as const) : ("live" as const)),
);

/**
 * Where this Console is reading, what it is, and whether a runner is alive.
 *
 * The runner half is read on every request because it changes while the Console is open; the rest is
 * the site, measured once at startup.
 */
const health = (site: FactorySite) =>
  HttpRouter.add(
    "GET",
    "/api/health",
    Effect.gen(function* () {
      const registered = yield* Effect.flatMap(
        RunnerRepository,
        (repository) => repository.registered,
      );
      return yield* sendsHealth(healthOf({ ...site, runners: registered }));
    }),
  );

/** Every run, newest first, polled whole. A factory that outgrows this has outgrown one file first. */
const runs = HttpRouter.add(
  "GET",
  "/api/runs",
  Effect.flatMap(TraceReader, (reader) => reader.runs).pipe(
    Effect.flatMap(sendsRuns),
    Effect.catchTag("TraceReadError", traceFailed),
  ),
);

/**
 * One whole run: the record, every phase, the settled askings, every acquisition.
 *
 * A run this trace has never seen is `404` rather than an error — a URL a person pasted with one
 * character wrong is not a failure of the trace, and the port answers `None` for exactly that.
 */
const run = HttpRouter.add(
  "GET",
  "/api/runs/:runId",
  Effect.gen(function* () {
    const runId = yield* segment(RunId, "runId");
    const document = yield* Effect.flatMap(TraceReader, (reader) => reader.run(runId));
    return yield* Option.match(document, {
      onNone: () => Effect.succeed(problem(404, "no-such-run", `no run ${runId} in this trace`)),
      onSome: sendsRun,
    });
  }).pipe(
    Effect.catchTags({
      TraceReadError: traceFailed,
      SchemaError: malformed("that is not a run id"),
    }),
  ),
);

/**
 * One phase's tool calls and `exec` invocations, from a cursor — the only cursor in this API.
 *
 * The cursor is a value the caller carries: it comes back on the page it produced and the next poll
 * passes it in. A panel that has just opened asks from the beginning, which is zero because the
 * trace's row ids start at one.
 */
const occurrences = HttpRouter.add(
  "GET",
  "/api/runs/:runId/phases/:phaseId/occurrences",
  Effect.gen(function* () {
    const phaseId = yield* segment(PhaseId, "phaseId");
    const params = yield* HttpServerRequest.ParsedSearchParams;
    const asked = params["since"];
    const since =
      asked === undefined
        ? beginning
        : yield* decodeUnknown(OccurrenceCursor)(Number(Array.isArray(asked) ? asked[0] : asked));

    const page = yield* Effect.flatMap(TraceReader, (reader) =>
      reader.occurrences({ phaseId, since }),
    );
    return yield* sendsOccurrences(page);
  }).pipe(
    Effect.catchTags({
      TraceReadError: traceFailed,
      SchemaError: malformed("that is not a phase id and a cursor"),
    }),
  ),
);

/**
 * One of the three things the trace deliberately does not store, fetched on demand.
 *
 * **The phase record is read first, and it is doing two jobs.** It is what supplies the commits the
 * diff is read from — they are on the record, so a reader that looked them up again would make the
 * artifact port depend on the trace — and it is what makes the response cacheable: a record exists
 * only for a phase that has **exited**, and a phase that has exited cannot change. So `Cache-Control:
 * immutable` here is a statement about the trace's own write rule rather than a guess.
 *
 * The three refusals become three statuses, which is why `ArtifactUnavailable` names three rather
 * than carrying a boolean. A missing artifact must never fail the whole panel, so none of them is a
 * server error the Console is expected to hide behind.
 */
const artifact = (kind: "prompt" | "session" | "diff") =>
  HttpRouter.add(
    "GET",
    `/api/runs/:runId/phases/:phaseId/${kind}`,
    Effect.gen(function* () {
      const runId = yield* segment(RunId, "runId");
      const phaseId = yield* segment(PhaseId, "phaseId");

      const document = yield* Effect.flatMap(TraceReader, (reader) => reader.run(runId));
      const record = Option.flatMap(document, (found) =>
        Option.fromUndefinedOr(
          found.phases.find((phase: PhaseRecord) => phase.phaseId === phaseId),
        ),
      );
      if (Option.isNone(record)) {
        return problem(404, "no-such-phase", `run ${runId} has no exited phase ${phaseId}`);
      }

      const reader = yield* ArtifactReader;
      const subject = { runId, phaseId };
      const found = yield* kind === "prompt"
        ? reader.prompt(subject)
        : kind === "session"
          ? reader.session(subject)
          : reader.diff({ ...subject, commits: record.value.repo?.commits ?? [] });

      return sent(found);
    }).pipe(
      Effect.catchTags({
        ArtifactUnavailable: missingArtifact,
        TraceReadError: traceFailed,
        SchemaError: malformed("that is not a run id and a phase id"),
      }),
    ),
  );

/**
 * The artifact itself, as its own media type rather than wrapped in JSON, and cacheable forever.
 *
 * A transcript and a patch are text a person may want to save, pipe or diff, and a JSON envelope
 * around them would make every consumer unwrap one. The media type comes off the artifact, so no two
 * surfaces can disagree about what a session is.
 */
const sent = (found: Artifact): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(found.content, {
    contentType: found.mediaType,
    headers: { "cache-control": forever },
  });

/** Three refusals, three statuses. None of them is a fault of the server except the last. */
const missingArtifact = (error: ArtifactUnavailable) => {
  switch (error.refusal) {
    case "refused":
      return Effect.succeed(problem(400, "refused-identifier", error.reason));
    case "absent":
      return Effect.succeed(problem(404, "no-such-artifact", error.reason));
    case "unreadable":
      return Effect.succeed(problem(502, "artifact-unreadable", error.reason));
  }
};

/** What waits on a human, and for how long. Every asking, answered or not; the UI filters. */
const gates = HttpRouter.add(
  "GET",
  "/api/gates",
  Effect.flatMap(GateRepository, (repository) => repository.all).pipe(
    Effect.flatMap(sendsGates),
    Effect.catchTag("GateStoreError", askingsFailed),
  ),
);

/**
 * The only mutation this API has: a verdict written down against a token.
 *
 * **Record, then say who can apply it.** The Console earns no privilege a Slack adapter lacks
 * (adr/gate/0001): it writes the verdict where any answering half writes it, and a live runner picks
 * it up on its own poll. The receipt therefore says `runner`, never `applied` — the answer has not
 * been applied at the moment this response is written, by definition.
 *
 * Three refusals before anything is written, each of which would otherwise be a decision nobody made:
 * a token this factory has never asked, a gate that already has a verdict, and a choice the gate does
 * not accept.
 */
const answer = HttpRouter.add(
  "POST",
  "/api/gates/:token/answer",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const token = (params["token"] ?? "") as DurableDeferred.Token;
    yield* parseToken(token);

    const request = yield* HttpServerRequest.HttpServerRequest;
    const given = yield* decodeUnknown(GateAnswer)(yield* request.json);

    const repository = yield* GateRepository;
    const asking = yield* repository.byToken(token);
    if (Option.isNone(asking)) {
      return problem(404, "no-such-gate", `this factory has no asking with the token ${token}`);
    }

    // The engine keeps the first answer — `deferredDone` refuses to overwrite a recorded result — so
    // a second answerer is told that rather than shown a success that changed nothing.
    const already = Option.fromUndefinedOr(asking.value.verdict);
    if (Option.isSome(already)) {
      return problem(
        409,
        "already-answered",
        `already answered: ${already.value.choice} by ${already.value.answerer}. The first answer is the one that counts, so nothing was written.`,
      );
    }

    // A gate declares the choices it accepts. Answering with one it does not accept writes a verdict
    // the workflow reads as a rejection — a decision nobody made.
    const declared = asking.value.request.choices;
    if (!declared.includes(given.choice)) {
      return problem(
        400,
        "undeclared-choice",
        `that gate accepts ${declared.join(" or ")}, not ${given.choice}`,
      );
    }

    const verdict = yield* answerGate({
      token,
      choice: given.choice,
      reason: given.reason ?? "",
      answerer: yield* osUser,
    });
    yield* repository.recorded({ token, verdict });

    return yield* sendsReceipt(new GateAnswerReceipt({ verdict, runner: yield* runnerPresence }));
  }).pipe(
    Effect.catchTags({
      GateStoreError: askingsFailed,
      HttpServerError: malformed("that request body is not JSON"),
      SchemaError: malformed("that is not a gate token and a choice"),
    }),
  ),
);

/**
 * Who a verdict is attributed to.
 *
 * The OS user of the process serving the Console, exactly as console.md §9 decided: localhost only,
 * no authentication, and the name of whoever is running it is the honest thing to record. Read here
 * rather than taken from the request, because a field a browser fills is a field a browser can lie
 * in.
 */
const osUser = Effect.sync(() => {
  const { USER, USERNAME } = process.env;
  return USER ?? USERNAME ?? "unknown-answerer";
});

/**
 * Every route of the API, as one layer.
 *
 * Its requirements are the four ports and the engine, carried as request-level requirements by
 * `HttpRouter.add`. Nothing in here knows whether they are backed by SQLite or by arrays.
 */
export const api = (site: FactorySite) =>
  Layer.mergeAll(
    health(site),
    runs,
    run,
    occurrences,
    artifact("prompt"),
    artifact("session"),
    artifact("diff"),
    gates,
    answer,
  );
