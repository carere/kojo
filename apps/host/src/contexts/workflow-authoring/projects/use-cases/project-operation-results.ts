import type {
  ProjectMutationResult,
  ProjectOperationError,
  ProjectQueryResult,
  ReadinessFindingKey,
  RequestKey,
} from "@kojo/control";

export const operationError = (
  code: ProjectOperationError["code"],
  message: string,
  next: string,
  affectedResource: ProjectOperationError["affectedResource"],
  findingKeys: ReadonlyArray<ReadinessFindingKey>,
): ProjectOperationError => ({ code, message, next, affectedResource, findingKeys });

export const queryFailure = (...args: Parameters<typeof operationError>): ProjectQueryResult => ({
  ok: false,
  error: operationError(...args),
});

export const mutationFailure = (
  requestKey: RequestKey,
  ...args: Parameters<typeof operationError>
): ProjectMutationResult => ({ ok: false, requestKey, error: operationError(...args) });

export const requestConflict = (requestKey: RequestKey) =>
  mutationFailure(
    requestKey,
    "request-key-conflict",
    "This Request Key was already used for a different Project mutation.",
    "Retry with the original request contents or use a new Request Key.",
    { kind: "request-key", requestKey },
    [],
  );

export const replay = (result: ProjectMutationResult): ProjectMutationResult =>
  result.ok ? { ...result, alreadyApplied: true } : result;
