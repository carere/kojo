import { expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  ProjectRuntime,
  ProjectRuntimeLive,
} from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { ProjectStore } from "../../../../../../src/contexts/workflow-execution/projects/services/project-store";

const project: ProjectSnapshot = {
  identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001"),
  path: "/project",
};

it.effect("serializes lifecycle inspection for one Project", () => {
  let active = 0;
  let maximumActive = 0;
  const store = Layer.succeed(ProjectStore, {
    migrate: () => Effect.succeed(true),
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
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide(store))));
});

it.effect("marks an indexed Project needs-attention when validated identity drifts", () => {
  let storeReadinessCalled = false;
  const store = Layer.succeed(ProjectStore, {
    migrate: () => Effect.succeed(true),
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
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide(store))));
});

it.effect("holds forget behind an active lifecycle mutation", () => {
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectStore, {
    migrate: () => Effect.succeed(true),
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
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide(store))));
});
