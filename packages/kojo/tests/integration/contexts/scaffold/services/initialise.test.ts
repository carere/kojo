// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, type Scope } from "effect";
import * as YamlRoster from "../../../../../src/contexts/agent/adapters/YamlRoster.ts";
import { Roster } from "../../../../../src/contexts/agent/ports/Roster.ts";
import * as InMemoryImageBuilder from "../../../../../src/contexts/scaffold/adapters/InMemoryImageBuilder.ts";
import {
  type TemplateName,
  templateNames,
} from "../../../../../src/contexts/scaffold/models/FactoryChoices.ts";
import { isPlaceholder } from "../../../../../src/contexts/scaffold/models/Placeholder.ts";
import { initialise } from "../../../../../src/contexts/scaffold/services/initialise.ts";
import { starters } from "../../../../../src/contexts/scaffold/services/plan.ts";
import { runtimePackage } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import { thisEngine } from "../../../../support/engineDependency.ts";

/**
 * **A factory on a real disk, in a real git repository.**
 *
 * The unit tests grade what the scaffolder decides. This grades what a repository *is* afterwards:
 * that git ignores what the factory says it ignores, that the roster the loader reads back is the
 * roster the workflow calls, and that a second run keeps a person's edits byte for byte.
 */
const git = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const repository = (
  seed?: Readonly<Record<string, string>>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "kojo-init-" })
      .pipe(Effect.orDie);

    yield* Effect.sync(() => {
      git(root, ["init", "--quiet", "--initial-branch=main"]);
      git(root, ["config", "user.name", "Kojo"]);
      git(root, ["config", "user.email", "kojo@example.invalid"]);
    });

    for (const [name, content] of Object.entries(seed ?? {})) {
      const target = path.join(root, name);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.orDie);
      yield* fileSystem.writeFileString(target, content).pipe(Effect.orDie);
    }

    return root;
  });

/** One real initialisation. The image builder is the in-memory one: no daemon, and none needed. */
const initialiseInto = (root: string, template: TemplateName = "review") =>
  initialise({
    root,
    agent: "pi",
    model: "claude-sonnet-4-6",
    sandbox: "docker",
    template,
    engine: thisEngine(),
    uid: 1000,
    gid: 1000,
    skipImage: true,
  }).pipe(Effect.provide(InMemoryImageBuilder.layer), Effect.orDie);

const inRepository = <A, E>(
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  seed?: Readonly<Record<string, string>>,
): Effect.Effect<A, E> =>
  Effect.flatMap(repository(seed), use).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("a factory stamped into a real repository", () => {
  it.effect.each(templateNames)("%s leaves every file the plan named", (template) =>
    inRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const stamped = yield* initialiseInto(root, template);

        for (const file of stamped.stamped) {
          expect(
            yield* fileSystem.exists(path.join(root, file.path)),
            `${file.path} was reported ${file.outcome} and is not there`,
          ).toBe(true);
        }
        expect(yield* fileSystem.exists(path.join(root, ".kojo/data"))).toBe(false);
      }),
    ),
  );

  it.effect("makes git ignore the run data, the trace, and the credentials", () =>
    inRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* initialiseInto(root);

        // Written, then put to git itself. Asserting the *content* of a `.gitignore` proves a
        // string; asking git proves the property, including that a `.gitignore` one directory down
        // governs the paths below it at all.
        for (const produced of [
          ".kojo/data/kojo.db",
          ".kojo/data/worktrees/kojo-review-x/notes.md",
          ".kojo/data/sessions/abc.jsonl",
          ".kojo/.env",
          ".kojo/kojo.db",
          // What the first-run guard leaves beside the database: the lock it takes, and the mark
          // that says the file was created and migrated. Outside `data/`, like `.kojo/kojo.db`
          // above — inside it they would be covered by the directory and prove nothing.
          ".kojo/kojo.db.first-run",
          ".kojo/kojo.db.migrated",
        ]) {
          const target = path.join(root, produced);
          yield* fileSystem
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(Effect.orDie);
          yield* fileSystem.writeFileString(target, "x").pipe(Effect.orDie);
        }

        const ignored = yield* Effect.sync(() =>
          git(root, ["status", "--porcelain", "--untracked-files=all"]),
        );

        expect(ignored).not.toContain(".kojo/data/");
        expect(ignored).not.toContain(".kojo/.env");
        expect(ignored).not.toContain(".kojo/kojo.db");
        expect(ignored).not.toContain(".first-run");
        expect(ignored).not.toContain(".migrated");
        // And everything a run is *decided by* is still tracked, or a factory could not be shared.
        expect(ignored).toContain(".kojo/kojo.config.yaml");
        expect(ignored).toContain(".kojo/workflows/");
      }),
    ),
  );

  it.effect.each(templateNames)(
    "%s stamps a roster the real loader reads back, with every prompt the agents need",
    (template) =>
      inRepository((root) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          yield* initialiseInto(root, template);

          // The real `YamlRoster`, against the stamped config. This is the closest a test in this
          // ticket gets to ticket 15's question — a factory whose roster does not load is a factory
          // no agent can be invoked in, and the failure would otherwise be found by ticket 15.
          const wanted = starters[template].agents;
          const loaded = yield* Effect.gen(function* () {
            const roster = yield* Roster;
            return {
              names: roster.names,
              definitions: yield* Effect.forEach(wanted, (agent) => roster.definition(agent.name)),
            };
          }).pipe(
            Effect.provide(
              YamlRoster.layer({ config: path.join(root, ".kojo/kojo.config.yaml") }).pipe(
                Layer.provide(BunServices.layer),
              ),
            ),
            Effect.orDie,
          );

          expect([...loaded.names].sort()).toEqual(wanted.map((agent) => agent.name).sort());
          for (const definition of loaded.definitions) {
            expect(definition.model).toBe("claude-sonnet-4-6");
            // Both prompt files were found and read. `YamlRoster` reads them at load, so this
            // having succeeded at all is the assertion.
            expect(definition.system.length).toBeGreaterThan(0);
            expect(definition.user.length).toBeGreaterThan(0);
          }
        }),
      ),
  );

  /**
   * The manifest, which is the difference between eleven files and a factory.
   *
   * Every stamped file imports `kojo` and `effect`. Initialisation used to write neither into a
   * `package.json` nor a `package.json` at all, so a freshly stamped factory could not load one
   * line of itself — while its own README asserted the engine was "a versioned dependency in your
   * package.json".
   */
  it.effect("declares the engine in a repository that has no manifest at all", () =>
    inRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stamped = yield* initialiseInto(root);

        const manifest = JSON.parse(
          yield* fileSystem.readFileString(path.join(root, "package.json")),
        ) as { dependencies?: Record<string, string> };

        expect(stamped.manifest.outcome).toBe("created");
        // Both entries, at the specifiers this engine resolves — and `effect` exactly, because two
        // copies are two `Schema` modules and a run then dies inside the framework.
        expect(manifest.dependencies?.[runtimePackage]).toBe(
          stamped.choices.engine.runtime.specifier,
        );
        expect(manifest.dependencies?.effect).toBe(stamped.choices.engine.effect.specifier);
        expect(stamped.choices.engine.effect.version).toBe(thisEngine().effect.version);
      }),
    ),
  );

  it.effect("adds only what is missing to a manifest a person already owns", () =>
    inRepository(
      (root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stamped = yield* initialiseInto(root);

          const manifest = JSON.parse(
            yield* fileSystem.readFileString(path.join(root, "package.json")),
          ) as {
            name?: string;
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
          };

          expect(stamped.manifest.outcome).toBe("updated");
          // Everything that was theirs is still theirs, value for value.
          expect(manifest.name).toBe("somebody-elses-repository");
          expect(manifest.scripts).toEqual({ build: "tsc" });
          expect(manifest.dependencies?.zod).toBe("3.0.0");
          expect(manifest.dependencies?.[runtimePackage]).toBeDefined();
        }),
      {
        "package.json": `${JSON.stringify(
          {
            name: "somebody-elses-repository",
            scripts: { build: "tsc" },
            dependencies: { zod: "3.0.0" },
          },
          undefined,
          2,
        )}\n`,
      },
    ),
  );

  it.effect("keeps every edit when it is run a second time", () =>
    inRepository((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const first = yield* initialiseInto(root);

        // A person does the first thing the README tells them to do.
        const mine = 'export const commands = { install: "make deps", test: "make test" };\n';
        const commands = path.join(root, ".kojo/commands.ts");
        yield* fileSystem.writeFileString(commands, mine).pipe(Effect.orDie);
        // And adds a second workflow of their own, which the scaffolder has never heard of.
        const ours = path.join(root, ".kojo/workflows/ours.ts");
        yield* fileSystem.writeFileString(ours, "// ours\n").pipe(Effect.orDie);

        const second = yield* initialiseInto(root);

        expect(second.stamped.every((file) => file.outcome === "kept")).toBe(true);
        expect(yield* fileSystem.readFileString(commands)).toBe(mine);
        expect(yield* fileSystem.readFileString(ours)).toBe("// ours\n");
        // The report is the same list either way, so a person can see what was kept rather than
        // being shown silence and left to wonder whether anything was replaced.
        expect(second.stamped.map((file) => file.path)).toEqual(
          first.stamped.map((file) => file.path),
        );
      }),
    ),
  );

  it.effect(
    "ships a factory whose mechanical judgement refuses until a human writes the commands",
    () =>
      inRepository((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* initialiseInto(root);

          const commands = yield* fileSystem.readFileString(path.join(root, ".kojo/commands.ts"));
          // The entries only. The marker also appears in this file's own comments, which is the
          // point of a marker — but a comment is not a command, and `kojo doctor` reads the exported
          // record rather than the text.
          const entries = commands
            .split("\n")
            .filter((line) => /^ {2}\w+: "/.test(line) && isPlaceholder(line));

          expect(entries.map((line) => line.trim().split(":")[0]).sort()).toEqual([
            "build",
            "lint",
            "test",
          ]);

          // And each of them really does refuse. Run through a shell, exactly as the code phase runs
          // it — the one property edge 6 turns on, measured rather than asserted about a string.
          for (const line of entries) {
            // The value is written with `JSON.stringify`, so reading it back is the inverse and not
            // a parser: everything between the first quote and the last is the command.
            const command = JSON.parse(
              line.slice(line.indexOf('"'), line.lastIndexOf('"') + 1),
            ) as string;
            const outcome = yield* Effect.sync(() => {
              try {
                execFileSync("sh", ["-c", command], { encoding: "utf8", stdio: "pipe" });
                return { code: 0, stderr: "" };
              } catch (cause) {
                const failure = cause as { status?: number; stderr?: string };
                return { code: failure.status ?? -1, stderr: failure.stderr ?? "" };
              }
            });

            expect(outcome.code).toBe(78);
            expect(outcome.stderr).toContain("KOJO-PLACEHOLDER");
          }
        }),
      ),
  );
});
