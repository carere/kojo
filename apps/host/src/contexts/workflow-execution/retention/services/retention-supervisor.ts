import { Effect, Layer, Schedule } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { HostDiagnosticLogger } from "../../control/services/host-diagnostic-logger";
import { ProjectRuntime } from "../../projects/services/project-runtime";
import { RetentionRepository } from "../repositories/retention-repository";
import { withRetentionCompletionDiagnostic } from "./retention-completion";

const cleanupAllProjects = Effect.gen(function* () {
  const index = yield* ProjectIndexRepository;
  const retention = yield* RetentionRepository;
  const runtime = yield* ProjectRuntime;
  const logger = yield* Effect.serviceOption(HostDiagnosticLogger);
  const projects = (yield* index.read).projects;
  yield* Effect.forEach(
    projects,
    (project) =>
      runtime
        .coordinateRetention(
          project,
          withRetentionCompletionDiagnostic(
            project,
            retention.cleanup(project),
            logger._tag === "Some" ? logger.value : undefined,
          ),
        )
        .pipe(Effect.catchCause(() => Effect.void)),
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
