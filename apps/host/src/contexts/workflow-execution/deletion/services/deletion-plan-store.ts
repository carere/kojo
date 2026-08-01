import type { RequestKey } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import type { DeletionPlanRecord } from "../models/deletion-plan";

export interface DeletionPlanStoreShape {
  readonly read: (planKey: RequestKey) => Effect.Effect<DeletionPlanRecord | undefined>;
  readonly write: (plan: DeletionPlanRecord) => Effect.Effect<void>;
  readonly remove: (planKey: RequestKey) => Effect.Effect<void>;
}

export class DeletionPlanStore extends Context.Service<DeletionPlanStore, DeletionPlanStoreShape>()(
  "kojo/host/DeletionPlanStore",
) {}

/**
 * Preview plans are deliberately ephemeral. Losing one on Host restart is
 * safe: it never makes a target unavailable and forces a fresh preview.
 * Confirmed work is durable in the Project store instead.
 */
export const DeletionPlanStoreLive = Layer.sync(DeletionPlanStore, () => {
  const plans = new Map<RequestKey, DeletionPlanRecord>();
  return {
    read: (planKey) => Effect.sync(() => plans.get(planKey)),
    write: (plan) => Effect.sync(() => plans.set(plan.planKey, plan)),
    remove: (planKey) => Effect.sync(() => plans.delete(planKey)),
  } satisfies DeletionPlanStoreShape;
});
