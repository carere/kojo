// `@effect/platform-bun` is imported by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import { spawnSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, type PlatformError } from "effect";

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;

/**
 * The Bun that is running this test, which is what the child must also be.
 *
 * A child spawned on Node dies at import on `bun:sqlite` and exits **1** — which is the very number
 * this file asserts. Every test here would pass for the wrong reason. So the runtime is checked
 * rather than assumed.
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

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One whole `kojo` process, start to exit.
 *
 * **A real process, because the exit code is the assertion.** Nothing short of a spawn can grade it:
 * the handler's typed failure becomes a status only in `runMain`'s teardown, so a test that ran the
 * command in-process and read its `Result` would grade a stand-in for the property — exactly the
 * class of proof that let this defect ship. `stdout` and `stderr` are kept apart for the same
 * reason: the split between them is also under test.
 */
const kojo = (args: ReadonlyArray<string>): Effect.Effect<Ran> =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], { encoding: "utf8" });
    return {
      status: finished.status,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  });

/** A database of its own per test, so two runs cannot be deduplicated into one by their key. */
const onOwnFile = <A, E>(
  use: (database: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-failed-run-" });
    return yield* use(`${root}/kojo.db`);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * The code an ordinary failure exits with, and the code a watch that gave up exits with.
 *
 * Written as numbers rather than as `not.toBe(0)`, and that is the whole point of this file. The
 * defect it grades was a command that printed `run failed` and exited **0**, so an assertion that
 * only read stdout could not see it, and one that read `not.toBe(0)` could not tell a failed run
 * from a watch that ran out of patience. `75` is `EX_TEMPFAIL` from `sysexits.h`: nothing is wrong,
 * ask again later.
 */
const failed = 1;
const unsettled = 75;

describe("a run that fails", () => {
  it.live("exits non-zero and says which typed error ended it", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const ran = yield* kojo(["run", "demo-hello", "Kevin", "--fail", "--database", database]);

        // **The assertion the old behaviour could not pass.** It printed the words below on stdout
        // and exited 0; a test that grepped stdout stayed green through the whole defect.
        expect(ran.status).toBe(failed);

        // The reason is the workflow's own typed error, with what it knows. `GreetingRefused` is
        // `demo-hello`'s declared failure and `who` is the field it carries.
        expect(ran.stderr).toContain("GreetingRefused");
        expect(ran.stderr).toContain("who: Kevin");

        // stderr for the reason, stdout for the table, so a script can separate them. The phase
        // table prints on a failure too — it is most wanted exactly then.
        expect(ran.stdout).toContain("deliver");
        expect(ran.stdout).toContain("FAIL");
        expect(ran.stdout).not.toContain("GreetingRefused");
      }),
    ),
  );

  it.live("still exits non-zero when the failure was waited for", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const ran = yield* kojo([
          "run",
          "demo-hello",
          "Kevin",
          "--fail",
          "--wait",
          "--timeout",
          "20",
          "--database",
          database,
        ]);

        // `--wait` observed a terminal `failed`, so its exit code is the failed one and not the
        // one that means "still going".
        expect(ran.status).toBe(failed);
        expect(ran.stdout).toContain("run failed");
        expect(ran.stderr).toContain("GreetingRefused");
      }),
    ),
  );
});

describe("a run that does not fail", () => {
  it.live("exits 0 when it succeeds", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const ran = yield* kojo(["run", "demo-hello", "Kevin", "--database", database]);

        expect(ran.status).toBe(0);
        expect(ran.stdout).toContain("run succeeded");
      }),
    ),
  );

  /**
   * **A suspended run is a success, and the exit code has to say so.**
   *
   * This is the one assertion that keeps the fix from over-reaching. The whole design exists so a
   * person can close the terminal at a gate and answer days later from anywhere; a command that
   * exited non-zero there would report the design's normal path as its broken one, and every script
   * built on Kojo would learn to treat a waiting gate as a fault.
   */
  it.live("exits 0 when it stops at a gate", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const ran = yield* kojo(["run", "demo-review", "the change", "--database", database]);

        expect(ran.status).toBe(0);
        expect(ran.stdout).toContain('suspended at gate "approve"');
        expect(ran.stderr).not.toContain("failed");
      }),
    ),
  );
});

describe("--wait on a run that has not ended", () => {
  it.live("says which status it gave up on, and exits with its own code", () =>
    onOwnFile((database) =>
      Effect.gen(function* () {
        const ran = yield* kojo([
          "run",
          "demo-review",
          "the change",
          "--wait",
          "--timeout",
          "2",
          "--database",
          database,
        ]);

        // Not 0: `--wait` promised to block until the run ended and it did not, and a script that
        // read 0 here would read it as `succeeded`. Not `failed` either: the run is fine.
        expect(ran.status).toBe(unsettled);
        expect(ran.status).not.toBe(failed);

        // It says **which** case this is. "suspended" is the word, because that is the status the
        // watching actually ended on.
        expect(ran.stderr).toContain("--wait");
        expect(ran.stderr).toContain("suspended");
        expect(ran.stdout).toContain("run suspended");
      }),
    ),
  );
});
