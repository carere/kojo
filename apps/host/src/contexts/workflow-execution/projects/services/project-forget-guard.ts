import type { ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";

export interface ProjectForgetBlockers {
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

export const ProjectForgetGuardLive = Layer.succeed(ProjectForgetGuard, {
  inspect: () => Effect.succeed({ enabledScheduleKeys: [], nonFinalRunIds: [] }),
});
