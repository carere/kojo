import { createHash } from "node:crypto";

/** Stable JSON identity for replay decisions. */
export const canonicalReplayJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("external action input must be finite JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalReplayJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalReplayJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("external action input must be JSON");
};

export interface ExternalActionIdentityInput {
  readonly runId: string;
  readonly revisionId: string;
  readonly phasePath: string;
  readonly attempt: number;
  readonly payload: object;
}

/** Pure identity decision shared by first execution and replay. */
export const externalActionIdentity = (
  input: ExternalActionIdentityInput,
): { readonly actionId: string; readonly inputHash: string } => {
  const inputHash = createHash("sha256")
    .update(
      canonicalReplayJson({
        payload: input.payload,
        phasePath: input.phasePath,
        attempt: input.attempt,
      }),
    )
    .digest("hex");
  const actionId = `action_${createHash("sha256")
    .update(
      canonicalReplayJson({
        runId: input.runId,
        revisionId: input.revisionId,
        phasePath: input.phasePath,
        attempt: input.attempt,
        inputHash,
      }),
    )
    .digest("hex")
    .slice(0, 32)}`;
  return { actionId, inputHash };
};

export type RecordedReplayDecision<A> =
  | { readonly kind: "execute" }
  | { readonly kind: "reuse"; readonly result: A };

/** Pure replay choice. A recorded result always wins over a second execution. */
export const recordedReplayDecision = <A>(recorded: A | undefined): RecordedReplayDecision<A> =>
  recorded === undefined ? { kind: "execute" } : { kind: "reuse", result: recorded };

/** External activities require recovery evidence. Ordinary activities do not. */
export const externalActionDecision = (
  recoveryPolicy: unknown,
): "ordinary" | "recoverable-external" =>
  recoveryPolicy === undefined ? "ordinary" : "recoverable-external";
