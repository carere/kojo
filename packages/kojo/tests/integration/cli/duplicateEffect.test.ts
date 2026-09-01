// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, readdirSync, symlinkSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import * as InMemoryImageBuilder from "../../../src/contexts/scaffold/adapters/InMemoryImageBuilder.ts";
import { initialise } from "../../../src/contexts/scaffold/services/initialise.ts";
import { defaultTrunk } from "../../../src/contexts/shared/models/FactoryLayout.ts";
import { installedPackage } from "../../../src/contexts/shared/services/resolvePackage.ts";
import { thisEngine } from "../../support/engineDependency.ts";
import { linkEngine } from "../../support/linkEngine.ts";

/**
 * **The failure this ticket exists to prevent, reproduced.**
 *
 * A stamped factory that resolves its own copy of `effect` — same version, different directory —
 * loads its commands, loads its workflows and assembles its layers. `kojo doctor` called such a
 * factory ready. The first run then died with a framework error at a line of the person's own
 * workflow that has nothing wrong with it:
 *
 * ```
 * TypeError: Cannot convert a symbol to a string
 *     at idempotencyKey (.kojo/workflows/review.ts:122:44)
 * ```
 *
 * The second copy here is **a real one** — the whole `effect` package, copied rather than linked —
 * because that is what makes the two `Schema` modules two. A directory with only a `package.json`
 * in it would satisfy the path comparison and prove nothing about what the run would have done.
 */

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;
const packageRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

const kojo = (root: string, args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], { cwd: root, encoding: "utf8" });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

const git = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** One line, so an assertion about a message is not defeated by where the report wrapped it. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

/**
 * A stamped repository whose `effect` is a second copy of the one this process is running on.
 *
 * `kojo` is linked to the engine under test, exactly as `bun install` would leave it. `effect` is
 * **copied** beside it — so the versions are identical, the directories are not, and every schema
 * the workflow builds comes from a different module than the one the engine reads.
 */
const twoCopies = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "kojo-duplicate-" })
    .pipe(Effect.orDie);

  yield* Effect.sync(() => {
    git(root, ["init", "--quiet", `--initial-branch=${defaultTrunk}`]);
    git(root, ["config", "user.name", "Kojo"]);
    git(root, ["config", "user.email", "kojo@example.invalid"]);
  });
  yield* fileSystem
    .writeFileString(path.join(root, ".gitignore"), "node_modules\n")
    .pipe(Effect.orDie);
  yield* Effect.sync(() => {
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", "a repository"]);
  });

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

  const mine = installedPackage(packageRoot, "effect");
  if (mine === undefined) throw new Error("this suite cannot resolve its own `effect`");

  yield* fileSystem
    .makeDirectory(path.join(root, "node_modules"), { recursive: true })
    .pipe(Effect.orDie);
  yield* Effect.sync(() => {
    // No `effect` in the list: the second copy below is the whole subject, and a link would
    // realpath back onto the first.
    linkEngine({ root, packageRoot, dependencies: ["@ai-hero", "@effect", "@types"] });
    // The second copy. Not a link — a link would realpath back onto the first, which is exactly
    // the arrangement that works.
    cpSync(mine.directory, path.join(root, "node_modules", "effect"), {
      recursive: true,
      dereference: true,
    });
  });

  return { root, mine };
});

const inRepository = <A, E>(
  use: (made: {
    root: string;
    mine: { version: string; directory: string };
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.flatMap(twoCopies, use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("a factory that resolves a second copy of effect", () => {
  it.live("is refused by `kojo doctor`, which names both versions and both directories", () =>
    inRepository(({ root, mine }) =>
      Effect.gen(function* () {
        const ran = yield* kojo(root, ["doctor"]);
        const report = flat(ran.stdout);

        expect(ran.status).not.toBe(0);
        expect(report).toContain("Factory resolves");
        expect(report).toContain("but the Project runtime resolves");
        expect(report).toContain(
          "Declare the exact Effect peer required by `@carere/kojo-runtime`",
        );
        // Both versions, and both directories. The versions are equal — that is the ordinary case,
        // and it is why a check comparing versions would have called this factory ready.
        expect(report).toContain(mine.version);
        expect(report).toContain(mine.directory);
        expect(report).toContain(`${root}/node_modules/effect`);
        // And the failure it is sparing the person, named where they will recognise it.
        expect(report).toContain("Cannot convert a symbol to a string");
      }),
    ),
  );

  it.live("is refused before a run starts, rather than dying inside the framework", () =>
    inRepository(({ root }) =>
      Effect.gen(function* () {
        const ran = yield* kojo(root, ["run", "review", "the auth bug"]);
        const said = flat(`${ran.stdout} ${ran.stderr}`);

        expect(ran.status).not.toBe(0);
        // **The whole claim.** Without the refusal this command reaches `Workflow.execute`, which
        // makes the payload and hashes its idempotency key, and throws
        // `TypeError: Cannot convert a symbol to a string` from inside `effect` — no Kojo
        // diagnosis anywhere in it.
        expect(said).not.toContain("TypeError");
        expect(said).toContain("two copies of effect");
        expect(said).toContain(".kojo/workflows/review.ts");

        // Refused before anything spawns: no branch was cut, so no sandbox was acquired and no
        // agent was called.
        expect(git(root, ["branch", "--list"])).not.toContain("kojo/");
      }),
    ),
  );

  it.live("passes once the second copy is gone and one `effect` serves both", () =>
    inRepository(({ root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mine = installedPackage(packageRoot, "effect");

        // The remedy, applied: one directory, reached by both.
        yield* fileSystem
          .remove(path.join(root, "node_modules", "effect"), { recursive: true })
          .pipe(Effect.orDie);
        yield* Effect.sync(() =>
          symlinkSync(mine?.directory ?? "", path.join(root, "node_modules", "effect")),
        );

        const ran = yield* kojo(root, ["doctor"]);

        expect(flat(ran.stdout)).toContain("one copy of each");
        // And the check that loading a workflow is not: the payload was built and keyed against
        // this Project runtime's own schemas.
        expect(flat(ran.stdout)).toContain("review — built and keyed against this Project runtime");
      }),
    ),
  );

  /**
   * **The false positive, which is the worse failure of the two.**
   *
   * `bun install` does not link a `file:` dependency's *directory*. It makes a real directory and
   * fills it with a link per file — so the directory's own realpath is the copy's while every
   * module the runtime loads out of it is the original. A check comparing directories calls that
   * two copies and refuses a factory that demonstrably works, which is how this was found: by
   * running `kojo init` and then `bun install`, and reading what `kojo doctor` then said.
   */
  it.live("counts a package manager's per-file links as the one copy they are", () =>
    inRepository(({ root, mine }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const laidOut = path.join(root, "node_modules", "effect");

        yield* fileSystem.remove(laidOut, { recursive: true }).pipe(Effect.orDie);
        yield* fileSystem.makeDirectory(laidOut, { recursive: true }).pipe(Effect.orDie);
        // Bun's own layout, reproduced: a real directory whose every entry links into the original.
        yield* Effect.sync(() => {
          for (const entry of readdirSync(mine.directory)) {
            symlinkSync(path.join(mine.directory, entry), path.join(laidOut, entry));
          }
        });

        const ran = yield* kojo(root, ["doctor"]);

        expect(flat(ran.stdout)).toContain("one copy of each");
        expect(flat(ran.stdout)).not.toContain("two copies");
        // And it really is one: the payload built and keyed against this Project runtime's schemas,
        // which is the thing two copies make impossible.
        expect(flat(ran.stdout)).toContain("review — built and keyed against this Project runtime");
      }),
    ),
  );
});
