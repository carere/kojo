import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { Effect, FileSystem, Path } from "effect";

/**
 * A repository nobody minds losing, with a finished factory in it.
 *
 * **This is the blast radius of ticket 15.** A real agent, invoked for real, with
 * `--dangerously-skip-permissions`, writes to whatever directory it is standing in — so it stands
 * in a temporary git repository seeded here and never in the Kojo working tree. Everything the agent
 * can reach is created by this module and deleted with the scope.
 *
 * Three things it does that a plain temp directory does not:
 *
 * - **`kojo init` stamps the factory**, as a subprocess, exactly as a person runs it. Not
 *   `initialise()` with an in-memory image builder: the claim under test is that *the factory
 *   `kojo init` stamps* can drive a real agent, and a fixture assembled by hand would be a claim
 *   about the fixture.
 * - **`.kojo/commands.ts` is finished**, before the first commit. A freshly stamped factory ships
 *   three placeholders that print `KOJO-PLACEHOLDER` and exit 78, so `verify` records
 *   `accepted: false` and `requireAcceptance` refuses however a human answers. Editing it is the
 *   first thing a person does with a new factory, and it is the first thing done here.
 * - **`node_modules/kojo` links to the package under test**, which is what `bun install` leaves a
 *   target repository holding, and is how the stamped file's `kojo/…` imports resolve to the engine
 *   being graded rather than to a published copy of it.
 */

const packageRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const cli = new URL("../../src/main.ts", import.meta.url).pathname;

/**
 * The Bun running this test, which is what every child must also be.
 *
 * The CLI reaches `bun:sqlite`, and a child on Node dies at import — which Vitest reports as a
 * *failed suite* contributing zero tests rather than as failing tests.
 */
export const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

export interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One whole `kojo` process, launched from inside the target repository, the way a person does. */
export const kojo = (
  root: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly timeoutMillis?: number;
    /**
     * The child's `PATH`, when the caller needs to decide which `claude` the run reaches.
     *
     * A stamped `review` wires the stock Claude Code provider, so the binary it spawns is whatever
     * `claude` is on this variable. Left unset the operator's own is used, and the call costs money;
     * a rehearsal puts a script in front of it instead.
     */
    readonly path?: string | undefined;
  },
): Effect.Effect<Ran> =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      ...(options?.path === undefined
        ? {}
        : { env: { ...process.env, PATH: options.path } as NodeJS.ProcessEnv }),
      // An agent turn is minutes, not seconds, and a `kojo run` that carries one inherits that.
      timeout: options?.timeoutMillis ?? 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

export const git = (root: string, args: ReadonlyArray<string>): string =>
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
  'import { isPlaceholder } from "kojo/contexts/scaffold/models/Placeholder";',
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

export interface Throwaway {
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
  /**
   * Extra text appended to the drafter's own `prompts/drafter/user.md`, before the commit.
   *
   * The task template is where a factory tells its agent how to work, so a standing instruction —
   * one that is about *how to answer* rather than about this change — belongs here rather than in the
   * subject, which is also the gate's question. (A run's branch cannot be reached from either: it is
   * `runBranch(runId)` and nothing else.)
   */
  readonly insist?: string | undefined;
  /**
   * Extra field declarations inserted into the stamped `Drafted`, before the commit.
   *
   * The envelope is the target repository's own file — `kojo init` stamps it and the author owns it
   * from then on — so widening it here is what a factory author does, not a hole poked in a fixture.
   * Ticket 48 needs one field with a **narrow** type to make a real model's first answer fail to
   * decode; see `tests/support/riskNote.ts` for the design and why it is a field rather than an
   * instruction to answer badly.
   */
  readonly alsoInEnvelope?: string | undefined;
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
      git(root, ["init", "--quiet"]);
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
    yield* write(".gitignore", "node_modules\n.sandcastle\n.kojo/kojo.db*\n");
    yield* write("notes/hello.txt", "hello\n");
    yield* write("scripts/test.sh", testScript);
    yield* write("scripts/lint.sh", lintScript);
    yield* write("scripts/build.sh", buildScript);

    // The real command, as a person runs it. `--skip-image` because the sandbox is `none`: there is
    // no image to build, and building one would need a daemon this suite does not require.
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
      "--skip-image",
    ]);
    if (stamped.status !== 0) {
      return yield* Effect.die(
        new Error(`kojo init exited ${stamped.status}\n${stamped.stdout}\n${stamped.stderr}`),
      );
    }

    // **The mandatory first step**, before the factory is committed — see the header.
    yield* write(".kojo/commands.ts", realCommands);

    if (options.alsoInEnvelope !== undefined) {
      const envelopes = path.join(root, ".kojo", "envelopes.ts");
      const stampedEnvelopes = yield* fileSystem.readFileString(envelopes).pipe(Effect.orDie);
      // The end of the only class the stamped file declares. Asserted rather than assumed: a
      // template that stops closing its envelope this way must fail here, loudly, rather than
      // silently drop the field this fixture's whole point is to add.
      const closes = stampedEnvelopes.lastIndexOf("}) {}");
      if (closes < 0) {
        return yield* Effect.die(
          new Error(`the stamped ${envelopes} does not close a class with "}) {}"`),
        );
      }
      yield* fileSystem
        .writeFileString(
          envelopes,
          `${stampedEnvelopes.slice(0, closes)}${options.alsoInEnvelope}\n${stampedEnvelopes.slice(closes)}`,
        )
        .pipe(Effect.orDie);
    }

    if (options.insist !== undefined) {
      const userPrompt = path.join(root, ".kojo", "prompts", "drafter", "user.md");
      const stampedPrompt = yield* fileSystem.readFileString(userPrompt).pipe(Effect.orDie);
      yield* fileSystem
        .writeFileString(userPrompt, `${stampedPrompt.trimEnd()}\n\n${options.insist}\n`)
        .pipe(Effect.orDie);
    }

    yield* Effect.sync(() => {
      git(root, ["add", "--all"]);
      git(root, ["commit", "--quiet", "--message", "seed a repository with a finished factory"]);
    });

    yield* fileSystem
      .makeDirectory(path.join(root, "node_modules"), { recursive: true })
      .pipe(Effect.orDie);
    yield* Effect.sync(() => {
      const link = (from: string, to: string) => {
        if (!existsSync(to)) symlinkSync(from, to);
      };
      link(packageRoot, path.join(root, "node_modules", "kojo"));
      for (const dependency of ["effect", "@ai-hero", "@effect", "@types"]) {
        link(
          path.join(packageRoot, "node_modules", dependency),
          path.join(root, "node_modules", dependency),
        );
      }
    });

    return { root };
  });
