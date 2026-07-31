import { expect, it } from "@effect/vitest";
import {
  ProjectIdentity,
  type ProjectRetentionSnapshot,
  type ProjectSnapshot,
} from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import { ProjectRepository } from "../../../../../../src/contexts/workflow-execution/projects/repositories/project-repository";
import {
  ProjectRuntime,
  ProjectRuntimeLive,
} from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { WorkflowBackend } from "../../../../../../src/contexts/workflow-execution/projects/services/workflow-backend";
import { RetentionRepository } from "../../../../../../src/contexts/workflow-execution/retention/repositories/retention-repository";

const project: ProjectSnapshot = {
  identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001"),
  path: "/project",
};

const unusedWorkflowExecution = {
  register: () => Effect.void,
  submit: () => Effect.die("Workflow submission is not used by Project Runtime tests"),
  observe: () => Effect.die("Workflow observation is not used by Project Runtime tests"),
};

const backend = Layer.succeed(WorkflowBackend, {
  ...unusedWorkflowExecution,
  acquire: () => Effect.succeed(true),
  quiesce: () => Effect.void,
  initialize: () => Effect.succeed(true),
  postflight: () => Effect.succeed(true),
  readiness: () => Effect.succeed("ready" as const),
  release: () => Effect.void,
});

const runtimeLayer = (store: Layer.Layer<ProjectRepository>) =>
  ProjectRuntimeLive.pipe(Layer.provide([store, backend]));

it.effect("serializes lifecycle inspection for one Project", () => {
  let active = 0;
  let maximumActive = 0;
  const store = Layer.succeed(ProjectRepository, {
    migrate: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
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
  const store = Layer.succeed(ProjectRepository, {
    migrate: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
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

it.effect("retains an accepted definition snapshot while a replacement is invalid", () => {
  const store = Layer.succeed(ProjectRepository, {
    migrate: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
    completeMigration: () => Effect.succeed(true),
    readiness: () => Effect.succeed("ready" as const),
    inspectForgetBlockers: () =>
      Effect.succeed({
        assessment: "available" as const,
        enabledScheduleKeys: [],
        nonFinalRunIds: [],
      }),
  });
  const accepted = {
    ok: true as const,
    snapshot: { snapshotId: "accepted", workflows: [] },
  };
  const rejected = {
    ok: false as const,
    findingKey: "workflow.schema-invalid" as const,
    message: "Workflow Definition is invalid.",
    findings: [
      {
        findingKey: "workflow.schema-invalid" as const,
        message: "Workflow Definition is invalid.",
      },
    ],
  };

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(yield* runtime.acceptDefinitions(project, accepted)).toEqual(accepted.snapshot);
    expect(yield* runtime.readiness(project, project, rejected)).toBe("limited");
    expect(yield* runtime.definitions(project)).toEqual(accepted.snapshot);
  }).pipe(Effect.provide(runtimeLayer(store)));
});

it.effect(
  "requires current valid source after cold activation before recovery can continue",
  () => {
    const store = Layer.succeed(ProjectRepository, {
      migrate: () => Effect.succeed(true),
      postflight: () => Effect.succeed(true),
      completeMigration: () => Effect.succeed(true),
      readiness: () => Effect.succeed("ready" as const),
      inspectForgetBlockers: () =>
        Effect.succeed({
          assessment: "available" as const,
          enabledScheduleKeys: [],
          nonFinalRunIds: [],
        }),
    });
    const rejected = {
      ok: false as const,
      findingKey: "configuration.load-failed" as const,
      message: "Kojo Configuration could not be loaded safely.",
      findings: [
        {
          findingKey: "configuration.load-failed" as const,
          message: "Kojo Configuration could not be loaded safely.",
        },
      ],
    };

    return Effect.gen(function* () {
      const runtime = yield* ProjectRuntime;
      expect(yield* runtime.readiness(project, project, rejected)).toBe("needs-attention");
      expect(yield* runtime.definitions(project)).toBeUndefined();
    }).pipe(Effect.provide(runtimeLayer(store)));
  },
);

it.effect("holds forget behind an active lifecycle mutation", () => {
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectRepository, {
    migrate: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
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
        runtime.coordinateForget(
          project.identity,
          Effect.succeed({ _tag: "project", project }),
          () =>
            Effect.sync(() => {
              order.push("forget");
              return { deactivate: false, result: undefined };
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
  let retentionCleanups = 0;
  const store = Layer.succeed(ProjectRepository, {
    migrate: () =>
      Effect.sync(() => {
        order.push("store-migrated");
        return true;
      }),
    postflight: () =>
      Effect.sync(() => {
        order.push("store-postflight");
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
    ...unusedWorkflowExecution,
    acquire: () =>
      Effect.sync(() => {
        order.push("ownership-acquired");
        return true;
      }),
    quiesce: () =>
      Effect.sync(() => {
        order.push("backend-quiesced");
      }),
    readiness: () => Effect.succeed("uninitialized" as const),
    postflight: () =>
      Effect.sync(() => {
        order.push("backend-ready");
        return true;
      }),
    initialize: () =>
      Effect.sync(() => {
        order.push("backend-owned");
        return true;
      }),
    release: () =>
      Effect.sync(() => {
        order.push("backend-released");
      }),
  });
  const retention = Layer.succeed(RetentionRepository, {
    show: () => Effect.die("Retention show is not used by this test"),
    set: () => Effect.die("Retention set is not used by this test"),
    reset: () => Effect.die("Retention reset is not used by this test"),
    cleanup: () =>
      Effect.sync(() => {
        retentionCleanups += 1;
        return {} as ProjectRetentionSnapshot;
      }),
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(project, Effect.succeed({}), (migrated) =>
        Effect.succeed(migrated),
      ),
    ).toBe(true);
    expect(order).toEqual([
      "ownership-acquired",
      "backend-quiesced",
      "store-migrated",
      "backend-owned",
      "backend-ready",
      "store-postflight",
      "migration-committed",
    ]);
    expect(retentionCleanups).toBe(1);
  }).pipe(
    Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, initializingBackend, retention]))),
  );
});

it.effect("does not mutate the store when another Workflow backend owns the Project", () => {
  let migrations = 0;
  const store = Layer.succeed(ProjectRepository, {
    migrate: () =>
      Effect.sync(() => {
        migrations += 1;
        return true;
      }),
    postflight: () => Effect.succeed(true),
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
    ...unusedWorkflowExecution,
    acquire: () => Effect.succeed(false),
    quiesce: () => Effect.void,
    readiness: () => Effect.succeed("needs-attention" as const),
    initialize: () => Effect.succeed(false),
    postflight: () => Effect.succeed(false),
    release: () => Effect.void,
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(project, Effect.succeed({}), (migrated) =>
        Effect.succeed(migrated),
      ),
    ).toBe(false);
    expect(migrations).toBe(0);
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, ownedBackend]))));
});

it.effect("releases a ready Workflow backend when deep Project store postflight fails", () => {
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectRepository, {
    migrate: () => Effect.die("A ready Project Store must not migrate"),
    postflight: () =>
      Effect.sync(() => {
        order.push("store-postflight");
        return false;
      }),
    completeMigration: () => Effect.die("A ready Project Store must not complete migration"),
    readiness: () => Effect.succeed("ready" as const),
    inspectForgetBlockers: () =>
      Effect.succeed({
        assessment: "available" as const,
        enabledScheduleKeys: [],
        nonFinalRunIds: [],
      }),
  });
  const activeBackend = Layer.succeed(WorkflowBackend, {
    ...unusedWorkflowExecution,
    acquire: () => Effect.die("A ready Workflow backend must not acquire ownership again"),
    quiesce: () => Effect.void,
    initialize: () => Effect.die("A ready Workflow backend must not initialize again"),
    postflight: () => Effect.succeed(true),
    readiness: () => Effect.succeed("ready" as const),
    release: () =>
      Effect.sync(() => {
        order.push("backend-released");
      }),
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(project, Effect.succeed({}), (ready) =>
        Effect.succeed(ready),
      ),
    ).toBe(false);
    expect(order).toEqual(["store-postflight", "backend-released"]);
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, activeBackend]))));
});

it.effect("releases the previous path before acquiring a moved Project", () => {
  const previous = { ...project, path: "/old-project" };
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectRepository, {
    migrate: () =>
      Effect.sync(() => {
        order.push("store-migrated");
        return true;
      }),
    postflight: () =>
      Effect.sync(() => {
        order.push("store-postflight");
        return true;
      }),
    completeMigration: () =>
      Effect.sync(() => {
        order.push("migration-committed");
        return true;
      }),
    readiness: () =>
      Effect.sync(() => {
        order.push("store-ready");
        return "ready" as const;
      }),
    inspectForgetBlockers: () =>
      Effect.succeed({
        assessment: "available" as const,
        enabledScheduleKeys: [],
        nonFinalRunIds: [],
      }),
  });
  let assessments = 0;
  const movedBackend = Layer.succeed(WorkflowBackend, {
    ...unusedWorkflowExecution,
    acquire: () => Effect.succeed(true),
    quiesce: () => Effect.void,
    readiness: () =>
      Effect.sync(() => {
        assessments += 1;
        return assessments === 1 ? ("uninitialized" as const) : ("ready" as const);
      }),
    initialize: () =>
      Effect.sync(() => {
        order.push("backend-owned");
        return true;
      }),
    postflight: () =>
      Effect.sync(() => {
        order.push("backend-postflight");
        return true;
      }),
    release: (released) =>
      Effect.sync(() => {
        order.push(`released:${released.path}`);
      }),
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(
        project,
        Effect.succeed({ previousProject: previous }),
        (migrated) => Effect.succeed(migrated),
      ),
    ).toBe(true);
    expect(order[0]).toBe("released:/old-project");
    expect(order[1]).toBe("store-ready");
    expect(order).toContain("store-migrated");
    expect(order.indexOf("store-migrated")).toBeLessThan(order.indexOf("backend-owned"));
    expect(order.indexOf("backend-postflight")).toBeLessThan(order.indexOf("store-postflight"));
    expect(order.indexOf("store-postflight")).toBeLessThan(order.indexOf("migration-committed"));
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, movedBackend]))));
});

it.effect("restores the store when Workflow ownership postflight fails", () => {
  const completions: Array<boolean> = [];
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectRepository, {
    migrate: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
    completeMigration: (_project, succeeded) =>
      Effect.sync(() => {
        completions.push(succeeded);
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
  let assessments = 0;
  const incompatibleBackend = Layer.succeed(WorkflowBackend, {
    ...unusedWorkflowExecution,
    acquire: () => Effect.succeed(true),
    quiesce: () =>
      Effect.sync(() => {
        order.push("backend-quiesced");
      }),
    initialize: () => Effect.succeed(true),
    readiness: () => Effect.succeed("uninitialized" as const),
    postflight: () =>
      Effect.sync(() => {
        assessments += 1;
        return false;
      }),
    release: () =>
      Effect.sync(() => {
        order.push("ownership-released");
      }),
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(project, Effect.succeed({}), (migrated) =>
        Effect.succeed(migrated),
      ),
    ).toBe(false);
    expect(assessments).toBe(1);
    expect(completions).toEqual([false]);
    expect(order).toEqual([
      "backend-quiesced",
      "backend-quiesced",
      "migration-restored",
      "ownership-released",
    ]);
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, incompatibleBackend]))));
});

it.effect("quiesces the Workflow backend when migration completion verification fails", () => {
  const order: Array<string> = [];
  const store = Layer.succeed(ProjectRepository, {
    migrate: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
    completeMigration: (_project, succeeded) =>
      Effect.sync(() => {
        order.push(succeeded ? "migration-verification-failed" : "migration-restored");
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
  const backend = Layer.succeed(WorkflowBackend, {
    ...unusedWorkflowExecution,
    acquire: () => Effect.succeed(true),
    quiesce: () =>
      Effect.sync(() => {
        order.push("backend-quiesced");
      }),
    initialize: () => Effect.succeed(true),
    readiness: () => Effect.succeed("uninitialized" as const),
    postflight: () => Effect.succeed(true),
    release: () =>
      Effect.sync(() => {
        order.push("ownership-released");
      }),
  });

  return Effect.gen(function* () {
    const runtime = yield* ProjectRuntime;
    expect(
      yield* runtime.coordinateRegistration(project, Effect.succeed({}), (migrated) =>
        Effect.succeed(migrated),
      ),
    ).toBe(false);
    expect(order).toEqual([
      "backend-quiesced",
      "migration-verification-failed",
      "backend-quiesced",
      "migration-restored",
      "ownership-released",
    ]);
  }).pipe(Effect.provide(ProjectRuntimeLive.pipe(Layer.provide([store, backend]))));
});
