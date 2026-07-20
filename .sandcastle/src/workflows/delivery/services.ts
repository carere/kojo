import { Context, type Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type {
  DeliveryWorkstream,
  IntegrationFailureKind,
  PreparedTarget,
  ReviewedIssue,
  TrackerIssue,
} from "../../types/delivery";
import type {
  DecodeError,
  ExternalServiceError,
  ProcessError,
  VerificationCheckError,
  WorkflowError,
} from "../../types/errors";
import type { DeliveryRepository } from "./repository";

type DeliveryFailure =
  | DecodeError
  | ExternalServiceError
  | ProcessError
  | VerificationCheckError
  | WorkflowError;

export class DeliveryTracker extends Context.Service<
  DeliveryTracker,
  {
    readonly loadWorkstream: (
      repository: DeliveryRepository,
      rootNumber: number,
    ) => Effect.Effect<DeliveryWorkstream, DeliveryFailure, ChildProcessSpawner>;
    readonly ensurePullRequest: (
      repository: DeliveryRepository,
      workstream: DeliveryWorkstream,
      verifiedTargetOid: string,
    ) => Effect.Effect<string, DeliveryFailure, ChildProcessSpawner>;
    readonly holdPullRequest: (
      repository: DeliveryRepository,
      workstream: DeliveryWorkstream,
    ) => Effect.Effect<void, DeliveryFailure, ChildProcessSpawner>;
    readonly closeIssueAsCompleted: (
      repositoryRoot: string,
      ticket: TrackerIssue,
      targetBranch: string,
      targetCommit: string,
    ) => Effect.Effect<void, DeliveryFailure, ChildProcessSpawner>;
  }
>()("sandcastle/delivery/DeliveryTracker") {}

export class DeliveryAgents extends Context.Service<
  DeliveryAgents,
  {
    readonly plan: (
      target: PreparedTarget,
      workstream: DeliveryWorkstream,
      frontier: ReadonlyArray<TrackerIssue>,
      concurrency: number,
    ) => Effect.Effect<ReadonlyArray<string>, DeliveryFailure, ChildProcessSpawner>;
    readonly implementAndReview: (
      repositoryRoot: string,
      target: PreparedTarget,
      workstream: DeliveryWorkstream,
      issue: TrackerIssue,
    ) => Effect.Effect<ReviewedIssue, DeliveryFailure, ChildProcessSpawner>;
    readonly verify: (
      repositoryRoot: string,
      workstream: DeliveryWorkstream,
      targetCommit: string,
    ) => Effect.Effect<void, DeliveryFailure, ChildProcessSpawner>;
    readonly repair: (
      target: PreparedTarget,
      workstream: DeliveryWorkstream,
      issue: ReviewedIssue,
      failureKind: typeof IntegrationFailureKind.Type,
      failureOutput: string,
    ) => Effect.Effect<void, DeliveryFailure, ChildProcessSpawner>;
  }
>()("sandcastle/delivery/DeliveryAgents") {}
