import { Context, type Effect } from "effect";
import type { ProjectRecovery, RunnerFailure } from "../models/ProjectRecovery.ts";
import type { ProjectRecoveryStoreError } from "../models/ProjectRecoveryStoreError.ts";

export class ProjectRecoveryRepository extends Context.Service<
  ProjectRecoveryRepository,
  {
    readonly read: (
      projectId: string,
    ) => Effect.Effect<ProjectRecovery | undefined, ProjectRecoveryStoreError>;
    readonly recordFailure: (
      failure: RunnerFailure,
    ) => Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError>;
    readonly confirmSafety: (
      projectId: string,
      runnerInstanceId: string,
      confirmedAt: string,
    ) => Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError>;
    readonly holdUncertain: (
      projectId: string,
      runnerInstanceId: string,
      detail: string,
    ) => Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError>;
    readonly observeHealthy: (
      projectId: string,
      observedAt: string,
      operationSucceeded: boolean,
    ) => Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError>;
    readonly repair: (
      projectId: string,
      requestedAt: string,
    ) => Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError>;
  }
>()("kojo/project/ProjectRecoveryRepository") {}
