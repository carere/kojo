import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Path } from "effect";
import * as InMemoryImageBuilder from "../../../../../src/contexts/scaffold/adapters/InMemoryImageBuilder.ts";
import {
  type InitialiseRequest,
  initialise,
} from "../../../../../src/contexts/scaffold/services/initialise.ts";
import { someEngine } from "../../../../support/engineDependency.ts";
import { memoryFileSystem } from "../../../../support/memoryFileSystem.ts";

const root = "/repo";

const request = (overrides?: Partial<InitialiseRequest>): InitialiseRequest => ({
  root,
  agent: "pi",
  model: "claude-sonnet-4-6",
  sandbox: "docker",
  template: "review",
  engine: someEngine,
  ...overrides,
});

/** One initialisation over a filesystem that lives in a `Map`, and a builder that only records. */
const run = (options: InitialiseRequest, seed?: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const memory = memoryFileSystem(seed);
    const environment = Layer.mergeAll(memory.layer, Path.layer, InMemoryImageBuilder.layer);

    const outcome = yield* Effect.gen(function* () {
      const initialised = yield* initialise(options);
      const built = yield* Effect.flatMap(
        InMemoryImageBuilder.BuiltImages,
        (images) => images.built,
      );
      return { initialised, built };
    }).pipe(Effect.provide(environment));

    return { ...outcome, files: memory.files, directories: memory.directories };
  });

describe("stamping a factory into a repository", () => {
  it.effect("writes every planned file without making runtime data", () =>
    Effect.gen(function* () {
      const { initialised, files, directories } = yield* run(request());

      expect(initialised.stamped.every((file) => file.outcome === "created")).toBe(true);
      expect(files.has("/repo/.kojo/kojo.config.yaml")).toBe(true);
      expect(files.has("/repo/.kojo/workflows/review.ts")).toBe(true);
      expect(files.has("/repo/.kojo/prompts/drafter/system.md")).toBe(true);
      expect(directories.has("/repo/.kojo/data")).toBe(false);
    }),
  );

  it.effect("keeps a file a person has edited, and creates only what is missing", () =>
    Effect.gen(function* () {
      const mine = 'export const commands = { install: "make deps", test: "make test" };\n';
      const { initialised, files } = yield* run(request(), {
        "/repo/.kojo/commands.ts": mine,
      });

      // The whole of "running initialisation twice does not clobber edits", and it is a per-file
      // decision rather than a per-run one: this repository has a finished `commands.ts` and no
      // workflow at all, and it gets to keep the first and receive the second.
      expect(files.get("/repo/.kojo/commands.ts")).toBe(mine);
      expect(initialised.stamped.find((file) => file.path === ".kojo/commands.ts")?.outcome).toBe(
        "kept",
      );
      expect(
        initialised.stamped.find((file) => file.path === ".kojo/workflows/review.ts")?.outcome,
      ).toBe("created");
    }),
  );

  it.effect("is exactly idempotent: a second run changes no byte and reports it", () =>
    Effect.gen(function* () {
      const first = yield* run(request());
      const seed = Object.fromEntries(first.files);

      const second = yield* run(request(), seed);

      expect(second.initialised.stamped.every((file) => file.outcome === "kept")).toBe(true);
      expect(Object.fromEntries(second.files)).toEqual(seed);
    }),
  );

  it.effect("detects the package manager from the repository it is stamping into", () =>
    Effect.gen(function* () {
      const { files } = yield* run(request(), { "/repo/pnpm-lock.yaml": "" });

      expect(files.get("/repo/.kojo/commands.ts")).toContain("pnpm install --frozen-lockfile");
      expect(files.get("/repo/.kojo/sandbox/Dockerfile")).toContain("corepack prepare pnpm");
    }),
  );

  it.effect(
    "lets a person overrule the lockfile, and still writes both files from one answer",
    () =>
      Effect.gen(function* () {
        const { files } = yield* run(request({ packageManager: "yarn" }), {
          "/repo/bun.lock": "",
        });

        expect(files.get("/repo/.kojo/commands.ts")).toContain("yarn install --immutable");
        expect(files.get("/repo/.kojo/sandbox/Dockerfile")).toContain("corepack prepare yarn");
      }),
  );
});

/**
 * Ticket 47: initialisation instructs an install, so it must arrange for what that install writes
 * to be ignored — or the first approved run refuses its merge over `node_modules/`.
 */
describe("the install the instructions create being ignored", () => {
  it.effect("writes a .gitignore covering node_modules/ into a repository that has none", () =>
    Effect.gen(function* () {
      const { initialised, files } = yield* run(request());

      expect(initialised.ignore.outcome).toBe("created");
      expect(files.get("/repo/.gitignore")).toContain("node_modules/");
    }),
  );

  it.effect("appends to the repository's own .gitignore, and clobbers not one byte of it", () =>
    Effect.gen(function* () {
      const mine = "# mine\ndist\n";
      const { initialised, files } = yield* run(request(), { "/repo/.gitignore": mine });

      expect(initialised.ignore.outcome).toBe("updated");
      expect(initialised.ignore.added).toEqual(["node_modules/"]);
      expect(files.get("/repo/.gitignore")?.startsWith(mine)).toBe(true);
      expect(files.get("/repo/.gitignore")).toContain("node_modules/");
    }),
  );

  it.effect("keeps a .gitignore that already covers what the install writes", () =>
    Effect.gen(function* () {
      const covered = "node_modules\n";
      const { initialised, files } = yield* run(request(), { "/repo/.gitignore": covered });

      expect(initialised.ignore.outcome).toBe("kept");
      expect(files.get("/repo/.gitignore")).toBe(covered);
    }),
  );
});

describe("safe initialisation", () => {
  it.effect("records the image contract without building an image", () =>
    Effect.gen(function* () {
      const { initialised, built, files } = yield* run(request({ imageName: "acme:latest" }));

      expect(built).toEqual([]);
      expect(Option.isNone(initialised.image)).toBe(true);
      expect(files.get("/repo/.kojo/workflows/review.ts")).toContain('imageName: "acme:latest"');
      expect(files.has("/repo/.kojo/sandbox/Dockerfile")).toBe(true);
    }),
  );
});
