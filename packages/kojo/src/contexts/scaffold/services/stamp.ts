import { Effect, FileSystem, Path, type PlatformError } from "effect";
import type { FactoryPlan, Stamped } from "../models/FactoryPlan.ts";
import { ScaffoldError } from "../models/ScaffoldError.ts";

const failed =
  (operation: "write" | "mkdir", target: string) => (cause: PlatformError.PlatformError) =>
    new ScaffoldError({ operation, target, reason: cause.message, cause });

/**
 * Write a plan into a repository, and never over anything already there.
 *
 * **This is the whole of "running initialisation twice does not clobber edits".** It is a property
 * of one line — the existence test below — and it is written as a per-file decision rather than a
 * per-run one on purpose: the second run of a factory that has grown a second workflow, or has had
 * `commands.ts` filled in and `checks.ts` left alone, keeps exactly what is there and creates
 * exactly what is not.
 *
 * There is no `--force`. A flag that overwrites a person's own workflow is a flag somebody will
 * pass while trying to fix something else, and what it destroys is the product. Deleting the file
 * you want re-stamped is one command, is reversible until you run this, and cannot be done by
 * accident.
 *
 * Every outcome is reported, kept ones included. A second run that printed nothing would be
 * indistinguishable from one that silently replaced everything.
 */
export const stamp = (
  root: string,
  factory: FactoryPlan,
): Effect.Effect<ReadonlyArray<Stamped>, ScaffoldError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const directory of factory.directories) {
      const target = path.join(root, directory);
      yield* fileSystem
        .makeDirectory(target, { recursive: true })
        .pipe(Effect.mapError(failed("mkdir", directory)));
    }

    // Serial, and in the plan's own order. Concurrency would buy nothing measurable — a factory is
    // a dozen small files — and would make the report's order depend on disk timing, which is the
    // order a person reads to find out what was created.
    return yield* Effect.forEach(
      factory.files,
      (file): Effect.Effect<Stamped, ScaffoldError> =>
        Effect.gen(function* () {
          const target = path.join(root, file.path);
          const exists = yield* fileSystem
            .exists(target)
            .pipe(Effect.mapError(failed("write", file.path)));

          if (exists) return { path: file.path, outcome: "kept" } as const;

          yield* fileSystem
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(Effect.mapError(failed("mkdir", file.path)));
          yield* fileSystem
            .writeFileString(target, file.content)
            .pipe(Effect.mapError(failed("write", file.path)));

          return { path: file.path, outcome: "created" } as const;
        }),
      { concurrency: 1 },
    );
  });
