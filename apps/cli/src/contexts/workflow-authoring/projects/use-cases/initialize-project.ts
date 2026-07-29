import { join } from "node:path";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Schema } from "effect";

const CONFIGURATION =
  'import { defineConfig } from "@kojo/workflow";\n\nexport default defineConfig({ workflows: [] });\n';
const IGNORE_RULE = "/.kojo/";

export class ProjectInitializationError extends Error {
  override readonly name = "ProjectInitializationError";

  constructor(
    message: string,
    readonly layoutMutated = false,
  ) {
    super(message);
  }
}

export interface ProjectInitializationPlatform {
  readonly appendIgnoreRule: (path: string, rule: string) => Promise<void>;
  readonly canWrite: (path: string) => Promise<void>;
  readonly createDatabase: (path: string, identity: ProjectSnapshot["identity"]) => Promise<void>;
  readonly createDirectory: (path: string, mode: number) => Promise<void>;
  readonly enforceMode: (path: string, mode: number) => Promise<void>;
  readonly generateIdentity: () => string;
  readonly hasProjectLocalIgnoreRule: (root: string, ignorePath: string) => Promise<boolean>;
  readonly inspectPath: (
    path: string,
    kind: "directory" | "file",
  ) => Promise<{ readonly mode: number } | undefined>;
  readonly readProjectIdentity: (metadataPath: string) => Promise<ProjectSnapshot["identity"]>;
  readonly resolveGitWorkingTreeRoot: (path: string) => Promise<string>;
  readonly validateDatabase: (path: string, identity: ProjectSnapshot["identity"]) => void;
  readonly validateProjectDefinition: (
    path: string,
  ) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly writeNewFile: (path: string, contents: string, mode: number) => Promise<void>;
}

export const initializeProjectWith = async (
  platform: ProjectInitializationPlatform,
  path: string,
): Promise<ProjectSnapshot> => {
  const root = await platform.resolveGitWorkingTreeRoot(path);
  const configurationPath = join(root, "kojo.config.ts");
  const ignorePath = join(root, ".gitignore");
  const dataPath = join(root, ".kojo");
  const metadataPath = join(dataPath, "project.json");
  const databasePath = join(dataPath, "kojo.sqlite");
  const artifactsPath = join(dataPath, "artifacts");
  const sandboxesPath = join(dataPath, "sandboxes");

  const [configuration, ignore, data, metadata, database, artifacts, sandboxes] = await Promise.all(
    [
      platform.inspectPath(configurationPath, "file"),
      platform.inspectPath(ignorePath, "file"),
      platform.inspectPath(dataPath, "directory"),
      platform.inspectPath(metadataPath, "file"),
      platform.inspectPath(databasePath, "file"),
      platform.inspectPath(artifactsPath, "directory"),
      platform.inspectPath(sandboxesPath, "directory"),
    ],
  );

  if (data !== undefined && (metadata === undefined || database === undefined)) {
    throw new ProjectInitializationError(
      `${dataPath} is an existing layout with missing durable Project data; use the explicit missing-data repair after reviewing it.`,
    );
  }
  if (data === undefined && [metadata, database, artifacts, sandboxes].some(Boolean)) {
    throw new ProjectInitializationError(
      `${dataPath} has a conflicting layout; no files were changed.`,
    );
  }
  if (data !== undefined && configuration === undefined) {
    throw new ProjectInitializationError(
      `${configurationPath} is missing from an existing Kojo Project; restore the developer configuration before retrying.`,
    );
  }
  if (data !== undefined && sandboxes === undefined) {
    throw new ProjectInitializationError(
      `${sandboxesPath} is missing from an existing Kojo Project; Kojo cannot prove that no non-final Workflow Run needs it.`,
    );
  }

  const identity =
    metadata === undefined
      ? Schema.decodeUnknownSync(ProjectIdentity)(platform.generateIdentity())
      : await platform.readProjectIdentity(metadataPath);
  if (database !== undefined) {
    try {
      platform.validateDatabase(databasePath, identity);
    } catch {
      throw new ProjectInitializationError(
        `${databasePath} Project database is invalid or needs migration; no files were changed.`,
      );
    }
  }

  const ignoreRuleExists =
    ignore !== undefined && (await platform.hasProjectLocalIgnoreRule(root, ignorePath));
  const needsRootWrite =
    configuration === undefined || ignore === undefined || !ignoreRuleExists || data === undefined;
  try {
    if (needsRootWrite) await platform.canWrite(root);
    if (
      data !== undefined &&
      [metadata, database, artifacts, sandboxes].some((item) => item === undefined)
    ) {
      await platform.canWrite(dataPath);
    }
  } catch {
    throw new ProjectInitializationError(
      `${root} cannot be changed safely; no files were changed.`,
    );
  }

  let layoutMutated = false;
  const enforceMode = async (
    target: string,
    information: { readonly mode: number } | undefined,
    mode: number,
  ) => {
    await platform.enforceMode(target, mode);
    if (information !== undefined && (information.mode & 0o777) !== mode) layoutMutated = true;
  };
  try {
    if (configuration === undefined) {
      await platform.writeNewFile(configurationPath, CONFIGURATION, 0o644);
      layoutMutated = true;
    }
    if (ignore === undefined) {
      await platform.writeNewFile(ignorePath, `${IGNORE_RULE}\n`, 0o644);
      layoutMutated = true;
    } else if (!ignoreRuleExists) {
      await platform.appendIgnoreRule(ignorePath, IGNORE_RULE);
      layoutMutated = true;
    }
    if (data === undefined) {
      await platform.createDirectory(dataPath, 0o700);
      layoutMutated = true;
    }
    await enforceMode(dataPath, data, 0o700);
    if (metadata === undefined) {
      await platform.writeNewFile(
        metadataPath,
        `${JSON.stringify({ layoutVersion: 1, projectIdentity: identity }, null, 2)}\n`,
        0o600,
      );
      layoutMutated = true;
      await platform.createDatabase(databasePath, identity);
      layoutMutated = true;
    }
    await enforceMode(metadataPath, metadata, 0o600);
    await enforceMode(databasePath, database, 0o600);
    if (artifacts === undefined) {
      await platform.createDirectory(artifactsPath, 0o700);
      layoutMutated = true;
    }
    if (data === undefined) {
      await platform.createDirectory(sandboxesPath, 0o700);
      layoutMutated = true;
    }
    await enforceMode(artifactsPath, artifacts, 0o700);
    await enforceMode(sandboxesPath, sandboxes, 0o700);
  } catch {
    throw new ProjectInitializationError(
      `Kojo could not finish initializing ${root}. Review the Project layout before trying again.`,
      layoutMutated,
    );
  }

  const validation = await platform.validateProjectDefinition(configurationPath);
  if (!validation.ok) {
    throw new ProjectInitializationError(
      `${configurationPath} ${validation.message ?? "is invalid."} The safe Project layout remains in place; fix this needs-attention finding and retry kojo init.`,
      layoutMutated,
    );
  }
  return { identity, path: root };
};
