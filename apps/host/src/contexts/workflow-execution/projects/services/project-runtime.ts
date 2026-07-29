import type { ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import { type ProjectForgetBlockers, ProjectStore } from "./project-store";

export interface ProjectRuntimeShape {
  readonly inspectForgetBlockers: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ProjectForgetBlockers>;
}

export class ProjectRuntime extends Context.Service<ProjectRuntime, ProjectRuntimeShape>()(
  "kojo/host/ProjectRuntime",
) {}

export const ProjectRuntimeLive = Layer.effect(
  ProjectRuntime,
  Effect.map(ProjectStore, (store) => {
    const pending = new Map<string, Promise<void>>();
    return {
      inspectForgetBlockers: (project: ProjectSnapshot) =>
        Effect.promise(() => {
          const previous = pending.get(project.identity) ?? Promise.resolve();
          const result = previous.then(() =>
            Effect.runPromise(store.inspectForgetBlockers(project)),
          );
          pending.set(
            project.identity,
            result.then(
              () => undefined,
              () => undefined,
            ),
          );
          return result;
        }),
    };
  }),
);
