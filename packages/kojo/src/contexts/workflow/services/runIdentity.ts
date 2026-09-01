import { canonicalJson } from "./canonicalJson.ts";

export const runIdOf = (projectId: string, workflowName: string, idempotencyKey: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonicalJson([1, projectId, workflowName, idempotencyKey]))
    .digest("hex");
