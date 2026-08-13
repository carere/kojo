import { Console, Duration, Effect, FileSystem, Layer, Option, Path, Result } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as SandcastleSandboxSource from "../contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import { sandboxChoices } from "../contexts/scaffold/models/FactoryChoices.ts";
import { type Finding, isReady, skipped } from "../contexts/scaffold/models/Finding.ts";
import { diagnose } from "../contexts/scaffold/services/diagnose.ts";
import { layersFinding } from "../contexts/scaffold/services/readiness.ts";
import { commandFailed } from "./CommandFailed.ts";
import { renderDiagnosis, verdictLine } from "./doctorReport.ts";
import { factory } from "./factory.ts";
import { bodiesOf, everything } from "./workflows.ts";

/**
 * How long the dry run is given to build every layer and take them down again.
 *
 * Generous, because the engine's layer starts and stops a shard manager and that is the slowest
 * thing here — and bounded, because a diagnostic that hangs is worse than one that says it could
 * not finish. A timeout comes back as a failed `layers` finding, not as a hung terminal.
 */
const patience = Duration.seconds(60);

/**
 * The dry run: assemble every layer over every workflow body, and stop.
 *
 * **Over a scratch database, and that is not a shortcut.** Building the real engine layer registers
 * this process as a runner, and a runner picks up every verdict written since the last one ran — so
 * a doctor pointed at the factory's own file would silently resume suspended runs. Looking must
 * never be an act of execution (adr/gate/0001), and this is the one command whose entire purpose is
 * looking. A scratch file proves the same thing the real one would: that the engine's storage, the
 * askings, the trace, the sandbox source, the agent invoker and every workflow body agree on their
 * services, and that the migrations apply.
 *
 * Nothing is started. `Effect.void` under the layer is the whole program: the layers are built,
 * `Effect.void` succeeds, and the scope closes. There is no `execute`, so there is no run — which is
 * the half of "stops before the first spawn" that matters.
 */
const dryRun = (
  root: string,
): Effect.Effect<Finding, never, SandcastleSandboxSource.HostServices> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-doctor-" });

    // Every workflow, not only one: `kojo watch` and `kojo gate answer` both register the whole set,
    // because a suspended run adopted from another process may belong to any of them.
    const runnables = yield* everything(root);

    yield* Effect.void.pipe(
      Effect.provide(
        bodiesOf(runnables).pipe(Layer.provideMerge(factory(path.join(scratch, "dry-run.db")))),
      ),
      Effect.timeout(patience),
    );

    return runnables.map((runnable) => runnable.name);
  }).pipe(
    Effect.scoped,
    Effect.result,
    Effect.map((outcome) =>
      Result.isSuccess(outcome)
        ? layersFinding({
            over: `a scratch database, for ${outcome.success.join(", ")}`,
          })
        : layersFinding({ reason: describe(outcome.failure) }),
    ),
  );

/** Whatever refused, on one line. Three unrelated error types reach here; all three have a message. */
const describe = (failure: unknown): string => {
  const message =
    failure instanceof Error
      ? failure.message
      : typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { readonly message: unknown }).message)
        : String(failure);
  return (message.split("\n").find((line) => line.trim() !== "") ?? message).trim();
};

/**
 * Refuse to call an unfinished factory ready.
 *
 * **The command the stamped README already cites**, and the one that closes edge 6. `kojo init`
 * stamps commands that say out loud they are fake, because a scaffolder cannot know how a
 * repository runs its suite and a plausible guess that exits 0 would report a clean suite that
 * never ran. This is the other half of that bargain: something a person — or a CI job — can run
 * that says *no, not yet*, names each thing that is wrong, and says what to do about each.
 *
 * Three properties are worth stating because each is a way this command could have been useless:
 *
 * - **It exits non-zero when the factory is not ready.** A diagnostic that printed problems and
 *   exited 0 could not gate anything, and the whole value of it in CI is that it can.
 * - **It never guesses.** A check it cannot aim comes back `skipped` with the flag that would aim
 *   it, never `ok`. A doctor that guessed would be the failure it exists to detect.
 * - **It writes nothing.** No database is opened, no file is created, no run is started or resumed.
 */
export const doctor = Command.make(
  "doctor",
  {
    root: Flag.directory("root", { mustExist: true }).pipe(
      Flag.withDescription("The repository whose factory is examined"),
      Flag.withDefault("."),
    ),
    sandbox: Flag.choice("sandbox", sandboxChoices).pipe(
      Flag.withDescription(
        "Where this factory runs, when `.kojo/workflows/` does not say — aims the container checks",
      ),
      Flag.optional,
    ),
    image: Flag.string("image").pipe(
      Flag.withDescription("The image tag to look for, when the workflow names none"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ root, sandbox, image }) {
    const examination = yield* diagnose({
      root,
      sandbox: Option.getOrUndefined(sandbox),
      image: Option.getOrUndefined(image),
    });

    // Assembled only when every workflow module loaded. Attempting it otherwise would report a
    // second failure about the first one, and bury the file that actually needs editing.
    const layers = examination.loadable
      ? yield* dryRun(examination.root)
      : skipped(
          "layers",
          "a workflow did not load, so there was nothing to assemble the layers over",
        );

    const findings = [...examination.findings, layers];
    yield* Console.log(renderDiagnosis({ root: examination.root, findings }));

    // The verdict is the exit code, said out loud. On stderr when it is bad, because that is where
    // a script's operator looks and because `commandFailed` is what makes the process exit non-zero.
    return isReady(findings)
      ? yield* Console.log(verdictLine(findings))
      : yield* commandFailed(verdictLine(findings));
  }),
).pipe(
  Command.withDescription("Say whether this factory can actually run, and refuse it if it cannot"),
  Command.withExamples([
    {
      command: "kojo doctor",
      description: "Examine the factory in this repository, and exit non-zero if it is not ready",
    },
    {
      command: "kojo doctor --root . --sandbox docker",
      description: "Aim the container checks when the workflows do not say where they run",
    },
  ]),
);
