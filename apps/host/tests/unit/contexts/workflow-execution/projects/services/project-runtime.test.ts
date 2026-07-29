import { expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  ProjectRuntime,
  ProjectRuntimeLive,
} from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { ProjectStore } from "../../../../../../src/contexts/workflow-execution/projects/services/project-store";
import { WorkflowBackend } from "../../../../../../src/contexts/workflow-execution/projects/services/workflow-backend";

const project: ProjectSnapshot = {
  identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001"),
  path: "/project",
};

const backend = Layer.succeed(WorkflowBackend, {
  initialize: () => Effect.succeed(true),
  readiness: () => Effect.succeed("ready" as const),
  release: () => Effect.void,
});

const runtimeLayer = (store: Layer.Layer<ProjectStore>) =>
  ProjectRuntimeLive.pipe(Layer.provide([store, backend]));

it.effect("serializes lifecycle inspection for one Project", () => {
  let active = 0;
  let maximumActive = 0;
  const store = Layer.succeed(ProjectStore, {
    migrate: () => Effect.succeed(true),
    completeMigration: () => Effect.succeed(true),
    readiness: () => Effect.succeed("ready"),
    inspectForgetBlockers: () =>
      Effect.gen(function* () {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        yield* Effect.sleep("10 millis");
        active -= 1;
        return {
          assessment: "available" as const,
          enabledScheduleKeys: [],
          nonFinalRunIds: [],
        };
      }),
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    yield* Effect.all(
      [runtime.inspectForgetBlockers(project), runtime.inspectForgetBlockers(project)],
      { concurrency: "unbounded" },
    );
    expect(maximumActive).toBe(1);
  }).pipe(Effect.provide(runtimeLayer(store)));
});

it.effect("marks an indexed Project needs-attention when validated identity drifts", () => {
  let storeReadinessCalled = false;
  const store = Layer.succeed(ProjectStore, {
    migrate: () => Effect.succeed(true),
    completeMigration: () => Effect.succeed(true),
    readiness: () =>
      Effect.sync(() => {
        storeReadinessCalled = true;
        return "ready" as const;
      }),
    inspectForgetBlockers: () =>
      Effect.succeed({
        assessment: "available" as const,
        enabledScheduleKeys: [],
        nonFinalRunIds: [],
      }),
  });
  const changedProject: ProjectSnapshot = {
    ...project,
    identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000002"),
  };

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(yield* runtime.readiness(project, changedProject)).toBe("needs-attention");
    expect(storeReadinessCalled).toBe(false);
  }).pipe(Effect.provide(runtimeLayer(store)));
});

it.effect("holds forget behind an active lifecycle mutation", () => {
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectStore, {
    migrate: () => Effect.succeed(true),
    completeMigration: () => Effect.succeed(true),
    readiness: () => Effect.succeed("ready" as const),
    inspectForgetBlockers: () =>
      Effect.sync(() => {
        order.push("inspect-forget");
        return {
          assessment: "available" as const,
          enabledScheduleKeys: [],
          nonFinalRunIds: [],
        };
      }),
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    yield* Effect.all(
      [
        runtime.coordinateLifecycle(
          project,
          Effect.gen(function* () {
            order.push("lifecycle-start");
            yield* Effect.sleep("20 millis");
            order.push("lifecycle-end");
          }),
        ),
        runtime.coordinateForget(project, () =>
          Effect.sync(() => {
            order.push("forget");
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    expect(order).toEqual(["lifecycle-start", "lifecycle-end", "inspect-forget", "forget"]);
  }).pipe(Effect.provide(runtimeLayer(store)));
});

it.effect("commits migration only after the Workflow backend acquires ownership", () => {
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectStore, {
    migrate: () =>
      Effect.sync(() => {
        order.push("store-migrated");
        return true;
      }),
    completeMigration: (_project, succeeded) =>
      Effect.sync(() => {
        order.push(succeeded ? "migration-committed" : "migration-restored");
        return succeeded;
      }),
    readiness: () => Effect.succeed("limited" as const),
    inspectForgetBlockers: () =>
      Effect.succeed({
        assessment: "available" as const,
        enabledScheduleKeys: [],
        nonFinalRunIds: [],
      }),
  });
  const initializingBackend = Layer.succeed(WorkflowBackend, {
    readiness: () => Effect.succeed("uninitialized" as const),
    initialize: () =>
      Effect.sync(() => {
        order.push("backend-owned");
        return true;
      }),
    release: () => Effect.void,
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(project, Effect.succeed(undefined), (migrated) =>
        Effect.succeed(migrated),
      ),
    ).toBe(true);
    expect(order).toEqual(["store-migrated", "backend-owned", "migration-committed"]);
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, initializingBackend]))));
});

it.effect("does not mutate the store when another Workflow backend owns the Project", () => {
  let migrations = 0;
  const store = Layer.succeed(ProjectStore, {
    migrate: () =>
      Effect.sync(() => {
        migrations += 1;
        return true;
      }),
    completeMigration: () => Effect.succeed(true),
    readiness: () => Effect.succeed("ready" as const),
    inspectForgetBlockers: () =>
      Effect.succeed({
        assessment: "available" as const,
        enabledScheduleKeys: [],
        nonFinalRunIds: [],
      }),
  });
  const ownedBackend = Layer.succeed(WorkflowBackend, {
    readiness: () => Effect.succeed("needs-attention" as const),
    initialize: () => Effect.succeed(false),
    release: () => Effect.void,
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(project, Effect.succeed(undefined), (migrated) =>
        Effect.succeed(migrated),
      ),
    ).toBe(false);
    expect(migrations).toBe(0);
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, ownedBackend]))));
});
