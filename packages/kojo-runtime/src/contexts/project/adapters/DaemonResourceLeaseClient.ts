import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Context, Data, Effect, Layer } from "effect";
import { ResourceLeaseClient } from "../ports/ResourceLeaseClient.ts";

export type SendResourceMutation = (
  kind:
    | "BeginResourceAcquisition"
    | "ConfirmResourceAcquired"
    | "BeginResourceRelease"
    | "ConfirmResourceReleased"
    | "PreserveResource"
    | "ReportRecovery",
  body: JsonValue,
) => Promise<Record<string, JsonValue>>;

class ResourceMutationError extends Data.TaggedError("ResourceMutationError")<{
  readonly cause: unknown;
}> {}

const committed = (
  send: SendResourceMutation,
  kind: Parameters<SendResourceMutation>[0],
  body: JsonValue,
) =>
  Effect.tryPromise({
    try: () => send(kind, body),
    catch: (cause) => new ResourceMutationError({ cause }),
  }).pipe(Effect.orDie, Effect.asVoid);

/** Resource lease client over the authenticated private Runner channel. */
export const layer = (send: SendResourceMutation): Layer.Layer<never> =>
  Layer.succeedContext(
    Context.make(ResourceLeaseClient, {
      beginAcquisition: (resource) =>
        committed(send, "BeginResourceAcquisition", {
          resourceVersion: 1,
          leaseId: resource.leaseId,
          kind: resource.kind,
          acquisitionKey: resource.acquisitionKey,
          requestedAt: new Date().toISOString(),
          detail: resource.detail,
        }),
      confirmAcquired: (leaseId, evidence) =>
        committed(send, "ConfirmResourceAcquired", {
          resourceVersion: 1,
          leaseId,
          acquiredAt: new Date().toISOString(),
          providerIdentity: evidence.providerIdentity,
          locator: evidence.locator,
        }),
      beginRelease: (leaseId) =>
        committed(send, "BeginResourceRelease", {
          resourceVersion: 1,
          leaseId,
          requestedAt: new Date().toISOString(),
        }),
      confirmReleased: (leaseId, evidence) =>
        committed(send, "ConfirmResourceReleased", {
          resourceVersion: 1,
          leaseId,
          releasedAt: new Date().toISOString(),
          evidence,
        }),
      preserve: (leaseId, reason) =>
        committed(send, "PreserveResource", {
          resourceVersion: 1,
          leaseId,
          observedAt: new Date().toISOString(),
          reason,
        }),
      unresolved: (leaseId, reason) =>
        committed(send, "ReportRecovery", {
          resourceVersion: 1,
          leaseId,
          observedAt: new Date().toISOString(),
          reason,
          outcome: "unresolved",
        }),
    }),
  );
