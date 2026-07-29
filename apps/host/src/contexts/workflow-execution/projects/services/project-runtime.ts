import type { ProjectCondition, ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import { type ProjectForgetBlockers, ProjectStore } from "./project-store";

export interface ProjectRuntimeShape {
  readonly migrateProject: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly readiness: (project: ProjectSnapshot) => Effect.Effect<ProjectCondition>;
  readonly inspectForgetBlockers: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ProjectForgetBlockers>;
  readonly coordinateForget: <A>(
    project: ProjectSnapshot,
    operation: (blockers: ProjectForgetBlockers) => Effect.Effect<A>,
  ) => Effect.Effect<A>;
}

export class ProjectRuntime extends Context.Service<ProjectRuntime, ProjectRuntimeShape>()(
  "kojo/host/ProjectRuntime",
) {}

export const ProjectRuntimeLive = Layer.effect(
  ProjectRuntime,
  Effect.map(ProjectStore, (store) => {
    const pending = new Map<string, Promise<void>>();
    const serialize = <A>(project: ProjectSnapshot, effect: Effect.Effect<A>) =>
      Effect.promise(() => {
        const previous = pending.get(project.identity) ?? Promise.resolve();
        const result = previous.then(() => Effect.runPromise(effect));
        pending.set(
          project.identity,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      });
    return {
      migrateProject: (project: ProjectSnapshot) => serialize(project, store.migrate(project)),
      readiness: (project: ProjectSnapshot) => serialize(project, store.readiness(project)),
      inspectForgetBlockers: (project: ProjectSnapshot) =>
        serialize(project, store.inspectForgetBlockers(project)),
      coordinateForget: <A>(
        project: ProjectSnapshot,
        operation: (blockers: ProjectForgetBlockers) => Effect.Effect<A>,
      ) => serialize(project, Effect.flatMap(store.inspectForgetBlockers(project), operation)),
    };
  }),
);
