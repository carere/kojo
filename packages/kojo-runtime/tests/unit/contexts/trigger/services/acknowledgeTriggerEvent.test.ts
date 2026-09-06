import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { TriggerError } from "../../../../../src/contexts/trigger/models/TriggerError.ts";
import { TriggerEvent } from "../../../../../src/contexts/trigger/models/TriggerEvent.ts";
import type { Trigger, TriggerOutcome } from "../../../../../src/contexts/trigger/ports/Trigger.ts";
import { acknowledgeTriggerEvent } from "../../../../../src/contexts/trigger/services/acknowledgeTriggerEvent.ts";

const event = (key: string) =>
  new TriggerEvent({ source: "memory", key, payload: null, receivedAt: 0 });
const outcome: TriggerOutcome = { runId: Schema.decodeSync(RunId)("run-one"), outcome: "admitted" };

class InMemoryFailingTrigger {
  readonly attempts: { key: string; at: number; run: TriggerOutcome }[] = [];
  constructor(readonly failures: number) {}
  readonly service: Trigger["Service"] = {
    stream: Stream.never,
    ack: (event, run) =>
      Effect.gen({ self: this }, function* () {
        this.attempts.push({ key: event.key, at: yield* Clock.currentTimeMillis, run });
        if (this.attempts.filter((attempt) => attempt.key === event.key).length <= this.failures) {
          return yield* new TriggerError({
            source: "memory",
            fault: "ack-refused",
            key: event.key,
            reason: "source unavailable",
            issues: [],
            cause: null,
          });
        }
      }),
  };
}

describe("admitted Trigger acknowledgement", () => {
  it.effect("bounds the live retry cycle to five delays and preserves the admitted Run", () =>
    Effect.gen(function* () {
      const source = new InMemoryFailingTrigger(6);
      const fiber = yield* acknowledgeTriggerEvent(source.service, event("one"), outcome).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      yield* TestClock.adjust(31_000);
      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
      expect(source.attempts.map(({ at }) => at)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000]);
      expect(source.attempts.every(({ run }) => run === outcome)).toBe(true);
      yield* TestClock.adjust(60_000);
      expect(source.attempts).toHaveLength(6);
    }),
  );

  it.effect("starts a fresh retry cycle after each acknowledged event", () =>
    Effect.gen(function* () {
      const source = new InMemoryFailingTrigger(1);
      const fiber = yield* acknowledgeTriggerEvent(source.service, event("one"), outcome).pipe(
        Effect.andThen(acknowledgeTriggerEvent(source.service, event("two"), outcome)),
        Effect.forkChild,
      );
      yield* TestClock.adjust(2_000);
      yield* Fiber.join(fiber);
      expect(source.attempts.map(({ key, at }) => ({ key, at }))).toEqual([
        { key: "one", at: 0 },
        { key: "one", at: 1_000 },
        { key: "two", at: 1_000 },
        { key: "two", at: 2_000 },
      ]);
    }),
  );
});
