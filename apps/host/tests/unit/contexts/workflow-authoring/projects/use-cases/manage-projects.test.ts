import { expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot, RequestKey } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  emptyProjectIndexState,
  ProjectIndexStore,
  type ProjectIndexStoreShape,
} from "../../../../../../src/contexts/workflow-authoring/projects/services/project-index-store";
import {
  ProjectLayout,
  type ProjectLayoutShape,
} from "../../../../../../src/contexts/workflow-authoring/projects/services/project-layout";
import {
  forgetProject,
  listProjectPage,
  listProjects,
  registerProject,
  replayForgetProject,
} from "../../../../../../src/contexts/workflow-authoring/projects/use-cases/manage-projects";
import { ProjectRuntime } from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import type { ProjectForgetBlockers } from "../../../../../../src/contexts/workflow-execution/projects/services/project-store";

const identity = Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001");
const requestKey = (suffix: string) =>
  Schema.decodeUnknownSync(RequestKey)(`10000000-0000-4000-8000-${suffix.padStart(12, "0")}`);

const makeStore = () => {
  let state = emptyProjectIndexState();
  const service: ProjectIndexStoreShape = {
    read: Effect.sync(() => state),
    update: (change) =>
      Effect.flatMap(change(state), (update) =>
        Effect.sync(() => {
          state = update.state;
          return update.result;
        }),
      ),
  };
  return Layer.succeed(ProjectIndexStore, service);
};

const makeLayout = (
  projects: Record<string, ProjectSnapshot>,
  inspect: ProjectLayoutShape["inspectIndexedPath"] = () =>
    Effect.succeed({ status: "missing" as const }),
) =>
  Layer.succeed(ProjectLayout, {
    validate: (path) =>
      Effect.succeed(
        projects[path] === undefined
          ? {
              ok: false as const,
              message: "invalid test layout",
              findingKey: "configuration.invalid",
            }
          : { ok: true as const, project: projects[path] },
      ),
    inspectIndexedPath: inspect,
  });

const makeRuntime = (
  blockers: Effect.Effect<ProjectForgetBlockers>,
  condition: "ready" | "limited" | "needs-attention" = "ready",
  onMigration = () => undefined,
) =>
  Layer.succeed(ProjectRuntime, {
    coordinateRegistration: (_project, beforeMigration, operation) =>
      Effect.flatMap(beforeMigration, (preflight) =>
        preflight.result === undefined
          ? Effect.sync(onMigration).pipe(Effect.andThen(operation(true)))
          : Effect.succeed(preflight.result),
      ),
    coordinateLifecycle: (_project, operation) => operation,
    readiness: () => Effect.succeed(condition),
    inspectForgetBlockers: () => blockers,
    coordinateForget: (_project, operation) => Effect.flatMap(blockers, operation),
    deactivate: () => Effect.void,
  });

const noForgetBlockers = Effect.succeed({
  assessment: "available" as const,
  enabledScheduleKeys: [] as ReadonlyArray<string>,
  nonFinalRunIds: [] as ReadonlyArray<string>,
});

it.effect("rejects a duplicate live identity and accepts the path after a move", () => {
  const first: ProjectSnapshot = { identity, path: "/projects/first" };
  const moved: ProjectSnapshot = { identity, path: "/projects/moved" };
  let firstPathExists = true;
  let migrations = 0;
  const layer = Layer.mergeAll(
    makeStore(),
    makeLayout({ inputA: first, inputB: moved }, (path) =>
      Effect.succeed(
        path === first.path && firstPathExists
          ? { status: "valid" as const, identity }
          : { status: "missing" as const },
      ),
    ),
    makeRuntime(noForgetBlockers, "ready", () => {
      migrations += 1;
    }),
  );

  return Effect.gen(function* () {
    const registered = yield* registerProject("inputA", requestKey("1"));
    expect(registered).toMatchObject({ ok: true, alreadyApplied: false, project: first });

    const duplicate = yield* registerProject("inputB", requestKey("2"));
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: "project-identity-duplicate",
        affectedResource: { kind: "project", identity },
        findingKeys: ["project.identity-duplicate"],
      },
    });
    expect(migrations).toBe(1);

    firstPathExists = false;
    const refusedRedelivery = yield* registerProject("inputB", requestKey("2"));
    expect(refusedRedelivery).toEqual(duplicate);
    const movedResult = yield* registerProject("inputB", requestKey("3"));
    expect(movedResult).toMatchObject({ ok: true, project: moved });
    expect((yield* listProjects).projects).toEqual([moved]);
    expect(migrations).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect("persists a refused request result and conflicts on different contents", () => {
  const projects: Record<string, ProjectSnapshot> = {};
  const layer = Layer.mergeAll(makeStore(), makeLayout(projects), makeRuntime(noForgetBlockers));

  return Effect.gen(function* () {
    const refused = yield* registerProject("invalid", requestKey("1"));
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "project-layout-invalid",
        affectedResource: { kind: "project-path", path: "invalid" },
        findingKeys: ["configuration.invalid"],
      },
    });
    projects.invalid = { identity, path: "/projects/valid-now" };

    expect(yield* registerProject("invalid", requestKey("1"))).toEqual(refused);
    expect(yield* registerProject("different", requestKey("1"))).toMatchObject({
      ok: false,
      error: { code: "request-key-conflict" },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("blocks forgetting a Project with an enabled Workflow Schedule", () => {
  const project: ProjectSnapshot = { identity, path: "/projects/first" };
  const layer = Layer.mergeAll(
    makeStore(),
    makeLayout({ input: project }),
    makeRuntime(
      Effect.succeed({
        assessment: "available",
        enabledScheduleKeys: ["nightly"],
        nonFinalRunIds: [],
      }),
    ),
  );

  return Effect.gen(function* () {
    yield* registerProject("input", requestKey("1"));
    const result = yield* forgetProject(identity, { kind: "identity", identity }, requestKey("2"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "project-forget-blocked",
        affectedResource: { kind: "project", identity },
        findingKeys: [],
      },
    });
    expect((yield* listProjects).projects).toEqual([project]);
  }).pipe(Effect.provide(layer));
});

it.effect("blocks forgetting a Project with a non-final Workflow Run", () => {
  const project: ProjectSnapshot = { identity, path: "/projects/first" };
  const layer = Layer.mergeAll(
    makeStore(),
    makeLayout({ input: project }),
    makeRuntime(
      Effect.succeed({
        assessment: "available",
        enabledScheduleKeys: [],
        nonFinalRunIds: ["run-in-progress"],
      }),
    ),
  );

  return Effect.gen(function* () {
    yield* registerProject("input", requestKey("1"));
    const result = yield* forgetProject(identity, { kind: "identity", identity }, requestKey("2"));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "project-forget-blocked",
        affectedResource: { kind: "project", identity },
        findingKeys: [],
      },
    });
    expect((yield* listProjects).projects).toEqual([project]);
  }).pipe(Effect.provide(layer));
});

it.effect("replays forget only for the identical original selector", () => {
  const project: ProjectSnapshot = { identity, path: "/projects/first" };
  const layer = Layer.mergeAll(
    makeStore(),
    makeLayout({ input: project }),
    makeRuntime(noForgetBlockers),
  );

  return Effect.gen(function* () {
    yield* registerProject("input", requestKey("1"));
    const selector = { kind: "path" as const, path: project.path };
    const forgotten = yield* forgetProject(identity, selector, requestKey("2"));
    expect(forgotten).toMatchObject({ ok: true, alreadyApplied: false });

    expect(yield* replayForgetProject(selector, requestKey("2"))).toMatchObject({
      ok: true,
      alreadyApplied: true,
    });
    expect(
      yield* replayForgetProject({ kind: "path", path: "/projects/other" }, requestKey("2")),
    ).toMatchObject({ ok: false, error: { code: "request-key-conflict" } });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "conflicts when the same forget selector and Request Key are reused with another identity",
  () => {
    const project: ProjectSnapshot = { identity, path: "/projects/first" };
    const changedIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
      "00000000-0000-7000-8000-000000000002",
    );
    const layer = Layer.mergeAll(
      makeStore(),
      makeLayout({ input: project }),
      makeRuntime(noForgetBlockers),
    );

    return Effect.gen(function* () {
      yield* registerProject("input", requestKey("1"));
      const selector = { kind: "path" as const, path: project.path };
      expect(yield* forgetProject(identity, selector, requestKey("2"))).toMatchObject({ ok: true });
      expect(yield* forgetProject(changedIdentity, selector, requestKey("2"))).toMatchObject({
        ok: false,
        error: { code: "request-key-conflict" },
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("uses Runtime readiness for Project condition filtering", () => {
  const project: ProjectSnapshot = { identity, path: "/projects/limited" };
  const layer = Layer.mergeAll(
    makeStore(),
    makeLayout({ input: project, [project.path]: project }),
    makeRuntime(noForgetBlockers, "limited"),
  );

  return Effect.gen(function* () {
    yield* registerProject("input", requestKey("1"));
    const listed = yield* listProjectPage({ conditions: ["limited"], limit: 50 });
    expect(listed).toEqual({
      ok: true,
      page: { items: [{ ...project, condition: "limited" }], nextCursor: null },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("acquires the Project Runtime before the Project Index for register and forget", () => {
  const project: ProjectSnapshot = { identity, path: "/projects/lock-order" };
  let state = emptyProjectIndexState();
  let runtimeOwned = false;
  const store = Layer.succeed(ProjectIndexStore, {
    read: Effect.sync(() => state),
    update: (change) =>
      Effect.gen(function* () {
        if (!runtimeOwned) throw new Error("Project Index acquired before Project Runtime");
        const update = yield* change(state);
        state = update.state;
        return update.result;
      }),
  });
  const withinRuntime = <A>(effect: Effect.Effect<A>) =>
    Effect.gen(function* () {
      runtimeOwned = true;
      try {
        return yield* effect;
      } finally {
        runtimeOwned = false;
      }
    });
  const runtime = Layer.succeed(ProjectRuntime, {
    coordinateRegistration: (_project, beforeMigration, operation) =>
      withinRuntime(
        Effect.flatMap(beforeMigration, (refused) =>
          refused.result === undefined ? operation(true) : Effect.succeed(refused.result),
        ),
      ),
    coordinateLifecycle: (_project, operation) => withinRuntime(operation),
    readiness: () => Effect.succeed("ready" as const),
    inspectForgetBlockers: () => noForgetBlockers,
    coordinateForget: (_project, operation) =>
      withinRuntime(Effect.flatMap(noForgetBlockers, operation)),
    deactivate: () => Effect.void,
  });
  const layer = Layer.mergeAll(store, makeLayout({ input: project }), runtime);

  return Effect.gen(function* () {
    expect(yield* registerProject("input", requestKey("1"))).toMatchObject({ ok: true });
    expect(
      yield* forgetProject(identity, { kind: "identity", identity }, requestKey("2")),
    ).toMatchObject({ ok: true });
  }).pipe(Effect.provide(layer));
});
