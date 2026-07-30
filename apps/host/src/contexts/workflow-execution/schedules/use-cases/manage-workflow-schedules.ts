import { createHash } from "node:crypto";
import type {
  ProjectIdentity,
  ProjectSnapshot,
  RequestKey,
  WorkflowScheduleListInput,
  WorkflowScheduleListResult,
  WorkflowScheduleMutationResult,
  WorkflowScheduleOperationError,
  WorkflowScheduleQueryResult,
  WorkflowScheduleSnapshot,
} from "@kojo/control";
import { Effect } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { ProjectLayout } from "../../../workflow-authoring/projects/services/project-layout";
import { ProjectRuntime } from "../../projects/services/project-runtime";
import { WorkflowScheduleRepository } from "../repositories/workflow-schedule-repository";
import { ScheduleClock } from "../services/schedule-clock";
import { nextWorkflowScheduleOccurrence } from "../services/schedule-timing";

const hash = (value: string) => createHash("sha256").update(value).digest();

const operationError = (
  code: WorkflowScheduleOperationError["code"],
  message: string,
  next: string,
  affectedResource: WorkflowScheduleOperationError["affectedResource"],
  findingKeys: WorkflowScheduleOperationError["findingKeys"] = [],
  currentSchedule?: WorkflowScheduleSnapshot,
): WorkflowScheduleOperationError => ({
  code,
  message,
  next,
  affectedResource,
  findingKeys,
  ...(currentSchedule === undefined ? {} : { currentSchedule }),
});

const missingProject = (identity: ProjectIdentity) =>
  operationError(
    "project-not-found",
    "Kojo Project was not found in the Project Index.",
    "Register the Project or choose a listed Project Identity.",
    { kind: "project", identity },
  );

const missingSchedule = (identity: ProjectIdentity, scheduleKey: string) =>
  operationError(
    "schedule-not-found",
    `Workflow Schedule ${scheduleKey} was not found in the accepted Project snapshot.`,
    "List Workflow Schedules and choose an available Schedule Key.",
    { kind: "schedule", identity, scheduleKey },
  );

const layoutError = (identity: ProjectIdentity, message: string, findingKey: string) =>
  operationError(
    "project-layout-invalid",
    message,
    "Correct the Project layout and retry.",
    { kind: "project", identity },
    [findingKey as never],
  );

interface ReconciledProject {
  readonly project: ProjectSnapshot;
}

const reconcileProjectSchedules = (
  identity: ProjectIdentity,
): Effect.Effect<
  ReconciledProject | WorkflowScheduleOperationError,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
> =>
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const clock = yield* ScheduleClock;
    const repository = yield* WorkflowScheduleRepository;
    const indexed = (yield* index.read).projects.find((project) => project.identity === identity);
    if (indexed === undefined) return missingProject(identity);
    const validation = yield* layout.validate(indexed.path);
    if (!validation.ok) return layoutError(identity, validation.message, validation.findingKey);
    if (!validation.definitions.ok) {
      return operationError(
        "project-runtime-not-ready",
        validation.definitions.message,
        "Correct the Kojo Configuration and retry.",
        { kind: "project", identity },
        validation.definitions.findings.map((finding) => finding.findingKey),
      );
    }
    const definitions = yield* runtime.acceptDefinitions(
      validation.project,
      validation.definitions,
    );
    if (definitions === undefined) {
      return operationError(
        "project-runtime-not-ready",
        "Kojo Configuration has not been accepted.",
        "Correct the Kojo Configuration and retry.",
        { kind: "project", identity },
      );
    }
    if (
      (yield* runtime.readiness(indexed, validation.project, validation.definitions)) !== "ready"
    ) {
      return operationError(
        "project-runtime-not-ready",
        "Kojo Project Runtime is not ready to control Workflow Schedules.",
        "Repair the Project Runtime and retry.",
        { kind: "project", identity },
      );
    }
    const schedules = definitions.workflows.flatMap((workflow) => workflow.schedules);
    yield* runtime.coordinateLifecycle(
      validation.project,
      repository.reconcile(
        validation.project,
        schedules,
        clock.now(),
        nextWorkflowScheduleOccurrence,
      ),
    );
    return { project: validation.project };
  });

export const listWorkflowSchedules = (
  input: WorkflowScheduleListInput,
): Effect.Effect<
  WorkflowScheduleListResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
> =>
  Effect.gen(function* () {
    const resolved = yield* reconcileProjectSchedules(input.identity);
    if ("code" in resolved) return { ok: false, error: resolved };
    const repository = yield* WorkflowScheduleRepository;
    const runtime = yield* ProjectRuntime;
    const schedules = yield* runtime.coordinateLifecycle(
      resolved.project,
      repository.list(resolved.project, input),
    );
    return { ok: true, schedules };
  });

export const listNextWorkflowSchedules = (
  input: WorkflowScheduleListInput,
): Effect.Effect<
  WorkflowScheduleListResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
> =>
  Effect.map(listWorkflowSchedules(input), (result) =>
    result.ok
      ? {
          ok: true as const,
          schedules: result.schedules.filter((schedule) => schedule.nextOccurrenceMs !== null),
        }
      : result,
  );

export const showWorkflowSchedule = (
  identity: ProjectIdentity,
  scheduleKey: string,
): Effect.Effect<
  WorkflowScheduleQueryResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
> =>
  Effect.gen(function* () {
    const resolved = yield* reconcileProjectSchedules(identity);
    if ("code" in resolved) return { ok: false, error: resolved };
    const repository = yield* WorkflowScheduleRepository;
    const runtime = yield* ProjectRuntime;
    const schedule = yield* runtime.coordinateLifecycle(
      resolved.project,
      repository.show(resolved.project, scheduleKey),
    );
    return schedule === undefined
      ? { ok: false, error: missingSchedule(identity, scheduleKey) }
      : { ok: true, schedule };
  });

export const enableWorkflowSchedule = (input: {
  readonly identity: ProjectIdentity;
  readonly requestKey: RequestKey;
  readonly scheduleKey: string;
  readonly scheduleRevision: string;
}): Effect.Effect<
  WorkflowScheduleMutationResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
> =>
  Effect.gen(function* () {
    const resolved = yield* reconcileProjectSchedules(input.identity);
    if ("code" in resolved) return { ok: false, requestKey: input.requestKey, error: resolved };
    const repository = yield* WorkflowScheduleRepository;
    const runtime = yield* ProjectRuntime;
    const clock = yield* ScheduleClock;
    const outcome = yield* runtime.coordinateLifecycle(
      resolved.project,
      repository.enable({
        project: resolved.project,
        scheduleKey: input.scheduleKey,
        scheduleRevision: input.scheduleRevision,
        requestKey: input.requestKey,
        requestHash: hash(
          JSON.stringify({
            operation: "schedule.enable",
            scheduleKey: input.scheduleKey,
            scheduleRevision: input.scheduleRevision,
          }),
        ),
        acceptedAtMs: clock.now(),
        nextOccurrence: nextWorkflowScheduleOccurrence,
      }),
    );
    if (outcome._tag === "accepted") {
      return {
        ok: true,
        schedule: outcome.schedule,
        alreadyApplied: outcome.alreadyApplied,
        acceptedRunsContinue: false,
        requestKey: input.requestKey,
      };
    }
    if (outcome._tag === "schedule-not-found") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: missingSchedule(input.identity, input.scheduleKey),
      };
    }
    if (outcome._tag === "schedule-revision-conflict") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: operationError(
          "schedule-revision-conflict",
          "The Workflow Schedule definition changed before this enable request was accepted.",
          "Refresh the Workflow Schedule and retry with its current revision.",
          { kind: "schedule", identity: input.identity, scheduleKey: input.scheduleKey },
          [],
          outcome.schedule,
        ),
      };
    }
    return {
      ok: false,
      requestKey: input.requestKey,
      error: operationError(
        "request-key-conflict",
        "This Request Key was already used for a different Workflow Schedule operation.",
        "Retry with the original request contents or use a new Request Key.",
        { kind: "request-key", requestKey: input.requestKey },
      ),
    };
  });

export const disableWorkflowSchedule = (input: {
  readonly identity: ProjectIdentity;
  readonly requestKey: RequestKey;
  readonly scheduleKey: string;
}): Effect.Effect<
  WorkflowScheduleMutationResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
> =>
  Effect.gen(function* () {
    const resolved = yield* reconcileProjectSchedules(input.identity);
    if ("code" in resolved) return { ok: false, requestKey: input.requestKey, error: resolved };
    const repository = yield* WorkflowScheduleRepository;
    const runtime = yield* ProjectRuntime;
    const clock = yield* ScheduleClock;
    const outcome = yield* runtime.coordinateLifecycle(
      resolved.project,
      repository.disable({
        project: resolved.project,
        scheduleKey: input.scheduleKey,
        requestKey: input.requestKey,
        requestHash: hash(
          JSON.stringify({ operation: "schedule.disable", scheduleKey: input.scheduleKey }),
        ),
        acceptedAtMs: clock.now(),
      }),
    );
    if (outcome._tag === "accepted") {
      return {
        ok: true,
        schedule: outcome.schedule,
        alreadyApplied: outcome.alreadyApplied,
        acceptedRunsContinue: true,
        requestKey: input.requestKey,
      };
    }
    if (outcome._tag === "schedule-not-found") {
      return {
        ok: false,
        requestKey: input.requestKey,
        error: missingSchedule(input.identity, input.scheduleKey),
      };
    }
    return {
      ok: false,
      requestKey: input.requestKey,
      error: operationError(
        "request-key-conflict",
        "This Request Key was already used for a different Workflow Schedule operation.",
        "Retry with the original request contents or use a new Request Key.",
        { kind: "request-key", requestKey: input.requestKey },
      ),
    };
  });
