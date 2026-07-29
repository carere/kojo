import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  ProjectLayout,
  type ProjectLayoutShape,
  type ProjectLayoutValidation,
} from "../services/project-layout";

class InvalidProjectLayoutError extends Error {
  constructor(
    message = "The path is not a safe initialized Kojo Project.",
    readonly findingKey = "project.layout.invalid",
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

const loadKojoConfiguration = async (path: string) => {
  const built = await Bun.build({
    entrypoints: [path],
    format: "esm",
    plugins: [
      {
        name: "kojo-configuration-contract",
        setup(build) {
          build.onResolve({ filter: /^@kojo\/workflow$/ }, () => ({
            namespace: "kojo-configuration-contract",
            path: "@kojo/workflow",
          }));
          build.onLoad({ filter: /.*/, namespace: "kojo-configuration-contract" }, () => ({
            contents: "export const defineConfig = (configuration) => configuration;",
            loader: "js",
          }));
        },
      },
    ],
    target: "bun",
  });
  if (!built.success || built.outputs.length !== 1) {
    throw new InvalidProjectLayoutError(
      "The Kojo Configuration is invalid.",
      "project.configuration.invalid",
    );
  }
  const source = `${await built.outputs[0].text()}\n// ${randomUUID()}\n`;
  const encoded = Buffer.from(source).toString("base64");
  const module = await import(`data:text/javascript;base64,${encoded}`);
  const configuration = module.default as unknown;
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    !("workflows" in configuration) ||
    !Array.isArray(configuration.workflows)
  ) {
    throw new InvalidProjectLayoutError(
      "The Kojo Configuration is invalid.",
      "project.configuration.invalid",
    );
  }
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
      if (check?.quick_check !== "ok" || version?.user_version !== 0) throw new Error();
    } finally {
      database.close();
    }
  } catch {
    throw new InvalidProjectLayoutError(
      "The Project database is invalid or needs migration.",
      "project.database.invalid",
    );
  }
};

const validate = async (path: string): Promise<ProjectLayoutValidation> => {
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
    try {
      await loadKojoConfiguration(join(root, "kojo.config.ts"));
    } catch (error) {
      if (error instanceof InvalidProjectLayoutError) throw error;
      throw new InvalidProjectLayoutError(
        "The Kojo Configuration is invalid.",
        "project.configuration.invalid",
      );
    }
    validateDatabase(join(root, ".kojo", "kojo.sqlite"));
    if (!(await hasIgnoreRule(root))) {
      return {
        ok: false,
        message: "The Project-local /.kojo/ ignore rule is missing.",
        findingKey: "project.layout.ignore-rule-missing",
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
      findingKey: "project.layout.invalid",
    };
  }
};

export const makeGitProjectLayout = (): ProjectLayoutShape => ({
  validate: (path) => Effect.promise(() => validate(path)),
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

export const GitProjectLayoutLive = Layer.succeed(ProjectLayout, makeGitProjectLayout());
