import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Result, Schema } from "effect";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { GateExpired } from "../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateRejected } from "../../../../../src/contexts/gate/models/GateRejected.ts";
import { decodeUnknown } from "../../../../../src/contexts/shared/lib/decode.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { EnvelopeParseError } from "../../../../../src/contexts/workflow/models/EnvelopeParseError.ts";
import { NotAccepted } from "../../../../../src/contexts/workflow/models/NotAccepted.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";

/** What a workflow that can hit any of these declares as its error channel. */
const KojoError = Schema.Union([EnvelopeParseError, GateRejected, GateExpired, NotAccepted]);

const parseFailure = Effect.gen(function* () {
  const error = yield* Effect.flip(
    decodeUnknown(Schema.Struct({ changedFiles: Schema.Array(Schema.String) }))({
      changedFiles: 1,
    }),
  );
  return EnvelopeParseError.fromSchemaError(
    { agent: "hotfixer", expected: "BuildOutput", raw: `{"changedFiles":1}` },
    error,
  );
});

describe("a Kojo error", () => {
  it.effect("round-trips through the engine's own exit encoding", () =>
    Effect.gen(function* () {
      const failure = yield* parseFailure;

      // This is the schema the engine persists a finished run with, built the same way it builds
      // it. A `Data.TaggedError` cannot even be handed to it — which is the whole reason every
      // error here is schema-backed, and the kind of thing that is invisible until the first
      // suspension.
      const persisted = Schema.toCodecJson(
        Workflow.Complete.Schema({ success: Schema.String, error: KojoError }),
      );

      const encoded = yield* Schema.encodeUnknownEffect(persisted)(
        new Workflow.Complete({ exit: Exit.fail(failure) }),
      );
      // Through a real string, because that is what a row in the store is.
      const read = yield* decodeUnknown(persisted)(JSON.parse(JSON.stringify(encoded)));

      expect(Exit.isFailure(read.exit)).toBe(true);
      const recovered = yield* Effect.flip(read.exit);
      expect(recovered).toBeInstanceOf(EnvelopeParseError);
      expect(recovered).toEqual(failure);
      // The structured issues came back, paths intact — a rendered string would not have.
      expect(
        recovered._tag === "EnvelopeParseError" && recovered.issues.map((i) => i.path),
      ).toEqual([["changedFiles"]]);
    }),
  );

  it.effect("encodes a Duration payload, so an expiry survives the same trip", () =>
    Effect.gen(function* () {
      const persisted = Schema.toCodecJson(
        Workflow.Complete.Schema({ success: Schema.String, error: KojoError }),
      );
      const expired = new GateExpired({ gate: "review", waited: Duration.days(2) });

      const encoded = yield* Schema.encodeUnknownEffect(persisted)(
        new Workflow.Complete({ exit: Exit.fail(expired) }),
      );
      const read = yield* decodeUnknown(persisted)(JSON.parse(JSON.stringify(encoded)));

      expect(yield* Effect.flip(read.exit)).toEqual(expired);
    }),
  );
});

// A union of Kojo errors as a workflow's error channel. That this compiles is half the point; that
// the error arrives at the caller with its tag and its fields is the other half.
const reviewed = workflow(
  {
    name: "reviewed",
    payload: { gate: Schema.String },
    success: Schema.String,
    error: KojoError,
    idempotencyKey: (payload) => `reviewed/${payload.gate}`,
  },
  (payload) =>
    Effect.fail(
      new GateRejected({ gate: payload.gate, actor: "engineer", reason: "not what was asked for" }),
    ),
);

describe("a workflow declaring a union of Kojo errors", () => {
  it.effect("fails with the error it declared", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(reviewed.definition.execute({ gate: "review" }));

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure._tag).toBe("GateRejected");
      }
    }).pipe(
      Effect.provide(
        reviewed.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(InMemoryTracer.layer, WorkflowEngine.layerMemory)),
        ),
      ),
    ),
  );
});

/** Exact type equality — `extends` alone would accept `never` for any expectation. */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

type ErrorOf<T> = T extends Effect.Effect<unknown, infer E, unknown> ? E : never;

describe("D8 — handling a subset of tags", () => {
  const raising: Effect.Effect<string, EnvelopeParseError | GateRejected | NotAccepted> =
    Effect.fail(new NotAccepted({ reason: "the suite never came back clean" }));

  const handled = raising.pipe(
    Effect.catchTags({
      EnvelopeParseError: () => Effect.succeed("corrected"),
      GateRejected: () => Effect.succeed("rejected"),
    }),
  );

  // The assertion is the annotation, and it is checked by `bun tsc`: the residual channel is
  // *exactly* `NotAccepted` — not wider, and not `never`. A breach-shaped error cannot be
  // swallowed by a correction loop that did not name it.
  const residualIsExactlyNotAccepted: Equals<ErrorOf<typeof handled>, NotAccepted> = true;

  it.effect("leaves the tags it did not handle in the residual channel", () =>
    Effect.gen(function* () {
      expect(residualIsExactlyNotAccepted).toBe(true);
      expect(yield* Effect.flip(handled)).toBeInstanceOf(NotAccepted);
    }),
  );

  it("rejects a handler for a tag the effect cannot raise", () => {
    const handled = raising.pipe(
      Effect.catchTags({
        // `GateExpired` is not in this effect's error channel, so the cases table maps the key to
        // `never` and the handler does not compile. A handler cannot be written for an error that
        // does not exist.
        // @ts-expect-error
        GateExpired: () => Effect.succeed("expired"),
      }),
    );

    expect(handled).toBeDefined();
  });
});
