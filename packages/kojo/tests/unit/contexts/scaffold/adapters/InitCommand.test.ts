import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Path, Result, Stdio, Terminal } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { kojo, version } from "../../../../../src/cli/kojo.ts";
import { memoryFileSystem } from "../../../../support/memoryFileSystem.ts";

/**
 * The CLI with a terminal that **dies if anybody reads from it**.
 *
 * That is the assertion, not the scaffolding. `Flag.withFallbackPrompt` turns a missing required
 * flag into a prompt, which is the behaviour a person at a terminal wants and the one CI cannot
 * survive. A prompt reads `Terminal.readInput`; this one is `Effect.die`, so a run that opened a
 * prompt would not fail — it would *defect*, which `Effect.result` does not catch and a passing
 * test therefore cannot hide.
 */
const runCli = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // `--path` is a `Flag.directory` with `mustExist`, and it is checked against *this* filesystem
    // before a handler runs — so the target repository has to be a directory the fake knows about.
    const memory = memoryFileSystem({}, ["/repo"]);
    const environment = Layer.mergeAll(
      Stdio.layerTest({ args: Effect.succeed(argv) }),
      // The real `Path`, so what the scaffolder asks the filesystem for is a real resolved path.
      Path.layer,
      memory.layer,
      Layer.succeed(
        Terminal.Terminal,
        Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(24),
          readInput: Effect.die(promptOpened),
          readLine: Effect.die(promptOpened),
          display: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("no image should be built by this test")),
      ),
    );

    // `Effect.exit` rather than `Effect.result`, because the terminal above defects rather than
    // fails, and a defect is what "a prompt was opened" looks like from here.
    const exit = yield* Command.runWith(kojo, { version })(argv).pipe(
      Effect.provide(environment),
      Effect.exit,
    );

    return {
      exit,
      outcome: Exit.isSuccess(exit)
        ? Result.succeed(exit.value)
        : Result.fail(Cause.squash(exit.cause)),
      files: memory.files,
    };
  });

/** What the fake terminal dies with. Reading it back is how a prompt is detected. */
const promptOpened = "kojo init read from the terminal";

const answered = [
  "init",
  "--agent",
  "pi",
  "--model",
  "claude-sonnet-4-6",
  "--sandbox",
  "docker",
  "--template",
  "review",
];

describe("initialising a factory from the command line", () => {
  it.effect("asks nobody anything when all four answers are flags", () =>
    Effect.gen(function* () {
      const { exit, files } = yield* runCli([...answered, "--path", "/repo"]);

      // Succeeded, and — the point of the whole test — never touched the terminal. Reading it is a
      // defect here, and `Exit.isSuccess` is false for a defect, so a prompt cannot hide behind a
      // pass. Ticket 15 and CI both need this path, and an `--interactive` switch with two code
      // paths would leave it as the one nobody exercises.
      expect(Exit.isSuccess(exit)).toBe(true);
      expect([...files.keys()].some((path) => path.endsWith("/.kojo/workflows/review.ts"))).toBe(
        true,
      );
    }),
  );

  it.effect.each(["--agent", "--model", "--sandbox", "--template"])(
    "prompts for %s rather than refusing, when it is the one answer missing",
    (missing) =>
      Effect.gen(function* () {
        const argv = [...answered, "--path", "/repo"];
        const at = argv.indexOf(missing);
        const withoutIt = [...argv.slice(0, at), ...argv.slice(at + 2)];

        const { exit } = yield* runCli(withoutIt);

        // The other half of the same declaration. A missing required flag would ordinarily be a
        // parse error; `Flag.withFallbackPrompt` makes it a question instead — and the proof that
        // a question was asked is that this run reached the terminal, which is rigged to die.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(String(Cause.squash(exit.cause))).toContain(promptOpened);
        }
      }),
  );

  it.effect("refuses an agent it has no Dockerfile for, before a handler runs", () =>
    Effect.gen(function* () {
      const { outcome, files } = yield* runCli([
        ...answered.slice(0, 2),
        "cursor",
        ...answered.slice(3),
      ]);

      expect(Result.isFailure(outcome)).toBe(true);
      // Rejected by the parser, so nothing was stamped for an agent whose CLI the image cannot
      // install. A factory whose image has no agent in it is a factory that fails on its first
      // agent phase, in a container, minutes in.
      expect(files.size).toBe(0);
    }),
  );

  it.effect("refuses a template it cannot stamp", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCli([...answered.slice(0, 8), "parallel-planner"]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("refuses the removed image-build compatibility flag", () =>
    Effect.gen(function* () {
      const removed = ["--skip", "image"].join("-");
      const { outcome } = yield* runCli([...answered, removed]);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  );
});
