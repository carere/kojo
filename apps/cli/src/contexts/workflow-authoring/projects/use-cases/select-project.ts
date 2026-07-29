import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { ProjectIdentity as ProjectIdentitySchema, type ProjectSnapshot } from "@kojo/control";
import { Schema } from "effect";

export interface ProjectSelection {
  readonly projectId?: string;
  readonly projectPath?: string;
}

export interface ProjectSelectionFailure {
  readonly code: "invalid-command" | "project-not-found";
  readonly exitCode: 2 | 4;
  readonly message: string;
  readonly next: string;
}

export const selectProject = async (
  projects: ReadonlyArray<ProjectSnapshot>,
  selection: ProjectSelection,
): Promise<ProjectSnapshot | ProjectSelectionFailure> => {
  if (selection.projectId !== undefined) {
    try {
      const identity = Schema.decodeUnknownSync(ProjectIdentitySchema)(selection.projectId);
      const project = projects.find((candidate) => candidate.identity === identity);
      return (
        project ?? {
          code: "project-not-found",
          exitCode: 4,
          message: "Kojo Project was not found in the Project Index.",
          next: "Register the Project or choose a listed Project Identity.",
        }
      );
    } catch {
      return {
        code: "invalid-command",
        exitCode: 2,
        message: "Invalid command.",
        next: "Use a full Project Identity from kojo project list.",
      };
    }
  }

  let path: string;
  try {
    path = await realpath(selection.projectPath ?? process.cwd());
  } catch {
    return {
      code: "project-not-found",
      exitCode: 4,
      message: "Kojo Project could not be inferred from this path.",
      next: "Use --project or --project-id, or register the Project.",
    };
  }
  const matches = projects
    .filter((project) => path === project.path || path.startsWith(`${project.path}${sep}`))
    .sort((left, right) => right.path.length - left.path.length);
  return (
    matches[0] ?? {
      code: "project-not-found",
      exitCode: 4,
      message: "Kojo Project could not be inferred from this path.",
      next: "Use --project or --project-id, or register the Project.",
    }
  );
};
