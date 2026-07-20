import { Layer } from "effect";
import { implementAndReview } from "./agents/implementation";
import { planFrontier } from "./agents/planner";
import { runMergeRepair, runVerificationSandbox } from "./agents/verification";
import { closeIssueAsCompleted, loadWorkstream } from "./issues";
import { ensureDeliveryPullRequest, holdDeliveryPullRequest } from "./pull-request";
import { DeliveryAgents, DeliveryTracker } from "./services";

const deliveryTrackerLive = Layer.succeed(
  DeliveryTracker,
  DeliveryTracker.of({
    closeIssueAsCompleted,
    ensurePullRequest: ensureDeliveryPullRequest,
    holdPullRequest: holdDeliveryPullRequest,
    loadWorkstream,
  }),
);

const deliveryAgentsLive = Layer.succeed(
  DeliveryAgents,
  DeliveryAgents.of({
    implementAndReview,
    plan: planFrontier,
    repair: runMergeRepair,
    verify: runVerificationSandbox,
  }),
);

export const deliveryServicesLive = Layer.merge(deliveryTrackerLive, deliveryAgentsLive);
