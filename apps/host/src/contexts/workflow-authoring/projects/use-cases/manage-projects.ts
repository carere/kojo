import type {
  ProjectIdentity,
  ProjectList,
  ProjectMutationResult,
  ProjectOperationError,
  ProjectQueryResult,
  RequestKey,
} from "@kojo/control";
import { Effect } from "effect";
import { ProjectIndexStore, successfulMutation } from "../services/project-index-store";
import { ProjectLayout } from "../services/project-layout";

const failure = (
  code: ProjectOperationError["code"],
  message: string,
  next: string,
): ProjectMutationResult | ProjectQueryResult => ({ ok: false, error: { code, message, next } });

const requestConflict = () =>
  failure(
    "request-key-conflict",
    "This Request Key was already used for a different Project mutation.",
    "Retry with the original request contents or use a new Request Key.",
  ) as ProjectMutationResult;

export const listProjects: Effect.Effect<ProjectList, never, ProjectIndexStore> = Effect.gen(
  function* () {
    const store = yield* ProjectIndexStore;
    const state = yield* store.read;
    return {
      projects: [...state.projects].sort((left, right) =>
        left.identity.localeCompare(right.identity),
      ),
    };
  },
);

export const showProject = (
  identity: ProjectIdentity,
): Effect.Effect<ProjectQueryResult, never, ProjectIndexStore> =>
  Effect.gen(function* () {
    const store = yield* ProjectIndexStore;
    const state = yield* store.read;
    const project = state.projects.find((candidate) => candidate.identity === identity);
    return project === undefined
      ? failure(
          "project-not-found",
          "Kojo Project was not found in the Project Index.",
          "Register the Project or choose a listed Project Identity.",
        )
      : { ok: true, project };
  });

export const registerProject = (
  path: string,
  requestKey: RequestKey,
): Effect.Effect<ProjectMutationResult, never, ProjectIndexStore | ProjectLayout> =>
  Effect.gen(function* () {
    const store = yield* ProjectIndexStore;
    const layout = yield* ProjectLayout;
    return yield* store.update((state) =>
      Effect.gen(function* () {
        const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
        if (receipt !== undefined) {
          return {
            state,
            result:
              receipt.operation === "register" && receipt.input === path
                ? successfulMutation(requestKey, receipt.project, true)
                : requestConflict(),
          };
        }

        const validation = yield* layout.validate(path);
        if (!validation.ok) {
          return {
            state,
            result: failure(
              "project-layout-invalid",
              validation.message,
              "Run kojo init for this working tree.",
            ) as ProjectMutationResult,
          };
        }
        const project = validation.project;
        const samePath = state.projects.find((candidate) => candidate.path === project.path);
        if (samePath !== undefined && samePath.identity !== project.identity) {
          return {
            state,
            result: failure(
              "project-layout-invalid",
              "This Project path is already indexed with another Project Identity.",
              "Inspect the Project metadata and Project Index before retrying.",
            ) as ProjectMutationResult,
          };
        }

        const existing = state.projects.find(
          (candidate) => candidate.identity === project.identity,
        );
        if (existing !== undefined && existing.path !== project.path) {
          const previous = yield* layout.inspectIndexedPath(existing.path);
          if (previous.status === "valid" && previous.identity === project.identity) {
            return {
              state,
              result: failure(
                "project-identity-duplicate",
                "The same Project Identity is present at two working-tree paths.",
                "Run kojo init --new-identity on the copied working tree.",
              ) as ProjectMutationResult,
            };
          }
          if (previous.status === "invalid") {
            return {
              state,
              result: failure(
                "project-identity-duplicate",
                "Kojo cannot safely distinguish a moved Project from a duplicate identity.",
                "Resolve the previous path or assign a new Project Identity explicitly.",
              ) as ProjectMutationResult,
            };
          }
        }

        const projects = [
          ...state.projects.filter(
            (candidate) =>
              candidate.identity !== project.identity && candidate.path !== project.path,
          ),
          project,
        ];
        const nextState = {
          ...state,
          projects,
          receipts: [
            ...state.receipts,
            { requestKey, operation: "register" as const, input: path, project },
          ],
        };
        return { state: nextState, result: successfulMutation(requestKey, project, false) };
      }),
    );
  });

export const forgetProject = (
  identity: ProjectIdentity,
  requestKey: RequestKey,
): Effect.Effect<ProjectMutationResult, never, ProjectIndexStore> =>
  Effect.gen(function* () {
    const store = yield* ProjectIndexStore;
    return yield* store.update((state) =>
      Effect.sync(() => {
        const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
        if (receipt !== undefined) {
          return {
            state,
            result:
              receipt.operation === "forget" && receipt.input === identity
                ? successfulMutation(requestKey, receipt.project, true)
                : requestConflict(),
          };
        }
        const project = state.projects.find((candidate) => candidate.identity === identity);
        if (project === undefined) {
          return {
            state,
            result: failure(
              "project-not-found",
              "Kojo Project was not found in the Project Index.",
              "Choose a listed Project Identity.",
            ) as ProjectMutationResult,
          };
        }
        const nextState = {
          ...state,
          projects: state.projects.filter((candidate) => candidate.identity !== identity),
          receipts: [
            ...state.receipts,
            { requestKey, operation: "forget" as const, input: identity, project },
          ],
        };
        return { state: nextState, result: successfulMutation(requestKey, project, false) };
      }),
    );
  });
