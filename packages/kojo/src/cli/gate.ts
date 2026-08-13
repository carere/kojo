import { Clock, Console, Duration, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { DurableDeferred } from "effect/unstable/workflow";
import { unsettled } from "../contexts/gate/models/AskedGate.ts";
import { GateRepository } from "../contexts/gate/ports/GateRepository.ts";
import { answerGate, parseToken } from "../contexts/gate/services/answerGate.ts";
import type { RunId } from "../contexts/shared/models/RunId.ts";
import { askingsSoFar, stopped } from "../contexts/workflow/services/stopped.ts";
import { commandFailed } from "./CommandFailed.ts";
import { ends, reachedStatus } from "./ends.ts";
import { askings, created, factory, readyFor } from "./factory.ts";
import { renderGateTable } from "./gateTable.ts";
import { reportPhases } from "./reportPhases.ts";
import { root } from "./root.ts";
import { describeStop } from "./stopLine.ts";
import { resolve } from "./workflows.ts";

/**
 * Who a verdict is attributed to when nobody says.
 *
 * The OS user, exactly as adr/gate/0001 decided for the Console: v1 has no authorisation, and the
 * name of whoever ran the command is the honest thing to record. Read in the handler rather than
 * baked into the flag's default, so it is the user running the command rather than the one who
 * built it.
 */
const osUser = Effect.sync(() => {
  const { USER, USERNAME } = process.env;
  return USER ?? USERNAME ?? "unknown-answerer";
});

/**
 * What waits on a human, and for how long.
 *
 * **It builds no engine.** The engine would make this process a runner, and a runner applies every
 * verdict written since one last ran — so listing what is waiting would resume runs. Looking must
 * never be an act of execution.
 */
const list = Command.make(
  "list",
  {
    all: Flag.boolean("all").pipe(
      Flag.withDescription(
        "Include settled askings — answered ones, and ones the deadline expired",
      ),
    ),
  },
  Effect.fn(function* ({ all }) {
    const { database } = yield* root;
    const now = yield* Clock.currentTimeMillis;

    const asked = yield* Effect.flatMap(GateRepository, (repository) => repository.all).pipe(
      Effect.provide(askings(database)),
    );

    yield* Console.log(renderGateTable(all ? asked : unsettled(asked), now));
  }),
).pipe(Command.withDescription("Show what waits on a human, and for how long"));

/**
 * The answering half, run from a process that never saw the run start.
 *
 * **One `--choice`, never `--approve` / `--reject`.** Two independent booleans parse
 * `--approve --reject` as both true and accept neither, and the framework has no exclusivity
 * combinator to forbid it — so a contradictory decision would reach a handler, and a missing one
 * would have to be invented there. A single choice flag makes both a parse error, which is the only
 * place a decision can be rejected before anything is written down.
 */
const answer = Command.make(
  "answer",
  {
    token: Argument.string("token").pipe(
      Argument.withDescription("The gate token, printed when the run asked"),
    ),
    choice: Flag.choice("choice", ["approve", "reject"]).pipe(
      Flag.withDescription("The verdict. One flag, so it is neither contradictory nor missing"),
    ),
    reason: Flag.string("reason").pipe(
      Flag.withDescription(
        "Why. A rejected run is re-prompted from it, so an empty one costs the next attempt its only clue",
      ),
      Flag.withDefault(""),
    ),
    as: Flag.string("as").pipe(
      Flag.withDescription("Who the verdict is attributed to. Defaults to the OS user"),
      Flag.optional,
    ),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDescription(
        "Seconds to watch the run after answering. The run outlives the watching",
      ),
      Flag.withDefault(60),
    ),
  },
  Effect.fn(function* ({ token, choice, reason, as, timeout }) {
    const { database } = yield* root;
    yield* readyFor(database);
    yield* created(database);

    const parsed = yield* parseToken(token).pipe(
      Effect.catch(() => commandFailed(`that is not a gate token: ${token}`)),
    );

    // The token names its workflow, and applying an answer needs that workflow's body registered in
    // *this* process: recording a verdict is a write to the engine's storage, but resuming the run
    // is the runner replaying a body it must therefore have. A CLI that answered without it would
    // record a real verdict and leave the run exactly where it was.
    //
    // Resolved through the same path `kojo run` uses, which is what makes a stamped factory's own
    // gate answerable at all: the token was minted by a workflow in `.kojo/workflows/`, and only a
    // loader that looks there can replay it.
    const runnable = yield* resolve(parsed.workflowName);

    const answerer = yield* Option.match(as, {
      onNone: () => osUser,
      onSome: (given: string) => Effect.succeed(given),
    });
    const gateToken = token as DurableDeferred.Token;
    const runId = parsed.executionId as RunId;

    yield* Effect.gen(function* () {
      const repository = yield* GateRepository;
      const asking = yield* repository.byToken(gateToken);

      // The engine keeps the first answer — `deferredDone` refuses to overwrite a recorded result —
      // so a second answerer is told that rather than shown a success that changed nothing.
      const already = Option.flatMap(asking, (gate) => Option.fromUndefinedOr(gate.verdict));
      if (Option.isSome(already)) {
        yield* Console.log(
          `already answered: ${already.value.choice} by ${already.value.answerer}. ` +
            "The first answer is the one that counts, so nothing was written.",
        );
        return;
      }

      // A gate declares the choices it accepts. Answering with one it does not accept writes a
      // verdict the workflow reads as a rejection — a decision nobody made.
      const declared = Option.map(asking, (gate) => gate.request.choices);
      if (Option.isSome(declared) && !declared.value.includes(choice)) {
        return yield* commandFailed(
          `that gate accepts ${declared.value.join(" or ")}, not ${choice}`,
        );
      }

      const before = yield* askingsSoFar;
      const verdict = yield* answerGate({ token: gateToken, choice, reason, answerer });
      yield* repository.recorded({ token: gateToken, verdict });
      yield* Console.log(`recorded ${choice} on run ${runId}, attributed to ${answerer}`);

      // Recorded is not applied. This process holds a runner, so the run does resume here — but it
      // resumes on the engine's own poll, and until it has, saying anything else would be a lie.
      const stop = yield* stopped({
        runId,
        status: runnable.status(runId),
        known: before,
        within: Duration.seconds(timeout),
      });
      yield* Console.log(describeStop(stop, yield* Clock.currentTimeMillis));
      yield* reportPhases;

      // **What the run did with the answer, in the exit code.** Answering is the moment a human
      // hands the run back to the machine, and a resume that ends in the workflow's own typed
      // error — the rejection this verdict just caused, an agent that could not be called, a check
      // that did not hold — has to say so and exit non-zero. The same rule `kojo run` obeys, from
      // the same function, because a run fails the same way whoever was watching it.
      //
      // A resume that stops at the *next* gate exits `0`: it suspended, which is a success.
      yield* ends({
        runId,
        reached: reachedStatus(stop),
        failure: runnable.failure(runId),
        // No `--wait` here. `--timeout` bounds the watching, and the run outlives the watching of
        // it, so a command that stops looking has nothing to report as a fault.
        promisedToWait: false,
      });
      // One `provide`, one merged layer. The workflow body consumes the engine, the gate and the
      // trace; the handler then reads the askings and the trace back, so both halves stay exported.
    }).pipe(Effect.provide(runnable.layer.pipe(Layer.provideMerge(factory(database)))));
  }),
).pipe(
  Command.withDescription("Answer a gate and let the run continue where it stopped"),
  Command.withExamples([
    {
      command: 'kojo gate answer <token> --choice approve --reason "ships"',
      description: "Approve a waiting gate and watch the run continue",
    },
  ]),
);

export const gate = Command.make("gate").pipe(
  Command.withDescription(
    "The reference gate adapter: what waits on a human, and how to answer it",
  ),
  Command.withSubcommands([list, answer]),
);
