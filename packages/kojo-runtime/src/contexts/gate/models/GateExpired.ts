import { Schema } from "effect";
import type { YieldableError } from "effect/Cause";

const GateExpiredBase: Schema.Class<
  GateExpired,
  Schema.TaggedStruct<
    "GateExpired",
    {
      readonly gate: Schema.String;
      readonly waited: Schema.Duration;
    }
  >,
  YieldableError
> = Schema.TaggedError<GateExpired>()("GateExpired", {
  gate: Schema.String,
  waited: Schema.Duration,
});

/**
 * The deadline passed and nobody answered.
 *
 * Every gate carries a deadline, because a run that waits forever is a leak. `waited` is the human
 * latency the gate spent before giving up — the metric a factory lives or dies by, and the reason
 * an expiry is worth more in the trace than "failed".
 */
export class GateExpired extends GateExpiredBase {}
