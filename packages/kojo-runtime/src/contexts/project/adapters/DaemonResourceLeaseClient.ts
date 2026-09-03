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
  }).pipe(Effect.timeout("250 millis"), Effect.retry({ times: 2 }), Effect.orDie);

const confirmed = (
  send: SendResourceMutation,
  kind: Parameters<SendResourceMutation>[0],
  body: JsonValue,
) => committed(send, kind, body).pipe(Effect.asVoid);

/** Resource lease client over the authenticated private Runner channel. */
export const layer = (send: SendResourceMutation): Layer.Layer<ResourceLeaseClient> =>
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
        }).pipe(
          Effect.map((result) => {
            if (
              result.acquisitionKey !== resource.acquisitionKey ||
              typeof result.providerIdentity !== "string" ||
              typeof result.inspectionLocator !== "string"
            ) {
              throw new Error("the Daemon did not return the exact committed Resource identity");
            }
            return {
              acquisitionKey: resource.acquisitionKey,
              providerIdentity: result.providerIdentity,
              inspectionLocator: result.inspectionLocator,
              ...(typeof result.providerLocator === "string"
                ? { providerLocator: result.providerLocator }
                : {}),
            };
          }),
          Effect.orDie,
        ),
      confirmAcquired: (leaseId, evidence) =>
        confirmed(send, "ConfirmResourceAcquired", {
          resourceVersion: 1,
          leaseId,
          acquiredAt: new Date().toISOString(),
          providerIdentity: evidence.providerIdentity,
          locator: evidence.locator,
        }),
      beginRelease: (leaseId) =>
        confirmed(send, "BeginResourceRelease", {
          resourceVersion: 1,
          leaseId,
          requestedAt: new Date().toISOString(),
        }),
      confirmReleased: (leaseId, evidence) =>
        confirmed(send, "ConfirmResourceReleased", {
          resourceVersion: 1,
          leaseId,
          releasedAt: new Date().toISOString(),
          evidence,
        }),
      preserve: (leaseId, reason) =>
        confirmed(send, "PreserveResource", {
          resourceVersion: 1,
          leaseId,
          observedAt: new Date().toISOString(),
          reason,
        }),
      unresolved: (leaseId, reason) =>
        confirmed(send, "ReportRecovery", {
          resourceVersion: 1,
          leaseId,
          observedAt: new Date().toISOString(),
          reason,
          outcome: "unresolved",
        }),
    }),
  );
