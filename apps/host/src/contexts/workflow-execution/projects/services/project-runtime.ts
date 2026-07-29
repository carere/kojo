import type { ProjectCondition, ProjectIdentity, ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Layer } from "effect";
import { type ProjectForgetBlockers, ProjectStore } from "./project-store";
import { WorkflowBackend } from "./workflow-backend";

export interface ProjectRuntimeShape {
  readonly coordinateRegistration: <A>(
    project: ProjectSnapshot,
    beforeMigration: Effect.Effect<{
      readonly previousProject?: ProjectSnapshot;
      readonly result?: A;
    }>,
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
    identity: ProjectIdentity,
    resolve: Effect.Effect<
      | { readonly _tag: "project"; readonly project: ProjectSnapshot }
      | { readonly _tag: "result"; readonly result: A }
    >,
    operation: (
      project: ProjectSnapshot,
      blockers: ProjectForgetBlockers,
    ) => Effect.Effect<{ readonly deactivate: boolean; readonly result: A }>,
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
    const serializeIdentity = <A>(identity: string, effect: Effect.Effect<A>) =>
      Effect.promise(() => {
        const previous = pending.get(identity) ?? Promise.resolve();
        const result = previous.then(() => Effect.runPromise(effect));
        pending.set(
          identity,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      });
    const serialize = <A>(project: ProjectSnapshot, effect: Effect.Effect<A>) =>
      serializeIdentity(project.identity, effect);
    const serializeRegistration = <A>(effect: Effect.Effect<A>) =>
      Effect.promise(() => {
        const result = pendingRegistration.then(() => Effect.runPromise(effect));
        pendingRegistration = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      });
    const activate = (project: ProjectSnapshot) =>
      Effect.gen(function* () {
        if (!(yield* backend.acquire(project))) return false;
        yield* backend.quiesce(project);
        if (!(yield* store.migrate(project))) {
          yield* backend.release(project);
          return false;
        }
        const initialized = yield* backend.initialize(project);
        const postflightReady =
          initialized && (yield* backend.postflight(project)) && (yield* store.postflight(project));
        if (!postflightReady) {
          yield* store.completeMigration(project, false);
          yield* backend.release(project);
          return false;
        }
        const completed = yield* store.completeMigration(project, true);
        if (!completed) {
          yield* store.completeMigration(project, false);
          yield* backend.release(project);
        }
        return completed;
      });
    return {
      coordinateRegistration: <A>(
        project: ProjectSnapshot,
        beforeMigration: Effect.Effect<{
          readonly previousProject?: ProjectSnapshot;
          readonly result?: A;
        }>,
        operation: (migrated: boolean) => Effect.Effect<A>,
      ) =>
        serializeRegistration(
          serialize(
            project,
            Effect.gen(function* () {
              const preflight = yield* beforeMigration;
              if (preflight.result !== undefined) return preflight.result;
              if (
                preflight.previousProject !== undefined &&
                preflight.previousProject.path !== project.path
              ) {
                yield* backend.release(preflight.previousProject);
              }
              const storeCondition = yield* store.readiness(project);
              if (storeCondition === "ready") {
                const backendCondition = yield* backend.readiness(project);
                if (backendCondition === "ready") {
                  return yield* operation(yield* backend.postflight(project));
                }
                if (backendCondition === "needs-attention") return yield* operation(false);
              }
              return yield* operation(yield* activate(project));
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
                const backendCondition = yield* backend.readiness(indexedProject);
                if (backendCondition === "ready") {
                  return (yield* backend.postflight(indexedProject))
                    ? ("ready" as const)
                    : ("needs-attention" as const);
                }
                if (backendCondition === "needs-attention") return "needs-attention" as const;
                return (yield* activate(indexedProject))
                  ? ("ready" as const)
                  : ("needs-attention" as const);
              }),
        ),
      inspectForgetBlockers: (project: ProjectSnapshot) =>
        serialize(project, store.inspectForgetBlockers(project)),
      coordinateForget: <A>(
        identity: ProjectIdentity,
        resolve: Effect.Effect<
          | { readonly _tag: "project"; readonly project: ProjectSnapshot }
          | { readonly _tag: "result"; readonly result: A }
        >,
        operation: (
          project: ProjectSnapshot,
          blockers: ProjectForgetBlockers,
        ) => Effect.Effect<{ readonly deactivate: boolean; readonly result: A }>,
      ) =>
        serializeIdentity(
          identity,
          Effect.gen(function* () {
            const resolved = yield* resolve;
            if (resolved._tag === "result") return resolved.result;
            const outcome = yield* operation(
              resolved.project,
              yield* store.inspectForgetBlockers(resolved.project),
            );
            if (outcome.deactivate) yield* backend.release(resolved.project);
            return outcome.result;
          }),
        ),
    };
  }),
);
