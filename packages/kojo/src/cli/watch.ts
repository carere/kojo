import { Clock, Console, Duration, Effect, Layer, Path } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as InMemoryTracer from "../contexts/trace/adapters/InMemoryTracer.ts";
import * as InboxTrigger from "../contexts/trigger/adapters/InboxTrigger.ts";
import type { WatchNotice } from "../contexts/trigger/models/WatchNotice.ts";
import { watch as watchRuns } from "../contexts/trigger/services/watch.ts";
import * as FileRunLock from "../contexts/workflow/adapters/FileRunLock.ts";
import { RunnerRepository } from "../contexts/workflow/ports/RunnerRepository.ts";
import { commandFailed } from "./CommandFailed.ts";
import { created, factory, readyFor, runners } from "./factory.ts";
import { renderPhaseTable } from "./phaseTable.ts";
import { root } from "./root.ts";
import { describeNotice, describeRunners } from "./watchLine.ts";
import { bodiesOf, choices, everything } from "./workflows.ts";

/** Where events are dropped when nobody says otherwise. Beside the database, in the factory. */
const defaultInbox = ".kojo/inbox";

/** What this process calls itself in a claim, so a refused runner reports something findable. */
const holder = `watch-${process.pid}`;

/**
 * The factory, running unattended — the mode a real one runs in.
 *
 * Everything before this ticket is a command a person waits for. This is the process that is still
 * there tomorrow: it starts runs from the trigger, it is the live runner that applies the verdicts
 * other processes wrote while it was down, and it says out loud which runs are waiting on somebody
 * and which have been waiting too long.
 *
 * Three things it does deliberately:
 *
 * - **Every workflow is registered, not only the one being driven.** Applying an answer needs the
 *   body in *this* process, and a run adopted from a previous instance may belong to any workflow
 *   this build has. A watcher holding fewer would record answers it could never apply.
 * - **It reports the registration table before it becomes a runner.** Every runner registers at the
 *   same address by default, so asking afterwards would find its own row.
 * - **It claims each run it drives.** Two processes against one run id contend for one worktree, so
 *   the second is refused and says so rather than racing the first (architecture.md §8 edge 9).
 *
 * Stopping it with Ctrl-C is a clean shutdown: sharding unregisters, and the table it registered in
 * goes back to empty. Killing it leaves the row behind, and that row ages out in thirty-five
 * seconds rather than claiming a runner forever.
 */
export const watch = Command.make(
  "watch",
  {
    workflow: Argument.string("workflow").pipe(
      Argument.withDescription(`The workflow the trigger's events start — ${choices()}`),
    ),
    inbox: Flag.string("inbox").pipe(
      Flag.withDescription(
        'The directory events are dropped in, one JSON file each: { "key": …, "payload": … }',
      ),
      Flag.withDefault(defaultInbox),
    ),
    sweep: Flag.integer("sweep").pipe(
      Flag.withDescription(
        "Seconds between readings of the askings — how promptly an overdue run is surfaced",
      ),
      Flag.withDefault(5),
    ),
    poll: Flag.integer("poll").pipe(
      Flag.withDescription("Seconds between readings of the inbox when it is empty"),
      Flag.withDefault(2),
    ),
  },
  Effect.fn(function* ({ workflow, inbox, sweep, poll }) {
    const { database } = yield* root;
    const path = yield* Path.Path;
    yield* readyFor(database);
    yield* created(database);

    // Everything, and by path: a watcher adopts runs it never started, so a workflow file that does
    // not load is found here — before this process registers as a runner — rather than when a
    // suspended run belonging to it is answered two days later.
    const runnables = yield* everything();
    const runnable = runnables.find((candidate) => candidate.name === workflow);
    if (runnable === undefined) {
      return yield* commandFailed(`unknown workflow: ${workflow}. Known workflows — ${choices()}`);
    }

    // Before the engine, and therefore before this process has a row of its own.
    const registered = yield* Effect.flatMap(
      RunnerRepository,
      (repository) => repository.registered,
    ).pipe(Effect.provide(runners(database)));
    yield* Console.log(describeRunners(registered));

    yield* Console.log(
      `watching ${runnable.name} — inbox ${inbox}, database ${database}, runner ${holder}`,
    );

    yield* Effect.gen(function* () {
      const trace = yield* InMemoryTracer.RecordedTrace;

      /**
       * Every notice as a line, and a finished run as its phases.
       *
       * **The phase table is the replay witness.** The trace is this process's own, so what it
       * holds for a resumed run is what *this* watcher executed — the phases after the gate, and
       * not the ones before it, whose recorded activity results came back without their bodies
       * running again. A phase from before the gate appearing here would mean the work was done
       * twice, which is the one thing the whole durability design exists to prevent.
       */
      const report = (notice: WatchNotice) =>
        Effect.gen(function* () {
          yield* Console.log(describeNotice(notice, yield* Clock.currentTimeMillis));
          if (notice._tag !== "ended") return;

          const phases = (yield* trace.phases).filter((phase) => phase.runId === notice.runId);
          yield* Console.log(
            `phases this watcher ran for ${notice.runId}:\n${renderPhaseTable(phases)}\n`,
          );
        });

      yield* watchRuns({
        driving: runnable,
        known: runnables,
        report,
        sweepEvery: Duration.seconds(sweep),
      });
    }).pipe(
      // Said on every exit path, including the interrupt Ctrl-C raises, because the line after it
      // is the registration being removed — and a watcher that vanished without a word is
      // indistinguishable from one that was killed.
      Effect.ensuring(Console.log("stopped watching")),
      Effect.provide(
        bodiesOf(runnables).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              factory(database),
              InboxTrigger.layer({ directory: inbox, interval: Duration.seconds(poll) }),
              FileRunLock.layer({
                // Beside the database, never inside a worktree: a claim outlives the branch it is
                // about, and a worktree is what a rebuilt sandbox deletes.
                directory: path.join(path.dirname(database), "claims"),
                holder,
              }),
            ),
          ),
        ),
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Run the factory unattended: drive the trigger, and apply what is answered",
  ),
  Command.withExamples([
    {
      command: "kojo watch review --inbox .kojo/inbox",
      description: "Start runs from files dropped in the inbox, and keep suspended runs alive",
    },
  ]),
);
