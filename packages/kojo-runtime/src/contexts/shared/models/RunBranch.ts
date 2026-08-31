import type { RunId } from "./RunId.ts";

/**
 * What every run's branch is called, and the one place the name is built.
 *
 * The prefix is a namespace on purpose: a factory shares a repository with the people who work in
 * it, and `git branch --list "kojo/*"` has to be able to answer "what does the factory own" without
 * a list somebody maintains by hand.
 */
export const branchPrefix = "kojo/";

/**
 * The branch a run owns.
 *
 * **The branch is the durable state of a run** (architecture.md §4), so its name has to be a
 * function of the run and of nothing else: a run that had to be *told* its branch is a run whose
 * commits can land somewhere else, and a resumed run derives the same name two days and two
 * processes later without carrying anything.
 *
 * No escaping is applied, and that is a measurement rather than an omission. The run id is the
 * engine's execution id, and `Workflow.execute` builds it with `makeHashDigest` — the first sixteen
 * bytes of a SHA-256, hex — so it is thirty-two characters of `[0-9a-f]` and there is nothing in it
 * git could refuse. Minting a run id any other way would break that, which is why `RunId` is branded
 * and why nothing in Kojo constructs one.
 */
export const runBranch = (runId: RunId): string => `${branchPrefix}${runId}`;
