// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${…}` below belongs to the
// TypeScript this file *writes into a target repository*, not to the TypeScript it is. Making these
// template literals would interpolate this test's variables into a workflow that has its own.

// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, type Scope } from "effect";
import * as InMemoryImageBuilder from "../../../src/contexts/scaffold/adapters/InMemoryImageBuilder.ts";
import { placeholderMarker } from "../../../src/contexts/scaffold/models/Placeholder.ts";
import { initialise } from "../../../src/contexts/scaffold/services/initialise.ts";
import { thisEngine } from "../../support/engineDependency.ts";

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;
const packageRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

/** The Bun running this test, which is what the child must also be. See `stampedRun.test.ts`. */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
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
    const finished = spawnSync(bun(), [cli, ...args], { cwd: root, encoding: "utf8" });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

/**
 * The report with its line breaks flattened.
 *
 * A remedy is a sentence, and the report folds it to fit a terminal — so a sentence asserted here
 * as one string would be graded against wherever this week's wrapping happened to break it. The
 * assertion is about the words, not about the column they land in.
 */
const flat = (text: string): string => text.replace(/\s+/g, " ");

/** A repository that is a repository: a commit to fork a branch from, and the engine linked in. */
const repository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "kojo-doctor-" })
    .pipe(Effect.orDie);

  yield* Effect.sync(() => {
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Kojo"]);
    git(root, ["config", "user.email", "kojo@example.invalid"]);
  });

  yield* fileSystem
    .writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({ name: "kojo-target", type: "module" }, undefined, 2),
    )
    .pipe(Effect.orDie);
  yield* fileSystem
    .writeFileString(path.join(root, ".gitignore"), "node_modules\n")
    .pipe(Effect.orDie);
  yield* Effect.sync(() => {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", "a repository"]);
  });

  return root;
});

/** The links `bun install` would have left, so a stamped file's `kojo/...` imports resolve. */
const linkEngine = (root: string, path: Path.Path) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
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
  });

/**
 * A repository with a factory freshly stamped into it and nothing finished.
 *
 * `--sandbox none` is a real answer rather than a way out: the container, image and toolchain
 * checks then have nothing on this machine to look at and say so, which leaves the rest of the
 * report — the placeholders, the credential, the roster, the workflows and the layers — as the
 * subject. Docker's own three are graded by `readiness.test.ts` against probe results.
 */
const stamped = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* repository;

  yield* initialise({
    root,
    agent: "pi",
    model: "claude-sonnet-4-6",
    sandbox: "none",
    template: "review",
    engine: thisEngine(),
    uid: 1000,
    gid: 1000,
    skipImage: true,
  }).pipe(Effect.provide(InMemoryImageBuilder.layer), Effect.orDie);

  yield* Effect.sync(() => {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", "stamp a factory"]);
  });

  yield* linkEngine(root, path);
  return root;
});

const inRepository = <A, E>(
  make: Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.flatMap(make, use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * A finished `commands.ts` that still **names** the marker in its own prose.
 *
 * This is the trap, written on purpose. The stamped file describes what a placeholder is in a doc
 * comment, so a doctor that answered "is anything still fake" by scanning the file as text would
 * report a finished factory as unfinished for ever — and would keep doing it however carefully the
 * commands were replaced. A comment is not a command, and this file is what says so.
 */
const finishedCommands = [
  `import { isPlaceholder } from "kojo/contexts/scaffold/models/Placeholder";`,
  "",
  "/**",
  " * Every real invocation this factory makes.",
  " *",
  ` * These used to print ${placeholderMarker} and exit 78. They do not any more.`,
  " */",
  "export const commands = {",
  `  install: "sh -c 'true'",`,
  `  test: "sh -c 'true'",`,
  `  lint: "sh -c 'true'",`,
  `  build: "sh -c 'true'",`,
  "} as const;",
  "",
  "export const survivingPlaceholders = (): ReadonlyArray<string> =>",
  "  Object.entries(commands)",
  "    .filter(([, command]) => isPlaceholder(command))",
  "    .map(([name]) => name);",
  "",
].join("\n");

/** The same file with one command half-edited: new words, and the marker still in it. */
const halfEditedCommands = finishedCommands.replace(
  `  test: "sh -c 'true'",`,
  `  test: "sh -c 'echo \\"${placeholderMarker}: I will write this tomorrow\\" >&2; exit 78'",`,
);

const finish = (root: string, commands: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem
      .writeFileString(path.join(root, ".kojo", "commands.ts"), commands)
      .pipe(Effect.orDie);
    yield* fileSystem
      .writeFileString(path.join(root, ".kojo", ".env"), "ANTHROPIC_API_KEY=sk-not-a-real-key\n")
      .pipe(Effect.orDie);
  });

describe("kojo doctor on a factory nobody has finished", () => {
  it.live("refuses it, and exits non-zero so a CI job can be gated on it", () =>
    inRepository(stamped, (root) =>
      Effect.gen(function* () {
        const ran = yield* kojo(root, ["doctor"]);

        // The exit code, asserted rather than the words alone. A diagnostic that printed problems
        // and exited 0 could gate nothing, and gating is the whole reason this command exists.
        expect(ran.status).not.toBe(0);
        expect(ran.status).toBeGreaterThan(0);
        expect(ran.stderr).toContain("this factory is not ready");

        // Edge 6, named by the three commands `kojo init` could not know.
        expect(ran.stdout).toContain("test, lint, build are still placeholders");
        // Each failure says what to do about it, not only that something is wrong.
        expect(flat(ran.stdout)).toContain("Write the real commands in .kojo/commands.ts");
        expect(ran.stdout).toContain("ANTHROPIC_API_KEY is empty");
        expect(flat(ran.stdout)).toContain("Fill in the value in .kojo/.env");
      }),
    ),
  );

  it.live("still assembles every layer, decodes the config, and validates the roster", () =>
    inRepository(stamped, (root) =>
      Effect.gen(function* () {
        const ran = yield* kojo(root, ["doctor"]);

        // The dry run, over the factory's own workflow and the built-in demos alike.
        expect(ran.stdout).toContain("assembled over a scratch database");
        expect(ran.stdout).toContain("review");
        // The roster was decoded and both prompt files were read, which is what `YamlRoster` does
        // while its layer builds — the same decode a run performs, with nothing built on top.
        expect(ran.stdout).toContain("1 agent — drafter, prompts read");
        expect(ran.stdout).toContain("review — loaded");
      }),
    ),
  );

  it.live("stops before the first spawn: no run, no branch, and no database of its own", () =>
    inRepository(stamped, (root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* kojo(root, ["doctor"]);

        // A `sandboxed` scope cuts a branch before its first phase, so a branch here would mean a
        // run started. There is none.
        expect(git(root, ["branch", "--list"])).not.toContain("kojo/");
        // And the factory's own database was never opened. Building the engine over it would have
        // registered this process as a runner, and a runner applies every verdict written since the
        // last one ran — so a doctor pointed at it would silently resume suspended runs. Looking
        // must never be an act of execution (adr/gate/0001).
        expect(yield* fileSystem.exists(path.join(root, ".kojo", "kojo.db"))).toBe(false);
      }),
    ),
  );

  it.live("refuses a command that kept the marker and changed the words", () =>
    inRepository(stamped, (root) =>
      Effect.gen(function* () {
        yield* finish(root, halfEditedCommands);
        const ran = yield* kojo(root, ["doctor"]);

        // Nothing `placeholder()` would produce, and still fake. One predicate answers both, which
        // is why there is only one.
        expect(ran.status).not.toBe(0);
        expect(ran.stdout).toContain("test is still a placeholder");
        expect(ran.stdout).not.toContain("install");
      }),
    ),
  );
});

/**
 * The check that loading a workflow is not.
 *
 * `kojo doctor` imported every workflow module and called that enough. Importing is all that
 * loading does — a module built against a second copy of `effect` imports perfectly well — and the
 * first thing that touches the workflow's schemas and the engine's together is the **payload**.
 * Ticket 44 was found because a factory this command called ready died at that exact step.
 */
describe("kojo doctor building a payload rather than only loading a workflow", () => {
  it.live("builds one for the stamped starter, and keys it against this engine", () =>
    inRepository(stamped, (root) =>
      Effect.gen(function* () {
        yield* finish(root, finishedCommands);
        const ran = yield* kojo(root, ["doctor"]);

        expect(ran.stdout).toContain("review — built and keyed against this engine");
      }),
    ),
  );

  it.live("refuses a workflow whose payload cannot be built, and names it", () =>
    inRepository(stamped, (root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* finish(root, finishedCommands);

        // A workflow whose one payload field is not a word. `kojo run counted "x"` cannot start it,
        // and until this check existed nothing said so before the run: the module loads, the layers
        // assemble, and the factory was reported ready.
        yield* fileSystem
          .writeFileString(path.join(root, ".kojo", "workflows", "counted.ts"), countedWorkflow)
          .pipe(Effect.orDie);

        const ran = yield* kojo(root, ["doctor"]);

        expect(ran.status).not.toBe(0);
        // **The two lines together are the point.** The module loaded — that is what `kojo doctor`
        // used to call enough — and the payload could not be built from it.
        expect(ran.stdout).toContain("counted, review — loaded");
        expect(flat(ran.stdout)).toContain("FAILED payload");
        expect(flat(ran.stdout)).toContain("counted: SchemaError");
      }),
    ),
  );
});

/** A workflow that loads and whose payload one typed word cannot fill. */
const countedWorkflow = [
  'import { Effect, Schema } from "effect";',
  'import { code } from "kojo/contexts/workflow/services/phase/code";',
  'import { workflow } from "kojo/contexts/workflow/services/workflow";',
  "",
  "export const counted = workflow(",
  "  {",
  '    name: "counted",',
  "    payload: { howMany: Schema.Number },",
  "    success: Schema.String,",
  "    error: Schema.Never,",
  "    idempotencyKey: (payload) => `counted/${payload.howMany}`,",
  "  },",
  "  (payload) =>",
  "    code(",
  '      { name: "say", description: "Say it", success: Schema.String, error: Schema.Never },',
  "      Effect.succeed(`${payload.howMany}`),",
  "    ),",
  ");",
  "",
].join("\n");

describe("kojo doctor on a factory somebody finished", () => {
  it.live("calls it ready and exits 0, though its own comments still name the marker", () =>
    inRepository(stamped, (root) =>
      Effect.gen(function* () {
        yield* finish(root, finishedCommands);
        const ran = yield* kojo(root, ["doctor"]);

        expect(ran.stdout).toContain("this factory is ready");
        expect(ran.status).toBe(0);
        expect(ran.stderr).toBe("");

        // The trap, sprung and survived: the file still *says* KOJO-PLACEHOLDER in its prose, and
        // the answer is about what it *exports*. A text scan would have failed here for ever.
        const source = yield* (yield* FileSystem.FileSystem).readFileString(
          (yield* Path.Path).join(root, ".kojo", "commands.ts"),
        );
        expect(source).toContain(placeholderMarker);

        // `--sandbox none` is a real answer, and the three container checks say they were skipped
        // rather than passing. A skip that read as a pass would be the same lie one level up.
        expect(ran.stdout).toContain("skipped  container");
        expect(ran.stdout).toContain("skipped  image");
        expect(ran.stdout).toContain("skipped  toolchain");
      }),
    ),
  );
});

describe("kojo doctor in a repository with no factory", () => {
  it.live("says so once, points at `kojo init`, and exits non-zero", () =>
    inRepository(repository, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* linkEngine(root, path);

        const ran = yield* kojo(root, ["doctor"]);

        expect(ran.status).not.toBe(0);
        expect(ran.stdout).toContain("Run `kojo init` to stamp one");
        // Once. Eight failures all saying the same thing would bury the one line that matters.
        expect(ran.stdout.match(/^FAILED/gm)?.length).toBe(1);
        // And the engine still assembles on this machine, which is a real answer to give somebody
        // whose `kojo init` has not happened yet.
        expect(ran.stdout).toContain("assembled over a scratch database");
      }),
    ),
  );
});
