#!/usr/bin/env bun
import { Cause, Console, Duration, Effect, Exit, Layer, Option } from "effect";
import type { DurableDeferred } from "effect/unstable/workflow";
import * as SqliteGateRepository from "../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import { GateRepository } from "../../src/contexts/gate/ports/GateRepository.ts";
import { answerGate } from "../../src/contexts/gate/services/answerGate.ts";
import * as SqliteDatabase from "../../src/contexts/shared/adapters/SqliteDatabase.ts";
import * as SingleNodeEngine from "../../src/contexts/workflow/adapters/SingleNodeEngine.ts";

/**
 * **A verdict written by somebody who cannot apply it.**
 *
 * `kojo gate answer` records the answer *and* rides the resume, because the person at the terminal
 * wants both. That makes it useless for grading a watcher: if the answering process applies the
 * answer itself, a watcher that applied nothing at all would look exactly the same. So this is the
 * other half of record-and-apply on its own — the shape the Console will have (adr/gate/0001), and
 * the only honest way to prove that the *watcher* is what picked the answer up.
 *
 * **`runnerAddress: Option.none()` is the whole mechanism.** Registration, shard locks and the
 * storage inbox are each guarded by the runner address being present, so a Sharding built without
 * one enqueues messages and claims nothing. Measured, not assumed: this process leaves
 * `cluster_runners` empty, and the run it answers stays suspended until a real runner starts.
 */
const [database, token, choice, reason, answerer] = process.argv.slice(2);

const clientOnly = SingleNodeEngine.layer({
  shardingConfig: {
    runnerAddress: Option.none(),
    entityMessagePollInterval: Duration.millis(200),
    entityReplyPollInterval: Duration.millis(200),
    refreshAssignmentsInterval: Duration.millis(200),
  },
}).pipe(
  Layer.provideMerge(
    SqliteGateRepository.layer.pipe(
      Layer.provideMerge(SqliteDatabase.layer({ path: database ?? "" })),
    ),
  ),
);

const program = Effect.gen(function* () {
  const verdict = yield* answerGate({
    token: (token ?? "") as DurableDeferred.Token,
    choice: choice ?? "approve",
    reason: reason ?? "",
    answerer: answerer ?? "recorder",
  });

  // The askings list is updated here for the same reason the CLI updates it: the row is what a
  // human reads, and a verdict that resumed a run without appearing in the list would be invisible.
  yield* Effect.flatMap(GateRepository, (repository) =>
    repository.recorded({ token: (token ?? "") as DurableDeferred.Token, verdict }),
  );

  yield* Console.log(`recorded ${verdict.choice} by ${verdict.answerer}, applied nothing`);
}).pipe(Effect.provide(clientOnly));

const exit = await Effect.runPromiseExit(program);
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
