import { execFileSync, spawnSync } from "node:child_process";
import { Effect, FileSystem, Path } from "effect";
import { defaultTrunk } from "../../src/contexts/shared/models/FactoryLayout.ts";
import { linkRuntime } from "./linkRuntime.ts";

/** Stamp and finish a temporary Factory for the controlled Agent Provider process tests. */

const packageRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const cli = new URL("../../../kojo/src/main.ts", import.meta.url).pathname;

/**
 * The Bun running this test, which is what every child must also be.
 *
 * The CLI reaches `bun:sqlite`, and a child on Node dies at import — which Vitest reports as a
 * *failed suite* contributing zero tests rather than as failing tests.
 */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `kojo-runtime:test-integration` moon task.",
    );
  }
  return process.execPath;
};

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One whole `kojo` process, launched from inside the target repository, the way a person does. */
const kojo = (root: string, args: ReadonlyArray<string>): Effect.Effect<Ran> =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

/**
 * The three commands this repository actually runs, replacing the placeholders.
 *
 * They are shell scripts committed in the repository rather than lines in this file, for the same
 * reason `commands.ts` exists at all: a factory's commands are the target's own, and a phase that
 * ran something invented by the test harness would grade nothing.
 */
const realCommands = [
  "// This file is yours.",
  "//",
  "// The three placeholders `kojo init` stamps have been replaced with what this repository",
  "// actually runs. Until that is done, every acceptance refuses — which is the honest answer for",
  "// a factory nobody has finished.",
  "",
  'import { isPlaceholder } from "@carere/kojo-runtime/contexts/workflow/models/Placeholder";',
  "",
  "export const commands = {",
  '  install: "true",',
  '  test: "sh scripts/test.sh",',
  '  lint: "sh scripts/lint.sh",',
  '  build: "sh scripts/build.sh",',
  "} as const;",
  "",
  "export const survivingPlaceholders = (): ReadonlyArray<string> =>",
  "  Object.entries(commands)",
  "    .filter(([, command]) => isPlaceholder(command))",
  "    .map(([name]) => name);",
  "",
].join("\n");

/**
 * The suite: every `.txt` in `notes/` has to hold something.
 *
 * It reads the working tree, so it genuinely grades what the agent wrote, and it can go red —
 * which is what makes the mechanical half of the acceptance worth having.
 */
const testScript = [
  "#!/bin/sh",
  "set -e",
  "for note in notes/*.txt; do",
  '  if [ ! -s "$note" ]; then',
  '    echo "empty note: $note" >&2',
  "    exit 1",
  "  fi",
  "done",
  'echo "notes ok"',
  "",
].join("\n");

/**
 * The linter: no tab characters anywhere under `notes/`.
 *
 * The tab is built with `printf` rather than written as `\t` in the pattern, because `grep -P` is
 * a GNU extension that BSD grep does not have — and the failure mode is the one this whole file
 * exists to avoid: `grep` errors, the pipeline's last command finds nothing, and the linter reports
 * clean about a check it never ran.
 */
const lintScript = [
  "#!/bin/sh",
  "set -e",
  'tab=$(printf "\\t")',
  'if grep -rl "$tab" notes > /dev/null 2>&1; then',
  '  echo "tabs are not allowed in notes" >&2',
  "  exit 1",
  "fi",
  'echo "lint ok"',
  "",
].join("\n");

/** The build: proves the notes concatenate, and writes nothing. */
const buildScript = [
  "#!/bin/sh",
  "set -e",
  "cat notes/*.txt > /dev/null",
  'echo "build ok"',
  "",
].join("\n");

interface Throwaway {
  /** The repository root. Everything the agent can reach is under here. */
  readonly root: string;
}

/**
 * Seed a repository, stamp a factory into it, finish the factory, and commit.
 *
 * Scoped: the directory is removed when the scope closes, so a run that leaves a container, a
 * worktree or a branch behind leaves them inside something that is about to be deleted.
 */
export const throwawayRepo = (options: {
  readonly model: string;
}): Effect.Effect<
  Throwaway,
  never,
  FileSystem.FileSystem | Path.Path | import("effect").Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "kojo-throwaway-" })
      .pipe(Effect.orDie);

    const write = (relative: string, content: string) =>
      Effect.gen(function* () {
        const target = path.join(root, relative);
        yield* fileSystem
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(Effect.ignore);
        yield* fileSystem.writeFileString(target, content).pipe(Effect.orDie);
      });

    yield* Effect.sync(() => {
      git(root, ["init", "--quiet", `--initial-branch=${defaultTrunk}`]);
      git(root, ["config", "user.name", "Kojo"]);
      git(root, ["config", "user.email", "kojo@example.invalid"]);
    });

    yield* write(
      "package.json",
      `${JSON.stringify({ name: "kojo-throwaway", type: "module" }, undefined, 2)}\n`,
    );
    // `.sandcastle/` is where Sandcastle puts the worktree it cuts and the log it writes. Neither
    // belongs to the repository, and an untracked one at the root would make every `git status`
    // here read dirty.
    yield* write(".gitignore", "node_modules\n.sandcastle\n");
    yield* write("notes/hello.txt", "hello\n");
    yield* write("scripts/test.sh", testScript);
    yield* write("scripts/lint.sh", lintScript);
    yield* write("scripts/build.sh", buildScript);

    // The Host provider needs no container image.
    const stamped = yield* kojo(root, [
      "init",
      "--agent",
      "claude-code",
      "--model",
      options.model,
      "--sandbox",
      "none",
      "--template",
      "review",
    ]);
    if (stamped.status !== 0) {
      return yield* Effect.die(
        new Error(`kojo init exited ${stamped.status}\n${stamped.stdout}\n${stamped.stderr}`),
      );
    }

    // **The mandatory first step**, before the factory is committed — see the header.
    yield* write(".kojo/commands.ts", realCommands);

    yield* Effect.sync(() => {
      git(root, ["add", "--all"]);
      git(root, ["commit", "--quiet", "--message", "seed a repository with a finished factory"]);
    });

    yield* fileSystem
      .makeDirectory(path.join(root, "node_modules"), { recursive: true })
      .pipe(Effect.orDie);
    yield* Effect.sync(() => linkRuntime({ root, runtimeRoot: packageRoot }));

    return { root };
  });
