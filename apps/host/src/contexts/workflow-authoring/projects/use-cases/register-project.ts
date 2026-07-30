import type { ProjectMutationResult, ProjectSnapshot, RequestKey } from "@kojo/control";
import { Effect } from "effect";
import { ProjectRuntime } from "../../../workflow-execution/projects/services/project-runtime";
import {
  ProjectIndexRepository,
  successfulMutation,
} from "../repositories/project-index-repository";
import { ProjectLayout } from "../services/project-layout";
import { mutationFailure, replay, requestConflict } from "./project-operation-results";
import {
  projectMutationFingerprint as fingerprint,
  recordProjectMutation as record,
} from "./project-receipts";

interface RegistrationPreflight {
  readonly previousProject?: ProjectSnapshot;
  readonly result?: ProjectMutationResult;
}

export const registerProject = (
  path: string,
  requestKey: RequestKey,
): Effect.Effect<
  ProjectMutationResult,
  never,
  ProjectIndexRepository | ProjectLayout | ProjectRuntime
> =>
  Effect.gen(function* () {
    const repository = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const requestFingerprint = fingerprint("register", path);
    const initial = yield* repository.read;
    const existingReceipt = initial.receipts.find(
      (candidate) => candidate.requestKey === requestKey,
    );
    if (existingReceipt !== undefined) {
      return existingReceipt.operation === "register" &&
        existingReceipt.fingerprint === requestFingerprint
        ? replay(existingReceipt.result)
        : requestConflict(requestKey);
    }

    const validation = yield* layout.validate(path);
    if (!validation.ok) {
      return yield* repository.update((state) => {
        const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
        if (receipt !== undefined) {
          return Effect.succeed({
            state,
            result:
              receipt.operation === "register" && receipt.fingerprint === requestFingerprint
                ? replay(receipt.result)
                : requestConflict(requestKey),
          });
        }
        const result = mutationFailure(
          requestKey,
          "project-layout-invalid",
          validation.message,
          "Run kojo init for this working tree.",
          { kind: "project-path", path },
          [validation.findingKey],
        );
        return Effect.succeed({
          state: record(state, requestKey, "register", path, result),
          result,
        });
      });
    }
    const project = validation.project;
    const definitionValidation = validation.definitions;
    if (definitionValidation.ok === false) {
      return yield* repository.update((state) => {
        const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
        if (receipt !== undefined) {
          return Effect.succeed({
            state,
            result:
              receipt.operation === "register" && receipt.fingerprint === requestFingerprint
                ? replay(receipt.result)
                : requestConflict(requestKey),
          });
        }
        const result = mutationFailure(
          requestKey,
          "project-layout-invalid",
          definitionValidation.message,
          "Correct the Kojo Configuration and retry registration.",
          { kind: "project-path", path },
          definitionValidation.findings.map((finding) => finding.findingKey),
        );
        return Effect.succeed({
          state: record(state, requestKey, "register", path, result),
          result,
        });
      });
    }
    yield* runtime.acceptDefinitions(project, definitionValidation);
    const checkConflictsBeforeMigration = repository.update<RegistrationPreflight>((state) =>
      Effect.gen(function* () {
        const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
        if (receipt !== undefined) {
          return {
            state,
            result: {
              result:
                receipt.operation === "register" && receipt.fingerprint === requestFingerprint
                  ? replay(receipt.result)
                  : requestConflict(requestKey),
            },
          };
        }
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
          return {
            state: record(state, requestKey, "register", path, result),
            result: { result },
          };
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
            return {
              state: record(state, requestKey, "register", path, result),
              result: { result },
            };
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
            return {
              state: record(state, requestKey, "register", path, result),
              result: { result },
            };
          }
        }
        return {
          state,
          result: {
            ...(existing === undefined ? {} : { previousProject: existing }),
          },
        };
      }),
    );
    return yield* runtime.coordinateRegistration(
      project,
      checkConflictsBeforeMigration,
      (migrated) =>
        repository.update((state) =>
          Effect.gen(function* () {
            const receipt = state.receipts.find((candidate) => candidate.requestKey === requestKey);
            if (receipt !== undefined) {
              return {
                state,
                result:
                  receipt.operation === "register" && receipt.fingerprint === requestFingerprint
                    ? replay(receipt.result)
                    : requestConflict(requestKey),
              };
            }
            if (!migrated) {
              const result = mutationFailure(
                requestKey,
                "project-layout-invalid",
                "Kojo Project database migration could not be completed safely.",
                "Restore the Project database and retry registration.",
                { kind: "project", identity: project.identity },
                ["store.migration-failed"],
              );
              return { state: record(state, requestKey, "register", path, result), result };
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
        ),
    );
  });
