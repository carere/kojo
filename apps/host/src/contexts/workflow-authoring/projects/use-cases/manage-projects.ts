import { createHash } from "node:crypto";
import { sep } from "node:path";
import type {
  ProjectIdentity,
  ProjectList,
  ProjectMutationResult,
  ProjectOperationError,
  ProjectQueryResult,
  ProjectSelector,
  ProjectSnapshot,
  ReadinessFindingKey,
  RequestKey,
} from "@kojo/control";
import { Effect } from "effect";
import { ProjectForgetGuard } from "../../../workflow-execution/projects/services/project-forget-guard";
import {
  type ProjectIndexState,
  ProjectIndexStore,
  successfulMutation,
} from "../services/project-index-store";
import { ProjectLayout } from "../services/project-layout";

const operationError = (
  code: ProjectOperationError["code"],
  message: string,
  next: string,
  affectedResource: ProjectOperationError["affectedResource"],
  findingKeys: ReadonlyArray<ReadinessFindingKey>,
): ProjectOperationError => ({ code, message, next, affectedResource, findingKeys });

const queryFailure = (...args: Parameters<typeof operationError>): ProjectQueryResult => ({
  ok: false,
  error: operationError(...args),
});

const mutationFailure = (
  requestKey: RequestKey,
  ...args: Parameters<typeof operationError>
): ProjectMutationResult => ({ ok: false, requestKey, error: operationError(...args) });

const requestConflict = (requestKey: RequestKey) =>
  mutationFailure(
    requestKey,
    "request-key-conflict",
    "This Request Key was already used for a different Project mutation.",
    "Retry with the original request contents or use a new Request Key.",
    { kind: "request-key", requestKey },
    [],
  );

const replay = (result: ProjectMutationResult): ProjectMutationResult =>
  result.ok ? { ...result, alreadyApplied: true } : result;

const fingerprint = (operation: "register" | "forget", input: string) =>
  createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");

const record = (
  state: ProjectIndexState,
  requestKey: RequestKey,
  operation: "register" | "forget",
  input: string,
  result: ProjectMutationResult,
): ProjectIndexState => ({
  ...state,
  receipts: [
    ...state.receipts,
    { requestKey, operation, fingerprint: fingerprint(operation, input), result },
  ],
});

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
      ? queryFailure(
          "project-not-found",
          "Kojo Project was not found in the Project Index.",
          "Register the Project or choose a listed Project Identity.",
          { kind: "project", identity },
          [],
        )
      : { ok: true, project };
  });

const selectorInput = (selector: ProjectSelector) => JSON.stringify(selector);

const selectorMatchesProject = (selector: ProjectSelector, project: ProjectSnapshot) =>
  selector.kind === "identity"
    ? selector.identity === project.identity
    : selector.path === project.path || selector.path.startsWith(`${project.path}${sep}`);

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
        const requestFingerprint = fingerprint("register", path);
        if (receipt !== undefined) {
          return {
            state,
            result:
              receipt.operation === "register" && receipt.fingerprint === requestFingerprint
                ? replay(receipt.result)
                : requestConflict(requestKey),
          };
        }

        const validation = yield* layout.validate(path);
        if (!validation.ok) {
          const result = mutationFailure(
            requestKey,
            "project-layout-invalid",
            validation.message,
            "Run kojo init for this working tree.",
            { kind: "project-path", path },
            [validation.findingKey],
          );
          return { state: record(state, requestKey, "register", path, result), result };
        }
        const project = validation.project;
        const samePath = state.projects.find((candidate) => candidate.path === project.path);
        if (samePath !== undefined && samePath.identity !== project.identity) {
          const result = mutationFailure(
            requestKey,
            "project-layout-invalid",
            "This Project path is already indexed with another Project Identity.",
            "Inspect the Project metadata and Project Index before retrying.",
            { kind: "project-path", path: project.path },
            ["layout.path-conflict"],
          );
          return { state: record(state, requestKey, "register", path, result), result };
        }

        const existing = state.projects.find(
          (candidate) => candidate.identity === project.identity,
        );
        if (existing !== undefined && existing.path !== project.path) {
          const previous = yield* layout.inspectIndexedPath(existing.path);
          if (previous.status === "valid" && previous.identity === project.identity) {
            const result = mutationFailure(
              requestKey,
              "project-identity-duplicate",
              "The same Project Identity is present at two working-tree paths.",
              "Run kojo init --new-identity on the copied working tree.",
              { kind: "project", identity: project.identity },
              ["project.identity-duplicate"],
            );
            return { state: record(state, requestKey, "register", path, result), result };
          }
          if (previous.status === "invalid") {
            const result = mutationFailure(
              requestKey,
              "project-identity-duplicate",
              "Kojo cannot safely distinguish a moved Project from a duplicate identity.",
              "Resolve the previous path or assign a new Project Identity explicitly.",
              { kind: "project", identity: project.identity },
              ["layout.path-conflict"],
            );
            return { state: record(state, requestKey, "register", path, result), result };
          }
        }

        const projects = [
          ...state.projects.filter(
            (candidate) =>
              candidate.identity !== project.identity && candidate.path !== project.path,
          ),
          project,
        ];
        const result = successfulMutation(requestKey, project, false);
        const nextState = record({ ...state, projects }, requestKey, "register", path, result);
        return { state: nextState, result };
      }),
    );
  });

export const forgetProject = (
  identity: ProjectIdentity,
  selector: ProjectSelector,
  requestKey: RequestKey,
): Effect.Effect<ProjectMutationResult, never, ProjectForgetGuard | ProjectIndexStore> =>
  Effect.gen(function* () {
    const store = yield* ProjectIndexStore;
    const guard = yield* ProjectForgetGuard;
    return yield* store.update((state) =>
      Effect.gen(function* () {
        const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
        const input = selectorInput(selector);
        const requestFingerprint = fingerprint("forget", input);
        if (receipt !== undefined) {
          return {
            state,
            result:
              receipt.operation === "forget" && receipt.fingerprint === requestFingerprint
                ? replay(receipt.result)
                : requestConflict(requestKey),
          };
        }
        const project = state.projects.find((candidate) => candidate.identity === identity);
        if (project === undefined || !selectorMatchesProject(selector, project)) {
          const result = mutationFailure(
            requestKey,
            "project-not-found",
            "Kojo Project was not found in the Project Index.",
            "Choose a listed Project Identity.",
            { kind: "project", identity },
            [],
          );
          return { state: record(state, requestKey, "forget", input, result), result };
        }

        const blockers = yield* guard.inspect(project);
        if (blockers.assessment === "unavailable") {
          const result = mutationFailure(
            requestKey,
            "project-forget-blocked",
            "Kojo could not verify that Project execution state is safe to forget.",
            "Restore Project database readiness and retry.",
            { kind: "project", identity },
            ["store.open-failed"],
          );
          return { state: record(state, requestKey, "forget", input, result), result };
        }
        if (blockers.enabledScheduleKeys.length > 0 || blockers.nonFinalRunIds.length > 0) {
          const result = mutationFailure(
            requestKey,
            "project-forget-blocked",
            "Kojo Project cannot be forgotten while it has enabled Workflow Schedules or non-final Workflow Runs.",
            "Disable every Workflow Schedule and finish or stop every non-final Workflow Run, then retry.",
            { kind: "project", identity },
            [],
          );
          return { state: record(state, requestKey, "forget", input, result), result };
        }

        const result = successfulMutation(requestKey, project, false);
        const nextState = record(
          {
            ...state,
            projects: state.projects.filter((candidate) => candidate.identity !== identity),
          },
          requestKey,
          "forget",
          input,
          result,
        );
        return { state: nextState, result };
      }),
    );
  });

export const replayForgetProject = (
  selector: ProjectSelector,
  requestKey: RequestKey,
): Effect.Effect<ProjectMutationResult, never, ProjectIndexStore> =>
  Effect.gen(function* () {
    const store = yield* ProjectIndexStore;
    const state = yield* store.read;
    const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
    if (
      receipt === undefined ||
      receipt.operation !== "forget" ||
      receipt.fingerprint !== fingerprint("forget", selectorInput(selector))
    ) {
      return requestConflict(requestKey);
    }
    return replay(receipt.result);
  });
