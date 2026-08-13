import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { HttpServerResponse } from "effect/unstable/http";
import { fixtureLayer, fixtureRunners } from "../../../src/console/fixtures.ts";
import { sends } from "../../../src/console/responses.ts";
import { AskedGate } from "../../../src/contexts/gate/models/AskedGate.ts";
import { GateRepository } from "../../../src/contexts/gate/ports/GateRepository.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import { RunDocument } from "../../../src/contexts/trace/models/RunDocument.ts";
import { RunSummary } from "../../../src/contexts/trace/models/RunSummary.ts";
import { TraceReader } from "../../../src/contexts/trace/ports/TraceReader.ts";
import { live } from "../../../src/contexts/workflow/models/RunnerRegistration.ts";

/**
 * The states the Console's browser tier is graded against, checked here rather than assumed there.
 *
 * A browser test that asserts *recorded — nothing is running* proves nothing if the fixture behind
 * it quietly stopped holding a recorded answer: the page would say *waiting*, the assertion would be
 * rewritten to match, and the state adr/gate/0001 exists for would go ungraded while the suite stayed
 * green. So the fixtures' own invariants are stated as tests, in the tier that can read them
 * directly.
 *
 * Four of them, and each is one half of a pair that must not collapse:
 *
 * 1. a verdict **without** a settled gate record — recorded, and the run has not moved;
 * 2. a verdict **with** one — applied, and the only shape that may ever be drawn that way;
 * 3. a settled record with **no verdict at all** and the outcome `expired` — the run moved on and
 *    nobody decided, which a reader that takes a record at face value draws as *applied*;
 * 4. two fixtures whose records are identical and whose runner tables are not.
 */

type Fixture = "busy" | "watching" | "settled" | "empty" | "absent";

const askingsOf = (fixture: Fixture) =>
  Effect.flatMap(GateRepository, (repository) => repository.all).pipe(
    Effect.orDie,
    Effect.provide(fixtureLayer(fixture)),
  );

const gatesOf = (fixture: "busy" | "watching", runId: string) =>
  Effect.flatMap(TraceReader, (reader) => reader.run(runId as RunId)).pipe(
    Effect.map((document) => (document._tag === "Some" ? document.value.gates : [])),
    Effect.orDie,
    Effect.provide(fixtureLayer(fixture)),
  );

/**
 * Everything one fixture *serves*, read back through the ports the Console reads.
 *
 * Read rather than compared as literals, because what the pair has to hold is a property of what
 * arrives at a browser and not of how the module happens to be written. A `watching` built from
 * scratch with the same records would still be honest; one built by spreading `busy` and then
 * quietly dropping a run would not, and only this can tell them apart.
 */
const servedBy = (fixture: "busy" | "watching") =>
  Effect.gen(function* () {
    const reader = yield* TraceReader;
    const repository = yield* GateRepository;
    const runs = yield* reader.runs;
    return {
      runs,
      askings: yield* repository.all,
      documents: yield* Effect.forEach(runs, (run) => reader.run(run.run.runId)),
    };
  }).pipe(Effect.orDie, Effect.provide(fixtureLayer(fixture)));

describe("the fixture the gate card is graded against", () => {
  it.effect("holds a verdict that nothing has applied", () =>
    Effect.gen(function* () {
      const askings = yield* askingsOf("busy");
      const recorded = askings.find((one) => one.request.runId === "run-recorded");

      expect(recorded?.verdict?.answerer).toBe("release-manager");
      // And the trace has no settled record for it. The record is written by the run itself, in the
      // activity that follows the suspension, so its absence is the proof the run has not woken up.
      const gates = yield* gatesOf("busy", "run-recorded");
      expect(gates).toHaveLength(0);
    }),
  );

  it.effect("holds a verdict that a run did apply, keyed by the same asking", () =>
    Effect.gen(function* () {
      const askings = yield* askingsOf("busy");
      const applied = askings.find((one) => one.request.runId === "run-merged");
      expect(applied?.verdict).toBeDefined();

      const gates = yield* gatesOf("busy", "run-merged");
      // The keys have to match, or the Console would draw *recorded* over a run that had resumed —
      // the safe direction, and still a bug. An asking is what a gate record is keyed by.
      expect(gates.map((one) => one.asking)).toContain(applied?.request.asking);
    }),
  );

  it.effect("holds one asking that is unanswered and exists to be answered", () =>
    Effect.gen(function* () {
      const askings = yield* askingsOf("busy");
      const waiting = askings.find((one) => one.request.runId === "run-waiting");

      expect(waiting?.verdict).toBeUndefined();
      expect(waiting?.request.choices).toEqual(["approve", "reject"]);
    }),
  );

  it.effect("holds a gate the deadline settled, with no verdict anywhere near it", () =>
    Effect.gen(function* () {
      const askings = yield* askingsOf("busy");
      const stranded = askings.find((one) => one.request.runId === "run-expired");

      // Nobody answered. There is no verdict to be *recorded*, and the run is not waiting either —
      // the record below says it already went the other way.
      expect(stranded?.verdict).toBeUndefined();

      // And the asking itself carries the settlement, because the run writes it beside the record
      // (ticket 46). It is what takes this row out of the queue's waiting list: without it the
      // asking sits there forever, *overdue by* a number growing without bound.
      expect(stranded?.expiredAt).toBe(stranded?.request.deadlineAt);
      expect(stranded?.state(Date.now())).toBe("expired");

      const gates = yield* gatesOf("busy", "run-expired");
      expect(gates).toHaveLength(1);
      expect(gates[0]?.asking).toBe(stranded?.request.asking);
      // The field the whole *applied* rule turns on. A record is written for an expiry exactly as it
      // is for an answer, so its presence proves the run moved and nothing more; only this says
      // whether a human decision was what moved it.
      expect(gates[0]?.outcome).toBe("expired");
      expect(gates[0]?.answerer).toBeUndefined();
      expect(gates[0]?.choice).toBeUndefined();
    }),
  );

  it.effect(
    "serves one set of records from two fixtures that differ only in the runner table",
    () =>
      Effect.gen(function* () {
        // The whole design of the pair. If `watching` ever stopped being `busy` plus a registration, the
        // browser test that reads *applying…* out of it would be grading two differences at once and
        // could not say which produced the word.
        expect(fixtureRunners("busy")).toHaveLength(0);
        expect(live(fixtureRunners("watching"))).toHaveLength(1);

        // And the records themselves, read back through the ports rather than trusted to a spread. The
        // sentence above this test is a claim about what two servers serve, so it is checked against
        // what they serve: every run, every asking, every run document, compared whole.
        expect(yield* servedBy("watching")).toEqual(yield* servedBy("busy"));
      }),
  );

  it("registers nobody in any other fixture, because nothing is running in one", () => {
    expect(fixtureRunners("settled")).toHaveLength(0);
    expect(fixtureRunners("empty")).toHaveLength(0);
    expect(fixtureRunners("absent")).toHaveLength(0);
  });

  it.effect("names every asking the way the engine names one", () =>
    Effect.gen(function* () {
      const askings = yield* askingsOf("busy");

      // `gate/<name>/<round>` — `phase/gate.ts`'s own shape, slashes and all. A fixture with flat
      // names would let the Console's gate route pass without ever encoding a segment, and the first
      // real gate anybody opened would 404.
      for (const one of askings) {
        expect(one.request.asking).toBe(`gate/${one.request.gate}/1`);
      }
    }),
  );
});

/**
 * **What these records turn into on the wire — the half no browser test could see.**
 *
 * A fixture is not read by a browser; its *encoding* is. And an absent field has two encodings: a
 * record built without the key sends nothing, and a record built with the key holding `undefined`
 * sends `null`. adr/trace/0003 chose the first for both, and this is the fixture side of that choice.
 * The database side is graded in `tests/integration/console/api.test.ts`, over records the SQLite
 * reader built — which is the producer that used to send the other shape.
 *
 * It goes through `sends`, which is the function every route answers with, so what is measured here
 * is bytes a browser would receive rather than a value this file encoded its own way.
 */
const bodyOf = (response: HttpServerResponse.HttpServerResponse): string => {
  const body = response.body;
  if (body._tag !== "Uint8Array") throw new Error(`the response body is ${body._tag}`);
  return new TextDecoder().decode(body.body);
};

/** Every `null` in a JSON tree, named by where it is, because "there is a null" is not a bug report. */
const nullsIn = (value: unknown, path = "$"): ReadonlyArray<string> => {
  if (value === null) return [path];
  if (Array.isArray(value))
    return value.flatMap((each, index) => nullsIn(each, `${path}[${index}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, each]) =>
      nullsIn(each, `${path}.${key}`),
    );
  }
  return [];
};

const sent = <A, RE>(
  schema: Schema.ConstraintCodec<A, unknown, unknown, RE>,
  value: A,
): Effect.Effect<unknown, never, RE> =>
  Effect.map(sends(schema)(value), (response) => JSON.parse(bodyOf(response)) as unknown);

describe("what a fixture puts on the wire", () => {
  for (const fixture of ["busy", "watching", "settled", "empty"] as const) {
    it.effect(`sends no null anywhere, on any route, from ${fixture}`, () =>
      Effect.gen(function* () {
        const reader = yield* TraceReader;
        const repository = yield* GateRepository;
        const runs = yield* reader.runs;

        expect(nullsIn(yield* sent(Schema.Array(RunSummary), runs), "$ /api/runs")).toEqual([]);
        expect(
          nullsIn(yield* sent(Schema.Array(AskedGate), yield* repository.all), "$ /api/gates"),
        ).toEqual([]);

        for (const run of runs) {
          const document = yield* reader.run(run.run.runId);
          if (document._tag === "None") continue;
          expect(
            nullsIn(yield* sent(RunDocument, document.value), `$ /api/runs/${run.run.runId}`),
          ).toEqual([]);
        }
      }).pipe(Effect.orDie, Effect.provide(fixtureLayer(fixture))),
    );
  }

  /**
   * The one field the run view threw on, stated by name.
   *
   * `run-approve` is suspended and has nothing in flight — the ordinary state of every run waiting
   * at a gate. The key must be **missing**: present holding `null` is what the Console's
   * `inFlight === undefined` guard falls through, and `inFlight.phaseId` is what it evaluates next.
   */
  it.effect("omits the in-flight key on a run that has nothing in flight", () =>
    Effect.gen(function* () {
      const reader = yield* TraceReader;
      const document = yield* reader.run("run-approve" as RunId);
      if (document._tag === "None") throw new Error("the busy fixture has no run-approve");

      const wire = (yield* sent(RunDocument, document.value)) as {
        readonly run: Record<string, unknown>;
      };
      expect(Object.keys(wire.run)).not.toContain("inFlight");
      expect(Object.keys(wire.run)).toContain("outcome");
    }).pipe(Effect.orDie, Effect.provide(fixtureLayer("busy"))),
  );
});
