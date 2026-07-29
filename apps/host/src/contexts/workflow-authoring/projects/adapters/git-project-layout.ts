import { Database } from "bun:sqlite";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProjectIdentity, type ProjectSnapshot, type ReadinessFindingKey } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  ProjectDefinitionLoader,
  type ProjectDefinitionLoaderShape,
} from "../services/project-definition-loader";
import {
  ProjectLayout,
  type ProjectLayoutShape,
  type ProjectLayoutValidation,
} from "../services/project-layout";

class InvalidProjectLayoutError extends Error {
  constructor(
    message = "The path is not a safe initialized Kojo Project.",
    readonly findingKey: ReadinessFindingKey = "layout.metadata-invalid",
  ) {
    super(message);
  }
}

const inspect = async (path: string, kind: "directory" | "file", mode?: number) => {
  const information = await lstat(path);
  const matches = kind === "directory" ? information.isDirectory() : information.isFile();
  const userId = process.getuid?.();
  if (
    information.isSymbolicLink() ||
    !matches ||
    (userId !== undefined && information.uid !== userId) ||
    (mode !== undefined && (information.mode & 0o777) !== mode)
  ) {
    throw new InvalidProjectLayoutError();
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
      if (check?.quick_check !== "ok" || ![0, 1].includes(version?.user_version ?? -1)) {
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

const validate = async (
  path: string,
  definitions: ProjectDefinitionLoaderShape,
): Promise<ProjectLayoutValidation> => {
  try {
    const canonicalInput = await realpath(path);
    if (!(await stat(canonicalInput)).isDirectory()) throw new InvalidProjectLayoutError();
    const [inside, bare, rootValue] = await Promise.all([
      git(canonicalInput, ["rev-parse", "--is-inside-work-tree"]),
      git(canonicalInput, ["rev-parse", "--is-bare-repository"]),
      git(canonicalInput, ["rev-parse", "--show-toplevel"]),
    ]);
    if (inside !== "true" || bare !== "false") throw new InvalidProjectLayoutError();
    const root = await realpath(rootValue);
    await Promise.all([
      inspect(join(root, "kojo.config.ts"), "file"),
      inspect(join(root, ".gitignore"), "file"),
      inspect(join(root, ".kojo"), "directory", 0o700),
      inspect(join(root, ".kojo", "kojo.sqlite"), "file", 0o600),
      inspect(join(root, ".kojo", "artifacts"), "directory", 0o700),
      inspect(join(root, ".kojo", "sandboxes"), "directory", 0o700),
    ]);
    const definitionValidation = await definitions.validate(join(root, "kojo.config.ts"));
    if (!definitionValidation.ok) {
      throw new InvalidProjectLayoutError(
        definitionValidation.message,
        definitionValidation.findingKey,
      );
    }
    validateDatabase(join(root, ".kojo", "kojo.sqlite"));
    if (!(await hasIgnoreRule(root))) {
      return {
        ok: false,
        message: "The Project-local /.kojo/ ignore rule is missing.",
        findingKey: "layout.ignore-rule-missing",
      };
    }
    const project: ProjectSnapshot = { identity: await readIdentity(root), path: root };
    return { ok: true, project };
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

export const makeGitProjectLayout = (
  definitions: ProjectDefinitionLoaderShape,
): ProjectLayoutShape => ({
  validate: (path) => Effect.promise(() => validate(path, definitions)),
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
