import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import type { StoredExecutionArtifact } from "../repositories/workflow-run-repository";

export type ExecutionArtifactReadFailure =
  | { readonly _tag: "artifact-content-changed" }
  | { readonly _tag: "artifact-content-missing" }
  | { readonly _tag: "artifact-content-unsafe" };

export interface ExecutionArtifactStoreShape {
  /**
   * Reads only a recorded, regular Artifact file. The adapter rejects every
   * storage identity that cannot be derived from this Project, Run, and
   * Artifact record before it touches the filesystem.
   */
  readonly read: (
    project: ProjectSnapshot,
    runId: string,
    artifact: StoredExecutionArtifact,
  ) => Effect.Effect<Uint8Array, ExecutionArtifactReadFailure>;
}

export class ExecutionArtifactStore extends Context.Service<
  ExecutionArtifactStore,
  ExecutionArtifactStoreShape
>()("kojo/host/ExecutionArtifactStore") {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const unsafe = (): ExecutionArtifactReadFailure => ({ _tag: "artifact-content-unsafe" });
const missing = (): ExecutionArtifactReadFailure => ({ _tag: "artifact-content-missing" });

const isMissingFile = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

const noFollowReadOnly = constants.O_RDONLY | constants.O_NOFOLLOW;
const noFollowDirectory = noFollowReadOnly | constants.O_DIRECTORY;

const unsafeDescriptorPath = (handle: FileHandle) =>
  realpath(`/dev/fd/${handle.fd}`).catch(() => {
    throw unsafe();
  });

const closeQuietly = async (handle: FileHandle | undefined) => {
  if (handle !== undefined) await handle.close().catch(() => undefined);
};

/** Local Artifact adapter. It intentionally accepts the current JSON storage format only. */
export const LocalExecutionArtifactStoreLive = Layer.succeed(ExecutionArtifactStore, {
  read: (project, runId, artifact) =>
    Effect.tryPromise({
      try: async () => {
        if (
          !uuid.test(runId) ||
          !uuid.test(artifact.artifactId) ||
          artifact.storageKey !== `${runId}/${artifact.artifactId}.json`
        ) {
          throw unsafe();
        }
        const projectDirectory = await realpath(project.path);
        const expectedRoot = join(projectDirectory, ".kojo", "artifacts");
        let root: FileHandle | undefined;
        let runDirectory: FileHandle | undefined;
        let file: FileHandle | undefined;
        try {
          root = await open(join(project.path, ".kojo", "artifacts"), noFollowDirectory);
          const rootPath = await unsafeDescriptorPath(root);
          if (!(await root.stat()).isDirectory() || rootPath !== expectedRoot) throw unsafe();

          const expectedRunDirectory = join(rootPath, runId);
          runDirectory = await open(expectedRunDirectory, noFollowDirectory);
          const runDirectoryPath = await unsafeDescriptorPath(runDirectory);
          if (
            !(await runDirectory.stat()).isDirectory() ||
            runDirectoryPath !== expectedRunDirectory
          ) {
            throw unsafe();
          }

          const expectedArtifactPath = join(runDirectoryPath, `${artifact.artifactId}.json`);
          file = await open(expectedArtifactPath, noFollowReadOnly);
          const [filePath, fileStats] = await Promise.all([
            unsafeDescriptorPath(file),
            file.stat(),
          ]);
          if (!fileStats.isFile() || filePath !== expectedArtifactPath) throw unsafe();

          // The file descriptor stays pinned even if a same-user process
          // replaces the path after open. Never reopen the path below.
          const content = await file.readFile();
          if (
            content.byteLength !== artifact.byteSize ||
            !createHash("sha256").update(content).digest().equals(Buffer.from(artifact.sha256))
          ) {
            throw { _tag: "artifact-content-changed" } satisfies ExecutionArtifactReadFailure;
          }
          return new Uint8Array(content);
        } finally {
          await closeQuietly(file);
          await closeQuietly(runDirectory);
          await closeQuietly(root);
        }
      },
      catch: (error): ExecutionArtifactReadFailure => {
        if (typeof error === "object" && error !== null && "_tag" in error) {
          return error as ExecutionArtifactReadFailure;
        }
        return isMissingFile(error) ? missing() : unsafe();
      },
    }),
});
