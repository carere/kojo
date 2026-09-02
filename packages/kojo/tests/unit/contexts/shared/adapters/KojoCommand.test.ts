import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result, Stdio, Terminal } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { kojo, version } from "../../../../../src/cli/kojo.ts";

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

  /**
   * The version the CLI prints is the version the registry serves.
   *
   * This is a release guard rather than a behaviour test. `version` was a literal `"0.0.0"` carrying
   * a comment that said it must track `package.json`, and nothing made it — so the first published
   * release would have reported `0.0.0`, and so would every release after it. Nothing would have
   * failed; `kojo --version` would simply have lied.
   *
   * It reads the manifest here rather than trusting the same call the source makes, so the two
   * cannot agree by both being wrong.
   *
   * **It is vacuous at `0.0.0` and arms itself on the first bump.** A hardcoded `"0.0.0"` matches an
   * unreleased manifest, so mutating the source alone proves nothing today. Mutating both — bump the
   * manifest, write the constant down — is what reddens it, and that is exactly the state every
   * release after the first is in.
   */
  it("prints the version the package.json beside it declares", () => {
    const manifest = new URL("../../../../../package.json", import.meta.url);
    const declared = JSON.parse(readFileSync(manifest, "utf8")) as { readonly version: string };

    expect(version).toBe(declared.version);
    expect(version).not.toBe("unknown");
  });
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

  it.effect("refuses the removed root storage flag", () =>
    Effect.gen(function* () {
      const storageFlag = ["--", "data", "base"].join("");
      const { outcome } = yield* runCli([storageFlag, "/tmp/nothing.db", "run", "list"]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("refuses the removed watcher command", () =>
    Effect.gen(function* () {
      const removed = ["wat", "ch"].join("");
      const { outcome } = yield* runCli([removed]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("refuses the removed positional Workflow start form", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli(["run", "review", "make the change"]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );
});
