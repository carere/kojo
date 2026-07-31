import type { ProjectCondition, ProjectIdentity, ProjectSnapshot } from "@kojo/control";
import type {
  ProjectDefinitionSnapshot,
  ProjectDefinitionValidation,
} from "@kojo/control/project-definition-validation";
import { Context, Effect, Layer, Option } from "effect";
import type { HostIdentity } from "../../control/models/host-identity";
import { HOST_INFORMATION } from "../../control/models/host-information";
import { HostDiagnosticLogger } from "../../control/services/host-diagnostic-logger";
import { RetentionRepository } from "../../retention/repositories/retention-repository";
import { withRetentionCompletionDiagnostic } from "../../retention/services/retention-completion";
import { type ProjectForgetBlockers, ProjectRepository } from "../repositories/project-repository";
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
  readonly coordinateRetention: <A>(
    project: ProjectSnapshot,
    operation: Effect.Effect<A>,
  ) => Effect.Effect<A>;
  readonly readiness: (
    indexedProject: ProjectSnapshot,
    validatedProject: ProjectSnapshot,
    definitions?: ProjectDefinitionValidation,
  ) => Effect.Effect<ProjectCondition>;
  readonly acceptDefinitions: (
    project: ProjectSnapshot,
    definitions: ProjectDefinitionValidation,
  ) => Effect.Effect<ProjectDefinitionSnapshot | undefined>;
  readonly definitions: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ProjectDefinitionSnapshot | undefined>;
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
    const repository = yield* ProjectRepository;
    const backend = yield* WorkflowBackend;
    const diagnosticLogger = yield* Effect.serviceOption(HostDiagnosticLogger);
    const retentionRepository = yield* Effect.serviceOption(RetentionRepository);
    const pending = new Map<string, Promise<void>>();
    const acceptedDefinitions = new Map<
      string,
      { readonly path: string; readonly snapshot: ProjectDefinitionSnapshot }
    >();
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
    const acceptDefinitions = (
      project: ProjectSnapshot,
      definitions: ProjectDefinitionValidation,
    ) =>
      Effect.sync(() => {
        const accepted = acceptedDefinitions.get(project.identity);
        if (definitions.ok) {
          acceptedDefinitions.set(project.identity, {
            path: project.path,
            snapshot: definitions.snapshot,
          });
          return definitions.snapshot;
        }
        return accepted?.path === project.path ? accepted.snapshot : undefined;
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
    const activate = (project: ProjectSnapshot) => {
      const startedAt = Date.now();
      return Effect.gen(function* () {
        if (!(yield* backend.acquire(project))) return false;
        yield* backend.quiesce(project);
        if (!(yield* repository.migrate(project))) {
          yield* backend.release(project);
          return false;
        }
        const initialized = yield* backend.initialize(project);
        const postflightReady =
          initialized &&
          (yield* backend.postflight(project)) &&
          (yield* repository.postflight(project));
        if (!postflightReady) {
          yield* backend.quiesce(project);
          yield* repository.completeMigration(project, false);
          yield* backend.release(project);
          return false;
        }
        const completed = yield* repository.completeMigration(project, true);
        if (completed && Option.isSome(retentionRepository)) {
          // activate is already running inside the Project Runtime serialization.
          yield* withRetentionCompletionDiagnostic(
            project,
            retentionRepository.value.cleanup(project),
            Option.isSome(diagnosticLogger) ? diagnosticLogger.value : undefined,
          ).pipe(Effect.catchCause(() => Effect.void));
        }
        if (!completed) {
          yield* backend.quiesce(project);
          yield* repository.completeMigration(project, false);
          yield* backend.release(project);
        }
        return completed;
      }).pipe(
        Effect.tap((activated) => {
          if (Option.isNone(diagnosticLogger) || backend.hostIdentity === undefined) {
            return Effect.void;
          }
          return diagnosticLogger.value
            .emit({
              eventVersion: 1,
              eventKind: "project-runtime.activation.completed",
              hostIdentity: backend.hostIdentity as HostIdentity,
              operation: "ProjectRuntimeActivate",
              outcome: activated ? "success" : "error",
              ...(activated ? {} : { safeErrorCode: "project-runtime-activation-failed" }),
              durationMs: Math.max(0, Date.now() - startedAt),
              hostVersion: HOST_INFORMATION.hostVersion,
              protocolMajor: HOST_INFORMATION.protocol.major,
              protocolMinor: HOST_INFORMATION.protocol.minor,
              projectIdentity: project.identity,
              timestamp: new Date().toISOString(),
            })
            .pipe(Effect.ignore);
        }),
      );
    };
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
              const storeCondition = yield* repository.readiness(project);
              if (storeCondition === "ready") {
                const backendCondition = yield* backend.readiness(project);
                if (backendCondition === "ready") {
                  const backendReady = yield* backend.postflight(project);
                  const compatible = backendReady && (yield* repository.postflight(project));
                  if (!compatible) yield* backend.release(project);
                  return yield* operation(compatible);
                }
                if (backendCondition === "needs-attention") return yield* operation(false);
              }
              return yield* operation(yield* activate(project));
            }),
          ),
        ),
      coordinateLifecycle: <A>(project: ProjectSnapshot, operation: Effect.Effect<A>) =>
        serialize(project, operation),
      coordinateRetention: <A>(project: ProjectSnapshot, operation: Effect.Effect<A>) =>
        serialize(project, operation),
      readiness: (
        indexedProject: ProjectSnapshot,
        validatedProject: ProjectSnapshot,
        definitions?: ProjectDefinitionValidation,
      ) =>
        serialize(
          indexedProject,
          indexedProject.identity !== validatedProject.identity ||
            indexedProject.path !== validatedProject.path
            ? Effect.succeed("needs-attention" as const)
            : Effect.gen(function* () {
                const accepted =
                  definitions === undefined
                    ? acceptedDefinitions.get(indexedProject.identity)?.snapshot
                    : yield* acceptDefinitions(indexedProject, definitions);
                if (definitions !== undefined && !definitions.ok && accepted === undefined) {
                  return "needs-attention" as const;
                }
                const storeCondition = yield* repository.readiness(indexedProject);
                if (storeCondition !== "ready") return storeCondition;
                const backendCondition = yield* backend.readiness(indexedProject);
                if (backendCondition === "ready") {
                  const backendReady = yield* backend.postflight(indexedProject);
                  const healthy = backendReady && (yield* repository.postflight(indexedProject));
                  if (!healthy) {
                    yield* backend.release(indexedProject);
                    return "needs-attention" as const;
                  }
                  return definitions !== undefined && !definitions.ok
                    ? ("limited" as const)
                    : ("ready" as const);
                }
                if (backendCondition === "needs-attention") return "needs-attention" as const;
                if (definitions !== undefined && !definitions.ok) return "limited" as const;
                return (yield* activate(indexedProject))
                  ? ("ready" as const)
                  : ("needs-attention" as const);
              }),
        ),
      acceptDefinitions: (project, definitions) =>
        serialize(project, acceptDefinitions(project, definitions)),
      definitions: (project) =>
        serialize(
          project,
          Effect.sync(() => {
            const accepted = acceptedDefinitions.get(project.identity);
            return accepted?.path === project.path ? accepted.snapshot : undefined;
          }),
        ),
      inspectForgetBlockers: (project: ProjectSnapshot) =>
        serialize(project, repository.inspectForgetBlockers(project)),
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
              yield* repository.inspectForgetBlockers(resolved.project),
            );
            if (outcome.deactivate) yield* backend.release(resolved.project);
            return outcome.result;
          }),
        ),
    };
  }),
);
