#!/usr/bin/env bun
// Deep paths, not the package barrel. See main.ts — the barrel reaches `BunRedis`, which imports
// the `bun` builtin.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Console, Effect, FileSystem, Path } from "effect";
import { promiseLeaksUnder, reportLeaks } from "../contexts/sandbox/guards/promiseFreeTypes.ts";

/**
 * Fail the build if a bare promise reached Kojo's published types.
 *
 * The guard itself lives in `contexts/sandbox/guards/promiseFreeTypes.ts`; this is only the
 * executable `moon run kojo:check-public-types` invokes. It grades what `tsc --build` emitted, so
 * the moon task depends on the `tsc` task rather than trusting whatever is in the cache.
 */
const defaultTypesDirectory = "../../.moon/cache/types/packages/kojo-runtime/src";

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = path.resolve(process.argv[2] ?? defaultTypesDirectory);

  if (!(yield* fileSystem.exists(root))) {
    yield* Console.error(
      `no declarations at ${root}. Run \`bun tsc --build\` before the check, or name a directory.`,
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  const processBoundaries = new Set([
    "contexts/project/adapters/DaemonResourceLeaseClient.d.ts",
    "contexts/trace/adapters/DaemonArtifactPublisher.d.ts",
    "contexts/workflow/adapters/RetainedFactoryAssetRepository.d.ts",
    "runner/main.d.ts",
    "validator/main.d.ts",
  ]);
  const leaks = (yield* promiseLeaksUnder(root)).filter(
    (leak) => !processBoundaries.has(leak.file),
  );
  if (leaks.length === 0) return yield* Console.log(`no promises under ${root}`);

  // The report is the whole message. Failing the Effect instead would print a second, less useful
  // one on top of it.
  yield* Console.error(reportLeaks(leaks));
  return yield* Effect.sync(() => process.exit(1));
});

program.pipe(Effect.orDie, Effect.provide(BunServices.layer), BunRuntime.runMain);
