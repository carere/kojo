import { createHash } from "node:crypto";
import type { ProjectMutationResult, RequestKey } from "@kojo/control";
import type { ProjectIndexState } from "../repositories/project-index-repository";

export const projectMutationFingerprint = (operation: "register" | "forget", input: string) =>
  createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");

export const recordProjectMutation = (
  state: ProjectIndexState,
  requestKey: RequestKey,
  operation: "register" | "forget",
  input: string,
  result: ProjectMutationResult,
  selectorLookupKey?: string,
): ProjectIndexState => ({
  ...state,
  receipts: [
    ...state.receipts,
    {
      requestKey,
      operation,
      fingerprint: projectMutationFingerprint(operation, input),
      result,
      ...(selectorLookupKey === undefined ? {} : { selectorLookupKey }),
    },
  ],
});
