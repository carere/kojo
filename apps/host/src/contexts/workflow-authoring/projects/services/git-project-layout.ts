import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
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
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const information = await handle.stat();
    const matches = kind === "directory" ? information.isDirectory() : information.isFile();
    const userId = process.getuid?.();
    if (!matches || (userId !== undefined && information.uid !== userId)) {
      throw new InvalidProjectLayoutError();
    }
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
    }
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
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (metadata.layoutVersion !== 1) throw new InvalidProjectLayoutError();
  return Schema.decodeUnknownSync(ProjectIdentity)(metadata.projectIdentity);
};

const validateDatabase = (path: string) => {
  try {
    const database = new Database(path, { readonly: true, strict: true });
    try {
      const check = database.query("PRAGMA quick_check").get() as
        | { readonly quick_check: string }
        | undefined;
      const version = database.query("PRAGMA user_version").get() as
        | { readonly user_version: number }
        | undefined;
      if (check?.quick_check !== "ok" || ![0, 1, 2].includes(version?.user_version ?? -1)) {
        throw new Error();
      }
    } finally {
      database.close();
    }
  } catch {
    throw new InvalidProjectLayoutError(
      "The Project database is invalid or needs migration.",
      "store.integrity-failed",
    );
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
