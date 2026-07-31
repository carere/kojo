import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
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
        const root = join(project.path, ".kojo", "artifacts");
        const runDirectory = join(root, runId);
        const path = join(runDirectory, `${artifact.artifactId}.json`);
        const [rootStats, directoryStats, fileStats] = await Promise.all([
          lstat(root),
          lstat(runDirectory),
          lstat(path),
        ]);
        if (
          rootStats.isSymbolicLink() ||
          !rootStats.isDirectory() ||
          directoryStats.isSymbolicLink() ||
          !directoryStats.isDirectory() ||
          fileStats.isSymbolicLink() ||
          !fileStats.isFile()
        ) {
          throw unsafe();
        }
        const content = await readFile(path);
        if (
          content.byteLength !== artifact.byteSize ||
          !createHash("sha256").update(content).digest().equals(Buffer.from(artifact.sha256))
        ) {
          throw { _tag: "artifact-content-changed" } satisfies ExecutionArtifactReadFailure;
        }
        return new Uint8Array(content);
      },
      catch: (error): ExecutionArtifactReadFailure => {
        if (typeof error === "object" && error !== null && "_tag" in error) {
          return error as ExecutionArtifactReadFailure;
        }
        return isMissingFile(error) ? missing() : unsafe();
      },
    }),
});
