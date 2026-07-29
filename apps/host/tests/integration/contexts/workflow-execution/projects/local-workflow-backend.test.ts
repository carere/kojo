import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Fiber, Layer, Schema } from "effect";
import {
  completeProjectStoreMigration,
  DrizzleProjectStoreLive,
  migrateProjectStore,
} from "../../../../../src/adapters/projects/drizzle-project-store";
import { makeLocalWorkflowBackendLayer } from "../../../../../src/adapters/projects/local-workflow-backend";
import {
  ProjectRuntime,
  ProjectRuntimeLive,
} from "../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { ProjectStore } from "../../../../../src/contexts/workflow-execution/projects/services/project-store";
import { WorkflowBackend } from "../../../../../src/contexts/workflow-execution/projects/services/workflow-backend";

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
      const store = Layer.succeed(ProjectStore, {
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
      yield* Effect.sync(() => migrateProjectStore(project));
      expect(completeProjectStoreMigration(project, true)).toBe(true);
      let quiescedBeforeRestoration = false;

      const backendContext = yield* Layer.build(makeLocalWorkflowBackendLayer("initialized-host"));
      const storeContext = yield* Layer.build(DrizzleProjectStoreLive);
      const backend = Context.get(backendContext, WorkflowBackend);
      const realStore = Context.get(storeContext, ProjectStore);
      const failingStore = Layer.succeed(ProjectStore, {
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
});
