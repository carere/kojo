import { Effect } from "effect";
import type { WorkspaceError } from "../../sandbox/models/WorkspaceError.ts";
import { CheckReport, CheckResult, type ClaimFault } from "../models/CheckReport.ts";

/**
 * A predicate over an envelope's claims, run after the agent returns.
 *
 * D6 in one type: an agent *proposes* — it reports which files it changed and which artifacts it
 * wrote — and code *disposes*, by going and looking. Nothing here asks the agent anything; a check
 * only ever compares a claim against the repository.
 *
 * Three things make it a port-shaped value rather than a plain function:
 *
 * - **It is named.** The name reaches the phase row and the correction prompt, so a human and an
 *   agent are told the same thing about why an answer was not accepted.
 * - **It returns faults, not a boolean.** A boolean says an answer is wrong; a fault says which
 *   claim is wrong and what the repository holds instead, which is the difference between a
 *   correction turn that lands and one that guesses.
 * - **Its error channel is `WorkspaceError`, and never a fault.** A check that could not look must
 *   say so. Reporting "no faults" when `git diff` failed grades every repository it cannot see as
 *   clean, which is the one failure mode a verification layer must not have.
 *
 * `R` is what the predicate needs to look — `Workspace` for everything shipped here. It stays a
 * parameter so an author's own check can need something else, and so an agent phase with no checks
 * does not inherit a requirement it never uses.
 *
 * **A shipped check is written with its envelope named — `artifactsExist<Scouted>({ … })`.** `A`
 * appears only in the selector's parameter, and a context-sensitive arrow gives TypeScript nothing
 * to infer from, so leaving it out silently types the selector's argument as `unknown`.
 */
export interface Check<A, R = never> {
  readonly name: string;
  /** What holding means, in words. It travels into the correction prompt and the trace. */
  readonly description: string;
  readonly verify: (claims: A) => Effect.Effect<ReadonlyArray<ClaimFault>, WorkspaceError, R>;
}

/** Define a check. A plain constructor, so the name and the predicate cannot drift apart. */
export const make = <A, R = never>(check: Check<A, R>): Check<A, R> => check;

/**
 * Run every check over one answer and collect what they found.
 *
 * Sequential and exhaustive. Sequential because a check reads a repository and two of them reading
 * one working tree at once is a race nobody asked for; exhaustive because the report is what one
 * correction turn is written from — see `CheckReport`.
 */
export const runChecks = <A, R>(
  checks: ReadonlyArray<Check<A, R>>,
  claims: A,
): Effect.Effect<CheckReport, WorkspaceError, R> =>
  Effect.forEach(checks, (check) =>
    check
      .verify(claims)
      .pipe(
        Effect.map(
          (faults) =>
            new CheckResult({ check: check.name, description: check.description, faults }),
        ),
      ),
  ).pipe(Effect.map((results) => new CheckReport({ results })));
