import { Context, Effect, Layer, Schedule } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { deliverWorkflowScheduleOccurrences } from "../use-cases/deliver-workflow-schedule-occurrences";

/**
 * Keeps enabled Workflow Schedules progressing independently of a connected
 * control client. Durable occurrence state makes every scan and restart safe.
 */
export class WorkflowScheduleSupervisor extends Context.Service<
  WorkflowScheduleSupervisor,
  Record<never, never>
>()("kojo/host/WorkflowScheduleSupervisor") {}

export const WorkflowScheduleSupervisorLive = Layer.effect(
  WorkflowScheduleSupervisor,
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    yield* Effect.gen(function* () {
      const { projects } = yield* index.read;
      yield* Effect.forEach(
        projects,
        (project) => deliverWorkflowScheduleOccurrences(project.identity),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.repeat({ schedule: Schedule.spaced("1 second") }), Effect.forkScoped);
    return {};
  }),
);
