/**
 * Where a stamped factory keeps its parts, relative to the repository root.
 *
 * One module, because two halves of this build read these paths from opposite ends: `kojo init`
 * *writes* them, and `kojo run` *loads* them back. A second copy of the string `.kojo/workflows`
 * is exactly how a scaffolder and a loader come to disagree about where the product lives, and the
 * symptom of that disagreement is `unknown workflow` in a repository that plainly has one.
 */

/** The directory a factory lives in, inside the target repository. */
export const factoryDirectory = ".kojo";

/**
 * Where a factory's own workflows live, inside it.
 *
 * **One file, one name.** The file name is the name `kojo run` takes, and the loader proves the
 * module agrees — a workflow whose tag is not its file name is refused rather than run under the
 * wrong name. That is what lets `kojo run --help` list what a factory has by reading the directory,
 * without importing a single module to find out.
 *
 * Only the top level is a name. A workflow may import anything it likes from a subdirectory, and
 * those files are modules rather than names: a run name reaches a gate token, and a token is one
 * string a human pastes into a terminal.
 */
export const workflowsDirectory = "workflows";

/** What a workflow module is called on disk. Kojo's runtime is Bun, so it is TypeScript. */
export const workflowExtension = ".ts";

/**
 * The branch a stamped factory lands its accepted runs on, unless its author changes it.
 *
 * One name, for the same reason `factoryDirectory` is one: two halves of this build write it from
 * opposite ends. `kojo init` stamps `const trunk = "main"` into the workflow it generates, and the
 * repositories the test suites create have to start on that branch or every merge phase refuses —
 * by name, with *the workspace is on X, and the merge targets Y*.
 *
 * **Before this existed, the fixtures did not say it at all.** They ran a bare `git init` and took
 * whatever the machine's `init.defaultBranch` produced, which is `main` on the machine this was
 * built on and `master` on a stock CI runner. Four suites went red on the first Linux run of the
 * container tier, for a setting no test mentioned. See ticket 59.
 */
export const defaultTrunk = "main";
