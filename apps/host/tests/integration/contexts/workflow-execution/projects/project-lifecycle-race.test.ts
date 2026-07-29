import { expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  ProjectRuntime,
  ProjectRuntimeLive,
} from "../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { ProjectStore } from "../../../../../src/contexts/workflow-execution/projects/services/project-store";

const project: ProjectSnapshot = {
  identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001"),
  path: "/project",
};

it("keeps forget removal atomic with a concurrent schedule lifecycle mutation", async () => {
  let releaseRemoval: () => void = () => undefined;
  const removalGate = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  const events: Array<string> = [];
  const store = Layer.succeed(ProjectStore, {
    prepare: () => Effect.succeed(true),
    inspectForgetBlockers: () =>
      Effect.succeed({
        assessment: "available" as const,
        enabledScheduleKeys: [],
        nonFinalRunIds: [],
      }),
  });

  const runtime = await Effect.runPromise(
    ProjectRuntime.pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide(store)))),
  );
  const forgetting = Effect.runPromise(
    runtime.coordinateForget(
      project,
      () =>
        Effect.promise(() => removalGate).pipe(
          Effect.andThen(Effect.sync(() => events.push("index-removed"))),
        ),
      () => true,
    ),
  );
  await Bun.sleep(5);
  const scheduling = Effect.runPromise(
    runtime.runLifecycleMutation(
      project,
      Effect.sync(() => events.push("schedule-enabled")),
    ),
  );
  await Bun.sleep(5);
  expect(events).toEqual([]);
  releaseRemoval();
  await Promise.all([forgetting, scheduling]);
  expect(events).toEqual(["index-removed"]);
});
