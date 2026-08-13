// Deep path, never the package barrel: the barrel re-exports BunRedis, which imports the `bun`
// builtin and would end this worker before a single test ran.
import { spawnSync } from "node:child_process";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Option } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { factory } from "../../../src/cli/factory.ts";
import { review } from "../../../src/cli/review.ts";
import type { FactorySite } from "../../../src/console/api.ts";
import { appliedSchema, expectedSchema } from "../../../src/console/schemaLedger.ts";
import { served } from "../../../src/console/server.ts";
import * as SqliteGateRepository from "../../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import * as BindMountWorkspace from "../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import * as SqliteDatabase from "../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryArtifactReader from "../../../src/contexts/trace/adapters/InMemoryArtifactReader.ts";
import * as SqliteTraceReader from "../../../src/contexts/trace/adapters/SqliteTraceReader.ts";
import * as SingleNodeEngine from "../../../src/contexts/workflow/adapters/SingleNodeEngine.ts";
import * as SqliteRunnerRepository from "../../../src/contexts/workflow/adapters/SqliteRunnerRepository.ts";
import { status } from "../../../src/contexts/workflow/services/run.ts";
import { askingsSoFar, stopped } from "../../../src/contexts/workflow/services/stopped.ts";

/**
 * **The claim the whole answer endpoint rests on**: a verdict the Console writes is a verdict a
 * runner applies.
 *
 * adr/gate/0001 says the Console records and a live runner applies. That is only true if the write
 * the Console makes lands in the *engine's* storage rather than in Kojo's own askings table — and
 * the Console holds an engine with **no runner address**, which is the one configuration nothing
 * else in this codebase uses. Everything about that could be wrong in a way no unit test would
 * notice, because a fake engine accepts any write.
 *
 * So this is three processes' worth of real work, in order:
 *
 * 1. a separate `kojo` process starts a run and **exits** while it is suspended at a gate;
 * 2. the Console, in this process, over that file, answers the gate through its own HTTP endpoint;
 * 3. a runner — this process, with the workflow registered, exactly as `kojo watch` is — picks the
 *    answer up and the run finishes.
 *
 * Step 3 is the assertion. If the Console's write went anywhere but the engine's storage, the run
 * stays suspended forever and this reports `unsettled`.
 */

const cli = new URL("../../../src/main.ts", import.meta.url).pathname;

/**
 * The Bun that is running this test, which is what the child must also be.
 *
 * The CLI reaches `bun:sqlite` through the engine's SQL client, so a child spawned on Node dies at
 * import — inside a spawn whose failure this file would report as "kojo exited 1".
 */
const bun = (): string => {
  if (process.versions.bun === undefined) {
    throw new Error(
      `this suite must run under Bun, but is running under Node ${process.version}. ` +
        "Run it through the `packages/kojo:test-integration` moon task.",
    );
  }
  return process.execPath;
};

const kojo = (args: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.sync(() => {
    const finished = spawnSync(bun(), [cli, ...args], { encoding: "utf8" });
    if (finished.status !== 0) {
      throw new Error(
        `kojo exited ${finished.status}\nstdout:\n${finished.stdout}\nstderr:\n${finished.stderr}`,
      );
    }
    return finished.stdout ?? "";
  });

/** `run <id>` is the first line of `kojo run`, and the id is what everything else is about. */
const runIdOf = (stdout: string): RunId => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("run "));
  return (line ?? "").slice("run ".length).trim() as RunId;
};

/** Everything the Console needs behind its routes, over one already-open client. */
const consolePorts = (workspace: string) =>
  Layer.mergeAll(
    SqliteTraceReader.layer,
    // The artifacts are not what this test is about, and a workspace read would need a git
    // repository to say anything. The trace reader and the askings are the real ones.
    InMemoryArtifactReader.of({}),
    Layer.orDie(SqliteGateRepository.layer),
    SqliteRunnerRepository.layer,
    // No runner address: this is the configuration under test.
    SingleNodeEngine.layer({ shardingConfig: { runnerAddress: Option.none() } }),
  ).pipe(Layer.provideMerge(BindMountWorkspace.layer({ root: workspace })));

describe("a gate answered from the Console", () => {
  it.live("is applied by a runner that never saw the Console", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-console-gate-" });
      const database = `${root}/kojo.db`;

      // One: a real process starts the run, reaches the gate, and exits. Nothing is held open.
      const started = yield* kojo(["run", "demo-review", "the change", "--database", database]);
      const runId = runIdOf(started);
      expect(runId).not.toBe("");
      expect(started).toContain('suspended at gate "approve"');

      // Two: the Console, over that file, answers through its own endpoint.
      const answered = yield* Effect.gen(function* () {
        const site: FactorySite = {
          database,
          factory: "present",
          version: "0.0.0",
          commit: "development",
          applied: yield* appliedSchema,
          expected: expectedSchema,
        };

        return yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;

          const queue = yield* client.get("/api/gates").pipe(Effect.orDie);
          const listed = JSON.parse(yield* queue.text.pipe(Effect.orDie));
          expect(listed).toHaveLength(1);
          const token: string = listed[0].request.token;

          const receipt = yield* client
            .execute(
              HttpClientRequest.post(`/api/gates/${token}/answer`, {
                body: HttpBody.text(
                  JSON.stringify({ choice: "approve", reason: "ships" }),
                  "application/json",
                ),
              }),
            )
            .pipe(Effect.orDie);

          expect(receipt.status).toBe(200);
          const body = JSON.parse(yield* receipt.text.pipe(Effect.orDie));
          expect(body.verdict.choice).toBe("approve");
          // Nothing is running, so the only honest thing the receipt can say is that it was written
          // down. This is the state adr/gate/0001 insists the Console must never draw as applied.
          expect(body.runner).toBe("none");

          // **And the trace still has no gate record for that asking**, which is the other half of
          // the same sentence and the fact the Console's *applied* state is read from. The record is
          // written by the run itself, in the activity after the suspension, so its absence here is
          // this file's proof that a recorded answer and an applied one are distinguishable from
          // outside — not an assumption the Console makes about its own `POST`.
          const before = yield* client.get(`/api/runs/${runId}`).pipe(Effect.orDie);
          expect(JSON.parse(yield* before.text.pipe(Effect.orDie)).gates).toHaveLength(0);

          return body.verdict.answerer as string;
        }).pipe(
          Effect.provide(
            served({ site, assets: `${root}/no-console-build` }).pipe(
              Layer.provide(consolePorts(root)),
              Layer.provideMerge(BunHttpServer.layerTest),
            ),
          ),
        );
      }).pipe(Effect.provide(Layer.orDie(SqliteDatabase.layer({ path: database }))), Effect.scoped);

      expect(answered).not.toBe("");

      // Three: a runner — this process, with the workflow registered, which is what `kojo watch` is
      // — picks up what the Console wrote. Nothing here answers anything.
      const finished = yield* Effect.gen(function* () {
        const before = yield* askingsSoFar;
        return yield* stopped({
          runId,
          status: status(review.definition, runId),
          known: before,
          // Comfortably inside the tier's own thirty seconds, so a run that never resumes reports
          // `unsettled` — which names the failure — instead of a test timeout, which does not.
          within: Duration.seconds(15),
        });
      }).pipe(
        Effect.provide(review.layer.pipe(Layer.provideMerge(Layer.orDie(factory(database))))),
        Effect.scoped,
        Effect.orDie,
      );

      expect(finished._tag).toBe("finished");
      if (finished._tag === "finished") expect(finished.status).toBe("succeeded");

      // Four: the same read the Console makes, over the same file, now that a runner has applied it.
      //
      // **This is what turns *applied — the run resumed* from a claim into a reading.** Between step
      // two and here the only thing that happened is a runner picking the verdict up, and the one
      // observable difference it left is this record. A Console that drew *applied* from anything
      // else — a 200, a run whose outcome left `suspended` — would be right by luck here and wrong
      // the moment a runner was not running.
      yield* Effect.gen(function* () {
        const site: FactorySite = {
          database,
          factory: "present",
          version: "0.0.0",
          commit: "development",
          applied: yield* appliedSchema,
          expected: expectedSchema,
        };

        return yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const document = yield* client.get(`/api/runs/${runId}`).pipe(Effect.orDie);
          const body = JSON.parse(yield* document.text.pipe(Effect.orDie));

          expect(body.gates).toHaveLength(1);
          expect(body.gates[0].outcome).toBe("answered");
          expect(body.gates[0].choice).toBe("approve");
          expect(body.gates[0].answerer).toBe(answered);

          // Keyed by the asking, which is what the Console matches on. A record the Console could
          // not tie back to the asking it is drawing would leave the card saying *applying…* for
          // ever over a run that had finished.
          const queue = yield* client.get("/api/gates").pipe(Effect.orDie);
          const listed = JSON.parse(yield* queue.text.pipe(Effect.orDie));
          expect(body.gates[0].asking).toBe(listed[0].request.asking);
        }).pipe(
          Effect.provide(
            served({ site, assets: `${root}/no-console-build` }).pipe(
              Layer.provide(consolePorts(root)),
              Layer.provideMerge(BunHttpServer.layerTest),
            ),
          ),
        );
      }).pipe(Effect.provide(Layer.orDie(SqliteDatabase.layer({ path: database }))), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.orDie),
  );
});
