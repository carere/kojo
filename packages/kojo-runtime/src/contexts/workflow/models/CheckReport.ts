import { Schema } from "effect";

const ClaimFaultBase: Schema.Class<
  ClaimFault,
  Schema.Struct<{
    readonly claim: Schema.$Array<Schema.String>;
    readonly subject: Schema.String;
    readonly detail: Schema.String;
  }>,
  Record<never, never>
> = Schema.Class<ClaimFault>("ClaimFault")({
  /** One key per level, outermost first. Empty when the fault is the whole envelope. */
  claim: Schema.Array(Schema.String),
  /** The value the claim named — a path, a commit, whatever this check compared. */
  subject: Schema.String,
  /** What is wrong with it, said against the repository rather than against the schema. */
  detail: Schema.String,
});

/**
 * One claim that did not hold.
 *
 * A check grades an envelope against the repository, so a fault has to say three things a
 * re-prompt can act on: **which field** carried the claim, **what value** it carried, and **what
 * the repository says instead**. A rendered sentence carries the third and loses the first two, and
 * an agent given "the check failed" is an agent sent back to guessing.
 *
 * `claim` is a path rather than a name, in the same shape a `DecodeIssue` uses, so the correction
 * text reads the same whether the answer failed to decode or failed to be true.
 */
export class ClaimFault extends ClaimFaultBase {}

const CheckResultBase: Schema.Class<
  CheckResult,
  Schema.Struct<{
    readonly check: Schema.String;
    readonly description: Schema.String;
    readonly faults: Schema.$Array<typeof ClaimFault>;
  }>,
  Record<never, never>
> = Schema.Class<CheckResult>("CheckResult")({
  check: Schema.String,
  description: Schema.String,
  faults: Schema.Array(ClaimFault),
});

/**
 * What one check found.
 *
 * `description` travels with the result rather than living only in the check, because the
 * correction prompt and the trace are both read far from the file that defined the predicate.
 */
export class CheckResult extends CheckResultBase {
  get held(): boolean {
    return this.faults.length === 0;
  }
}

const CheckReportBase: Schema.Class<
  CheckReport,
  Schema.Struct<{
    readonly results: Schema.$Array<typeof CheckResult>;
  }>,
  Record<never, never>
> = Schema.Class<CheckReport>("CheckReport")({
  results: Schema.Array(CheckResult),
});

/**
 * What every check that graded one answer found, in the order they ran.
 *
 * **Every check runs, never up to the first failure.** It is the same invariant as decoding with
 * `{ errors: "all" }`, for the same reason: one fault per correction turn spends one whole agent
 * call per fault, and the loop is bounded, so a three-fault answer would exhaust the bound without
 * ever being told the third thing that was wrong.
 */
export class CheckReport extends CheckReportBase {
  /** The checks that did not hold, in the order they ran. */
  get failed(): ReadonlyArray<CheckResult> {
    return this.results.filter((result) => !result.held);
  }

  get held(): boolean {
    return this.failed.length === 0;
  }
}
