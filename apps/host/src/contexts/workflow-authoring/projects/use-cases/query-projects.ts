import type {
  ProjectIdentity,
  ProjectList,
  ProjectListInput,
  ProjectListResult,
  ProjectQueryResult,
} from "@kojo/control";
import { Effect } from "effect";
import { ProjectRuntime } from "../../../workflow-execution/projects/services/project-runtime";
import { ProjectIndexRepository } from "../repositories/project-index-repository";
import { ProjectLayout } from "../services/project-layout";
import {
  decodeProjectCursor as decodeCursor,
  encodeProjectCursor as encodeCursor,
  projectFilterFingerprint as filterFingerprint,
} from "./project-list-cursor";
import { queryFailure } from "./project-operation-results";

export const listProjects: Effect.Effect<ProjectList, never, ProjectIndexRepository> = Effect.gen(
  function* () {
    const repository = yield* ProjectIndexRepository;
    const state = yield* repository.read;
    return {
      projects: [...state.projects].sort((left, right) =>
        right.identity.localeCompare(left.identity),
      ),
    };
  },
);

export const listProjectPage = (
  input: ProjectListInput = { conditions: [], limit: 50 },
): Effect.Effect<
  ProjectListResult,
  never,
  ProjectIndexRepository | ProjectLayout | ProjectRuntime
> =>
  Effect.gen(function* () {
    const repository = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const state = yield* repository.read;
    const assessed = yield* Effect.all(
      state.projects.map((project) =>
        Effect.gen(function* () {
          const validation = yield* layout.validate(project.path);
          return {
            ...project,
            condition: validation.ok
              ? yield* runtime.readiness(project, validation.project)
              : ("needs-attention" as const),
          };
        }),
      ),
    );
    const filters = filterFingerprint(input);
    const decoded = decodeCursor(input.cursor, filters);
    if (!decoded.ok) return decoded.result;
    const filtered = assessed
      .filter(
        (project) => input.conditions.length === 0 || input.conditions.includes(project.condition),
      )
      .sort((left, right) => right.identity.localeCompare(left.identity));
    const after = decoded.cursor?.sort.identity;
    const start =
      after === undefined
        ? 0
        : filtered.findIndex((item) => item.identity.localeCompare(after) < 0);
    const pageStart = start < 0 ? filtered.length : start;
    const items = filtered.slice(pageStart, pageStart + input.limit);
    return {
      ok: true,
      page: {
        items,
        nextCursor:
          pageStart + items.length < filtered.length && items.length > 0
            ? encodeCursor(items[items.length - 1].identity, filters)
            : null,
      },
    };
  });

export const showProject = (
  identity: ProjectIdentity,
): Effect.Effect<ProjectQueryResult, never, ProjectIndexRepository> =>
  Effect.gen(function* () {
    const repository = yield* ProjectIndexRepository;
    const state = yield* repository.read;
    const project = state.projects.find((candidate) => candidate.identity === identity);
    return project === undefined
      ? queryFailure(
          "project-not-found",
          "Kojo Project was not found in the Project Index.",
          "Register the Project or choose a listed Project Identity.",
          { kind: "project", identity },
          [],
        )
      : { ok: true, project };
  });
