import { expect, it } from "@effect/vitest";
import {
  ProjectIdentity,
  type ProjectRetentionSnapshot,
  type ProjectSnapshot,
  RequestKey,
} from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  ProjectIndexRepository,
  type ProjectIndexRepositoryShape,
} from "../../../../../../src/contexts/workflow-authoring/projects/repositories/project-index-repository";
import {
  ProjectRuntime,
  type ProjectRuntimeShape,
} from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import {
  RetentionRepository,
  type RetentionRepositoryShape,
} from "../../../../../../src/contexts/workflow-execution/retention/repositories/retention-repository";
import {
  cleanupProjectRetention,
  resetProjectRetention,
  setProjectRetention,
} from "../../../../../../src/contexts/workflow-execution/retention/use-cases/manage-retention";

const project: ProjectSnapshot = {
  identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001"),
  path: "/project",
};
const snapshot = {} as ProjectRetentionSnapshot;

it.effect("routes retention set and reset through Project Runtime ownership", () => {
  const runtimeCalls: Array<string> = [];
  const repositoryCalls: Array<string> = [];
  const index: ProjectIndexRepositoryShape = {
    read: Effect.succeed({ layoutVersion: 1, projects: [project], receipts: [] }),
    update: () => Effect.die("Project Index updates are not used by this test"),
  };
  const retention: RetentionRepositoryShape = {
    policy: () => Effect.die("Retention policy is not used by this test"),
    show: () => Effect.die("Retention show is not used by this test"),
    set: () =>
      Effect.sync(() => {
        repositoryCalls.push("set");
        return { _tag: "success" as const, snapshot, alreadyApplied: false };
      }),
    reset: () =>
      Effect.sync(() => {
        repositoryCalls.push("reset");
        return { _tag: "success" as const, snapshot, alreadyApplied: false };
      }),
    cleanup: () =>
      Effect.sync(() => {
        repositoryCalls.push("cleanup");
        return snapshot;
      }),
  };
  const runtime = {
    coordinateRetention: <A>(_project: ProjectSnapshot, operation: Effect.Effect<A>) =>
      Effect.sync(() => {
        runtimeCalls.push("enter");
      }).pipe(
        Effect.andThen(operation),
        Effect.tap(() => Effect.sync(() => runtimeCalls.push("exit"))),
      ),
  } as ProjectRuntimeShape;
  const requestKey = Schema.decodeUnknownSync(RequestKey)("10000000-0000-4000-8000-000000000001");

  return Effect.gen(function* () {
    const set = yield* setProjectRetention({
      identity: project.identity,
      requestKey,
      disposableMaxBytes: 1,
    });
    const reset = yield* resetProjectRetention(project.identity, requestKey);
    yield* cleanupProjectRetention(project, 100);

    expect(set.ok).toBe(true);
    expect(reset.ok).toBe(true);
    expect(runtimeCalls).toEqual(["enter", "exit", "enter", "exit", "enter", "exit"]);
    expect(repositoryCalls).toEqual(["set", "reset", "cleanup"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectIndexRepository, index),
        Layer.succeed(ProjectRuntime, runtime),
        Layer.succeed(RetentionRepository, retention),
      ),
    ),
  );
});
