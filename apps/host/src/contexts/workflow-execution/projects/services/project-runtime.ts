import type { ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import { type ProjectForgetBlockers, ProjectStore } from "./project-store";

export interface ProjectRuntimeShape {
  readonly prepareProject: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly inspectForgetBlockers: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ProjectForgetBlockers>;
  readonly coordinateForget: <A>(
    project: ProjectSnapshot,
    operation: (blockers: ProjectForgetBlockers) => Effect.Effect<A>,
    didForget: (result: A) => boolean,
  ) => Effect.Effect<A>;
  readonly runLifecycleMutation: <A>(
    project: ProjectSnapshot,
    mutation: Effect.Effect<A>,
  ) => Effect.Effect<A | undefined>;
}

export class ProjectRuntime extends Context.Service<ProjectRuntime, ProjectRuntimeShape>()(
  "kojo/host/ProjectRuntime",
) {}

export const ProjectRuntimeLive = Layer.effect(
  ProjectRuntime,
  Effect.map(ProjectStore, (store) => {
    const pending = new Map<string, Promise<void>>();
    const forgotten = new Set<string>();
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
      prepareProject: (project: ProjectSnapshot) =>
        serialize(
          project,
          Effect.tap(store.prepare(project), (ready) =>
            Effect.sync(() => {
              if (ready) forgotten.delete(project.identity);
            }),
          ),
        ),
      inspectForgetBlockers: (project: ProjectSnapshot) =>
        serialize(project, store.inspectForgetBlockers(project)),
      coordinateForget: <A>(
        project: ProjectSnapshot,
        operation: (blockers: ProjectForgetBlockers) => Effect.Effect<A>,
        didForget: (result: A) => boolean,
      ) =>
        serialize(
          project,
          Effect.tap(Effect.flatMap(store.inspectForgetBlockers(project), operation), (result) =>
            Effect.sync(() => {
              if (didForget(result)) forgotten.add(project.identity);
            }),
          ),
        ),
      runLifecycleMutation: <A>(project: ProjectSnapshot, mutation: Effect.Effect<A>) =>
        serialize(
          project,
          Effect.suspend(() =>
            forgotten.has(project.identity) ? Effect.succeed(undefined) : mutation,
          ),
        ),
    };
  }),
);
