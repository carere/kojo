import { Console, Effect, FileSystem, Option, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { commandFailed } from "../../../cli/CommandFailed.ts";
import { renderDiagnosis, verdictLine } from "../../../cli/doctorReport.ts";
import { factoryDirectory } from "../../shared/models/FactoryLayout.ts";
import { sandboxChoices } from "../models/FactoryChoices.ts";
import { isReady, skipped } from "../models/Finding.ts";
import { diagnose } from "../services/diagnose.ts";
import { standaloneValidation } from "../services/standaloneValidation.ts";

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
      contracts: "global",
      sandbox: Option.getOrUndefined(sandbox),
      image: Option.getOrUndefined(image),
    });

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hasFactory = yield* fileSystem
      .exists(path.join(examination.root, factoryDirectory))
      .pipe(Effect.orElseSucceed(() => false));
    const project = hasFactory
      ? yield* standaloneValidation(examination.root)
      : [skipped("validation", "there is no Factory to validate")];
    const findings = [...examination.findings, ...project];
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
