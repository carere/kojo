import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Console, Effect, FileSystem, Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { HttpServer } from "effect/unstable/http";
import { WorkflowEngine } from "effect/unstable/workflow";
import type { FactorySite } from "../console/api.ts";
import { noticeFor, standingOf } from "../console/FactoryHealth.ts";
import {
  fixtureLayer,
  fixtureNames,
  fixturePresence,
  fixtureRunners,
} from "../console/fixtures.ts";
import { appliedSchema, expectedSchema } from "../console/schemaLedger.ts";
import { served } from "../console/server.ts";
import * as InMemoryGateRepository from "../contexts/gate/adapters/InMemoryGateRepository.ts";
import * as SqliteGateRepository from "../contexts/gate/adapters/SqliteGateRepository.ts";
import * as BindMountWorkspace from "../contexts/sandbox/adapters/BindMountWorkspace.ts";
import * as SqliteDatabase from "../contexts/shared/adapters/SqliteDatabase.ts";
import { BuildInfo } from "../contexts/shared/models/BuildInfo.ts";
import * as InMemoryArtifactReader from "../contexts/trace/adapters/InMemoryArtifactReader.ts";
import * as InMemoryTraceReader from "../contexts/trace/adapters/InMemoryTraceReader.ts";
import * as SqliteTraceReader from "../contexts/trace/adapters/SqliteTraceReader.ts";
import * as WorkspaceArtifactReader from "../contexts/trace/adapters/WorkspaceArtifactReader.ts";
import * as InMemoryRunnerRepository from "../contexts/workflow/adapters/InMemoryRunnerRepository.ts";
import * as SingleNodeEngine from "../contexts/workflow/adapters/SingleNodeEngine.ts";
import * as SqliteRunnerRepository from "../contexts/workflow/adapters/SqliteRunnerRepository.ts";
import { root as sharedFlags } from "./root.ts";

/** Where the Console listens when nobody says otherwise. Loopback only, per adr/gate/0001. */
const defaultPort = 4321;

/**
 * The line that says where to point a browser, printed once the port is actually open.
 *
 * **It requires `HttpServer`, and that is the whole reason it is a layer.** Printed from the
 * handler it would come out before `Layer.launch` built anything, so a person who followed it
 * immediately would meet a refused connection — and so would anything scripting this command.
 * Asking for the server makes the framework order the two.
 */
const announce = (line: string): Layer.Layer<never, never, HttpServer.HttpServer> =>
  Layer.effectDiscard(Effect.andThen(HttpServer.HttpServer, Console.log(line)));

/**
 * Where the built Console lives inside the published package.
 *
 * Beside the sources rather than in the repository's `apps/`, because `kojo ui` has to work for
 * somebody who installed Kojo rather than only for somebody who cloned it: `console:build` is a
 * build dependency of the published package and its output lands here (console.md §12). Until that
 * build exists there is no directory, and the server says so with a placeholder rather than a blank
 * page.
 */
const defaultAssets = new URL("../../console", import.meta.url).pathname;

/**
 * The Console: one command, one factory, one process.
 *
 * It serves the static build and a JSON API over one trace, and it is deliberately **not** a second
 * runtime. Three properties follow from that, and each has a record behind it:
 *
 * - **It never becomes a runner.** The engine it holds is configured with no runner address, which
 *   is a client-only Sharding: it can write a verdict into the engine's storage, and it registers no
 *   row in `cluster_runners`. That is what keeps `/api/health` honest — a Console that registered
 *   itself would find its own row and report a live runner while nothing was running (adr/gate/0001).
 * - **It never migrates.** The reader runs no migration, and the ledger is *read* here, before any
 *   layer is built, precisely because a failing migration is `Effect.die` and nothing downstream
 *   could catch it. A schema older than this build is a loud warning rather than a crash.
 * - **A repository with no factory is a message, not an error.** The command still serves, health
 *   says the factory is absent, and every list is empty — which is what a person who has not run
 *   `kojo init` should see (console.md §10).
 */
export const ui = Command.make(
  "ui",
  {
    port: Flag.integer("port").pipe(
      Flag.withDescription("The port to listen on. Loopback only; v1 has no authentication"),
      Flag.withDefault(defaultPort),
    ),
    assets: Flag.string("assets").pipe(
      Flag.withDescription(
        "The directory holding the Console build. A placeholder is served when it holds no index.html",
      ),
      Flag.withDefault(defaultAssets),
    ),
    root: Flag.string("root").pipe(
      Flag.withDescription(
        "The repository the artifacts are read from — prompts, sessions, and diffs from git",
      ),
      Flag.withDefault("."),
    ),
    fixtures: Flag.choice("fixtures", fixtureNames).pipe(
      Flag.withDescription(
        "Serve a stated trace instead of the database — what the Console's browser tests run against",
      ),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ port, assets, root, fixtures }) {
    const { database } = yield* sharedFlags;
    const build = yield* BuildInfo;
    const fileSystem = yield* FileSystem.FileSystem;

    // **The database is not opened at all**, which is the whole point of the flag: the browser tier
    // exercises the real routes, the real Query wiring and the real components with nothing faked
    // but the records (console.md §11). A fixture server that still touched SQLite would be testing
    // the driver as well, and could not be asked for a gate held for forty-one hours.
    if (Option.isSome(fixtures)) {
      const name = fixtures.value;
      const factory = fixturePresence(name);
      const site: FactorySite = {
        database: `fixtures:${name}`,
        factory,
        version: build.version,
        commit: build.commit,
        // A stated trace has no ledger to read. It claims the schema this build expects, so the
        // Console renders the ordinary case rather than the *older schema* warning.
        applied: factory === "absent" ? 0 : expectedSchema,
        expected: expectedSchema,
      };

      return yield* Layer.launch(
        announce(`console on http://localhost:${port} — fixtures ${name}`).pipe(
          Layer.provideMerge(
            served({ site, assets }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  fixtureLayer(name),
                  // Whatever the fixture states, which for every one of them but `watching` is
                  // nothing — true of a server reading records that no process is executing. The
                  // one that states a live registration is what puts a gate card into *recorded —
                  // applying…* instead of *recorded — nothing is running*.
                  InMemoryRunnerRepository.of(fixtureRunners(name)),
                  WorkflowEngine.layerMemory,
                ),
              ),
              Layer.provideMerge(BunHttpServer.layer({ port })),
            ),
          ),
        ),
      );
    }

    // **Asked before the file is opened, and that is the point.** The driver creates the file it is
    // pointed at, so a Console that opened it to find out whether a factory exists would answer by
    // creating one. Looking must never be an act of writing.
    const present = yield* fileSystem.exists(database).pipe(Effect.orElseSucceed(() => false));

    if (!present) {
      const site: FactorySite = {
        database,
        factory: "absent",
        version: build.version,
        commit: build.commit,
        applied: 0,
        expected: expectedSchema,
      };
      yield* Console.error(
        noticeFor({
          factory: "absent",
          standing: "unwritten",
          applied: 0,
          expected: expectedSchema,
        }),
      );
      return yield* Layer.launch(
        announce(`console on http://localhost:${port} — no database at ${database}`).pipe(
          Layer.provideMerge(
            served({ site, assets }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  // Empty rather than missing: every list answers *nothing yet*, every run answers
                  // *no such run*, and no token names an asking. All of that is true of a repository
                  // nobody has run `kojo init` in, and it is what console.md §10 asks for.
                  InMemoryTraceReader.of({}),
                  InMemoryArtifactReader.of({}),
                  InMemoryGateRepository.layer,
                  InMemoryRunnerRepository.of([]),
                  WorkflowEngine.layerMemory,
                ),
              ),
              Layer.provideMerge(BunHttpServer.layer({ port })),
            ),
          ),
        ),
      );
    }

    return yield* Effect.gen(function* () {
      // Read, never run: the ledger is a `select`, and the migrator is a process-ending defect.
      const applied = yield* appliedSchema;
      const site: FactorySite = {
        database,
        factory: "present",
        version: build.version,
        commit: build.commit,
        applied,
        expected: expectedSchema,
      };

      const notice = noticeFor({
        factory: "present",
        standing: standingOf(applied, expectedSchema),
        applied,
        expected: expectedSchema,
      });
      if (notice !== undefined) yield* Console.error(notice);

      return yield* Layer.launch(
        announce(`console on http://localhost:${port} — database ${database}`).pipe(
          Layer.provideMerge(
            served({ site, assets }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  SqliteTraceReader.layer,
                  WorkspaceArtifactReader.layer.pipe(
                    Layer.provide(BindMountWorkspace.layer({ root })),
                  ),
                  Layer.orDie(SqliteGateRepository.layer),
                  SqliteRunnerRepository.layer,
                  // **No runner address, so no runner.** A verdict written here lands in the
                  // engine's storage and waits for whatever is running to pick it up, and this
                  // process registers nothing `/api/health` could mistake for somebody else.
                  SingleNodeEngine.layer({ shardingConfig: { runnerAddress: Option.none() } }),
                ),
              ),
              Layer.provideMerge(BunHttpServer.layer({ port })),
            ),
          ),
        ),
      );
    }).pipe(
      // One client for the ledger read, the trace, the askings, the registrations and the engine.
      // Two layers on one path are two `bun:sqlite` handles with two independent write serializers.
      Effect.provide(Layer.orDie(SqliteDatabase.layer({ path: database }))),
    );
  }),
).pipe(
  Command.withDescription("Serve the Console: one factory's trace, read from a browser"),
  Command.withExamples([
    {
      command: "kojo ui --port 4321",
      description: "Read this repository's runs, and answer what waits on a human",
    },
    {
      command: "kojo ui --fixtures busy",
      description: "Serve a stated trace — no database is opened, and nothing is written",
    },
  ]),
);
