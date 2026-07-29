import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
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
  it("retries bounded ownership contention and acquires after release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kojo-backend-ownership-retry-"));
    cleanups.push(() => rm(directory, { recursive: true }));
    const projectPath = join(directory, "project");
    await mkdir(join(projectPath, ".kojo"), { recursive: true, mode: 0o700 });
    const project: ProjectSnapshot = {
      identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
      path: projectPath,
    };

    const acquired = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
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
          return yield* Fiber.join(waiting);
        }),
      ),
    );

    expect(acquired).toBe(true);
  });

  it("keeps exclusive ownership until failed migration restoration completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kojo-backend-owned-restoration-"));
    cleanups.push(() => rm(directory, { recursive: true }));
    const projectPath = join(directory, "project");
    await mkdir(join(projectPath, ".kojo"), { recursive: true, mode: 0o700 });
    const project: ProjectSnapshot = {
      identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
      path: projectPath,
    };
    let restorationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      restorationStarted = resolve;
    });
    let restorationComplete = false;

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
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
          return {
            activation: yield* Fiber.join(activation),
            competingAcquired,
            completeWhenAcquired,
          };
        }),
      ),
    );

    expect(result).toEqual({
      activation: false,
      competingAcquired: true,
      completeWhenAcquired: true,
    });
  });
});
