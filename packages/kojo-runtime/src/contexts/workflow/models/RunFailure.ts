import { Cause, Option } from "effect";
import { runBranch } from "../../shared/models/RunBranch.ts";
import type { RunId } from "../../shared/models/RunId.ts";

/**
 * One line about the error itself, for the report a human reads.
 *
 * A declared error is a `Schema.TaggedError`, whose tag and fields are own enumerable properties, so
 * `JSON.stringify` renders exactly what the author declared and nothing else. An error that renders
 * to nothing falls back to its own string form rather than to an empty pair of braces.
 */
const renderError = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error);
  const rendered = JSON.stringify(error);
  return rendered === undefined || rendered === "{}" ? String(error) : rendered;
};

/**
 * Why a whole run failed, and what it left behind — the value a compensation is handed.
 *
 * **The cause stays typed.** `Failure` is the workflow's own declared error type, which is the whole
 * reason the compensation surface is built from the workflow *method* `withCompensation` rather than
 * the module function: the module version widens the cause to `Cause.Cause<unknown>`, and a
 * compensation that cannot match on the error it is compensating for has to guess.
 *
 * **The branch is a field, not an instruction.** It is derived from the run id, so a compensation
 * cannot be told the wrong one, and it is here because the branch is what a failed run *leaves* — a
 * report that does not name it sends somebody to look for a run with nothing to look at.
 *
 * Not a `Schema.Class`: a `Cause` is not an encodable value, and this record is never persisted. The
 * trace's own account of a failed run is the run row `workflow()` writes on exit.
 */
export class RunFailure<Failure> {
  readonly runId: RunId;
  /** The failure exactly as the engine recorded it, still carrying the declared error type. */
  readonly cause: Cause.Cause<Failure>;

  constructor(options: { readonly runId: RunId; readonly cause: Cause.Cause<Failure> }) {
    this.runId = options.runId;
    this.cause = options.cause;
  }

  /**
   * The branch the failed run leaves behind.
   *
   * **Preserved, never deleted.** A failed run's branch and the worktree it can be checked out into
   * are the inspection surface — deleting them is the failure, not the cleanup.
   */
  get branch(): string {
    return runBranch(this.runId);
  }

  /** The declared error the run failed with. Absent when the run died or was interrupted instead. */
  get error(): Option.Option<Failure> {
    return Cause.findErrorOption(this.cause);
  }

  /** The declared error's tag, when there is one. What a report groups failures by. */
  get errorTag(): string | undefined {
    return Option.match(this.error, {
      onNone: () => undefined,
      onSome: (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        typeof error._tag === "string"
          ? error._tag
          : undefined,
    });
  }

  /** The run died on something nobody declared. A defect is a bug in the factory, not a refusal. */
  get died(): boolean {
    return Cause.hasDies(this.cause);
  }

  /**
   * Somebody stopped the run rather than the run failing on its own.
   *
   * A suspension is **not** this. Suspension leaves the workflow instance open and never closes its
   * scope, so a run waiting at a gate reaches no compensation at all — which is the property that
   * lets a gate wait two days.
   */
  get interrupted(): boolean {
    return Cause.hasInterrupts(this.cause);
  }

  /** What went wrong, in one line. */
  get description(): string {
    return Option.match(this.error, {
      onNone: () =>
        this.died ? "a defect" : this.interrupted ? "an interruption" : "an unnamed failure",
      onSome: (error) => renderError(error),
    });
  }

  /**
   * The whole failure as one line to post — at the ticket, in the channel, wherever it is owed.
   *
   * It names the branch, because the first question anybody asks about a failed run is where to go
   * and look at it.
   */
  get report(): string {
    return `run ${this.runId} failed: ${this.description}. The branch ${this.branch} is preserved.`;
  }
}
