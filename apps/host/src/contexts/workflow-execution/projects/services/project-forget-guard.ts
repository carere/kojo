import type { ProjectSnapshot } from "@kojo/control";
import { Context, type Effect } from "effect";

export interface ProjectForgetBlockers {
  readonly assessment: "available" | "unavailable";
  readonly enabledScheduleKeys: ReadonlyArray<string>;
  readonly nonFinalRunIds: ReadonlyArray<string>;
}

export interface ProjectForgetGuardShape {
  readonly inspect: (project: ProjectSnapshot) => Effect.Effect<ProjectForgetBlockers>;
}

export class ProjectForgetGuard extends Context.Service<
  ProjectForgetGuard,
  ProjectForgetGuardShape
>()("kojo/host/ProjectForgetGuard") {}
