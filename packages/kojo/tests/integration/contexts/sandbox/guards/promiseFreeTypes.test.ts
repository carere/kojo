// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { promiseLeaksUnder } from "../../../../../src/contexts/sandbox/guards/promiseFreeTypes.ts";

/**
 * A tree of declaration files on a real disk, written exactly as tsgo emits them.
 *
 * The unit tier already grades the scanner; what this adds is the walk — nested directories, the
 * `.d.ts.map` files that sit beside the declarations, and a real filesystem underneath. A guard
 * that reads one file correctly and misses the directory it was pointed at guards nothing.
 */
const inTree = <A, E>(
  files: Record<string, string>,
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-types-" });

    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFileString(target, content);
    }
    return yield* use(root);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** The declarations of a boundary that did its job. Effect out, nothing else. */
const clean = {
  "contexts/sandbox/adapters/boundary.d.ts": [
    'import { Effect, type Scope } from "effect";',
    'import { ExecResult } from "../models/ExecResult.ts";',
    "export interface SandboxHandle {",
    "    readonly branch: string;",
    "    readonly exec: (command: string) => Effect.Effect<ExecResult, SandboxError>;",
    "}",
    "//# sourceMappingURL=boundary.d.ts.map",
  ].join("\n"),
  "contexts/sandbox/adapters/boundary.d.ts.map": '{"version":3,"file":"boundary.d.ts"}',
  "contexts/shared/models/RunId.d.ts": "export type RunId = string & {};\n",
};

describe("the promise-free build check", () => {
  it.effect("passes a tree where every promise was already spent", () =>
    inTree(clean, (root) =>
      Effect.gen(function* () {
        expect(yield* promiseLeaksUnder(root)).toEqual([]);
      }),
    ),
  );

  it.effect("fails against a deliberate violation, wherever it is nested", () =>
    inTree(
      {
        ...clean,
        // What `export const leaked = (): Promise<string> => ...` in src actually emits.
        "contexts/agent/adapters/deliberateLeak.d.ts": [
          "export declare const leaked: () => Promise<string>;",
          "//# sourceMappingURL=deliberateLeak.d.ts.map",
        ].join("\n"),
      },
      (root) =>
        Effect.gen(function* () {
          const leaks = yield* promiseLeaksUnder(root);

          expect(leaks).toEqual([
            {
              file: "contexts/agent/adapters/deliberateLeak.d.ts",
              line: 1,
              text: "export declare const leaked: () => Promise<string>;",
            },
          ]);
        }),
    ),
  );

  it.effect("reads only declarations, so a source map naming the file is not a finding", () =>
    inTree(
      {
        "boundary.d.ts": "export declare const branch: string;\n",
        // A map file is JSON holding source text. It is build output, not published types.
        "boundary.js.map": '{"sourcesContent":["const close = (): Promise<void> => x();"]}',
      },
      (root) =>
        Effect.gen(function* () {
          expect(yield* promiseLeaksUnder(root)).toEqual([]);
        }),
    ),
  );
});
