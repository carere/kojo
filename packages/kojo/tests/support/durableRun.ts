#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { Cause, Duration, Effect, Exit, Layer, Schedule, Schema } from "effect";
import { Activity, DurableDeferred, Workflow } from "effect/unstable/workflow";
import * as SqliteDatabase from "../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../src/contexts/shared/models/RunId.ts";
import * as SingleNodeEngine from "../../src/contexts/workflow/adapters/SingleNodeEngine.ts";
import { type RunStatus, start, status } from "../../src/contexts/workflow/services/run.ts";

/**
 * One run that waits on something outside itself, driven from a command line.
 *
 * It exists so a test can start a run in one process, kill that process, and finish the run in
 * another — which is the only honest way to assert that a suspended run survives the process
 * exiting. Nothing here uses a Kojo port: the subject is the engine and the database client, and
 * a real `Tracer` does not exist yet.
 */
const reviewed = Workflow.make("durable-run", {
  payload: { subject: Schema.String },
  success: Schema.String,
  error: Schema.Never,
  idempotencyKey: (payload) => `durable-run/${payload.subject}`,
});

const review = DurableDeferred.make("review", { success: Schema.String });

/**
 * Two activities around the wait, each appending one line to a file.
 *
 * The file is the replay assertion. The second process replays the whole body, so a run that
 * survived correctly leaves `announce` exactly once — recorded activity results come back without
 * their side effect running again — and `land` exactly once, from the process that finished it.
 */
const registered = (log: string) =>
  reviewed.toLayer(() =>
    Effect.gen(function* () {
      yield* Activity.make({
        name: "announce",
        success: Schema.Void,
        error: Schema.Never,
        execute: Effect.sync(() => appendFileSync(log, "announce\n")),
      });

      const verdict = yield* DurableDeferred.await(review);

      yield* Activity.make({
        name: "land",
        success: Schema.Void,
        error: Schema.Never,
        execute: Effect.sync(() => appendFileSync(log, "land\n")),
      });

      return verdict;
    }),
  );

/**
 * One client, built once, under both the engine's storage and anything else on the file.
 *
 * The poll intervals are the cluster's defaults compressed: ten seconds is the right answer for a
 * factory and the wrong one for a test that would otherwise wait ten seconds to notice an answer
 * another process already wrote.
 */
const layers = (database: string, log: string) =>
  registered(log).pipe(
    Layer.provideMerge(
      SingleNodeEngine.layer({
        shardingConfig: {
          entityMessagePollInterval: Duration.millis(100),
          entityReplyPollInterval: Duration.millis(100),
          refreshAssignmentsInterval: Duration.millis(100),
        },
      }),
    ),
    Layer.provideMerge(SqliteDatabase.layer({ path: database })),
  );

/** Polls until the run reports one of the wanted statuses, or gives up. */
const waitFor = (runId: RunId, wanted: ReadonlyArray<RunStatus>) =>
  Effect.repeat(status(reviewed, runId), {
    schedule: Schedule.spaced(Duration.millis(50)),
    until: (reported: RunStatus) => wanted.includes(reported),
    times: 200,
  });

const started = (subject: string) =>
  Effect.gen(function* () {
    const runId = yield* start(reviewed, { subject });
    return { runId, status: yield* waitFor(runId, ["suspended", "succeeded", "failed"]) };
  });

const answered = (runId: RunId, verdict: string) =>
  Effect.gen(function* () {
    yield* DurableDeferred.succeed(review, {
      // The answering process rebuilds the token from the run id alone. Nothing has to be carried
      // across the process boundary except the id the first process printed.
      token: DurableDeferred.tokenFromExecutionId(review, {
        workflow: reviewed,
        executionId: runId,
      }),
      value: verdict,
    });
    return { runId, status: yield* waitFor(runId, ["succeeded", "failed"]) };
  });

const [command, database, log, ...rest] = process.argv.slice(2);

const program =
  command === "start"
    ? started(rest[0] ?? "one")
    : command === "answer"
      ? answered((rest[0] ?? "") as RunId, rest[1] ?? "approve")
      : Effect.die(`unknown command: ${command}`);

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(layers(database ?? "", log ?? ""))),
);

if (Exit.isSuccess(exit)) {
  console.log(JSON.stringify(exit.value));
} else {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
