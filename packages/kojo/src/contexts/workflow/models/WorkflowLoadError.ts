import { Schema } from "effect";

/**
 * Why a factory's workflow did not become something runnable.
 *
 * Six faults, and the split is the one a person acts on. `no-factory` and `missing` are answered by
 * looking at a directory; `unloadable` is answered by running the file; `malformed` and `misnamed`
 * are answered by editing it; `duplicated` is answered by the repository's `package.json`. A single
 * "could not load" would make all six the same sentence.
 */
export const WorkflowLoadFault = Schema.Literals([
  /** There is no `.kojo/workflows/` here at all. This repository has no factory in it yet. */
  "no-factory",
  /** The factory is there and this workflow is not. */
  "missing",
  /** The module threw while it was being evaluated — a bad import, or a `workflow()` that refused. */
  "unloadable",
  /** It loaded, and what it exports is not one workflow. */
  "malformed",
  /** It is a workflow, and its name is not the name of the file it is in. */
  "misnamed",
  /**
   * This repository resolves a different `effect` from the one this process is running on.
   *
   * The file would import perfectly well, and what it built could not be used: two copies of
   * `effect` are two `Schema` modules, so the payload struct the workflow declares and the payload
   * struct the engine reads have different symbol keys. Left to run, the failure surfaces as
   * `TypeError: Cannot convert a symbol to a string` from inside the framework, at a line of the
   * workflow that is innocent. Refusing here is the difference between that and a sentence naming
   * both copies.
   */
  "duplicated",
]);
export type WorkflowLoadFault = typeof WorkflowLoadFault.Type;

/**
 * A factory's workflow could not be loaded, and the message names the path.
 *
 * **Every one of these is raised before anything spawns** — before a sandbox, before an agent,
 * before a row is written. That is the standard `RosterError` already sets for `kojo.config.yaml`
 * (ticket 07): a factory that cannot run says so while it is being read, not four phases into a run
 * that has already built a container.
 *
 * `source` is always a path and is always absolute. A relative one reads fine in the terminal it was
 * printed in and is useless in a log somebody else is reading.
 */
export class WorkflowLoadError extends Schema.TaggedError<WorkflowLoadError>()(
  "WorkflowLoadError",
  {
    /** The file, or the directory when the fault is about the directory. Absolute. */
    source: Schema.String,
    fault: WorkflowLoadFault,
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  /** `…/.kojo/workflows/review.ts: two workflows in one file`. The path first, because it is the answer. */
  get describe(): string {
    return `${this.source}: ${this.reason}`;
  }
}
