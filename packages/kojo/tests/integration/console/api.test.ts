// Deep path, never the package barrel: the barrel re-exports BunRedis, which imports the `bun`
// builtin and would end this worker before a single test ran.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, type PlatformError } from "effect";
import { HttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { FactorySite } from "../../../src/console/api.ts";
import { appliedSchema, expectedSchema } from "../../../src/console/schemaLedger.ts";
import { served } from "../../../src/console/server.ts";
import * as SqliteGateRepository from "../../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import * as BindMountWorkspace from "../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import * as SqliteDatabase from "../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import { makePhaseId } from "../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import * as SqliteTraceReader from "../../../src/contexts/trace/adapters/SqliteTraceReader.ts";
import * as SqliteTracer from "../../../src/contexts/trace/adapters/SqliteTracer.ts";
import * as WorkspaceArtifactReader from "../../../src/contexts/trace/adapters/WorkspaceArtifactReader.ts";
import { artifactsRoot } from "../../../src/contexts/trace/adapters/WorkspaceArtifactReader.ts";
import { PhaseRecord } from "../../../src/contexts/trace/models/PhaseRecord.ts";
import { RunRecord } from "../../../src/contexts/trace/models/RunRecord.ts";
import { Tracer } from "../../../src/contexts/trace/ports/Tracer.ts";
import * as SingleNodeEngine from "../../../src/contexts/workflow/adapters/SingleNodeEngine.ts";
import * as SqliteRunnerRepository from "../../../src/contexts/workflow/adapters/SqliteRunnerRepository.ts";

/**
 * The whole Console over the real adapters, on a real socket.
 *
 * Every port here is the durable one: the trace reader reads the file the writer wrote, the askings
 * are the SQLite ones, the registrations come from the cluster's own table, and the artifacts are
 * files under a real workspace. What that buys over the unit tier is three claims a fake cannot
 * make:
 *
 * - the health document reports the migration the **file** has applied;
 * - the Console registers no runner of its own, so the liveness it reports is somebody else's;
 * - an artifact is served from the disk with the header that says it never changes.
 */

const runId = "run-live" as RunId;
const drafted = makePhaseId(runId, "draft", 1);

const record = new RunRecord({
  runId,
  workflow: "review",
  idempotencyKey: `review/${runId}`,
  startedAt: 500,
  engineVersion: "0.0.0",
  engineCommit: "development",
  configDigest: "sha256:abc",
  host: "builder-1",
});

const phase = new PhaseRecord({
  runId,
  phaseId: drafted,
  name: "draft",
  description: "the draft phase",
  kind: "agent",
  outcome: "succeeded",
  attempt: 1,
  startedAt: 1_000,
  endedAt: 2_000,
});

interface Answered {
  readonly status: number;
  readonly type: string;
  readonly cacheControl: string;
  readonly body: string;
}

const gets = (path: string): Effect.Effect<Answered, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(path);
    return {
      status: response.status,
      type: response.headers["content-type"] ?? "",
      cacheControl: response.headers["cache-control"] ?? "",
      body: yield* response.text,
    };
  }).pipe(Effect.orDie);

/**
 * One Console over one file and one workspace, with the trace already written.
 *
 * The writer runs first and through `provideMerge`, because the writer owns the schema: the reader
 * migrates nothing, so the migrations have to have happened before anything asks. Both are over the
 * **same** client, which is the rule the whole database layer exists to state.
 */
const serving = <A, E>(
  use: (options: {
    readonly database: string;
    readonly workspace: string;
  }) => Effect.Effect<A, E, HttpClient.HttpClient | SqlClient.SqlClient>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-console-api-" });
    const database = `${root}/kojo.db`;
    const workspace = `${root}/repo`;

    yield* fileSystem.makeDirectory(`${workspace}/${artifactsRoot}/${drafted}`, {
      recursive: true,
    });
    yield* fileSystem.writeFileString(
      `${workspace}/${artifactsRoot}/${drafted}/prompt.md`,
      "# what the agent was asked",
    );

    return yield* Effect.gen(function* () {
      const tracer = yield* Tracer;
      yield* tracer.runStarted(record);
      yield* tracer.phase(phase);

      // Read after the writer has migrated, and never by migrating: this is the same `select` the
      // command makes before it builds anything, so what the health document reports is what the
      // file says rather than what this build hopes.
      const site: FactorySite = {
        database,
        factory: "present",
        version: "0.0.0",
        commit: "development",
        applied: yield* appliedSchema,
        expected: expectedSchema,
      };

      return yield* use({ database, workspace }).pipe(
        Effect.provide(
          served({ site, assets: `${root}/no-console-build` }).pipe(
            Layer.provide(
              Layer.mergeAll(
                SqliteTraceReader.layer,
                WorkspaceArtifactReader.layer.pipe(
                  Layer.provide(BindMountWorkspace.layer({ root: workspace })),
                ),
                Layer.orDie(SqliteGateRepository.layer),
                SqliteRunnerRepository.layer,
                // The Console's own engine: **no runner address**, so client-only sharding.
                SingleNodeEngine.layer({ shardingConfig: { runnerAddress: Option.none() } }),
              ),
            ),
            Layer.provideMerge(BunHttpServer.layerTest),
          ),
        ),
      );
    }).pipe(
      // One provide and one client. The writer owns the schema, so it is `provideMerge` beneath the
      // rest: its migrations must have run before anything reads, and the reader migrates nothing.
      Effect.provide(
        Layer.orDie(SqliteTracer.layer).pipe(
          Layer.provideMerge(Layer.orDie(SqliteDatabase.layer({ path: database }))),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("the Console over a real trace", () => {
  it.live("answers the run list from the file the writer wrote", () =>
    serving(() =>
      Effect.gen(function* () {
        const runs = yield* gets("/api/runs");
        expect(runs.status).toBe(200);
        expect(runs.type).toContain("application/json");

        const listed = JSON.parse(runs.body);
        expect(listed).toHaveLength(1);
        expect(listed[0].run.runId).toBe(runId);
        expect(listed[0].run.configDigest).toBe("sha256:abc");

        const document = yield* gets(`/api/runs/${runId}`);
        expect(document.status).toBe(200);
        expect(JSON.parse(document.body).phases.map((each: { name: string }) => each.name)).toEqual(
          ["draft"],
        );
      }),
    ).pipe(Effect.orDie),
  );

  it.live("reports the migration the file has applied, and no runner of its own", () =>
    serving(() =>
      Effect.gen(function* () {
        const health = yield* gets("/api/health");
        expect(health.status).toBe(200);

        const body = JSON.parse(health.body);
        expect(body.factory).toBe("present");
        expect(body.schemaApplied).toBe(expectedSchema);
        expect(body.schema).toBe("current");

        // **The claim adr/gate/0001 exists to protect.** This process holds an engine, so a Console
        // built the obvious way would have registered at the default address and then found its own
        // row — reporting a live runner while nothing was running. With no runner address there is
        // nothing to find, and the honest answer is `none`.
        //
        // **Read what this grades, and what it does not.** The engine above is built *by this file*,
        // and it restates `runnerAddress: Option.none()` rather than importing the one `kojo ui`
        // wires. So it proves the API answers honestly for a client-only engine — it does **not**
        // protect `src/cli/ui.ts` from regaining an address. Measured during the wave-8 merge:
        // changing `ui.ts` to `shardingConfig: {}` leaves this test green, and is caught only by
        // `tests/integration/cli/ui.test.ts`, which spawns the real command. That file is where the
        // Console's own wiring is graded; keep its `runner` assertion.
        expect(body.runner).toBe("none");

        const sql = yield* SqlClient.SqlClient;
        const registrations = yield* sql
          .unsafe<{ readonly address: string }>("select address from cluster_runners")
          .pipe(Effect.orDie);
        expect(registrations).toEqual([]);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("serves an artifact off the disk, cacheable forever", () =>
    serving(() =>
      Effect.gen(function* () {
        const prompt = yield* gets(
          `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/prompt`,
        );
        expect(prompt.status).toBe(200);
        expect(prompt.body).toBe("# what the agent was asked");
        expect(prompt.type).toContain("text/markdown");
        // The phase has a record, so it has exited, so its artifacts cannot change.
        expect(prompt.cacheControl).toBe("public, max-age=31536000, immutable");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("says absent for an artifact nothing ever captured", () =>
    serving(() =>
      Effect.gen(function* () {
        const session = yield* gets(
          `/api/runs/${runId}/phases/${encodeURIComponent(drafted)}/session`,
        );
        // One missing artifact never fails the whole panel: it is a 404 about that one file, and the
        // phase record it belongs to is still served in full by the run document.
        expect(session.status).toBe(404);
        expect(JSON.parse(session.body).error).toBe("no-such-artifact");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("has an empty gate queue on a factory nobody has asked anything", () =>
    serving(() =>
      Effect.gen(function* () {
        const gates = yield* gets("/api/gates");
        expect(gates.status).toBe(200);
        expect(JSON.parse(gates.body)).toEqual([]);
      }),
    ).pipe(Effect.orDie),
  );
});

/** Every `null` in a JSON tree, named by where it is, because "there is a null" is not a bug report. */
const nullsIn = (value: unknown, path = "$"): ReadonlyArray<string> => {
  if (value === null) return [path];
  if (Array.isArray(value))
    return value.flatMap((each, index) => nullsIn(each, `${path}[${index}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, each]) =>
      nullsIn(each, `${path}.${key}`),
    );
  }
  return [];
};

/**
 * **The shape this reader puts on the wire — the defect the whole browser tier could not see.**
 *
 * The records above are as absent as a record gets: no image digest, no outcome, nothing in flight,
 * and a phase with no sandbox, no error, no agent, no verification and no repository effect. Nine
 * fields with nothing in them, built by `SqliteTraceReader` out of nine null columns.
 *
 * Before adr/trace/0003 this reader passed `undefined` for each of them, which the JSON serializer
 * writes as `null` — while `console/fixtures.ts` omitted them, which it writes as nothing. So the
 * browser tier was shown one document and a person was served the other, and the Console's twenty
 * `x === undefined` guards were all correct about a shape they never met. `spansOf` fell through and
 * threw on `inFlight.phaseId` for every non-terminal run in existence.
 *
 * The mirror of this test is in `tests/unit/console/fixtures.test.ts`, over the stated records. Two
 * producers, one assertion, and neither can drift without reddening its own tier.
 */
describe("what a real trace puts on the wire", () => {
  it.live("sends no null anywhere, on any route", () =>
    serving(() =>
      Effect.gen(function* () {
        for (const path of ["/api/runs", `/api/runs/${runId}`, "/api/gates", "/api/health"]) {
          const answered = yield* gets(path);
          expect(answered.status).toBe(200);
          expect(nullsIn(JSON.parse(answered.body), path)).toEqual([]);
        }
      }),
    ).pipe(Effect.orDie),
  );

  it.live("omits the in-flight key on a run that has nothing in flight", () =>
    serving(() =>
      Effect.gen(function* () {
        const document = JSON.parse((yield* gets(`/api/runs/${runId}`)).body) as {
          readonly run: Record<string, unknown>;
          readonly phases: ReadonlyArray<Record<string, unknown>>;
        };

        // Missing, not present holding `null`. That is the difference the run view threw on, and
        // `toBeUndefined` would pass on both — `JSON.parse` gives `null`, and `null === undefined`
        // is false, which is the whole bug in one line.
        expect(Object.keys(document.run)).not.toContain("inFlight");
        expect(Object.keys(document.run)).not.toContain("outcome");
        expect(Object.keys(document.run.run as Record<string, unknown>)).not.toContain(
          "imageDigest",
        );
        expect(Object.keys(document.phases[0] ?? {})).not.toContain("sandboxId");
        expect(Object.keys(document.phases[0] ?? {})).not.toContain("verification");
      }),
    ).pipe(Effect.orDie),
  );
});
