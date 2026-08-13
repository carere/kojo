import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";
import { describeFailure } from "../../../src/cli/failureLine.ts";
import { AgentInvocationError } from "../../../src/contexts/agent/models/AgentInvocationError.ts";
import { PathRollback } from "../../../src/contexts/shared/models/PathRollback.ts";
import {
  CheckReport,
  CheckResult,
  ClaimFault,
} from "../../../src/contexts/workflow/models/CheckReport.ts";
import { CheckViolation } from "../../../src/contexts/workflow/models/CheckViolation.ts";
import { NotAccepted } from "../../../src/contexts/workflow/models/NotAccepted.ts";
import { PermissionBreach } from "../../../src/contexts/workflow/models/PermissionBreach.ts";

/**
 * The reason a failed run gives, graded against the errors that will carry it.
 *
 * Every error below is one of the five ticket 15 will meet, and each is asserted on the **one fact
 * its reader needs** rather than on a rendered blob: the agent that was never called, the check that
 * did not hold, the path that was written. A test that only checked the tag appeared would pass
 * against the `run failed` this replaces.
 */
describe("why a run failed, in the error's own words", () => {
  it("names the tag and every field the error carries", () => {
    const said = describeFailure(
      Cause.fail(
        new AgentInvocationError({
          agent: "drafter",
          fault: "provider-failed",
          reason: "no agent provider is wired into this build, so `drafter` was never called.",
          cause: undefined,
        }),
      ),
    );

    expect(said).toContain("AgentInvocationError");
    expect(said).toContain("agent: drafter");
    expect(said).toContain("fault: provider-failed");
    // `AbsentAgentInvoker`'s own sentence. It exists to explain why no agent ran, and before this
    // it reached no surface a person reads.
    expect(said).toContain("no agent provider is wired into this build");
    // A `Schema.Defect()` given nothing reads back as `null` after the engine stores it, and a line
    // saying `cause: null` is a line that says nothing.
    expect(said).not.toContain("cause:");
  });

  it("carries the check that did not hold, and what the repository said instead", () => {
    const violation = CheckViolation.fromReport(
      "drafter",
      new CheckReport({
        results: [
          new CheckResult({
            check: "touched-only-src",
            description: "Every changed file is under src/",
            faults: [
              new ClaimFault({
                claim: ["changedFiles", "0"],
                subject: "docs/readme.md",
                detail: "outside the permitted scope",
              }),
            ],
          }),
        ],
      }),
    );

    expect(violation).toBeDefined();
    const said = describeFailure(Cause.fail(violation));

    expect(said).toContain("CheckViolation");
    expect(said).toContain("check: touched-only-src");
    // The fault is nested two levels down, inside a report inside a result. A renderer that stopped
    // at the top-level fields would print the headline and lose the only actionable fact.
    expect(said).toContain("docs/readme.md");
    expect(said).toContain("outside the permitted scope");
  });

  it("names the breached path and what became of it", () => {
    const said = describeFailure(
      Cause.fail(
        new PermissionBreach({
          agent: "drafter",
          scope: "src/** and nothing else",
          paths: [
            new PathRollback({
              path: "/etc/hosts",
              outcome: { _tag: "NotUndone", reason: "read-only" },
            }),
            new PathRollback({ path: "docs/readme.md", outcome: { _tag: "Restored" } }),
          ],
        }),
      ),
    );

    expect(said).toContain("PermissionBreach");
    expect(said).toContain("/etc/hosts");
    expect(said).toContain("read-only");
    // A tagged value with nothing else in it is the one word it is, not a block holding a `_tag`.
    expect(said).toContain("outcome: Restored");
  });

  it("says both reasons when two things went wrong", () => {
    const said = describeFailure(
      Cause.combine(
        Cause.fail(new NotAccepted({ reason: "the suite is red" })),
        Cause.fail(new NotAccepted({ reason: "nobody signed it off" })),
      ),
    );

    expect(said).toContain("the suite is red");
    expect(said).toContain("nobody signed it off");
  });

  it("says a defect is a defect, and keeps the line that threw", () => {
    const said = describeFailure(Cause.die(new TypeError("greeting is not a function")));

    expect(said).toContain("died:");
    expect(said).toContain("greeting is not a function");
  });

  it("says an interrupt is an interrupt rather than inventing an error", () => {
    expect(describeFailure(Cause.interrupt(1))).toBe("interrupted");
  });
});
