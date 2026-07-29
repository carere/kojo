import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ProjectIdentity,
  type ProjectOperationError,
  type ProjectOperationResult,
  ProjectSnapshot,
} from "@kojo/control";
import { Context, Effect, Layer, Schema } from "effect";
import {
  InvalidProjectLayoutError,
  readProjectIdentityAtPath,
  validateInitializedProject,
} from "./project-layout";

export interface ProjectIndexShape {
  readonly forget: (identity: ProjectIdentity) => Effect.Effect<ProjectOperationResult>;
  readonly list: Effect.Effect<ReadonlyArray<ProjectSnapshot>>;
  readonly register: (path: string) => Effect.Effect<ProjectOperationResult>;
  readonly show: (identity: ProjectIdentity) => Effect.Effect<ProjectOperationResult>;
}

export class ProjectIndex extends Context.Service<ProjectIndex, ProjectIndexShape>()(
  "kojo/host/ProjectIndex",
) {}

const StoredIndex = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  projects: Schema.Array(ProjectSnapshot),
});

const failure = (
  code: ProjectOperationError["code"],
  message: string,
  next: string,
): ProjectOperationResult => ({ ok: false, error: { code, message, next } });

const writeIndex = async (path: string, projects: ReadonlyArray<ProjectSnapshot>) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ layoutVersion: 1, projects }, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const readIndex = async (path: string): Promise<Array<ProjectSnapshot>> => {
  try {
    const information = await lstat(path);
    const userId = process.getuid?.();
    if (
      information.isSymbolicLink() ||
      !information.isFile() ||
      (userId !== undefined && information.uid !== userId) ||
      (information.mode & 0o777) !== 0o600
    ) {
      throw new Error("unsafe Project Index");
    }
    const value = Schema.decodeUnknownSync(StoredIndex)(JSON.parse(await readFile(path, "utf8")));
    return [...value.projects];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Kojo Project Index is invalid.");
  }
};

export const makeProjectIndex = async (path: string): Promise<ProjectIndexShape> => {
  let projects = await readIndex(path);
  let mutation = Promise.resolve();

  const mutate = <A>(operation: () => Promise<A>) => {
    const result = mutation.then(operation, operation);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return Effect.promise(() => result);
  };

  return {
    list: Effect.sync(() =>
      [...projects].sort((left, right) => left.identity.localeCompare(right.identity)),
    ),
    show: (identity) =>
      Effect.sync(() => {
        const project = projects.find((candidate) => candidate.identity === identity);
        return project === undefined
          ? failure(
              "project-not-found",
              "Kojo Project was not found in the Project Index.",
              "Register the Project or choose a listed Project Identity.",
            )
          : { ok: true as const, project };
      }),
    register: (candidatePath) =>
      mutate(async () => {
        let candidate: ProjectSnapshot;
        try {
          candidate = await validateInitializedProject(candidatePath);
        } catch (error) {
          const message =
            error instanceof InvalidProjectLayoutError
              ? error.message
              : "The path is not a safe initialized Kojo Project.";
          return failure("project-layout-invalid", message, "Run kojo init for this working tree.");
        }

        const samePath = projects.find((project) => project.path === candidate.path);
        if (samePath !== undefined && samePath.identity !== candidate.identity) {
          return failure(
            "project-layout-invalid",
            "This Project path is already indexed with another Project Identity.",
            "Inspect the Project metadata and Project Index before retrying.",
          );
        }

        const existing = projects.find((project) => project.identity === candidate.identity);
        if (existing?.path === candidate.path) return { ok: true as const, project: existing };
        if (existing !== undefined) {
          try {
            const existingIdentity = await readProjectIdentityAtPath(existing.path);
            if (existingIdentity === candidate.identity) {
              return failure(
                "project-identity-duplicate",
                "The same Project Identity is present at two working-tree paths.",
                "Run kojo init --new-identity on the copied working tree.",
              );
            }
          } catch {
            try {
              await lstat(existing.path);
              return failure(
                "project-identity-duplicate",
                "Kojo cannot prove that the indexed working tree moved because its previous path still exists.",
                "Resolve the previous path or assign a new Project Identity explicitly.",
              );
            } catch (pathError) {
              if ((pathError as NodeJS.ErrnoException).code !== "ENOENT") {
                return failure(
                  "project-identity-duplicate",
                  "Kojo cannot safely distinguish a moved Project from a duplicate identity.",
                  "Resolve access to the previous path before retrying.",
                );
              }
            }
          }
        }

        projects = [
          ...projects.filter(
            (project) => project.identity !== candidate.identity && project.path !== candidate.path,
          ),
          candidate,
        ];
        await writeIndex(path, projects);
        return { ok: true as const, project: candidate };
      }),
    forget: (identity) =>
      mutate(async () => {
        const project = projects.find((candidate) => candidate.identity === identity);
        if (project === undefined) {
          return failure(
            "project-not-found",
            "Kojo Project was not found in the Project Index.",
            "Choose a listed Project Identity.",
          );
        }
        projects = projects.filter((candidate) => candidate.identity !== identity);
        await writeIndex(path, projects);
        return { ok: true as const, project };
      }),
  };
};

export const makeProjectIndexLayer = (path: string) =>
  Layer.effect(
    ProjectIndex,
    Effect.promise(() => makeProjectIndex(path)),
  );
