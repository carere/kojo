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
