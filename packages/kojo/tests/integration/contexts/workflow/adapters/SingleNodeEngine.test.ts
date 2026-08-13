// `@effect/platform-bun` is imported below by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, type PlatformError } from "effect";

const script = new URL("../../../../support/durableRun.ts", import.meta.url).pathname;

/**
 * The Bun that is running this test, which is what the child process must also be.
 *
 * `durableRun.ts` reaches `bun:sqlite` through the engine's SQL client, so a child spawned on Node
 * dies at import with `ERR_UNSUPPORTED_ESM_URL_SCHEME` — and it does that *inside* a spawn whose
 * failure this file reports as "durableRun exited 1", which reads like a defect in the engine rather
 * than in how the suite was launched. The task in `moon.yml` runs Vitest through `bun` so that
 * `process.execPath` is Bun; this asserts that rather than assuming it, so a runtime regression is
 * named where it happens.
 */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

/**
 * One whole process, start to exit.
 *
 * Restarting is the assertion, so it has to be a real process: a second layer built in the same
 * process proves nothing about what the file holds.
 */
const inItsOwnProcess = (args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [script, ...args], { encoding: "utf8" });
    if (finished.status !== 0) {
      throw new Error(`durableRun ${args[0]} exited ${finished.status}: ${finished.stderr}`);
    }
    const lines = finished.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1] ?? "{}") as {
      readonly runId: string;
      readonly status: string;
    };
  });

const onOwnFile = <A, E>(
  use: (paths: { readonly database: string; readonly log: string }) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-engine-" });
    return yield* use({ database: `${root}/kojo.db`, log: `${root}/activities.log` });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("the single-node durable engine", () => {
  it.live("carries a suspended run across the process that started it exiting", () =>
    onOwnFile((paths) =>
      Effect.gen(function* () {
        // The first process starts the run and reports where it stopped. It does not block on the
        // run: a suspended run is a success, and this process exits with the answer still missing.
        const started = yield* inItsOwnProcess(["start", paths.database, paths.log, "alpha"]);
        expect(started.status).toBe("suspended");
        expect(readFileSync(paths.log, "utf8")).toBe("announce\n");

        // A second process, on nothing but the same file and the run id, answers and finishes it.
        const finished = yield* inItsOwnProcess([
          "answer",
          paths.database,
          paths.log,
          started.runId,
          "approve",
        ]);
        expect(finished.status).toBe("succeeded");

        // The second process replayed the whole body, and the activity that already ran did not run
        // again — its recorded result came back instead. That is the property everything else in
        // the design leans on, and it holds across a process boundary.
        expect(readFileSync(paths.log, "utf8")).toBe("announce\nland\n");
      }),
    ),
  );

  it.live("gives the run the same id in both processes", () =>
    onOwnFile((paths) =>
      Effect.gen(function* () {
        const started = yield* inItsOwnProcess(["start", paths.database, paths.log, "beta"]);
        const finished = yield* inItsOwnProcess([
          "answer",
          paths.database,
          paths.log,
          started.runId,
          "approve",
        ]);

        // Nothing mints a second identifier. The execution id the first process printed is what the
        // second process answers, and it is what the trace and the branch name will join on.
        expect(finished.runId).toBe(started.runId);
      }),
    ),
  );
});
