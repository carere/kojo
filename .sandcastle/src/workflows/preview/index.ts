import { Effect } from "effect";
import { findRepositoryRoot } from "../../shared/git";
import type { PreviewOptions } from "../../types/preview";
import { startPreview } from "./start";
import { stopPreview } from "./stop";

export const runPreviewWorkflow = Effect.fn("runPreviewWorkflow")(function* (
  options: PreviewOptions,
) {
  const repositoryRoot = yield* findRepositoryRoot();
  if (options.action === "start") {
    return yield* startPreview(repositoryRoot, options.branch);
  }
  return yield* stopPreview(repositoryRoot, options.branch);
});
