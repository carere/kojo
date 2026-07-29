import { expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectSnapshot, RequestKey } from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import {
  emptyProjectIndexState,
  ProjectIndexStore,
  type ProjectIndexStoreShape,
} from "../../../../../src/contexts/workflow-authoring/projects/services/project-index-store";
import {
  ProjectLayout,
  type ProjectLayoutShape,
} from "../../../../../src/contexts/workflow-authoring/projects/services/project-layout";
import {
  listProjects,
  registerProject,
} from "../../../../../src/contexts/workflow-authoring/projects/use-cases/manage-projects";

const identity = Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-4000-8000-000000000001");
const firstKey = Schema.decodeUnknownSync(RequestKey)("10000000-0000-4000-8000-000000000001");
const secondKey = Schema.decodeUnknownSync(RequestKey)("10000000-0000-4000-8000-000000000002");

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
  projects: Readonly<Record<string, ProjectSnapshot>>,
  inspect: ProjectLayoutShape["inspectIndexedPath"],
) =>
  Layer.succeed(ProjectLayout, {
    validate: (path) =>
      Effect.succeed(
        projects[path] === undefined
          ? { ok: false as const, message: "invalid test layout" }
          : { ok: true as const, project: projects[path] },
      ),
    inspectIndexedPath: inspect,
  });

it.effect("rejects a duplicate live identity and accepts the path after a move", () => {
  const first: ProjectSnapshot = { identity, path: "/projects/first" };
  const moved: ProjectSnapshot = { identity, path: "/projects/moved" };
  let firstPathExists = true;
  const layer = Layer.mergeAll(
    makeStore(),
    makeLayout({ inputA: first, inputB: moved }, (path) =>
      Effect.succeed(
        path === first.path && firstPathExists
          ? { status: "valid" as const, identity }
          : { status: "missing" as const },
      ),
    ),
  );

  return Effect.gen(function* () {
    const registered = yield* registerProject("inputA", firstKey);
    expect(registered).toMatchObject({ ok: true, alreadyApplied: false, project: first });

    const duplicate = yield* registerProject("inputB", secondKey);
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: "project-identity-duplicate" },
    });

    firstPathExists = false;
    const movedResult = yield* registerProject("inputB", secondKey);
    expect(movedResult).toMatchObject({ ok: true, project: moved });
    expect((yield* listProjects).projects).toEqual([moved]);
  }).pipe(Effect.provide(layer));
});

it.effect("does not commit index state when Project layout validation fails", () => {
  const layer = Layer.mergeAll(
    makeStore(),
    makeLayout({}, () => Effect.succeed({ status: "missing" as const })),
  );

  return Effect.gen(function* () {
    const result = yield* registerProject("invalid", firstKey);

    expect(result).toMatchObject({ ok: false, error: { code: "project-layout-invalid" } });
    expect((yield* listProjects).projects).toEqual([]);
  }).pipe(Effect.provide(layer));
});
