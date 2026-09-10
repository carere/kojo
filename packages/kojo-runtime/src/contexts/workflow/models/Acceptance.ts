import { Schema } from "effect";

const JudgementBase: Schema.Class<
  Judgement,
  Schema.Struct<{
    readonly by: Schema.String;
    readonly accepted: Schema.Boolean;
    readonly reason: Schema.String;
  }>,
  Record<never, never>
> = Schema.Class<Judgement>("Judgement")({
  by: Schema.String,
  accepted: Schema.Boolean,
  reason: Schema.String,
});

/**
 * One half of an acceptance: who judged, what they decided, and why.
 *
 * `by` is a name a human recognises — `the suite`, `kevin` — because the refusal it produces is
 * read by a person who has to decide what to do about it. `reason` is the judge's own words for the
 * same reason a `Verdict` carries the reviewer's: a refusal with no reason is a refusal nobody can
 * act on.
 */
export class Judgement extends JudgementBase {}

const AcceptanceBase: Schema.Class<
  Acceptance,
  Schema.Struct<{
    readonly mechanical: typeof Judgement;
    readonly review: typeof Judgement;
  }>,
  Record<never, never>
> = Schema.Class<Acceptance>("Acceptance")({
  mechanical: Judgement,
  review: Judgement,
});

/**
 * Authored acceptance combines mechanical checks and review. The Workflow chooses a human or
 * an agent reviewer. A human review comes from an exact Gate Verdict; agent review is a Judgement
 * in its own right and must never be presented as a human Verdict. Neither Phase success nor
 * positive review alone is sufficient.
 */
export class Acceptance extends AcceptanceBase {
  /** The conjunction. Both halves say yes, or the run is not accepted. */
  get accepted(): boolean {
    return this.mechanical.accepted && this.review.accepted;
  }

  /**
   * Why the run is not accepted, in the refusers' own words. Empty when it is accepted.
   *
   * Both refusals when both refused: a run whose suite was red *and* whose reviewer said no has two
   * things wrong with it, and reporting the first one only sends somebody back for a second look.
   */
  get refusal(): string {
    return [this.mechanical, this.review]
      .filter((judgement) => !judgement.accepted)
      .map((judgement) => `${judgement.by}: ${judgement.reason}`)
      .join("; ");
  }
}
