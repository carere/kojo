import { join } from "node:path";
import type { ProjectSnapshot, ReadinessFindingKey } from "@kojo/control";
import type { ProjectDefinitionLoaderShape } from "../services/project-definition-loader";
import type { ProjectLayoutValidation } from "../services/project-layout";

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
  readonly inspect: (path: string, kind: "directory" | "file", mode?: number) => Promise<void>;
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
    await Promise.all([
      platform.inspect(join(root, ".gitignore"), "file"),
      platform.inspect(join(root, ".kojo"), "directory", 0o700),
      platform.inspect(join(root, ".kojo", "kojo.sqlite"), "file", 0o600),
      platform.inspect(join(root, ".kojo", "artifacts"), "directory", 0o700),
      platform.inspect(join(root, ".kojo", "sandboxes"), "directory", 0o700),
    ]);
    const definitionValidation = await definitions.load(join(root, "kojo.config.ts"));
    const configurationMissing =
      !definitionValidation.ok &&
      definitionValidation.findings.some(
        (finding) => finding.findingKey === "configuration.missing",
      );
    if (!configurationMissing) {
      await platform.inspect(join(root, "kojo.config.ts"), "file");
    }
    platform.validateDatabase(join(root, ".kojo", "kojo.sqlite"));
    if (!(await platform.hasIgnoreRule(root))) {
      return {
        ok: false,
        message: "The Project-local /.kojo/ ignore rule is missing.",
        findingKey: "layout.ignore-rule-missing",
      };
    }
    return {
      ok: true,
      project: { identity: await platform.readIdentity(root), path: root },
      definitions: definitionValidation,
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
