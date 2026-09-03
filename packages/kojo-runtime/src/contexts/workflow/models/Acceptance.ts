import { Schema } from "effect";

/**
 * One half of an acceptance: who judged, what they decided, and why.
 *
 * `by` is a name a human recognises — `the suite`, `kevin` — because the refusal it produces is
 * read by a person who has to decide what to do about it. `reason` is the judge's own words for the
 * same reason a `Verdict` carries the reviewer's: a refusal with no reason is a refusal nobody can
 * act on.
 */
export class Judgement extends Schema.Class<Judgement>("Judgement")({
  by: Schema.String,
  accepted: Schema.Boolean,
  reason: Schema.String,
}) {}

/**
 * Whether a finished run is **good**, which is a different question from whether its phases passed.
 *
 * D7, as a type. A test phase that ran a red suite passed — it did exactly its job — so a run made
 * only of successful phases can still be one nobody wants merged. Acceptance is the **conjunction**
 * of the two judgements that answer the real question:
 *
 * - **mechanical** — what the machine measured. The suite, the linter, CI.
 * - **human** — what the person decided at the gate.
 *
 * Both are carried rather than collapsed into one boolean, because the two refuse for different
 * reasons and a human reading the trace has to know which one said no. And it is one value rather
 * than two arguments so that it can be *handed to the merge*: the merge hangs on this and on nothing
 * else, which is what makes "phases passing is not enough" structural instead of a convention.
 */
export class Acceptance extends Schema.Class<Acceptance>("Acceptance")({
  mechanical: Judgement,
  human: Judgement,
}) {
  /** The conjunction. Both halves say yes, or the run is not accepted. */
  get accepted(): boolean {
    return this.mechanical.accepted && this.human.accepted;
  }

  /**
   * Why the run is not accepted, in the refusers' own words. Empty when it is accepted.
   *
   * Both refusals when both refused: a run whose suite was red *and* whose reviewer said no has two
   * things wrong with it, and reporting the first one only sends somebody back for a second look.
   */
  get refusal(): string {
    return [this.mechanical, this.human]
      .filter((judgement) => !judgement.accepted)
      .map((judgement) => `${judgement.by}: ${judgement.reason}`)
      .join("; ");
  }
}
