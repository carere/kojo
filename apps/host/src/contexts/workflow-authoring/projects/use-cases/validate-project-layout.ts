import { join } from "node:path";
import type { ProjectSnapshot, ReadinessFindingKey } from "@kojo/control";
import type { ProjectDefinitionLoaderShape } from "../services/project-definition-loader";
import type { ProjectLayoutRepair, ProjectLayoutValidation } from "../services/project-layout";

export class InvalidProjectLayoutError extends Error {
  constructor(
    message = "The path is not a safe initialized Kojo Project.",
    readonly findingKey: ReadinessFindingKey = "layout.metadata-invalid",
  ) {
    super(message);
  }
}

export interface ProjectLayoutPlatform {
  readonly canonicalDirectory: (path: string) => Promise<string>;
  readonly gitWorkingTree: (
    path: string,
  ) => Promise<{ readonly bare: string; readonly inside: string; readonly root: string }>;
  readonly hasIgnoreRule: (root: string) => Promise<boolean>;
  readonly inspect: (
    path: string,
    kind: "directory" | "file",
    mode?: number,
  ) => Promise<undefined | "permissions-tightened">;
  readonly readIdentity: (root: string) => Promise<ProjectSnapshot["identity"]>;
  readonly validateDatabase: (path: string) => void;
}

export const validateProjectLayout = async (
  platform: ProjectLayoutPlatform,
  path: string,
  definitions: ProjectDefinitionLoaderShape,
): Promise<ProjectLayoutValidation> => {
  try {
    const canonicalInput = await platform.canonicalDirectory(path);
    const git = await platform.gitWorkingTree(canonicalInput);
    if (git.inside !== "true" || git.bare !== "false") throw new InvalidProjectLayoutError();
    const root = await platform.canonicalDirectory(git.root);
    const layoutFindings: Array<{
      readonly findingKey: ReadinessFindingKey;
      readonly message: string;
    }> = [];
    const repairs: Array<ProjectLayoutRepair> = [];
    const inspect = async (
      target: string,
      kind: "directory" | "file",
      findingKey: ReadinessFindingKey,
      message: string,
      mode?: number,
    ) => {
      try {
        const outcome = await platform.inspect(target, kind, mode);
        if (outcome === "permissions-tightened") {
          repairs.push({
            code: "layout.permissions-tightened",
            path: target,
            summary: "Kojo tightened permissions on a safely owned Project path.",
          });
        }
        return true;
      } catch (error) {
        layoutFindings.push({
          findingKey: error instanceof InvalidProjectLayoutError ? error.findingKey : findingKey,
          message: error instanceof InvalidProjectLayoutError ? error.message : message,
        });
        return false;
      }
    };
    const [, kojoDirectory, database, artifacts, sandboxes, metadata] = await Promise.all([
      inspect(
        join(root, ".gitignore"),
        "file",
        "layout.metadata-invalid",
        "The Project .gitignore file is not safe.",
      ),
      inspect(
        join(root, ".kojo"),
        "directory",
        "layout.path-conflict",
        "The Project .kojo path is not a safe directory.",
        0o700,
      ),
      inspect(
        join(root, ".kojo", "kojo.sqlite"),
        "file",
        "store.missing",
        "The Project database is missing or unsafe.",
        0o600,
      ),
      inspect(
        join(root, ".kojo", "artifacts"),
        "directory",
        "layout.path-conflict",
        "The Project artifacts path is not a safe directory.",
        0o700,
      ),
      inspect(
        join(root, ".kojo", "sandboxes"),
        "directory",
        "layout.path-conflict",
        "The Project sandboxes path is not a safe directory.",
        0o700,
      ),
      inspect(
        join(root, ".kojo", "project.json"),
        "file",
        "project.identity-missing",
        "The Project Identity metadata is missing or unsafe.",
        0o600,
      ),
    ]);
    const definitionValidation = await definitions.load(join(root, "kojo.config.ts"));
    let project: ProjectSnapshot | undefined;
    if (metadata) {
      try {
        project = { identity: await platform.readIdentity(root), path: root };
      } catch (error) {
        layoutFindings.push({
          findingKey:
            error instanceof InvalidProjectLayoutError
              ? error.findingKey
              : "layout.metadata-invalid",
          message: error instanceof Error ? error.message : "Project Identity metadata is invalid.",
        });
      }
    }
    if (database) {
      try {
        platform.validateDatabase(join(root, ".kojo", "kojo.sqlite"));
      } catch (error) {
        layoutFindings.push({
          findingKey:
            error instanceof InvalidProjectLayoutError
              ? error.findingKey
              : "store.integrity-failed",
          message:
            error instanceof Error
              ? error.message
              : "The Project database could not be verified safely.",
        });
      }
    }
    if (!(await platform.hasIgnoreRule(root))) {
      layoutFindings.push({
        findingKey: "layout.ignore-rule-missing",
        message: "The Project-local /.kojo/ ignore rule is missing.",
      });
    }
    if (layoutFindings.length > 0) {
      const first = layoutFindings[0] as (typeof layoutFindings)[number];
      return {
        ok: false,
        message: first.message,
        findingKey: first.findingKey,
        findings: layoutFindings,
        definitions: definitionValidation,
        ...(project === undefined ? {} : { project }),
        ...(repairs.length === 0 ? {} : { repairs }),
      };
    }
    if (project === undefined || !kojoDirectory || !artifacts || !sandboxes) {
      throw new InvalidProjectLayoutError();
    }
    return {
      ok: true,
      project,
      definitions: definitionValidation,
      ...(repairs.length === 0 ? {} : { repairs }),
    };
  } catch (error) {
    if (error instanceof InvalidProjectLayoutError) {
      return { ok: false, message: error.message, findingKey: error.findingKey };
    }
    return {
      ok: false,
      message: "The path is not a safe initialized Kojo Project.",
      findingKey: "layout.metadata-invalid",
    };
  }
};
