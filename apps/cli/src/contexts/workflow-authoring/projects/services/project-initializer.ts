import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Schema } from "effect";
import { validateProjectDefinition } from "../adapters/subprocess-project-definition-validator";

const CONFIGURATION =
  'import { defineConfig } from "@kojo/workflow";\n\nexport default defineConfig({ workflows: [] });\n';
const IGNORE_RULE = "/.kojo/";

export class ProjectInitializationError extends Error {
  override readonly name = "ProjectInitializationError";
}

interface ExistingPath {
  readonly path: string;
  readonly kind: "directory" | "file";
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const inspectPath = async ({ path, kind }: ExistingPath) => {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink()) {
      throw new ProjectInitializationError(`${path} is a symbolic link; no files were changed.`);
    }
    const matches = kind === "directory" ? information.isDirectory() : information.isFile();
    if (!matches) {
      throw new ProjectInitializationError(
        `${path} is not a regular ${kind}; no files were changed.`,
      );
    }
    const userId = process.getuid?.();
    if (userId !== undefined && information.uid !== userId) {
      throw new ProjectInitializationError(
        `${path} is not owned by the current user; no files were changed.`,
      );
    }
    return information;
  } catch (error) {
    if (error instanceof ProjectInitializationError) throw error;
    if (missing(error)) return undefined;
    throw new ProjectInitializationError(`Kojo could not inspect ${path}; no files were changed.`);
  }
};

const runGit = async (args: ReadonlyArray<string>, cwd: string) => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) return undefined;
  return stdout.trim();
};

export const resolveGitWorkingTreeRoot = async (path: string) => {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch {
    throw new ProjectInitializationError(`${path} does not resolve to an existing path.`);
  }
  const information = await stat(canonicalPath);
  const directory = information.isDirectory() ? canonicalPath : undefined;
  if (directory === undefined) {
    throw new ProjectInitializationError(`${path} is not inside a non-bare Git working tree.`);
  }
  const [inside, bare, root] = await Promise.all([
    runGit(["rev-parse", "--is-inside-work-tree"], directory),
    runGit(["rev-parse", "--is-bare-repository"], directory),
    runGit(["rev-parse", "--show-toplevel"], directory),
  ]);
  if (inside !== "true" || bare !== "false" || root === undefined) {
    throw new ProjectInitializationError(`${path} is not inside a non-bare Git working tree.`);
  }
  return realpath(root);
};

export const resolveInitializedProject = async (path: string): Promise<ProjectSnapshot> => {
  const root = await resolveGitWorkingTreeRoot(path);
  const metadataPath = join(root, ".kojo", "project.json");
  const metadata = await inspectPath({ path: metadataPath, kind: "file" });
  if (metadata === undefined) {
    throw new ProjectInitializationError(`${root} is not an initialized Kojo Project.`);
  }
  return { identity: await readProjectIdentity(metadataPath), path: root };
};

const hasProjectLocalIgnoreRule = async (root: string, ignorePath: string) => {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.excludesFile=/dev/null",
      "-C",
      root,
      "check-ignore",
      "--no-index",
      "-v",
      ".kojo/.ignore-check",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) return false;
  const source = output.slice(0, output.indexOf(":"));
  return source === ".gitignore" || source === ignorePath;
};

const readProjectIdentity = async (metadataPath: string) => {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.layoutVersion !== 1) throw new Error("unsupported layout");
    return Schema.decodeUnknownSync(ProjectIdentity)(metadata.projectIdentity);
  } catch {
    throw new ProjectInitializationError(
      `${metadataPath} does not contain valid Kojo Project metadata; no files were changed.`,
    );
  }
};

const writeNewFileAtomically = async (path: string, contents: string, mode: number) => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await chmod(temporaryPath, mode);
    await link(temporaryPath, path);
    await unlink(temporaryPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const appendIgnoreRule = async (path: string) => {
  const handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const information = await handle.stat();
    const userId = process.getuid?.();
    if (!information.isFile() || (userId !== undefined && information.uid !== userId)) {
      throw new ProjectInitializationError(
        `${path} changed while it was being checked; no ignore rule was added.`,
      );
    }
    const existing = await handle.readFile({ encoding: "utf8" });
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await handle.write(`${separator}${IGNORE_RULE}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createDatabase = async (path: string) => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const database = new Database(temporaryPath, { create: true, strict: true });
    database.exec("PRAGMA user_version = 0");
    database.close();
    await chmod(temporaryPath, 0o600);
    await link(temporaryPath, path);
    await unlink(temporaryPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const validateDatabase = (path: string) => {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const check = database.query("PRAGMA quick_check").get() as
      | { readonly quick_check: string }
      | undefined;
    const version = database.query("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    if (check?.quick_check !== "ok" || version?.user_version !== 0) {
      throw new Error("unsupported database state");
    }
  } finally {
    database.close();
  }
};

export const initializeProject = async (path: string): Promise<ProjectSnapshot> => {
  const root = await resolveGitWorkingTreeRoot(path);
  const configurationPath = join(root, "kojo.config.ts");
  const ignorePath = join(root, ".gitignore");
  const dataPath = join(root, ".kojo");
  const metadataPath = join(dataPath, "project.json");
  const databasePath = join(dataPath, "kojo.sqlite");
  const artifactsPath = join(dataPath, "artifacts");
  const sandboxesPath = join(dataPath, "sandboxes");

  const [configuration, ignore, data, metadata, database, artifacts, sandboxes] = await Promise.all(
    [
      inspectPath({ path: configurationPath, kind: "file" }),
      inspectPath({ path: ignorePath, kind: "file" }),
      inspectPath({ path: dataPath, kind: "directory" }),
      inspectPath({ path: metadataPath, kind: "file" }),
      inspectPath({ path: databasePath, kind: "file" }),
      inspectPath({ path: artifactsPath, kind: "directory" }),
      inspectPath({ path: sandboxesPath, kind: "directory" }),
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

  if (database !== undefined) {
    try {
      validateDatabase(databasePath);
    } catch {
      throw new ProjectInitializationError(
        `${databasePath} Project database is invalid or needs migration; no files were changed.`,
      );
    }
  }

  const ignoreRuleExists =
    ignore !== undefined && (await hasProjectLocalIgnoreRule(root, ignorePath));
  const needsRootWrite =
    configuration === undefined || ignore === undefined || !ignoreRuleExists || data === undefined;
  try {
    if (needsRootWrite) await access(root, constants.W_OK);
    if (
      data !== undefined &&
      [metadata, database, artifacts, sandboxes].some((item) => item === undefined)
    ) {
      await access(dataPath, constants.W_OK);
    }
  } catch {
    throw new ProjectInitializationError(
      `${root} cannot be changed safely; no files were changed.`,
    );
  }

  let identity: ProjectSnapshot["identity"];
  if (metadata === undefined) {
    identity = Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7());
  } else {
    identity = await readProjectIdentity(metadataPath);
  }

  try {
    if (configuration === undefined) {
      await writeNewFileAtomically(configurationPath, CONFIGURATION, 0o644);
    }
    if (ignore === undefined) {
      await writeNewFileAtomically(ignorePath, `${IGNORE_RULE}\n`, 0o644);
    } else if (!ignoreRuleExists) {
      await appendIgnoreRule(ignorePath);
    }
    if (data === undefined) await mkdir(dataPath, { mode: 0o700 });
    await chmod(dataPath, 0o700);
    if (metadata === undefined) {
      await writeNewFileAtomically(
        metadataPath,
        `${JSON.stringify({ layoutVersion: 1, projectIdentity: identity }, null, 2)}\n`,
        0o600,
      );
      await createDatabase(databasePath);
    }
    await chmod(metadataPath, 0o600);
    await chmod(databasePath, 0o600);
    if (artifacts === undefined) await mkdir(artifactsPath, { mode: 0o700 });
    if (data === undefined) await mkdir(sandboxesPath, { mode: 0o700 });
    await chmod(artifactsPath, 0o700);
    await chmod(sandboxesPath, 0o700);
  } catch {
    throw new ProjectInitializationError(
      `Kojo could not finish initializing ${root}. Review the Project layout before trying again.`,
    );
  }

  const validation = await validateProjectDefinition(configurationPath);
  if (!validation.ok) {
    throw new ProjectInitializationError(
      `${configurationPath} ${validation.message} The safe Project layout remains in place; fix this needs-attention finding and retry kojo init.`,
    );
  }

  return { identity, path: root };
};
