import type { ProjectCondition, ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import { type ProjectForgetBlockers, ProjectStore } from "./project-store";
import { WorkflowBackend } from "./workflow-backend";

export interface ProjectRuntimeShape {
  readonly coordinateRegistration: <A>(
    project: ProjectSnapshot,
    beforeMigration: Effect.Effect<A | undefined>,
    operation: (migrated: boolean) => Effect.Effect<A>,
  ) => Effect.Effect<A>;
  readonly coordinateLifecycle: <A>(
    project: ProjectSnapshot,
    operation: Effect.Effect<A>,
  ) => Effect.Effect<A>;
  readonly readiness: (
    indexedProject: ProjectSnapshot,
    validatedProject: ProjectSnapshot,
  ) => Effect.Effect<ProjectCondition>;
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
  Effect.gen(function* () {
    const store = yield* ProjectStore;
    const backend = yield* WorkflowBackend;
    const pending = new Map<string, Promise<void>>();
    let pendingRegistration: Promise<void> = Promise.resolve();
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
    const serializeRegistration = <A>(effect: Effect.Effect<A>) =>
      Effect.promise(() => {
        const result = pendingRegistration.then(() => Effect.runPromise(effect));
        pendingRegistration = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      });
    return {
      coordinateRegistration: <A>(
        project: ProjectSnapshot,
        beforeMigration: Effect.Effect<A | undefined>,
        operation: (migrated: boolean) => Effect.Effect<A>,
      ) =>
        serializeRegistration(
          serialize(
            project,
            Effect.gen(function* () {
              const refused = yield* beforeMigration;
              if (refused !== undefined) return refused;
              const storeCondition = yield* store.readiness(project);
              const backendCondition = yield* backend.readiness(project);
              if (storeCondition === "ready" && backendCondition === "ready") {
                return yield* operation(true);
              }
              if (backendCondition === "needs-attention") return yield* operation(false);
              if (!(yield* store.migrate(project))) return yield* operation(false);
              const initialized = yield* backend.initialize(project);
              if (!initialized) {
                yield* backend.release(project);
                yield* store.completeMigration(project, false);
                return yield* operation(false);
              }
              const completed = yield* store.completeMigration(project, true);
              if (!completed) {
                yield* backend.release(project);
                yield* store.completeMigration(project, false);
              }
              return yield* operation(completed);
            }),
          ),
        ),
      coordinateLifecycle: <A>(project: ProjectSnapshot, operation: Effect.Effect<A>) =>
        serialize(project, operation),
      readiness: (indexedProject: ProjectSnapshot, validatedProject: ProjectSnapshot) =>
        serialize(
          indexedProject,
          indexedProject.identity !== validatedProject.identity ||
            indexedProject.path !== validatedProject.path
            ? Effect.succeed("needs-attention" as const)
            : Effect.gen(function* () {
                const storeCondition = yield* store.readiness(indexedProject);
                if (storeCondition !== "ready") return storeCondition;
                return (yield* backend.readiness(indexedProject)) === "ready"
                  ? ("ready" as const)
                  : ("needs-attention" as const);
              }),
        ),
      inspectForgetBlockers: (project: ProjectSnapshot) =>
        serialize(project, store.inspectForgetBlockers(project)),
      coordinateForget: <A>(
        project: ProjectSnapshot,
        operation: (blockers: ProjectForgetBlockers) => Effect.Effect<A>,
      ) => serialize(project, Effect.flatMap(store.inspectForgetBlockers(project), operation)),
    };
  }),
);
