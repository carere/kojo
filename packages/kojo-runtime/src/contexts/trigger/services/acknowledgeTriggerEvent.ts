import { Effect, Exit } from "effect";
import type { TriggerEvent } from "../models/TriggerEvent.ts";
import type { Trigger, TriggerOutcome } from "../ports/Trigger.ts";

export const triggerRetryDelays = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** Retry acknowledgement of an admitted Run. Each event gets its own bounded cycle. */
export const acknowledgeTriggerEvent = (
  trigger: Trigger["Service"],
  event: TriggerEvent,
  outcome: TriggerOutcome,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt += 1) {
      const result = yield* Effect.exit(Effect.suspend(() => trigger.ack(event, outcome)));
      if (Exit.isSuccess(result)) return;
      const delay = triggerRetryDelays[attempt];
      if (delay === undefined) return yield* Effect.failCause(result.cause);
      yield* Effect.sleep(delay);
    }
  });
