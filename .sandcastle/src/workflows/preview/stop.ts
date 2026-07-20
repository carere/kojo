import { Console, Effect } from "effect";
import { createPreviewIdentity } from "./identity";
import { PreviewDocker } from "./services";

export const stopPreview = Effect.fn("stopPreview")(function* (
  repositoryRoot: string,
  branch: string,
) {
  const docker = yield* PreviewDocker;
  // 1. Verify Docker before looking up the deterministic container identity.
  yield* docker.assertReady();
  const identity = createPreviewIdentity(branch, repositoryRoot);
  const current = yield* docker.inspect(identity.containerName);
  if (current.status === "missing") {
    yield* Console.log(`No preview is running for '${branch}'.`);
    return;
  }

  // 2. Remove only the container; the worktree and local state remain reusable.
  yield* docker.remove(identity.containerName);
  yield* Console.log(`Stopped preview for '${branch}'.`);
  yield* Console.log(
    "The worktree, dependencies, and local application state were kept for reuse.",
  );
});
