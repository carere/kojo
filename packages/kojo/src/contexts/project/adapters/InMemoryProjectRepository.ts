import { basename } from "node:path";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { ProjectDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Effect, Layer } from "effect";
import type { RegisterProjectRequest } from "../models/Project.ts";
import { ProjectStoreError } from "../models/ProjectStoreError.ts";
import { ProjectRepository } from "../ports/ProjectRepository.ts";

export const inMemoryProjectRepository = Layer.sync(ProjectRepository, () => {
  const projects: ProjectDocument[] = [];
  const receipts = new Map<string, { readonly body: string; readonly receipt: OperationReceipt }>();
  let version = 0;
  const keyOf = (dataIdentity: string, requestId: string) => `${dataIdentity}\0${requestId}`;

  return {
    register: (request: RegisterProjectRequest) =>
      Effect.try({
        try: () => {
          const key = keyOf(request.dataIdentity, request.requestId);
          const prior = receipts.get(key);
          if (prior !== undefined) {
            if (prior.body !== request.requestBody) {
              throw new ProjectStoreError({
                code: "REQUEST_ID_CONFLICT",
                message: "This request ID already names different request content.",
                status: 409,
                retry: "lookupOriginal",
                remedy: "Look up the original request.",
              });
            }
            const result = prior.receipt.result as unknown as {
              readonly created: boolean;
              readonly project: ProjectDocument;
            };
            return result;
          }
          let project = projects.find((candidate) => candidate.location === request.location);
          const created = project === undefined;
          if (project === undefined) {
            project = {
              projectId: crypto.randomUUID(),
              label: basename(request.location),
              location: request.location,
              locationActive: true,
              locationConfirmed: true,
              projectState: "available",
              factoryState: request.factory.state,
              refreshState: request.factory.refreshState ?? "current",
              registeredAt: request.observedAt,
              refreshedAt: request.observedAt,
              locationChange: { state: "steady" },
              locationHistory: [{ location: request.location, activeFrom: request.observedAt }],
              ...(request.factory.fault === undefined ? {} : { fault: request.factory.fault }),
              ...(request.factory.remedy === undefined ? {} : { remedy: request.factory.remedy }),
            };
            projects.push(project);
            version += 1;
          }
          const receipt: OperationReceipt = {
            receiptVersion: 1,
            requestId: request.requestId,
            dataIdentity: request.dataIdentity,
            operation: "registerProject",
            status: "committed",
            result: JSON.parse(JSON.stringify({ created, project })),
          };
          receipts.set(key, { body: request.requestBody, receipt });
          return { created, project };
        },
        catch: (cause) =>
          cause instanceof ProjectStoreError
            ? cause
            : new ProjectStoreError({
                code: "PROJECT_STORE_FAILED",
                message: String(cause),
                status: 500,
                retry: "safe",
                remedy: "Retry the request.",
              }),
      }),
    projects: Effect.sync(() => [...projects]),
    receipt: (dataIdentity: string, requestId: string) =>
      Effect.sync(() => receipts.get(keyOf(dataIdentity, requestId))?.receipt),
    snapshotVersion: Effect.sync(() => version),
  };
});
