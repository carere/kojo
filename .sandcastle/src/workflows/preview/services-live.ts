import { Console, Effect, Layer } from "effect";
import { CONTAINER_PORT, CONTAINER_WORKSPACE, PREVIEW_LOG } from "./constants";
import {
  assertDockerIsReady,
  buildDockerRunArguments,
  findMoonExecutable,
  inspectContainer,
  mountedPreviewWorktree,
  previewPort,
  previewRevision,
  readPreviewLogs,
  removeContainer,
  resolvePreviewImage,
  runDocker,
} from "./docker";
import { waitUntilReady } from "./readiness";
import { PreviewDocker, PreviewReadiness } from "./services";

const initializePreviewContainer = Effect.fn("initializePreviewContainer")(function* (
  containerName: string,
  branch: string,
) {
  const port = yield* previewPort(containerName);
  const moonExecutable = yield* findMoonExecutable(containerName);

  yield* Console.log(`Installing dependencies for '${branch}'...`);
  yield* runDocker(
    ["exec", "--workdir", CONTAINER_WORKSPACE, containerName, "/usr/local/bin/bun", "ci"],
    true,
  );

  yield* Console.log(`Starting preview for '${branch}'...`);
  yield* runDocker([
    "exec",
    "--detach",
    "--workdir",
    CONTAINER_WORKSPACE,
    containerName,
    "sh",
    "-c",
    `exec ${moonExecutable} run admin:dev -- --host 0.0.0.0 --port ${CONTAINER_PORT} --strictPort > ${PREVIEW_LOG} 2>&1`,
  ]);
  return port;
});

const previewDockerLive = Layer.succeed(
  PreviewDocker,
  PreviewDocker.of({
    assertReady: assertDockerIsReady,
    create: (input) => runDocker(buildDockerRunArguments(input)).pipe(Effect.asVoid),
    initialize: initializePreviewContainer,
    inspect: (containerName) =>
      Effect.gen(function* () {
        const current = yield* inspectContainer(containerName);
        if (current === undefined) return { status: "missing" } as const;
        if (current === false) return { status: "stopped" } as const;
        const [port, worktreePath, revision] = yield* Effect.all(
          [
            previewPort(containerName),
            mountedPreviewWorktree(containerName),
            previewRevision(containerName).pipe(Effect.catch(() => Effect.succeed(""))),
          ],
          { concurrency: "unbounded" },
        );
        return { status: "running", port, revision, worktreePath } as const;
      }),
    prepareImage: resolvePreviewImage,
    readLogs: readPreviewLogs,
    remove: removeContainer,
  }),
);

const previewReadinessLive = Layer.succeed(
  PreviewReadiness,
  PreviewReadiness.of({ wait: waitUntilReady }),
);

export const previewServicesLive = Layer.merge(previewDockerLive, previewReadinessLive);
