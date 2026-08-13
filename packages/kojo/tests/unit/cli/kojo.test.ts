import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result, Stdio, Terminal } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { kojo, version } from "../../../src/cli/kojo.ts";

/**
 * Drives the real command with a fake environment, so the CLI is exercised end to end without
 * spawning a process. Two things about this seam are worth knowing, because both cost a debugging
 * session to find:
 *
 * - The built-in flags render through `Console.log`, not through the stdio sinks and not through
 *   `Terminal.display`. `it.effect` already supplies a `TestConsole`, so the lines are readable
 *   with `TestConsole.logLines`.
 * - `runWith` does not print help. It puts `ShowHelp` in the typed error channel and leaves the
 *   rendering to `Command.run`. So this seam tests parsing and dispatch, which is what a unit test
 *   should test.
 */
const runCli = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const environment = Layer.mergeAll(
      Stdio.layerTest({ args: Effect.succeed(argv) }),
      FileSystem.layerNoop({}),
      Path.layer,
      Layer.succeed(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(24),
          readInput: Effect.die("unused"),
          readLine: Effect.die("unused"),
          display: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unused")),
      ),
    );

    const outcome = yield* Command.runWith(kojo, { version })(argv).pipe(
      Effect.provide(environment),
      Effect.result,
    );

    return { outcome };
  });

describe("the kojo command", () => {
  it.effect("prints its version", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli(["--version"]);
      expect(Result.isSuccess(outcome)).toBe(true);
      const lines = yield* TestConsole.logLines;
      expect(lines.join(" ")).toContain(version);
    }),
  );

  it.effect("asks for help to be shown when invoked bare", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli([]);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure._tag).toBe("ShowHelp");
      }
    }),
  );

  it.effect("rejects a command it does not have", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli(["definitely-not-a-command"]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );
});

/**
 * The parser is the whole subject here, and it is the subject on purpose.
 *
 * A verdict is the one input in this system that must never be guessed at: a missing one invented by
 * a handler, or a contradictory one resolved by whichever branch was written first, is a decision
 * attributed to a human who did not make it. Every case below is rejected before a handler runs, so
 * nothing is written down and no run moves.
 *
 * None of these reach a database, which is what lets them stay unit tests: the parse fails first.
 */
describe("answering a gate from the command line", () => {
  it.effect("refuses a decision that was not given", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli(["gate", "answer", "some-token"]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("refuses a decision the gate has no name for", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli([
        "gate",
        "answer",
        "some-token",
        "--choice",
        "maybe-later",
      ]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("has no --approve and no --reject to contradict each other with", () =>
    Effect.gen(function* () {
      // Two independent booleans parse `--approve --reject` as both true, and the framework has no
      // exclusivity combinator to forbid it. One `Flag.choice` is why this is an unknown-flag error
      // rather than a handler deciding which of two contradictory switches wins.
      const { outcome } = yield* runCli(["gate", "answer", "some-token", "--approve", "--reject"]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("refuses a token that is not there at all", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli(["gate", "answer", "--choice", "approve"]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("takes the shared --database flag on the subcommand, where a person types it", () =>
    Effect.gen(function* () {
      // A flag declared in the root's own config rather than through `withSharedFlags` is invisible
      // to children, so `--database` here would be `Unrecognized flag`. The command still fails —
      // the token is missing — and *what it complains about* is the assertion: the missing argument
      // and not the flag.
      //
      // The obvious version of this test does not work: `--help` short-circuits the whole parse, so
      // `runWith` returns success even for an argv carrying an unrecognised flag. Nothing about
      // flag visibility can be read from a run with `--help` in it.
      const { outcome } = yield* runCli(["gate", "answer", "--database", "/tmp/nothing.db"]);

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        const failure = outcome.failure as {
          readonly _tag: string;
          readonly errors?: ReadonlyArray<unknown>;
        };
        expect(failure._tag).toBe("ShowHelp");
        const complaints = (failure.errors ?? []).map(String).join(" | ");
        expect(complaints).toContain("token");
        expect(complaints).not.toContain("database");
      }
    }),
  );
});
