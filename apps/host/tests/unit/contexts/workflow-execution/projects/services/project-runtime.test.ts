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
    prepare: () => Effect.succeed(true),
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
