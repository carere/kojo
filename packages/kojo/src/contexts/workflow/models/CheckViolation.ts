import { Schema } from "effect";
import { CheckReport } from "./CheckReport.ts";

/**
 * An agent answered with a well-formed envelope, and the envelope is not true.
 *
 * The second half of the correction loop's input, beside `EnvelopeParseError`. The two are separate
 * errors because they say different things to a human — *the answer was the wrong shape* and *the
 * answer was the wrong content* — and identical things to the loop, which re-prompts either way.
 *
 * **This is not a `PermissionBreach`.** A violated claim is work an agent can be asked to redo; a
 * breach is a write that already happened and has already been undone. See architecture.md D8, and
 * the residual channel of `withCorrections`, which is what makes the difference structural.
 */
export class CheckViolation extends Schema.TaggedError<CheckViolation>()("CheckViolation", {
  agent: Schema.String,
  /**
   * The first check that did not hold — what the trace groups on, and what the phase row names.
   * Every other failing check is in `report`, because the correction prompt needs all of them.
   */
  check: Schema.String,
  report: CheckReport,
}) {
  /**
   * The violation a report describes, or nothing when the report says nothing is wrong.
   *
   * `undefined` rather than a violation with an empty `check`, so a report where everything held
   * cannot be turned into an error at all — the one place the headline check is chosen is here.
   */
  static fromReport(agent: string, report: CheckReport): CheckViolation | undefined {
    const first = report.failed[0];
    return first === undefined
      ? undefined
      : new CheckViolation({ agent, check: first.check, report });
  }
}
