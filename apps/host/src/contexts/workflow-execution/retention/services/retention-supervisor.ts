import { Effect, Layer, Schedule } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { HOST_INFORMATION } from "../../control/models/host-information";
import { HostDiagnosticLogger } from "../../control/services/host-diagnostic-logger";
import { RetentionRepository } from "../repositories/retention-repository";

const cleanupAllProjects = Effect.gen(function* () {
  const index = yield* ProjectIndexRepository;
  const retention = yield* RetentionRepository;
  const logger = yield* Effect.serviceOption(HostDiagnosticLogger);
  const projects = (yield* index.read).projects;
  yield* Effect.forEach(
    projects,
    (project) =>
      retention.cleanup(project).pipe(
        Effect.tap((snapshot) => {
          const warning = snapshot.warnings[0];
          if (
            warning === undefined ||
            logger._tag === "None" ||
            logger.value.hostIdentity === undefined
          ) {
            return Effect.void;
          }
          return logger.value
            .emit({
              eventVersion: 1,
              eventKind: "retention.cleanup.completed",
              hostIdentity: logger.value.hostIdentity,
              operation: "RetentionCleanup",
              outcome: "error",
              durationMs: 0,
              hostVersion: HOST_INFORMATION.hostVersion,
              protocolMajor: HOST_INFORMATION.protocol.major,
              protocolMinor: HOST_INFORMATION.protocol.minor,
              projectIdentity: project.identity,
              safeErrorCode:
                warning.code === "protected-over-limit"
                  ? "retention-protected-over-limit"
                  : "retention-missing-retained-content",
              timestamp: new Date().toISOString(),
            })
            .pipe(Effect.ignore);
        }),
        Effect.catchCause(() => Effect.void),
      ),
    { concurrency: "unbounded", discard: true },
  );
});

export interface RetentionSupervisorOptions {
  readonly interval?: Parameters<typeof Schedule.spaced>[0];
}

export const makeRetentionSupervisorLayer = (options: RetentionSupervisorOptions = {}) =>
  Layer.effectDiscard(
    cleanupAllProjects.pipe(
      Effect.repeat({ schedule: Schedule.spaced(options.interval ?? "1 hour") }),
      Effect.forkScoped,
    ),
  );

export const RetentionSupervisorLive = makeRetentionSupervisorLayer();
