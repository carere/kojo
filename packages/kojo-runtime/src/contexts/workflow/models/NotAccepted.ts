import { Schema } from "effect";

/**
 * The run finished its phases and is still not good.
 *
 * Acceptance is the conjunction of the mechanical verdict and the human one, and it is the single
 * condition the merge hangs on. A test phase that ran a red suite passed — it did exactly its
 * job — so "every phase succeeded" is not the question this answers.
 */
export class NotAccepted extends Schema.TaggedError<NotAccepted>()("NotAccepted", {
  reason: Schema.String,
}) {}
