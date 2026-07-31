import type {
  ProjectIdentity,
  ProjectRetentionMutationResult,
  ProjectRetentionQueryResult,
  ProjectRetentionSetInput,
  ProjectSnapshot,
  RequestKey,
  RetentionOperationError,
} from "@kojo/control";
import { Effect } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { RetentionRepository } from "../repositories/retention-repository";

const error = (
  code: RetentionOperationError["code"],
  message: string,
  next: string,
  identity: ProjectIdentity,
  requestKey?: RequestKey,
): RetentionOperationError => ({
  code,
  message,
  next,
  affectedResource:
    requestKey === undefined ? { kind: "project", identity } : { kind: "request-key", requestKey },
  findingKeys: [],
});

const resolveProject = (
  identity: ProjectIdentity,
): Effect.Effect<ProjectSnapshot | RetentionOperationError, never, ProjectIndexRepository> =>
  Effect.gen(function* () {
    const state = yield* (yield* ProjectIndexRepository).read;
    const project = state.projects.find((candidate) => candidate.identity === identity);
    return (
      project ??
      error(
        "project-not-found",
        "Kojo Project was not found in the Project Index.",
        "Register the Project or choose a listed Project Identity.",
        identity,
      )
    );
  });

export const showProjectRetention = (
  identity: ProjectIdentity,
): Effect.Effect<
  ProjectRetentionQueryResult,
  never,
  ProjectIndexRepository | RetentionRepository
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(identity);
    if ("code" in resolved) return { ok: false, error: resolved };
    return { ok: true, retention: yield* (yield* RetentionRepository).show(resolved) };
  });

const mutationFailure = (
  requestKey: RequestKey,
  operationError: RetentionOperationError,
): ProjectRetentionMutationResult => ({ ok: false, requestKey, error: operationError });

export const setProjectRetention = (
  input: ProjectRetentionSetInput,
): Effect.Effect<
  ProjectRetentionMutationResult,
  never,
  ProjectIndexRepository | RetentionRepository
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(input.identity);
    if ("code" in resolved) {
      return mutationFailure(input.requestKey, {
        ...resolved,
        affectedResource: { kind: "project", identity: input.identity },
      });
    }
    const fields = [
      "diagnosticMaxAgeMs",
      "diagnosticMaxBytes",
      "disposableMaxAgeMs",
      "disposableMaxBytes",
    ] as const;
    if (!fields.some((field) => Object.hasOwn(input, field))) {
      return mutationFailure(
        input.requestKey,
        error(
          "retention-invalid",
          "Retention set requires at least one policy value.",
          "Provide one or more retention flags, or use retention reset.",
          input.identity,
          input.requestKey,
        ),
      );
    }
    const result = yield* (yield* RetentionRepository).set(resolved, input);
    if (result._tag === "request-key-conflict") {
      return mutationFailure(
        input.requestKey,
        error(
          "request-key-conflict",
          "This Request Key was already used for a different retention change.",
          "Retry with the original retention values or use a new Request Key.",
          input.identity,
          input.requestKey,
        ),
      );
    }
    return {
      ok: true,
      retention: result.snapshot,
      alreadyApplied: result.alreadyApplied,
      requestKey: input.requestKey,
    };
  });

export const resetProjectRetention = (
  identity: ProjectIdentity,
  requestKey: RequestKey,
): Effect.Effect<
  ProjectRetentionMutationResult,
  never,
  ProjectIndexRepository | RetentionRepository
> =>
  Effect.gen(function* () {
    const resolved = yield* resolveProject(identity);
    if ("code" in resolved) {
      return mutationFailure(requestKey, {
        ...resolved,
        affectedResource: { kind: "project", identity },
      });
    }
    const result = yield* (yield* RetentionRepository).reset(resolved, requestKey);
    if (result._tag === "request-key-conflict") {
      return mutationFailure(
        requestKey,
        error(
          "request-key-conflict",
          "This Request Key was already used for a different retention change.",
          "Retry with the original retention values or use a new Request Key.",
          identity,
          requestKey,
        ),
      );
    }
    return {
      ok: true,
      retention: result.snapshot,
      alreadyApplied: result.alreadyApplied,
      requestKey,
    };
  });

export const cleanupProjectRetention = (
  project: ProjectSnapshot,
  nowMs?: number,
): Effect.Effect<unknown, never, RetentionRepository> =>
  Effect.flatMap(RetentionRepository, (repository) => repository.cleanup(project, nowMs));
