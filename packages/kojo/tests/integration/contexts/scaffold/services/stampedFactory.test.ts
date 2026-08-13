// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import * as InMemoryImageBuilder from "../../../../../src/contexts/scaffold/adapters/InMemoryImageBuilder.ts";
import {
  type TemplateName,
  templateNames,
} from "../../../../../src/contexts/scaffold/models/FactoryChoices.ts";
import { initialise } from "../../../../../src/contexts/scaffold/services/initialise.ts";
import { thisEngine } from "../../../../support/engineDependency.ts";

/**
 * **The test that grades whether ticket 15 can happen.**
 *
 * Every other test in this ticket asks whether the scaffolder wrote the strings it meant to. This
 * one asks the only question that matters afterwards: *is what it wrote a program*. A stamped
 * workflow is TypeScript that imports the real Kojo package and calls its real API, so a signature
 * that moved, an import path that does not resolve, or a phase built out of the wrong pieces are
 * all defects in **this** ticket — and none of them is visible in a string comparison.
 *
 * Two independent checks, because they fail for different reasons:
 *
 * - `tsc` over the stamped tree, against the engine's own source. It catches a call that does not
 *   type: an envelope in the wrong position, a check whose requirement the sandbox does not
 *   provide, an error union missing a member the body can raise.
 * - `import()` under Bun. It catches what a typechecker cannot: a specifier that does not resolve
 *   at runtime, and a `workflow()` call that throws while the module is being evaluated.
 *
 * The linking below is what a real target repository gets from `bun install`. Symlinks rather than
 * copies, so the package under test is the package that is checked.
 */
const packageRoot = new URL("../../../../../", import.meta.url).pathname.replace(/\/$/, "");
const repositoryRoot = new URL("../../../../../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const typescript = `${repositoryRoot}/node_modules/.bin/tsc`;

/** What a target repository's `tsconfig.json` says. Strict, because a stamped file has to survive it. */
const tsconfig = JSON.stringify(
  {
    compilerOptions: {
      target: "esnext",
      module: "preserve",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      // The setting Kojo's own option types are written against — a stamped file that widened an
      // optional would not be assignable to the engine's, and this is where that shows up.
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
      types: ["bun"],
    },
    include: [".kojo/**/*.ts"],
  },
  undefined,
  2,
);

const stampedInto = (template: TemplateName) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: `kojo-stamped-${template}-` })
      .pipe(Effect.orDie);

    yield* initialise({
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

    yield* fileSystem
      .makeDirectory(path.join(root, "node_modules"), { recursive: true })
      .pipe(Effect.orDie);
    yield* fileSystem
      .writeFileString(path.join(root, "tsconfig.json"), tsconfig)
      .pipe(Effect.orDie);
    yield* fileSystem
      .writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ name: `kojo-target-${template}`, type: "module" }, undefined, 2),
      )
      .pipe(Effect.orDie);

    // `kojo` is the package under test; everything else is what it and the stamped files resolve
    // through. This is `bun install` in a target repository, with nothing copied.
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

    return root;
  });

describe("the factory a target repository is left holding", () => {
  it.effect.each(templateNames)(
    "%s typechecks against the real engine, under strict TypeScript",
    (template) =>
      Effect.gen(function* () {
        // The binary is the repository's own tsgo — the same one `bun tsc` runs. A missing one is
        // a failed test rather than a skipped one: this check is the point of the file.
        expect(existsSync(typescript), `no TypeScript at ${typescript}`).toBe(true);

        const root = yield* stampedInto(template);

        const reported = yield* Effect.sync(() => {
          try {
            execFileSync(typescript, ["--project", "tsconfig.json"], {
              cwd: root,
              encoding: "utf8",
              stdio: "pipe",
            });
            return "";
          } catch (cause) {
            const failure = cause as { stdout?: string; stderr?: string };
            return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
          }
        });

        expect(reported).toBe("");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect.each(templateNames)("%s is a module that loads and builds its workflow", (template) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* stampedInto(template);

      // Imported for real, under the runtime a factory runs on. A specifier that typechecks and
      // does not resolve — the ordinary cost of getting an `exports` map wrong — dies here.
      const loaded = yield* Effect.promise(
        () =>
          import(path.join(root, ".kojo", "workflows", `${template}.ts`)) as Promise<
            Record<string, { readonly definition: { readonly _tag: string } }>
          >,
      );

      // The engine's execution id is the run id and is derived from this name, so a workflow whose
      // definition does not carry it is a workflow `kojo run` cannot find.
      expect(loaded[template]?.definition._tag).toBe(template);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  /**
   * **Every agent a stamped factory runs is inside the guard, and the guard protects the factory's
   * own files.**
   *
   * This exists because of a hole an adversarial verifier measured on ticket 15: emptying
   * `protectedPaths` in the `review` template left the entire offline suite green. The only thing
   * grading criterion 4 was a test behind `KOJO_REAL_AGENT`, so the one property that stops an agent
   * editing its own grader could be deleted and nothing free would notice.
   *
   * A string assertion is a weak test and is the right one here. What can silently rot is not the
   * behaviour of `withPermissions` — `Permissions`' own suite grades that — it is whether the
   * *stamped file* still calls it. That is a fact about generated text, so it is checked as text.
   *
   * Written over `templateNames`, so a template added later either carries the guard or turns this
   * red on the day it is added rather than the day an agent gets loose in someone's repository.
   */
  it.effect.each(templateNames)("%s runs every one of its agents inside the guard", (template) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* stampedInto(template);
      const source = yield* fileSystem
        .readFileString(path.join(root, ".kojo", "workflows", `${template}.ts`))
        .pipe(Effect.orDie);

      // The factory's own files are the roster, the workflows, the envelopes, the checks, the
      // commands and the prompts. An empty list here is a guard that permits everything.
      expect(source).toContain("protectedPaths: factoryOwnPaths");

      // Every `agent({` in the file is preceded by a `withPermissions(`. Counting is enough and is
      // deliberately blunt: a second agent phase added later without a guard makes the counts
      // disagree, which is the failure this is here to catch.
      const agents = source.match(/\bagent\(\{/g) ?? [];
      const guards = source.match(/\bwithPermissions\(/g) ?? [];
      expect(agents.length, `no agent phase found in the stamped ${template}`).toBeGreaterThan(0);
      expect(
        guards.length,
        `${template} stamps ${agents.length} agent phases behind ${guards.length} guards`,
      ).toBe(agents.length);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  /**
   * **The work reaches the branch before the run suspends.**
   *
   * Ticket 15 measured what happens when it does not: Sandcastle preserves a dirty worktree when the
   * container closes at a gate, and the rebuild on the answer refuses it as
   * `WorktreeUnusable{fault: "modified"}` — so an uncommitted change does not merely fail to survive
   * the gate, it stops the run being resumable at all. The `review` template was fixed for it and
   * `hotfix` was left behind; this is what would have caught that.
   */
  it.effect.each(templateNames)("%s commits what an agent wrote before it suspends", (template) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* stampedInto(template);
      const source = yield* fileSystem
        .readFileString(path.join(root, ".kojo", "workflows", `${template}.ts`))
        .pipe(Effect.orDie);

      expect(source).toContain('workspace.git(["commit"');
      // Staging is what makes the commit carry the agent's work rather than an empty tree.
      expect(source).toContain('workspace.git(["add", "--all"])');
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("reports the commands that are still fake, from the file it stamped", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* stampedInto("review");

      // `survivingPlaceholders` is what ticket 23 will call. Loading the stamped module and asking
      // it is the whole mechanism, end to end: the marker is Kojo's, the detection is Kojo's, and
      // the answer comes from the target repository's own file.
      const commands = yield* Effect.promise(
        () =>
          import(path.join(root, ".kojo", "commands.ts")) as Promise<{
            readonly commands: Record<string, string>;
            readonly survivingPlaceholders: () => ReadonlyArray<string>;
          }>,
      );

      expect([...commands.survivingPlaceholders()].sort()).toEqual(["build", "lint", "test"]);
      expect(commands.commands.install).toBe("npm ci");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
