import { Schema } from "effect";
import type { YieldableError } from "effect/Cause";

const NotAcceptedBase: Schema.Class<
  NotAccepted,
  Schema.TaggedStruct<
    "NotAccepted",
    {
      readonly reason: Schema.String;
    }
  >,
  YieldableError
> = Schema.TaggedError<NotAccepted>()("NotAccepted", {
  reason: Schema.String,
});

/**
 * The run finished its phases and is still not good.
 *
 * Acceptance is the conjunction of the mechanical verdict and the human one, and it is the single
 * condition the merge hangs on. A test phase that ran a red suite passed — it did exactly its
 * job — so "every phase succeeded" is not the question this answers.
 */
export class NotAccepted extends NotAcceptedBase {}
