import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ProjectRegistrationState, StoredProject, SystemStore } from "./storage";

export interface ProjectAvailabilityReason {
  readonly code:
    | "BARE_REPOSITORY"
    | "LINKED_WORKTREE"
    | "NOT_GIT_REPOSITORY"
    | "NOT_REPOSITORY_ROOT"
    | "PATH_NOT_DIRECTORY"
    | "PATH_NOT_FOUND"
    | "PATH_UNAVAILABLE";
  readonly message: string;
  readonly path: string;
}

export type ProjectAvailability =
  | { readonly status: "Available" }
  | {
      readonly reasons: ReadonlyArray<ProjectAvailabilityReason>;
      readonly status: "Unavailable";
    };

export interface ProjectMetadata {
  readonly branches: ReadonlyArray<string>;
  readonly currentBranch: string | null;
  readonly folderName: string;
  readonly headCommit: string | null;
  readonly remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>;
}

export interface Project {
  readonly availability: ProjectAvailability;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: ProjectMetadata;
  readonly path: string;
  readonly registrationState: ProjectRegistrationState;
  readonly updatedAt: string;
}

interface Inspection {
  readonly availability: ProjectAvailability;
  readonly canonicalPath: string;
  readonly linkedWorktree: boolean;
  readonly metadata: ProjectMetadata;
}

export class ProjectOperationError extends Error {
  constructor(
    readonly code:
      | "LINKED_WORKTREE_NOT_PROJECT"
      | "PROJECT_ALREADY_REGISTERED"
      | "PROJECT_ARCHIVED"
      | "PROJECT_NOT_FOUND"
      | "PROJECT_UNAVAILABLE",
    message: string,
    readonly reasons?: ReadonlyArray<ProjectAvailabilityReason>,
  ) {
    super(message);
  }
}

const emptyMetadata = (path: string): ProjectMetadata => ({
  branches: [],
  currentBranch: null,
  folderName: basename(path),
  headCommit: null,
  remotes: [],
});

const unavailable = (
  code: ProjectAvailabilityReason["code"],
  message: string,
  path: string,
): ProjectAvailability => ({ reasons: [{ code, message, path }], status: "Unavailable" });

const unavailableInspection = (
  path: string,
  code: "PATH_NOT_FOUND" | "PATH_UNAVAILABLE",
): Inspection => ({
  availability: unavailable(
    code,
    code === "PATH_NOT_FOUND"
      ? "The registered Project path does not currently exist"
      : "The registered Project path could not be inspected",
    path,
  ),
  canonicalPath: path,
  linkedWorktree: false,
  metadata: emptyMetadata(path),
});

const runGit = async (path: string, ...arguments_: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", "-C", path, ...arguments_], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
};

const gitValue = async (path: string, ...arguments_: ReadonlyArray<string>) => {
  const result = await runGit(path, ...arguments_);
  return result.exitCode === 0 ? result.stdout : undefined;
};

const inspectProjectPath = async (requestedPath: string): Promise<Inspection> => {
  const absolutePath = resolve(requestedPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    return unavailableInspection(
      absolutePath,
      errorCode === "ENOENT" || errorCode === "ENOTDIR" ? "PATH_NOT_FOUND" : "PATH_UNAVAILABLE",
    );
  }

  try {
    if (!(await stat(canonicalPath)).isDirectory()) {
      return {
        availability: unavailable(
          "PATH_NOT_DIRECTORY",
          "The registered Project path is not a directory",
          canonicalPath,
        ),
        canonicalPath,
        linkedWorktree: false,
        metadata: emptyMetadata(canonicalPath),
      };
    }

    const bare = await runGit(canonicalPath, "rev-parse", "--is-bare-repository");
    if (bare.exitCode !== 0) {
      return {
        availability: unavailable(
          "NOT_GIT_REPOSITORY",
          "The registered Project path is not a Git repository",
          canonicalPath,
        ),
        canonicalPath,
        linkedWorktree: false,
        metadata: emptyMetadata(canonicalPath),
      };
    }
    if (bare.stdout === "true") {
      return {
        availability: unavailable(
          "BARE_REPOSITORY",
          "A bare Git repository cannot be registered as a Project",
          canonicalPath,
        ),
        canonicalPath,
        linkedWorktree: false,
        metadata: emptyMetadata(canonicalPath),
      };
    }

    const topLevelValue = await gitValue(canonicalPath, "rev-parse", "--show-toplevel");
    if (topLevelValue === undefined) {
      return {
        availability: unavailable(
          "NOT_GIT_REPOSITORY",
          "The registered Project path is not a Git repository",
          canonicalPath,
        ),
        canonicalPath,
        linkedWorktree: false,
        metadata: emptyMetadata(canonicalPath),
      };
    }
    const topLevel = await realpath(topLevelValue);
    const gitDirectoryValue = await gitValue(
      topLevel,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    );
    const commonDirectoryValue = await gitValue(
      topLevel,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const linkedWorktree =
      gitDirectoryValue !== undefined &&
      commonDirectoryValue !== undefined &&
      (await realpath(gitDirectoryValue)) !== (await realpath(commonDirectoryValue));

    if (canonicalPath !== topLevel) {
      return {
        availability: unavailable(
          "NOT_REPOSITORY_ROOT",
          `The registered path is inside the Git repository rooted at ${topLevel}`,
          canonicalPath,
        ),
        canonicalPath,
        linkedWorktree,
        metadata: emptyMetadata(canonicalPath),
      };
    }

    const remoteNames = (await gitValue(topLevel, "remote"))?.split("\n").filter(Boolean) ?? [];
    const remotes = await Promise.all(
      remoteNames.map(async (name) => ({
        name,
        url: (await gitValue(topLevel, "remote", "get-url", name)) ?? "",
      })),
    );
    const branches =
      (await gitValue(topLevel, "for-each-ref", "--format=%(refname:short)", "refs/heads"))
        ?.split("\n")
        .filter(Boolean) ?? [];

    return {
      availability: linkedWorktree
        ? unavailable(
            "LINKED_WORKTREE",
            "A linked Git worktree is an execution resource and not a Project",
            topLevel,
          )
        : { status: "Available" },
      canonicalPath: topLevel,
      linkedWorktree,
      metadata: {
        branches,
        currentBranch: (await gitValue(topLevel, "symbolic-ref", "--short", "HEAD")) ?? null,
        folderName: basename(topLevel),
        headCommit: (await gitValue(topLevel, "rev-parse", "HEAD")) ?? null,
        remotes,
      },
    };
  } catch {
    return unavailableInspection(canonicalPath, "PATH_UNAVAILABLE");
  }
};

const uuidV7 = () => {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((milliseconds >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const parseMetadata = (stored: StoredProject): ProjectMetadata => {
  try {
    return JSON.parse(stored.metadata) as ProjectMetadata;
  } catch {
    return emptyMetadata(stored.path);
  }
};

export const makeProjectService = (store: SystemStore) => {
  const findByCanonicalPath = async (canonicalPath: string, excludedId?: string) => {
    for (const stored of store.projects.list()) {
      if (stored.id === excludedId) {
        continue;
      }
      if (stored.path === canonicalPath) {
        return stored;
      }
      const existingInspection = await inspectProjectPath(stored.path);
      if (existingInspection.canonicalPath === canonicalPath) {
        return stored;
      }
    }
    return undefined;
  };

  const project = async (stored: StoredProject, refresh: boolean): Promise<Project> => {
    const inspection = await inspectProjectPath(stored.path);
    const metadata =
      inspection.availability.status === "Available" ? inspection.metadata : parseMetadata(stored);
    const refreshed =
      refresh && JSON.stringify(metadata) !== stored.metadata
        ? (store.projects.update(stored.id, { metadata: JSON.stringify(metadata) }) ?? stored)
        : stored;
    return {
      availability: inspection.availability,
      createdAt: refreshed.createdAt,
      id: refreshed.id,
      metadata,
      path: refreshed.path,
      registrationState: refreshed.registrationState,
      updatedAt: refreshed.updatedAt,
    };
  };

  const requireProject = (id: string) => {
    const stored = store.projects.findById(id);
    if (stored === undefined) {
      throw new ProjectOperationError("PROJECT_NOT_FOUND", `Project ${id} was not found`);
    }
    return stored;
  };

  const changeState = async (id: string, registrationState: ProjectRegistrationState) => {
    const stored = requireProject(id);
    if (stored.registrationState === "Archived" && registrationState !== "Archived") {
      throw new ProjectOperationError("PROJECT_ARCHIVED", `Project ${id} is Archived`);
    }
    if (registrationState === "Enabled") {
      const inspected = await project(stored, true);
      if (inspected.availability.status === "Unavailable") {
        throw new ProjectOperationError(
          "PROJECT_UNAVAILABLE",
          `Project ${id} is Unavailable`,
          inspected.availability.reasons,
        );
      }
    }
    const updated = store.projects.update(id, { registrationState });
    if (updated === undefined) {
      throw new ProjectOperationError("PROJECT_NOT_FOUND", `Project ${id} was not found`);
    }
    return project(updated, false);
  };

  return {
    add: async (path: string) => {
      const inspection = await inspectProjectPath(path);
      if (inspection.linkedWorktree) {
        throw new ProjectOperationError(
          "LINKED_WORKTREE_NOT_PROJECT",
          "A linked Git worktree is an execution resource and cannot be registered as a Project",
        );
      }
      if ((await findByCanonicalPath(inspection.canonicalPath)) !== undefined) {
        throw new ProjectOperationError(
          "PROJECT_ALREADY_REGISTERED",
          `Project path ${inspection.canonicalPath} is already registered`,
        );
      }
      const now = new Date().toISOString();
      const stored = store.projects.create({
        createdAt: now,
        id: uuidV7(),
        metadata: JSON.stringify(inspection.metadata),
        path: inspection.canonicalPath,
        registrationState: "Disabled",
        updatedAt: now,
      });
      return project(stored, false);
    },
    archive: (id: string) => changeState(id, "Archived"),
    disable: (id: string) => changeState(id, "Disabled"),
    enable: (id: string) => changeState(id, "Enabled"),
    list: () => Promise.all(store.projects.list().map((stored) => project(stored, true))),
    relink: async (id: string, path: string) => {
      const stored = requireProject(id);
      const inspection = await inspectProjectPath(path);
      if (inspection.linkedWorktree) {
        throw new ProjectOperationError(
          "LINKED_WORKTREE_NOT_PROJECT",
          "A linked Git worktree is an execution resource and cannot be registered as a Project",
        );
      }
      const existing = await findByCanonicalPath(inspection.canonicalPath, id);
      if (existing !== undefined) {
        throw new ProjectOperationError(
          "PROJECT_ALREADY_REGISTERED",
          `Project path ${inspection.canonicalPath} is already registered`,
        );
      }
      const updated = store.projects.update(stored.id, {
        metadata: JSON.stringify(inspection.metadata),
        path: inspection.canonicalPath,
      });
      if (updated === undefined) {
        throw new ProjectOperationError("PROJECT_NOT_FOUND", `Project ${id} was not found`);
      }
      return project(updated, false);
    },
  };
};
