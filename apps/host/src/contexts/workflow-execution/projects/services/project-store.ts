import type { ProjectCondition, ProjectSnapshot } from "@kojo/control";
import { Context, type Effect } from "effect";

export interface ProjectForgetBlockers {
  readonly assessment: "available" | "unavailable";
  readonly enabledScheduleKeys: ReadonlyArray<string>;
  readonly nonFinalRunIds: ReadonlyArray<string>;
}

export interface ProjectStoreShape {
  readonly migrate: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly completeMigration: (
    project: ProjectSnapshot,
    succeeded: boolean,
  ) => Effect.Effect<boolean>;
  readonly readiness: (project: ProjectSnapshot) => Effect.Effect<ProjectCondition>;
  readonly inspectForgetBlockers: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ProjectForgetBlockers>;
}

export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreShape>()(
  "kojo/host/ProjectStore",
) {}
