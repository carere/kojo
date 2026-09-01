import { Context, type Effect } from "effect";
import type { RunStoreError } from "../../workflow/models/RunStoreError.ts";
import type {
  TriggerAdmission,
  TriggerDeliveryObservation,
  TriggerDeliveryRequest,
} from "../models/TriggerDelivery.ts";

export class TriggerRepository extends Context.Service<
  TriggerRepository,
  {
    readonly admit: (
      request: TriggerDeliveryRequest,
    ) => Effect.Effect<TriggerAdmission, RunStoreError>;
    readonly reject: (
      request: Omit<TriggerDeliveryRequest, "idempotencyKey" | "payload">,
      reason: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly deliveries: Effect.Effect<ReadonlyArray<TriggerDeliveryObservation>, RunStoreError>;
  }
>()("kojo/trigger/TriggerRepository") {}
