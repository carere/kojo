import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Schema } from "effect";

export class InvalidProjectLayoutError extends Error {
  override readonly name = "InvalidProjectLayoutError";
}

const inspect = async (path: string, kind: "directory" | "file", mode?: number) => {
  try {
    const information = await lstat(path);
    const matches = kind === "directory" ? information.isDirectory() : information.isFile();
    const userId = process.getuid?.();
    if (
      information.isSymbolicLink() ||
      !matches ||
      (userId !== undefined && information.uid !== userId) ||
      (mode !== undefined && (information.mode & 0o777) !== mode)
    ) {
      throw new Error("unsafe path");
    }
  } catch {
    throw new InvalidProjectLayoutError("The path is not a safe initialized Kojo Project.");
  }
};

const git = async (path: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new InvalidProjectLayoutError("The path is not a Git working tree.");
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

export const readProjectIdentityAtPath = async (root: string) => {
  const metadataPath = join(root, ".kojo", "project.json");
  await inspect(metadataPath, "file", 0o600);
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.layoutVersion !== 1) throw new Error("unsupported layout");
    return Schema.decodeUnknownSync(ProjectIdentity)(metadata.projectIdentity);
  } catch {
    throw new InvalidProjectLayoutError("The Project metadata is invalid.");
  }
};

export const validateInitializedProject = async (path: string): Promise<ProjectSnapshot> => {
  let canonicalInput: string;
  try {
    canonicalInput = await realpath(path);
    if (!(await stat(canonicalInput)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new InvalidProjectLayoutError("The Project path does not exist.");
  }
  const [inside, bare, rootValue] = await Promise.all([
    git(canonicalInput, ["rev-parse", "--is-inside-work-tree"]),
    git(canonicalInput, ["rev-parse", "--is-bare-repository"]),
    git(canonicalInput, ["rev-parse", "--show-toplevel"]),
  ]);
  if (inside !== "true" || bare !== "false") {
    throw new InvalidProjectLayoutError("The path is not a non-bare Git working tree.");
  }
  const root = await realpath(rootValue);
  await Promise.all([
    inspect(join(root, "kojo.config.ts"), "file"),
    inspect(join(root, ".gitignore"), "file"),
    inspect(join(root, ".kojo"), "directory", 0o700),
    inspect(join(root, ".kojo", "kojo.sqlite"), "file", 0o600),
    inspect(join(root, ".kojo", "artifacts"), "directory", 0o700),
    inspect(join(root, ".kojo", "sandboxes"), "directory", 0o700),
  ]);
  if (!(await hasIgnoreRule(root))) {
    throw new InvalidProjectLayoutError("The Project-local /.kojo/ ignore rule is missing.");
  }
  return { identity: await readProjectIdentityAtPath(root), path: root };
};
