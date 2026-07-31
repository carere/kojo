import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { ProjectIdentity } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  InvalidProjectLayoutError,
  type ProjectLayoutPlatform,
  validateProjectLayout,
} from "../use-cases/validate-project-layout";
import {
  ProjectDefinitionLoader,
  type ProjectDefinitionLoaderShape,
} from "./project-definition-loader";
import { ProjectLayout, type ProjectLayoutShape } from "./project-layout";

const inspect = async (path: string, kind: "directory" | "file", mode?: number) => {
  const link = await lstat(path);
  if (link.isSymbolicLink()) {
    throw new InvalidProjectLayoutError(
      "A Kojo-owned Project path is a symbolic link.",
      "layout.symbolic-link",
    );
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const information = await handle.stat();
    const matches = kind === "directory" ? information.isDirectory() : information.isFile();
    const userId = process.getuid?.();
    if (!matches)
      throw new InvalidProjectLayoutError(
        "A Kojo-owned Project path has an unsupported file kind.",
        "layout.path-conflict",
      );
    if (userId !== undefined && information.uid !== userId)
      throw new InvalidProjectLayoutError(
        "A Kojo-owned Project path is not owned by the current user.",
        "layout.owner-invalid",
      );
    if (mode !== undefined && (information.mode & 0o777) !== mode) {
      try {
        await handle.chmod(mode);
      } catch {
        throw new InvalidProjectLayoutError(
          "Kojo could not tighten permissions on an owned Project path.",
          "layout.permissions-invalid",
        );
      }
      const repaired = await handle.stat();
      if (
        repaired.dev !== information.dev ||
        repaired.ino !== information.ino ||
        (repaired.mode & 0o777) !== mode
      ) {
        throw new InvalidProjectLayoutError(
          "Kojo could not tighten permissions on an owned Project path.",
          "layout.permissions-invalid",
        );
      }
      return "permissions-tightened" as const;
    }
    return undefined;
  } finally {
    await handle.close();
  }
};

const git = async (path: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new InvalidProjectLayoutError();
  return stdout.trim();
};

const hasIgnoreRule = async (root: string) => {
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
      ".kojo/.index-check",
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
  return source === ".gitignore" || source === join(root, ".gitignore");
};

const readIdentity = async (root: string) => {
  const metadataPath = join(root, ".kojo", "project.json");
  await inspect(metadataPath, "file", 0o600);
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.layoutVersion !== 1) {
      throw new InvalidProjectLayoutError(
        "The Project layout version is not supported by this Kojo Host.",
        "layout.version-unsupported",
      );
    }
    return Schema.decodeUnknownSync(ProjectIdentity)(metadata.projectIdentity);
  } catch (error) {
    if (error instanceof InvalidProjectLayoutError) throw error;
    throw new InvalidProjectLayoutError(
      "The Project Identity metadata is invalid.",
      "layout.metadata-invalid",
    );
  }
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const inspectMissing = async (path: string) => {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
};

const writeNewFile = async (path: string, contents: string, mode: number) => {
  const temporary = `${path}.${crypto.randomUUID()}.repair`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await link(temporary, path);
    await unlink(temporary);
    return true;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

const replaceOwnedFile = async (path: string, contents: string, mode: number) => {
  await inspect(path, "file", mode);
  const temporary = `${path}.${crypto.randomUUID()}.repair`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    return true;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const createDatabase = async (path: string, identity: string) => {
  const temporary = `${path}.${crypto.randomUUID()}.repair`;
  try {
    const database = new Database(temporary, { create: true, strict: true });
    database.exec(`CREATE TABLE kojo_project_store_identity (
      singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
      project_identity TEXT NOT NULL UNIQUE,
      database_instance_id TEXT NOT NULL UNIQUE
    ) STRICT`);
    database
      .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
      .run(identity, crypto.randomUUID());
    database.exec("PRAGMA user_version = 0");
    database.close();
    const handle = await open(temporary, "r");
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
    await unlink(temporary);
    return true;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

const addIgnoreRule = async (project: { readonly path: string }) => {
  const path = join(project.path, ".gitignore");
  if (await hasIgnoreRule(project.path)) return false;
  const handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const information = await handle.stat();
    const userId = process.getuid?.();
    if (!information.isFile() || (userId !== undefined && information.uid !== userId)) return false;
    const contents = await handle.readFile({ encoding: "utf8" });
    await handle.write(`${contents.length === 0 || contents.endsWith("\n") ? "" : "\n"}/.kojo/\n`);
    await handle.sync();
    return await hasIgnoreRule(project.path);
  } finally {
    await handle.close();
  }
};

const assignNewIdentity = async (project: { readonly identity: string; readonly path: string }) => {
  const metadataPath = join(project.path, ".kojo", "project.json");
  const databasePath = join(project.path, ".kojo", "kojo.sqlite");
  try {
    await inspect(metadataPath, "file", 0o600);
    await inspect(databasePath, "file", 0o600);
    if ((await readIdentity(project.path)) !== project.identity) return undefined;
    const identity = Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7());
    const database = new Database(databasePath, { strict: true });
    try {
      database.exec("BEGIN IMMEDIATE");
      const current = database.query("PRAGMA user_version").get() as {
        readonly user_version: number;
      };
      if (current.user_version === 0) {
        database
          .query(
            "UPDATE kojo_project_store_identity SET project_identity = ? WHERE singleton_key = 1",
          )
          .run(identity);
      } else {
        database
          .query("UPDATE kojo_store_metadata SET project_identity = ? WHERE singleton_key = 1")
          .run(identity);
      }
      await replaceOwnedFile(
        metadataPath,
        `${JSON.stringify({ layoutVersion: 1, projectIdentity: identity })}\n`,
        0o600,
      );
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // SQLite can have already rolled the failed transaction back.
      }
      throw error;
    } finally {
      database.close();
    }
    return { identity, path: project.path };
  } catch {
    return undefined;
  }
};

const replaceMissingData = async (project: {
  readonly identity: string;
  readonly path: string;
}) => {
  try {
    const root = await realpath(project.path);
    if (root !== project.path) return false;
    const kojoPath = join(root, ".kojo");
    await inspect(kojoPath, "directory", 0o700);
    const metadataPath = join(kojoPath, "project.json");
    const databasePath = join(kojoPath, "kojo.sqlite");
    const metadataMissing = await inspectMissing(metadataPath);
    const databaseMissing = await inspectMissing(databasePath);
    if (!metadataMissing && !databaseMissing) return false;
    if (metadataMissing) {
      if (
        !(await writeNewFile(
          metadataPath,
          `${JSON.stringify({ layoutVersion: 1, projectIdentity: project.identity })}\n`,
          0o600,
        ))
      ) {
        return false;
      }
    } else if ((await readIdentity(root)) !== project.identity) {
      return false;
    }
    if (databaseMissing && !(await createDatabase(databasePath, project.identity))) return false;
    for (const name of ["artifacts", "sandboxes"]) {
      const path = join(kojoPath, name);
      if (await inspectMissing(path)) await mkdir(path, { mode: 0o700 });
      await inspect(path, "directory", 0o700);
    }
    return true;
  } catch {
    return false;
  }
};

const recreateMissingDirectory = async (
  project: { readonly path: string },
  name: "artifacts" | "sandboxes",
) => {
  try {
    const root = await realpath(project.path);
    if (root !== project.path) return false;
    const kojoPath = join(root, ".kojo");
    await inspect(kojoPath, "directory", 0o700);
    const path = join(kojoPath, name);
    if (!(await inspectMissing(path))) return false;
    await mkdir(path, { mode: 0o700 });
    await inspect(path, "directory", 0o700);
    return true;
  } catch {
    return false;
  }
};

const validateDatabase = (path: string) => {
  let database: Database;
  try {
    database = new Database(path, { readonly: true, strict: true });
  } catch {
    throw new InvalidProjectLayoutError(
      "The Project database could not be opened safely.",
      "store.open-failed",
    );
  }
  try {
    const check = database.query("PRAGMA quick_check").get() as
      | { readonly quick_check: string }
      | undefined;
    const version = database.query("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    if (check?.quick_check !== "ok") {
      throw new InvalidProjectLayoutError(
        "The Project database integrity check failed.",
        "store.integrity-failed",
      );
    }
    if ((version?.user_version ?? -1) > 2) {
      throw new InvalidProjectLayoutError(
        "The Project database was created by a newer Kojo version.",
        "store.version-unsupported",
      );
    }
    if (![0, 1, 2].includes(version?.user_version ?? -1)) {
      throw new InvalidProjectLayoutError(
        "The Project database is invalid.",
        "store.integrity-failed",
      );
    }
  } finally {
    database.close();
  }
};

const platform: ProjectLayoutPlatform = {
  canonicalDirectory: async (path) => {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new InvalidProjectLayoutError();
    return canonical;
  },
  gitWorkingTree: async (path) => {
    const [inside, bare, root] = await Promise.all([
      git(path, ["rev-parse", "--is-inside-work-tree"]),
      git(path, ["rev-parse", "--is-bare-repository"]),
      git(path, ["rev-parse", "--show-toplevel"]),
    ]);
    return { inside, bare, root };
  },
  hasIgnoreRule,
  inspect,
  readIdentity,
  validateDatabase,
};

export const makeGitProjectLayout = (
  definitions: ProjectDefinitionLoaderShape,
): ProjectLayoutShape => ({
  validate: (path) => Effect.promise(() => validateProjectLayout(platform, path, definitions)),
  addIgnoreRule: (project) => Effect.promise(() => addIgnoreRule(project)),
  assignNewIdentity: (project) => Effect.promise(() => assignNewIdentity(project)),
  replaceMissingData: (project) => Effect.promise(() => replaceMissingData(project)),
  recreateArtifacts: (project) =>
    Effect.promise(() => recreateMissingDirectory(project, "artifacts")),
  recreateEmptySandboxes: (project) =>
    Effect.promise(() => recreateMissingDirectory(project, "sandboxes")),
  inspectIndexedPath: (path) =>
    Effect.promise(async () => {
      try {
        await lstat(path);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { status: "missing" as const }
          : { status: "invalid" as const };
      }
      try {
        return { status: "valid" as const, identity: await readIdentity(path) };
      } catch {
        return { status: "invalid" as const };
      }
    }),
});

export const GitProjectLayoutLive = Layer.effect(
  ProjectLayout,
  Effect.map(ProjectDefinitionLoader, makeGitProjectLayout),
);
