import { basename, resolve } from "node:path";
import { Console, Effect, Exit, Result } from "effect";
import { failureMessage } from "../../shared/external-failure";
import { findGitCommonDirectory } from "../../shared/git";
import { runText } from "../../shared/process";
import { WorkflowError } from "../../types/errors";
import { DockerRunInput } from "../../types/preview";
import { createPreviewIdentity } from "./identity";
import { previewUrl, printReady } from "./readiness";
import { PreviewDocker, type PreviewDockerService, PreviewReadiness } from "./services";
import { resolveWorktree } from "./worktree";

const enrichStartupFailure = (containerName: string, docker: PreviewDockerService) =>
  Effect.catch((error) =>
    Effect.gen(function* () {
      const logs = yield* docker
        .readLogs(containerName)
        .pipe(Effect.catch(() => Effect.succeed("")));
      const message = failureMessage(error);
      return yield* new WorkflowError({
        message: logs ? `${message}\n\n${logs}` : message,
        operation: "preview.start",
      });
    }),
  );

export const startPreview = Effect.fn("startPreview")(function* (
  repositoryRoot: string,
  branch: string,
) {
  const docker = yield* PreviewDocker;
  const readiness = yield* PreviewReadiness;
  const identity = createPreviewIdentity(branch, repositoryRoot);
  const imageName =
    globalThis.process.env.SANDCASTLE_PREVIEW_IMAGE ?? `sandcastle:${basename(repositoryRoot)}`;
  const uid = globalThis.process.getuid?.() ?? 1000;

  // 1. Verify Docker and the UID-compatible preview image before touching a worktree.
  yield* docker.assertReady();
  const image = yield* docker.prepareImage(imageName, uid);

  // 2. Capture the running container revision before resolving the requested
  // branch, since updating its bind-mounted worktree would otherwise hide staleness.
  const current = yield* docker.inspect(identity.containerName);
  const worktreePath = yield* resolveWorktree(repositoryRoot, branch);
  const requestedRevision = yield* runText(["git", "rev-parse", "HEAD"], worktreePath);
  if (current.status === "running") {
    const isExactRevision =
      current.worktreePath === worktreePath && current.revision === requestedRevision;
    if (isExactRevision) {
      const port = current.port;
      const url = previewUrl(identity, port);
      yield* Console.log(`Preview for '${branch}' is already running. Waiting for readiness...`);
      const ready = yield* Effect.result(readiness.wait(url));
      if (Result.isSuccess(ready)) {
        yield* printReady(identity, port);
        return;
      }
    }
    yield* docker.remove(identity.containerName);
  } else if (current.status === "stopped") {
    yield* docker.remove(identity.containerName);
  }

  // 3. Mount the exact, clean branch worktree and the Git metadata it requires.
  const gitCommonDirectory = yield* findGitCommonDirectory(repositoryRoot);
  const input = new DockerRunInput({
    identity,
    envExamplePath: resolve(repositoryRoot, ".sandcastle/.env.example"),
    gitCommonDirectory,
    image,
    worktreePath,
    uid,
    gid: globalThis.process.getgid?.() ?? 1000,
  });

  // 4. Create, initialize, and probe the container; failures collect logs and remove it.
  const port = yield* Effect.acquireUseRelease(
    docker.create(input),
    () =>
      Effect.gen(function* () {
        const publishedPort = yield* docker.initialize(identity.containerName, branch);
        yield* readiness.wait(previewUrl(identity, publishedPort));
        return publishedPort;
      }).pipe(enrichStartupFailure(identity.containerName, docker)),
    (_, exit) => (Exit.isFailure(exit) ? docker.remove(identity.containerName) : Effect.void),
  );
  yield* printReady(identity, port);
});
