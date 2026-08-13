import { Clock, Console, Duration, Effect, Layer, Option, Schedule } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { WorkflowEngine } from "effect/unstable/workflow";
import type { RunId } from "../contexts/shared/models/RunId.ts";
import type { RunStatus } from "../contexts/workflow/services/run.ts";
import { askingsSoFar, stopped } from "../contexts/workflow/services/stopped.ts";
import { ends, reachedStatus } from "./ends.ts";
import { created, factory, readyFor } from "./factory.ts";
import { reportPhases } from "./reportPhases.ts";
import { root } from "./root.ts";
import { describeStop } from "./stopLine.ts";
import { choices, type Runnable, resolve } from "./workflows.ts";

const pollEvery = Duration.millis(200);

/**
 * Blocks until the run reaches a terminal status, for scripts that genuinely want that.
 *
 * `--wait` and nothing else, because for anybody standing at a terminal it is the wrong default: a
 * run that stops at a two-day gate would hold the command open for two days, and holding the
 * command open is what this whole design exists to avoid.
 *
 * Polling the status is right *here* and wrong in `stopped`. The question is not which suspension
 * the run is on — a question `poll` cannot answer — but whether it has ended, which is the one
 * question `poll` answers unambiguously. When the patience runs out it reports the last status it
 * saw, so `--wait` on a run that is still suspended says `suspended` rather than pretending.
 */
const untilTerminal = (
  runnable: Runnable,
  runId: RunId,
  within: Duration.Duration,
): Effect.Effect<RunStatus, never, WorkflowEngine.WorkflowEngine> =>
  Effect.repeat(runnable.status(runId), {
    schedule: Schedule.spaced(pollEvery),
    until: (reported: RunStatus) => reported === "succeeded" || reported === "failed",
    times: Math.max(1, Math.ceil(Duration.toMillis(within) / Duration.toMillis(pollEvery))),
  });

/**
 * Starts a run, says where it stopped, and exits.
 *
 * **A suspended run is a success, not a hang.** The run is started with `{ discard: true }`, which
 * returns the run id as soon as the run is recorded rather than when it completes — a bare
 * `execute` on a workflow that stops at a two-day gate leaves the caller unsettled for two days.
 * This command then watches only until the body comes to rest, prints where that was, and exits 0
 * with the question still unanswered. That is the point: the human closes the terminal and answers
 * later, from anywhere.
 */
export const run = Command.make(
  "run",
  {
    workflow: Argument.string("workflow").pipe(
      // Read off `.kojo/workflows/` in the directory this command was launched in, so `--help`
      // describes *this* repository's factory rather than a list compiled into the binary. It is
      // computed while this module loads because that is when the parser is built; see
      // `namesInFactory` for why answering it costs one `readdir` and imports nothing.
      Argument.withDescription(`The workflow to run — ${choices()}`),
    ),
    payload: Argument.string("payload").pipe(
      Argument.withDescription("What the run is about — the greeting's subject, the change's name"),
      Argument.optional,
    ),
    fail: Flag.boolean("fail").pipe(
      Flag.withDescription(
        "`demo-hello` only: make the second phase fail, to show a failed phase records",
      ),
    ),
    wait: Flag.boolean("wait").pipe(
      Flag.withDescription("Block until the run reaches a terminal status, for scripts"),
    ),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDescription("Seconds to watch the run. The run outlives the watching of it"),
      Flag.withDefault(60),
    ),
  },
  Effect.fn(function* ({ workflow, payload, fail, wait, timeout }) {
    const { database } = yield* root;
    yield* readyFor(database);
    yield* created(database);

    // Resolved before the layers are built, so a workflow that is missing, malformed or misnamed is
    // reported by path while nothing has been started, no container exists, and no row is written.
    const runnable = yield* resolve(workflow);
    const within = Duration.seconds(timeout);

    yield* Effect.gen(function* () {
      const before = yield* askingsSoFar;
      const runId = yield* runnable.start({
        payload: Option.getOrElse(payload, () => ""),
        fail,
      });
      yield* Console.log(`run ${runId}`);

      // Where the run got to, said on stdout by both paths, so a script may read the table and the
      // status together and still take the reason off stderr on its own.
      const reached = yield* wait
        ? Effect.tap(untilTerminal(runnable, runId, within), (reported) =>
            Console.log(`run ${reported}`),
          )
        : Effect.gen(function* () {
            const stop = yield* stopped({
              runId,
              status: runnable.status(runId),
              known: before,
              within,
            });
            yield* Console.log(describeStop(stop, yield* Clock.currentTimeMillis));
            return reachedStatus(stop);
          });

      // The table before the reason, and both before the exit. A person reads downwards, so the
      // last thing printed is the thing they act on; a phase table that only printed on success
      // would be missing exactly when it is most wanted.
      yield* reportPhases;
      yield* ends({
        runId,
        reached,
        failure: runnable.failure(runId),
        // `--wait` is the only promise to watch until a run ends that this build makes.
        promisedToWait: wait,
      });
      // One `provide`, one merged layer. The workflow body consumes the engine, the gate and the
      // trace; the handler then reads the askings and the trace back, so both halves stay exported.
    }).pipe(Effect.provide(runnable.layer.pipe(Layer.provideMerge(factory(database)))));
  }),
).pipe(Command.withDescription("Start a workflow and report where it stopped"));
