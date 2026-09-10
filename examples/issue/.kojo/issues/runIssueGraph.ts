import { Effect, Schema } from "effect";

export interface Issue {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly blockedBy: ReadonlyArray<number>;
}

export interface AcceptedIssue {
  readonly issue: number;
  readonly branch: string;
  readonly sha: string;
}

/** These operations are supplied by this Factory, not by the Kojo engine. */
export interface IssueDelivery<E, R> {
  readonly implement: (issue: Issue, revision: string) => Effect.Effect<AcceptedIssue, E, R>;
  readonly integrate: (result: AcceptedIssue) => Effect.Effect<string, E, R>;
}

export class InvalidIssueGraph extends Schema.TaggedError<InvalidIssueGraph>()(
  "InvalidIssueGraph",
  { reason: Schema.String },
) {}

/** Validate the entire graph before any issue can change a worktree. */
const validate = (issues: ReadonlyArray<Issue>, concurrency: number, mode: "single" | "graph") => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    return "Concurrency must be a positive integer.";
  if (issues.length === 0 || (mode === "single" && issues.length !== 1))
    return "Select one issue, or a parent with at least one child issue.";
  const ids = new Set(issues.map((issue) => issue.number));
  if (ids.size !== issues.length) return "The issue graph contains a duplicate issue.";
  for (const issue of issues) {
    const external = issue.blockedBy.filter((blocker) => !ids.has(blocker));
    if (external.length > 0)
      return `Issue #${issue.number} has unresolved external blockers: ${external.join(", ")}.`;
  }
  const checked = new Set<number>();
  while (checked.size < issues.length) {
    const ready = issues.filter(
      (issue) =>
        !checked.has(issue.number) && issue.blockedBy.every((blocker) => checked.has(blocker)),
    );
    if (ready.length === 0)
      return `Dependency cycle among issues: ${issues
        .filter((issue) => !checked.has(issue.number))
        .map((issue) => issue.number)
        .join(", ")}.`;
    for (const issue of ready) checked.add(issue.number);
  }
  return undefined;
};

/**
 * Run ready issues in bounded batches. Integrate each accepted result in issue-number order.
 * A dependent starts only after its blockers are integrated, from that exact combined revision.
 * All mutable scheduling state belongs to one execution of this authored Effect.
 */
export const runIssueGraph = <E, R>(options: {
  readonly issues: ReadonlyArray<Issue>;
  readonly mode: "single" | "graph";
  readonly concurrency: number;
  readonly baseRevision: string;
  readonly delivery: IssueDelivery<E, R>;
}): Effect.Effect<
  { readonly revision: string; readonly accepted: ReadonlyArray<AcceptedIssue> },
  E | InvalidIssueGraph,
  R
> =>
  Effect.gen(function* () {
    const reason = validate(options.issues, options.concurrency, options.mode);
    if (reason !== undefined) return yield* new InvalidIssueGraph({ reason });
    const integrated = new Set<number>();
    const accepted: Array<AcceptedIssue> = [];
    let revision = options.baseRevision;
    while (integrated.size < options.issues.length) {
      const ready = options.issues
        .filter(
          (issue) =>
            !integrated.has(issue.number) &&
            issue.blockedBy.every((blocker) => integrated.has(blocker)),
        )
        .sort((left, right) => left.number - right.number)
        .slice(0, options.concurrency);
      const source = revision;
      const results = yield* Effect.forEach(
        ready,
        (issue) => options.delivery.implement(issue, source),
        { concurrency: options.concurrency },
      );
      for (const result of results) {
        revision =
          options.mode === "single" ? result.sha : yield* options.delivery.integrate(result);
        integrated.add(result.issue);
        accepted.push(result);
      }
    }
    return { revision, accepted };
  });
