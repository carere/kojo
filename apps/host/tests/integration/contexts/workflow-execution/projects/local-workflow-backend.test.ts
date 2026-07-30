import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Fiber, Layer, Schedule, Schema } from "effect";
import {
  completeProjectRepositoryMigration,
  DrizzleProjectRepositoryLive,
  migrateProjectRepository,
} from "../../../../../src/contexts/workflow-execution/projects/repositories/drizzle-project-repository";
import { ProjectRepository } from "../../../../../src/contexts/workflow-execution/projects/repositories/project-repository";
import { makeLocalWorkflowBackendLayer } from "../../../../../src/contexts/workflow-execution/projects/services/local-workflow-backend";
import {
  ProjectRuntime,
  ProjectRuntimeLive,
} from "../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import {
  type LocalWorkflowDefinition,
  WorkflowBackend,
  type WorkflowBackendReference,
  type WorkflowBackendState,
} from "../../../../../src/contexts/workflow-execution/projects/services/workflow-backend";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Local Workflow backend ownership", () => {
  it.live("retries bounded ownership contention and acquires after release", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-backend-ownership-retry-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const projectPath = join(directory, "project");
      yield* Effect.promise(() =>
        mkdir(join(projectPath, ".kojo"), { recursive: true, mode: 0o700 }),
      );
      const project: ProjectSnapshot = {
        identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
        path: projectPath,
      };
      const firstContext = yield* Layer.build(makeLocalWorkflowBackendLayer("first-host"));
      const secondContext = yield* Layer.build(makeLocalWorkflowBackendLayer("second-host"));
      const first = Context.get(firstContext, WorkflowBackend);
      const second = Context.get(secondContext, WorkflowBackend);
      expect(yield* first.acquire(project)).toBe(true);

      const waiting = yield* Effect.forkChild(second.acquire(project), {
        startImmediately: true,
      });
      yield* Effect.sleep("40 millis");
      yield* first.release(project);
      expect(yield* Fiber.join(waiting)).toBe(true);
    }),
  );

  it.live("keeps exclusive ownership until failed migration restoration completes", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-backend-owned-restoration-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const projectPath = join(directory, "project");
      yield* Effect.promise(() =>
        mkdir(join(projectPath, ".kojo"), { recursive: true, mode: 0o700 }),
      );
      const project: ProjectSnapshot = {
        identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
        path: projectPath,
      };
      let restorationStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        restorationStarted = resolve;
      });
      let restorationComplete = false;

      const firstContext = yield* Layer.build(makeLocalWorkflowBackendLayer("first-host"));
      const secondContext = yield* Layer.build(makeLocalWorkflowBackendLayer("second-host"));
      const first = Context.get(firstContext, WorkflowBackend);
      const second = Context.get(secondContext, WorkflowBackend);
      const backend = Layer.succeed(WorkflowBackend, {
        ...first,
        initialize: () => Effect.succeed(true),
        postflight: () => Effect.succeed(false),
        readiness: () => Effect.succeed("uninitialized" as const),
      });
      const store = Layer.succeed(ProjectRepository, {
        migrate: () => Effect.succeed(true),
        postflight: () => Effect.succeed(true),
        completeMigration: (_project, succeeded) =>
          succeeded
            ? Effect.succeed(true)
            : Effect.gen(function* () {
                restorationStarted();
                yield* Effect.sleep("40 millis");
                restorationComplete = true;
                return false;
              }),
        readiness: () => Effect.succeed("limited" as const),
        inspectForgetBlockers: () =>
          Effect.succeed({
            assessment: "available" as const,
            enabledScheduleKeys: [],
            nonFinalRunIds: [],
          }),
      });
      const runtimeContext = yield* Layer.build(
        ProjectRuntimeLive.pipe(Layer.provide([store, backend])),
      );
      const runtime = Context.get(runtimeContext, ProjectRuntime);
      const activation = yield* Effect.forkChild(
        runtime.coordinateRegistration(project, Effect.succeed({}), (ready) =>
          Effect.succeed(ready),
        ),
        { startImmediately: true },
      );
      yield* Effect.promise(() => started);
      const competing = yield* Effect.forkChild(second.acquire(project), {
        startImmediately: true,
      });
      const competingAcquired = yield* Fiber.join(competing);
      const completeWhenAcquired = restorationComplete;
      yield* second.release(project);

      expect({
        activation: yield* Fiber.join(activation),
        competingAcquired,
        completeWhenAcquired,
      }).toEqual({
        activation: false,
        competingAcquired: true,
        completeWhenAcquired: true,
      });
    }),
  );

  it.live("quiesces an initialized Workflow backend before restoring a failed migration", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-backend-initialized-restoration-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const projectPath = join(directory, "project");
      const dataPath = join(projectPath, ".kojo");
      yield* Effect.promise(() => mkdir(dataPath, { recursive: true, mode: 0o700 }));
      const project: ProjectSnapshot = {
        identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
        path: projectPath,
      };
      yield* Effect.promise(() =>
        writeFile(
          join(dataPath, "project.json"),
          `${JSON.stringify({ layoutVersion: 1, projectIdentity: project.identity })}\n`,
          { mode: 0o600 },
        ),
      );
      const databasePath = join(dataPath, "kojo.sqlite");
      yield* Effect.sync(() => {
        const database = new Database(databasePath, { create: true, strict: true });
        database.exec(`CREATE TABLE kojo_project_store_identity (
          singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
          project_identity TEXT NOT NULL UNIQUE,
          database_instance_id TEXT NOT NULL UNIQUE
        ) STRICT`);
        database
          .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
          .run(project.identity, randomUUID());
        database.exec("PRAGMA user_version = 0");
        database.close();
      });
      yield* Effect.promise(() => chmod(databasePath, 0o600));
      yield* Effect.sync(() => migrateProjectRepository(project));
      expect(completeProjectRepositoryMigration(project, true)).toBe(true);
      let quiescedBeforeRestoration = false;

      const backendContext = yield* Layer.build(makeLocalWorkflowBackendLayer("initialized-host"));
      const storeContext = yield* Layer.build(DrizzleProjectRepositoryLive);
      const backend = Context.get(backendContext, WorkflowBackend);
      const realStore = Context.get(storeContext, ProjectRepository);
      const failingStore = Layer.succeed(ProjectRepository, {
        ...realStore,
        postflight: (snapshot) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              const connection = new Database(databasePath);
              connection.exec(
                "INSERT INTO kojo_deletion_intents(deletion_id, request_key, target_kind, target_sha256, target_snapshot_json, phase, created_at_ms, updated_at_ms) VALUES ('deletion', 'request', 'run', zeroblob(32), '{}', 'quiescing', 1, 1)",
              );
              connection.close();
            });
            return yield* realStore.postflight(snapshot);
          }),
        completeMigration: (snapshot, succeeded) =>
          succeeded
            ? realStore.completeMigration(snapshot, true)
            : Effect.gen(function* () {
                quiescedBeforeRestoration =
                  (yield* backend.readiness(snapshot)) === "uninitialized";
                return yield* realStore.completeMigration(snapshot, false);
              }),
      });
      const runtimeContext = yield* Layer.build(
        ProjectRuntimeLive.pipe(
          Layer.provide([failingStore, Layer.succeed(WorkflowBackend, backend)]),
        ),
      );
      const runtime = Context.get(runtimeContext, ProjectRuntime);
      const activation = yield* runtime.coordinateRegistration(
        project,
        Effect.succeed({}),
        (ready) => Effect.succeed(ready),
      );

      expect(activation).toBe(false);
      expect(quiescedBeforeRestoration).toBe(true);
      const restored = new Database(databasePath, { readonly: true });
      expect(restored.query("SELECT * FROM kojo_deletion_intents").all()).toEqual([]);
      restored.close();
    }),
  );

  it.live(
    "executes Workflows through the engine owned by the active Project Runtime",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "kojo-project-runtime-workflow-")),
        );
        cleanups.push(() => rm(directory, { recursive: true }));
        const projectPath = join(directory, "project");
        const dataPath = join(projectPath, ".kojo");
        yield* Effect.promise(() => mkdir(dataPath, { recursive: true, mode: 0o700 }));
        const project: ProjectSnapshot = {
          identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
          path: projectPath,
        };
        yield* Effect.promise(() =>
          writeFile(
            join(dataPath, "project.json"),
            `${JSON.stringify({ layoutVersion: 1, projectIdentity: project.identity })}\n`,
            { mode: 0o600 },
          ),
        );
        const databasePath = join(dataPath, "kojo.sqlite");
        yield* Effect.sync(() => {
          const database = new Database(databasePath, { create: true, strict: true });
          database.exec(`CREATE TABLE kojo_project_store_identity (
            singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
            project_identity TEXT NOT NULL UNIQUE,
            database_instance_id TEXT NOT NULL UNIQUE
          ) STRICT`);
          database
            .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
            .run(project.identity, randomUUID());
          database.exec("PRAGMA user_version = 0");
          database.close();
        });
        yield* Effect.promise(() => chmod(databasePath, 0o600));
        yield* Effect.sync(() => migrateProjectRepository(project));
        expect(completeProjectRepositoryMigration(project, true)).toBe(true);

        const wakeAfterMillis = 1_000;
        let activityInvocations = 0;
        const definition = makeRecoveryDefinition(() => {
          activityInvocations += 1;
          return "recorded activity result";
        });

        const reference = yield* Effect.scoped(
          Effect.gen(function* () {
            const backendContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer("execution-host", [definition]),
            );
            const backend = Context.get(backendContext, WorkflowBackend);
            const runtimeContext = yield* Layer.build(
              ProjectRuntimeLive.pipe(
                Layer.provide([
                  DrizzleProjectRepositoryLive,
                  Layer.succeed(WorkflowBackend, backend),
                ]),
              ),
            );
            const runtime = Context.get(runtimeContext, ProjectRuntime);
            expect(
              yield* runtime.coordinateRegistration(project, Effect.succeed({}), (ready) =>
                Effect.succeed(ready),
              ),
            ).toBe(true);

            const accepted = yield* backend.submit(project, {
              workflowKey: definition.workflowKey,
              workflowRevision: definition.revision ?? "default",
              runId: "run:project-runtime-recovery-proof",
              input: { wakeAfterMillis },
            });
            expect(yield* awaitState(backend, project, accepted, "Waiting")).toEqual({
              _tag: "Waiting",
            });
            expect(activityInvocations).toBe(1);

            const competitorContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer("competing-host", [definition]),
            );
            const competitor = Context.get(competitorContext, WorkflowBackend);
            expect(yield* competitor.acquire(project)).toBe(false);
            return accepted;
          }),
        );

        yield* Effect.sleep(`${wakeAfterMillis + 250} millis`);

        const completed = yield* Effect.scoped(
          Effect.gen(function* () {
            const backendContext = yield* Layer.build(
              makeLocalWorkflowBackendLayer("execution-host", [definition]),
            );
            const backend = Context.get(backendContext, WorkflowBackend);
            const runtimeContext = yield* Layer.build(
              ProjectRuntimeLive.pipe(
                Layer.provide([
                  DrizzleProjectRepositoryLive,
                  Layer.succeed(WorkflowBackend, backend),
                ]),
              ),
            );
            const runtime = Context.get(runtimeContext, ProjectRuntime);
            expect(
              yield* runtime.coordinateRegistration(project, Effect.succeed({}), (ready) =>
                Effect.succeed(ready),
              ),
            ).toBe(true);
            return yield* awaitState(backend, project, reference, "Completed");
          }),
        );

        expect(completed).toEqual({
          _tag: "Completed",
          result: { activityResult: "recorded activity result", wakeUpDelivered: true },
        });
        expect(activityInvocations).toBe(1);
      }),
    20_000,
  );
});

const RecoveryInput = Schema.Struct({
  wakeAfterMillis: Schema.Number,
});

const RecoveryResult = Schema.Struct({
  activityResult: Schema.String,
  wakeUpDelivered: Schema.Boolean,
});

const makeRecoveryDefinition = (
  invokeActivity: () => string,
): LocalWorkflowDefinition<typeof RecoveryInput, typeof RecoveryResult> => ({
  workflowKey: "recovery-proof",
  inputSchema: RecoveryInput,
  successSchema: RecoveryResult,
  execute: (input, operations) =>
    Effect.gen(function* () {
      const activityResult = yield* operations.activity({
        operationKey: "record-result",
        successSchema: Schema.String,
        execute: Effect.sync(invokeActivity),
      });
      yield* operations.sleep({
        operationKey: "wake-after-restart",
        duration: `${input.wakeAfterMillis} millis`,
      });
      return { activityResult, wakeUpDelivered: true };
    }),
});

const awaitState = (
  backend: WorkflowBackend["Service"],
  project: ProjectSnapshot,
  reference: WorkflowBackendReference,
  tag: WorkflowBackendState["_tag"],
) =>
  backend.observe(project, reference).pipe(
    Effect.repeat({
      until: (state) => state._tag === tag,
      schedule: Schedule.spaced("25 millis"),
      times: 400,
    }),
  );
