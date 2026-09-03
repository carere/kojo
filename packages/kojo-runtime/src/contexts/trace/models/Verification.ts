import { Schema } from "effect";

/**
 * What a phase's own after-the-fact verification cost and found.
 *
 * The trace answers "why did this run take four agent calls to do one thing", and a phase that
 * corrected itself twice looks identical to one that answered first time unless the row says so.
 * So the count is a fact of the phase, beside what it cost in tokens, rather than something a
 * reader reconstructs by counting agent calls that were never separately recorded.
 */
export class Verification extends Schema.Class<Verification>("Verification")({
  /**
   * What the answer was asked to be — the envelope's own identifier.
   *
   * The first half of the verdict: decoding the envelope *is* a verification, and this is what it
   * decoded against. Whether it decoded is `errorTag` on the row beside this one.
   */
  envelope: Schema.String,
  /** Every check that graded the answer, in the order they ran. Empty when the phase runs none. */
  ran: Schema.Array(Schema.String),
  /**
   * The checks that did not hold on the last attempt. Empty on a phase whose answer was accepted,
   * and empty on one that died before any check ran — `errorTag` is what tells those apart.
   */
  failed: Schema.Array(Schema.String),
  /** How many correction turns the phase spent. Zero when the first answer was accepted. */
  corrections: Schema.Finite,
  /**
   * Whether a correction was possible at all.
   *
   * False when the invoker cannot re-enter a session. A correction is one more message in the same
   * conversation; an invoker without resume can only offer a cold call carrying the correction and
   * none of the context that earned it, which is a different request wearing the same name. So the
   * phase does not correct, and the row says which of the two reasons it stopped.
   */
  correctable: Schema.Boolean,
}) {}
