import type { ProjectCondition, ProjectSnapshot } from "@kojo/control";
import { Context, type Effect } from "effect";

export interface ProjectForgetBlockers {
  readonly assessment: "available" | "unavailable";
  /** A durable deletion intent keeps the Project indexed until replay completes. */
  readonly pendingDeletion?: boolean;
  readonly enabledScheduleKeys: ReadonlyArray<string>;
  readonly nonFinalRunIds: ReadonlyArray<string>;
}

export interface ProjectRepositoryShape {
  readonly migrate: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly postflight: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly completeMigration: (
    project: ProjectSnapshot,
    succeeded: boolean,
  ) => Effect.Effect<boolean>;
  readonly readiness: (project: ProjectSnapshot) => Effect.Effect<ProjectCondition>;
  /** Reads the durable deletion-intent fence without activating the Project. */
  readonly hasPendingDeletion?: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  /** Clears the once-per-activation guard after an explicit repair request. */
  readonly retryMigration?: (project: ProjectSnapshot) => Effect.Effect<void>;
  readonly inspectForgetBlockers: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ProjectForgetBlockers>;
}

export class ProjectRepository extends Context.Service<ProjectRepository, ProjectRepositoryShape>()(
  "kojo/host/ProjectRepository",
) {}
