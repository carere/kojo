import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result, Stdio, Terminal } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { kojo, version } from "../../../src/cli/kojo.ts";

/**
 * That `kojo ui` is on the command tree, and what it refuses before it opens anything.
 *
 * Parsing and dispatch only. The handler starts a server and never returns, so nothing here runs it
 * — what a unit test can grade is that the command exists, that its flags are its own, and that the
 * shared `--database` flag reaches it, which is the flag the whole Console is pointed by.
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

    return yield* Command.runWith(kojo, { version })(argv).pipe(
      Effect.provide(environment),
      Effect.result,
    );
  });

/** The complaints a `ShowHelp` failure carries, which is where a parse error says what was wrong. */
const complaintsOf = (outcome: Result.Result<unknown, unknown>): string => {
  if (!Result.isFailure(outcome)) return "";
  const failure = outcome.failure as {
    readonly _tag: string;
    readonly errors?: ReadonlyArray<unknown>;
  };
  return (failure.errors ?? []).map(String).join(" | ");
};

describe("the ui command", () => {
  it.effect("is a command this build has", () =>
    Effect.gen(function* () {
      // A subcommand the tree does not have fails with an unrecognised-command complaint. This one
      // fails on nothing, because every flag it has carries a default.
      const unknown = yield* runCli(["definitely-not-a-command"]);
      expect(Result.isFailure(unknown)).toBe(true);
      expect(complaintsOf(unknown)).toContain("definitely-not-a-command");

      const mine = yield* runCli(["ui", "--port", "not-a-number"]);
      expect(Result.isFailure(mine)).toBe(true);
      // The complaint is about the port rather than about the command, which is what says the
      // command was found and its own flags were parsed.
      expect(complaintsOf(mine)).not.toContain("ui");
    }),
  );

  it.effect("takes the shared --database flag, where a person types it", () =>
    Effect.gen(function* () {
      // A flag declared in the root's own config rather than through `withSharedFlags` is invisible
      // to children, so `--database` here would be an unrecognised flag. The run still fails — the
      // port is nonsense — and *what it complains about* is the assertion.
      const outcome = yield* runCli([
        "ui",
        "--database",
        "/tmp/nothing.db",
        "--port",
        "not-a-number",
      ]);
      expect(Result.isFailure(outcome)).toBe(true);
      expect(complaintsOf(outcome)).not.toContain("database");
    }),
  );
});
