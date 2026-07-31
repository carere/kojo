import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makeControlSubscriptionDeliveryWindow } from "../../../../../../src/contexts/workflow-execution/control/services/control-subscription-delivery-window";

it.effect("closes sessions that race Host shutdown while opening or attaching", () =>
  Effect.gen(function* () {
    const window = makeControlSubscriptionDeliveryWindow();
    const attachMayProceed = yield* Deferred.make<void>();
    const attachStarted = yield* Deferred.make<void>();
    let detachCount = 0;

    // This session is in the registry while its transport callback has not
    // registered cleanup yet. Shutdown must make that later registration run
    // immediately rather than leaving an open stream behind.
    const openingSession = yield* window.open;
    const delayedAttach = yield* Effect.gen(function* () {
      yield* Deferred.succeed(attachStarted, undefined);
      yield* Deferred.await(attachMayProceed);
      yield* openingSession.attachDetach(
        Effect.sync(() => {
          detachCount += 1;
        }),
      );
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(attachStarted);

    // The shutdown flag is synchronous. This starts Host shutdown between
    // open and attach, then lets the attaching callback continue concurrently.
    yield* window.shutdown;
    yield* Deferred.succeed(attachMayProceed, undefined);
    yield* Fiber.join(delayedAttach);

    // A request accepted at the same boundary after shutdown begins receives
    // an already-closed session and its callback is detached immediately too.
    const sessionOpenedDuringShutdown = yield* window.open;
    yield* sessionOpenedDuringShutdown.attachDetach(
      Effect.sync(() => {
        detachCount += 1;
      }),
    );

    expect(detachCount).toBe(2);
    expect(yield* openingSession.next).toMatchObject({ kind: "resync-required" });
    expect(yield* sessionOpenedDuringShutdown.next).toMatchObject({
      kind: "resync-required",
    });
  }),
);
