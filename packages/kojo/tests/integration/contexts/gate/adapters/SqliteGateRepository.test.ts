// `@effect/platform-bun` is imported by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, type PlatformError } from "effect";
import type { SqlError } from "effect/unstable/sql";
import type { DurableDeferred } from "effect/unstable/workflow";
import * as SqliteGateRepository from "../../../../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import { GateRequest } from "../../../../../src/contexts/gate/models/GateRequest.ts";
import type { GateStoreError } from "../../../../../src/contexts/gate/models/GateStoreError.ts";
import { Verdict } from "../../../../../src/contexts/gate/models/Verdict.ts";
import { GateRepository } from "../../../../../src/contexts/gate/ports/GateRepository.ts";
import * as SqliteDatabase from "../../../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";

const hour = 3_600_000;

const request = (options: {
  readonly gate: string;
  readonly runId?: string;
  readonly requestedAt?: number;
}) =>
  new GateRequest({
    runId: (options.runId ?? "run-1") as RunId,
    gate: options.gate,
    asking: `gate/${options.gate}/1`,
    description: 'does "the change" land?',
    actor: "engineer",
    choices: ["approve", "reject"],
    token: `token-${options.gate}` as DurableDeferred.Token,
    requestedAt: options.requestedAt ?? 1_000,
    deadlineAt: (options.requestedAt ?? 1_000) + 48 * hour,
    onExpiry: "fail",
  });

/**
 * A fresh file per test, and a *fresh client each time the repository is opened*.
 *
 * `open` builds the whole stack from the path, so calling it twice is two `bun:sqlite` handles on
 * one file — which is what makes the second call a genuine reader of what the first one wrote,
 * rather than a reader of its own memory.
 */
const onOwnFile = <A, E>(
  use: (
    open: <B, E2>(
      program: Effect.Effect<B, E2, GateRepository>,
    ) => Effect.Effect<B, E2 | GateStoreError | SqlError.SqlError>,
  ) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-askings-" });
    const stack = SqliteGateRepository.layer.pipe(
      Layer.provide(SqliteDatabase.layer({ path: `${root}/kojo.db` })),
    );

    return yield* use((program) => program.pipe(Effect.provide(stack)));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("the askings on disk", () => {
  it.live("hands back every field of an asking, decoded rather than cast", () =>
    onOwnFile((open) =>
      Effect.gen(function* () {
        yield* open(
          Effect.flatMap(GateRepository, (repository) =>
            repository.asked(request({ gate: "approve" })),
          ),
        );

        // A second client on the same file, so what comes back is what the first one wrote down
        // rather than anything either of them is still holding.
        const all = yield* open(Effect.flatMap(GateRepository, (repository) => repository.all));

        expect(all).toHaveLength(1);
        const asking = all[0];
        expect(asking?.request.runId).toBe("run-1");
        expect(asking?.request.gate).toBe("approve");
        expect(asking?.request.asking).toBe("gate/approve/1");
        expect(asking?.request.actor).toBe("engineer");
        // An array through a text column and back. A cast would have handed back the JSON string.
        expect(asking?.request.choices).toEqual(["approve", "reject"]);
        expect(asking?.request.description).toBe('does "the change" land?');
        expect(asking?.request.requestedAt).toBe(1_000);
        expect(asking?.request.deadlineAt).toBe(1_000 + 48 * hour);
        expect(asking?.request.onExpiry).toBe("fail");
        expect(asking?.verdict).toBeUndefined();
      }),
    ).pipe(Effect.orDie),
  );

  it.live("writes one row for one asking, however many times it is asked to", () =>
    onOwnFile((open) =>
      Effect.gen(function* () {
        // The requesting activity writes this, so a replayed body should never reach it twice. This
        // is the belt to that brace: a second write of the same asking must not duplicate the row,
        // and — see the test below — must not erase a verdict already written against it.
        yield* open(
          Effect.flatMap(GateRepository, (repository) =>
            Effect.andThen(
              repository.asked(request({ gate: "approve" })),
              repository.asked(request({ gate: "approve" })),
            ),
          ),
        );

        const all = yield* open(Effect.flatMap(GateRepository, (repository) => repository.all));
        expect(all).toHaveLength(1);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("keeps the first verdict and says the second changed nothing", () =>
    onOwnFile((open) =>
      Effect.gen(function* () {
        const token = "token-approve" as DurableDeferred.Token;
        const verdict = (choice: string, answerer: string, answeredAt: number) =>
          new Verdict({ choice, reason: `${choice} for ${answerer}`, answerer, answeredAt });

        const answers = yield* open(
          Effect.gen(function* () {
            const repository = yield* GateRepository;
            yield* repository.asked(request({ gate: "approve" }));
            return [
              yield* repository.recorded({ token, verdict: verdict("approve", "kevin", 5_000) }),
              // `DurableDeferred.succeed` refuses to overwrite a recorded result, so the run never
              // saw this one. A list that showed it would report a decision nothing acted on.
              yield* repository.recorded({ token, verdict: verdict("reject", "dana", 9_000) }),
            ];
          }),
        );

        expect(answers).toEqual([true, false]);

        const found = yield* open(
          Effect.flatMap(GateRepository, (repository) => repository.byToken(token)),
        );
        const asking = Option.getOrThrow(found);
        expect(asking.verdict?.answerer).toBe("kevin");
        expect(asking.verdict?.choice).toBe("approve");
        expect(asking.verdict?.answeredAt).toBe(5_000);
        // Human latency, across two clients and one file.
        expect(asking.waitedMillis(999_999)).toBe(4_000);
        expect(asking.state(999_999)).toBe("recorded");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("writes the settlement down once, and keeps the first one", () =>
    onOwnFile((open) =>
      Effect.gen(function* () {
        const token = "token-deploy" as DurableDeferred.Token;
        const deadlineAt = 1_000 + 48 * hour;

        const settlements = yield* open(
          Effect.gen(function* () {
            const repository = yield* GateRepository;
            yield* repository.asked(request({ gate: "deploy" }));
            return [
              yield* repository.expired({ token, expiredAt: deadlineAt }),
              // A replayed record activity, or a second process racing the first: the settlement
              // is one fact, and the second writer is told it changed nothing.
              yield* repository.expired({ token, expiredAt: deadlineAt + hour }),
            ];
          }),
        );

        expect(settlements).toEqual([true, false]);

        // A second client on the same file: what comes back is what was written down, and it is
        // exactly what takes the asking out of the waiting list days later, in another process.
        const found = yield* open(
          Effect.flatMap(GateRepository, (repository) => repository.byToken(token)),
        );
        const asking = Option.getOrThrow(found);
        expect(asking.expiredAt).toBe(deadlineAt);
        expect(asking.verdict).toBeUndefined();
        expect(asking.state(deadlineAt + 10 * hour)).toBe("expired");
        // The wait stopped accruing at the expiry.
        expect(asking.waitedMillis(deadlineAt + 10 * hour)).toBe(48 * hour);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("settles an expiry without touching a verdict already on the row", () =>
    onOwnFile((open) =>
      Effect.gen(function* () {
        const token = "token-late" as DurableDeferred.Token;

        const asking = yield* open(
          Effect.gen(function* () {
            const repository = yield* GateRepository;
            yield* repository.asked(request({ gate: "late" }));
            yield* repository.recorded({
              token,
              verdict: new Verdict({
                choice: "approve",
                reason: "too late",
                answerer: "kevin",
                answeredAt: 9_000,
              }),
            });
            yield* repository.expired({ token, expiredAt: 8_000 });
            return Option.getOrThrow(yield* repository.byToken(token));
          }),
        );

        // Both facts survive — somebody answered, and the run settled without the answer — and the
        // state ranks them: a verdict the run expired past is one it will never apply.
        expect(asking.verdict?.answerer).toBe("kevin");
        expect(asking.expiredAt).toBe(8_000);
        expect(asking.state(10_000)).toBe("expired");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("says an asking it never saw is not there, rather than inventing one", () =>
    onOwnFile((open) =>
      Effect.gen(function* () {
        // The token is the authority, not this table: a verdict may be given from a machine that
        // never ran the workflow. `recorded` reporting `false` is how a caller tells the two apart.
        const outcome = yield* open(
          Effect.gen(function* () {
            const repository = yield* GateRepository;
            return {
              found: yield* repository.byToken("token-elsewhere" as DurableDeferred.Token),
              updated: yield* repository.recorded({
                token: "token-elsewhere" as DurableDeferred.Token,
                verdict: new Verdict({
                  choice: "approve",
                  reason: "",
                  answerer: "kevin",
                  answeredAt: 1,
                }),
              }),
              settled: yield* repository.expired({
                token: "token-elsewhere" as DurableDeferred.Token,
                expiredAt: 1,
              }),
            };
          }),
        );

        expect(Option.isNone(outcome.found)).toBe(true);
        expect(outcome.updated).toBe(false);
        expect(outcome.settled).toBe(false);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("hands back askings from several runs in the order they were asked", () =>
    onOwnFile((open) =>
      Effect.gen(function* () {
        yield* open(
          Effect.gen(function* () {
            const repository = yield* GateRepository;
            yield* repository.asked(request({ gate: "late", runId: "run-2", requestedAt: 9_000 }));
            yield* repository.asked(request({ gate: "early", runId: "run-1", requestedAt: 1_000 }));
          }),
        );

        const all = yield* open(Effect.flatMap(GateRepository, (repository) => repository.all));
        expect(all.map((asking) => asking.request.gate)).toEqual(["early", "late"]);
      }),
    ).pipe(Effect.orDie),
  );
});
