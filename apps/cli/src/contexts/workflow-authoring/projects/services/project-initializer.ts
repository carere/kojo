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
import {
  initializeProjectWith,
  ProjectInitializationError,
  type ProjectInitializationPlatform,
} from "../use-cases/initialize-project";
import { validateProjectDefinition } from "./subprocess-project-definition-validator";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const inspectPath = async (path: string, kind: "directory" | "file") => {
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
  if (!information.isDirectory()) {
    throw new ProjectInitializationError(`${path} is not inside a non-bare Git working tree.`);
  }
  const [inside, bare, root] = await Promise.all([
    runGit(["rev-parse", "--is-inside-work-tree"], canonicalPath),
    runGit(["rev-parse", "--is-bare-repository"], canonicalPath),
    runGit(["rev-parse", "--show-toplevel"], canonicalPath),
  ]);
  if (inside !== "true" || bare !== "false" || root === undefined) {
    throw new ProjectInitializationError(`${path} is not inside a non-bare Git working tree.`);
  }
  return realpath(root);
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

export const resolveInitializedProject = async (path: string): Promise<ProjectSnapshot> => {
  const root = await resolveGitWorkingTreeRoot(path);
  const metadataPath = join(root, ".kojo", "project.json");
  if ((await inspectPath(metadataPath, "file")) === undefined) {
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

const writeNewFile = async (path: string, contents: string, mode: number) => {
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

const appendIgnoreRule = async (path: string, rule: string) => {
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
    await handle.write(`${separator}${rule}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createDatabase = async (path: string, identity: ProjectSnapshot["identity"]) => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const database = new Database(temporaryPath, { create: true, strict: true });
    database.exec(`CREATE TABLE kojo_project_store_identity (
      singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
      project_identity TEXT NOT NULL UNIQUE,
      database_instance_id TEXT NOT NULL UNIQUE
    ) STRICT`);
    database
      .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
      .run(identity, randomUUID());
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

const validateDatabase = (path: string, identity: ProjectSnapshot["identity"]) => {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const check = database.query("PRAGMA quick_check").get() as
      | { readonly quick_check: string }
      | undefined;
    const version = database.query("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    const userObjects = database
      .query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as ReadonlyArray<{ readonly name: string }>;
    const bootstrap =
      version?.user_version === 0 &&
      userObjects.length === 1 &&
      userObjects[0]?.name === "kojo_project_store_identity"
        ? (database
            .query(
              "SELECT project_identity, database_instance_id FROM kojo_project_store_identity WHERE singleton_key = 1",
            )
            .get() as
            | { readonly database_instance_id: string; readonly project_identity: string }
            | undefined)
        : undefined;
    const metadata =
      version?.user_version === 0
        ? undefined
        : (database
            .query(
              "SELECT project_identity, store_format_version FROM kojo_store_metadata WHERE singleton_key = 1",
            )
            .get() as
            | { readonly project_identity: string; readonly store_format_version: number }
            | undefined);
    if (
      check?.quick_check !== "ok" ||
      ![0, 1, 2].includes(version?.user_version ?? -1) ||
      (version?.user_version === 0
        ? userObjects.length !== 1 ||
          bootstrap?.project_identity !== identity ||
          bootstrap.database_instance_id.length === 0
        : metadata?.project_identity !== identity ||
          metadata.store_format_version !== version?.user_version)
    ) {
      throw new Error("unsupported database state");
    }
  } finally {
    database.close();
  }
};

const platform: ProjectInitializationPlatform = {
  appendIgnoreRule,
  canWrite: (path) => access(path, constants.W_OK),
  createDatabase,
  createDirectory: (path, mode) => mkdir(path, { mode }).then(() => undefined),
  enforceMode: chmod,
  generateIdentity: () => Bun.randomUUIDv7(),
  hasProjectLocalIgnoreRule,
  inspectPath,
  readProjectIdentity,
  resolveGitWorkingTreeRoot,
  validateDatabase,
  validateProjectDefinition,
  writeNewFile,
};

export const initializeProject = (path: string) => initializeProjectWith(platform, path);
export { ProjectInitializationError };
