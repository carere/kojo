import type { WorkItemProgress } from "@carere/kojo-runtime/contexts/trace/models/WorkItemProgress";
import { Cause, Effect, Schema } from "effect";

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
  readonly observe?: (
    name: string,
    items: ReadonlyArray<WorkItemProgress>,
  ) => Effect.Effect<unknown, never, R>;
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
    const progress = new Map<number, WorkItemProgress>();
    const observe = (
      issue: Issue,
      state: WorkItemProgress["state"],
      detail: string,
      waitingFor?: WorkItemProgress["waitingFor"],
      dependencies: ReadonlyArray<number> = [],
    ): Effect.Effect<void, never, R> =>
      Effect.gen(function* () {
        const previous = progress.get(issue.number);
        if (previous?.state === state && previous.detail === detail) return;
        const item: WorkItemProgress = {
          key: String(issue.number),
          title: `#${issue.number} ${issue.title}`,
          revision: (previous?.revision ?? 0) + 1,
          state,
          detail,
          dependencies: dependencies.map(String),
          url: issue.url,
          ...(waitingFor === undefined ? {} : { waitingFor }),
        };
        progress.set(issue.number, item);
        yield* options.delivery.observe?.(`progress/issue-${issue.number}/${item.revision}`, [
          item,
        ]) ?? Effect.void;
      });
    const failed =
      (issue: Issue) =>
      (cause: Cause.Cause<E>): Effect.Effect<void, never, R> =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : observe(issue, "failed", Cause.pretty(cause).slice(0, 8000));
    let revision = options.baseRevision;
    while (integrated.size < options.issues.length) {
      for (const issue of options.issues) {
        if (integrated.has(issue.number)) continue;
        const blockers = issue.blockedBy.filter((id) => !integrated.has(id));
        yield* observe(
          issue,
          "waiting",
          blockers.length > 0
            ? `Wait for integrated changes from ${blockers.map((id) => `#${id}`).join(", ")}.`
            : "Wait for capacity in the next implementation batch.",
          blockers.length > 0 ? "dependencies" : "capacity",
          blockers,
        );
      }
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
        (issue) =>
          Effect.gen(function* () {
            yield* observe(issue, "executing", `Implement and review from ${source}.`);
            const result = yield* options.delivery
              .implement(issue, source)
              .pipe(Effect.onError(failed(issue)));
            if (result.issue !== issue.number)
              return yield* new InvalidIssueGraph({
                reason: `Implementation for #${issue.number} returned #${result.issue}.`,
              });
            yield* observe(
              issue,
              "accepted",
              `Checks and UI review accepted ${result.sha} on ${result.branch}.`,
            );
            return result;
          }),
        { concurrency: options.concurrency },
      );
      for (const result of results) {
        const issue = options.issues.find((item) => item.number === result.issue);
        if (issue === undefined)
          return yield* new InvalidIssueGraph({
            reason: `Implementation returned unknown issue #${result.issue}.`,
          });
        if (options.mode === "graph")
          yield* observe(issue, "integrating", `Merge accepted commit ${result.sha}.`);
        revision =
          options.mode === "single"
            ? result.sha
            : yield* options.delivery.integrate(result).pipe(Effect.onError(failed(issue)));
        if (options.mode === "graph")
          yield* observe(
            issue,
            "integrated",
            `Accepted changes are in combined revision ${revision}.`,
          );
        integrated.add(result.issue);
        accepted.push(result);
      }
    }
    return { revision, accepted };
  });
