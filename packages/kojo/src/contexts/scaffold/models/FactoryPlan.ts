/**
 * One file initialisation would write, as content rather than as an action.
 *
 * The path is relative to the target repository root, never absolute: a plan is compared against
 * an expectation in a unit test, and an absolute path would make every such test depend on where
 * the test ran.
 */
export interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Everything a stamped factory is, before anything has touched a disk.
 *
 * A plan is a **pure function of the answers**, which is what lets the content of a factory —
 * that the package manager reached both the image and the command block, that every placeholder is
 * obviously fake — be graded by unit tests with no filesystem at all. Writing it is a separate
 * step, and the only step that can fail for a reason that is not about the answers.
 */
export interface FactoryPlan {
  /** Made whether or not a file lands in them. `data/` holds nothing until the first run. */
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<PlannedFile>;
}

/**
 * What happened to one planned file.
 *
 * `kept` is not a failure and not a no-op worth hiding — it is the whole of "running initialisation
 * twice does not clobber edits". A second run that reported nothing would leave a person unable to
 * tell it from a run that overwrote everything silently.
 */
export type StampOutcome = "created" | "kept";

export interface Stamped {
  readonly path: string;
  readonly outcome: StampOutcome;
}
