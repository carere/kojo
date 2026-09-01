import { createHash } from "node:crypto";
import { canonicalJson } from "./canonicalJson.ts";

/** Stable identity for one authored Phase action. It does not contain user-readable input. */
export const externalActionId = (input: {
  readonly runId: string;
  readonly revisionId: string;
  readonly phasePath: string;
  readonly attempt: number;
  readonly inputHash: string;
}): string =>
  `action_${createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 32)}`;

export const externalActionInputHash = (input: unknown): string =>
  createHash("sha256").update(canonicalJson(input)).digest("hex");
