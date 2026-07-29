import type { ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import { ProjectRuntime } from "./project-runtime";
import type { ProjectForgetBlockers } from "./project-store";

export interface ProjectForgetGuardShape {
  readonly inspect: (project: ProjectSnapshot) => Effect.Effect<ProjectForgetBlockers>;
}

export class ProjectForgetGuard extends Context.Service<
  ProjectForgetGuard,
  ProjectForgetGuardShape
>()("kojo/host/ProjectForgetGuard") {}

export const ProjectForgetGuardLive: Layer.Layer<ProjectForgetGuard, never, ProjectRuntime> =
  Layer.effect(
    ProjectForgetGuard,
    Effect.map(ProjectRuntime, (runtime) => ({
      inspect: runtime.inspectForgetBlockers,
    })),
  );
