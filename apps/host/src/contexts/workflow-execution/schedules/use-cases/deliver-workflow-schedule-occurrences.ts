import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ProjectIdentity,
  ProjectSnapshot,
  WorkflowScheduleOccurrenceListInput,
  WorkflowScheduleOccurrenceListResult,
  WorkflowScheduleOccurrenceOperationError,
  WorkflowScheduleOccurrenceQueryResult,
  WorkflowScheduleOccurrenceSnapshot,
} from "@kojo/control";
import { RequestKey } from "@kojo/control";
import type { ProjectDefinitionSnapshot } from "@kojo/control/project-definition-validation";
import type { AnyWorkflowDefinition } from "@kojo/workflow";
import { Effect, Schema } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { loadExecutableWorkflowDefinitions } from "../../../workflow-authoring/projects/services/project-executable-definition-loader";
import { ProjectLayout } from "../../../workflow-authoring/projects/services/project-layout";
import { ProjectRuntime } from "../../projects/services/project-runtime";
import { WorkflowBackend } from "../../projects/services/workflow-backend";
import { maskPayload } from "../../runs/models/sensitivity-map";
import { WorkflowRunRepository } from "../../runs/repositories/workflow-run-repository";
import { asLocalDefinition, reconcileWorkflowRun } from "../../runs/use-cases/manage-workflow-runs";
import { WorkflowScheduleRepository } from "../repositories/workflow-schedule-repository";
import { ScheduleClock } from "../services/schedule-clock";
import { nextWorkflowScheduleOccurrence } from "../services/schedule-timing";

const hash = (value: string) => createHash("sha256").update(value).digest();

const executableDefinitions = new Map<
  string,
  { readonly definitions: ReadonlyArray<AnyWorkflowDefinition>; readonly snapshotId: string }
>();

const loadAcceptedExecutableDefinitions = async (
  configurationPath: string,
  accepted: ProjectDefinitionSnapshot,
) => {
  const cached = executableDefinitions.get(configurationPath);
  if (cached?.snapshotId === accepted.snapshotId) return cached.definitions;
  const definitions = await loadExecutableWorkflowDefinitions(configurationPath, accepted);
  executableDefinitions.set(configurationPath, { definitions, snapshotId: accepted.snapshotId });
  return definitions;
};

const stableJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Workflow input is not JSON encodable");
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

const occurrenceRequestKey = (scheduleKey: string, scheduledAtMs: number): RequestKey =>
  Schema.decodeUnknownSync(RequestKey)(
    `schedule:${createHash("sha256").update(`${scheduleKey}\u0000${scheduledAtMs}`).digest("hex")}`,
  );

const operationError = (
  code: WorkflowScheduleOccurrenceOperationError["code"],
  message: string,
  next: string,
  affectedResource: WorkflowScheduleOccurrenceOperationError["affectedResource"],
  findingKeys: WorkflowScheduleOccurrenceOperationError["findingKeys"] = [],
): WorkflowScheduleOccurrenceOperationError => ({
  code,
  message,
  next,
  affectedResource,
  findingKeys,
});

const maskedOccurrence = (occurrence: WorkflowScheduleOccurrenceSnapshot) => ({
  ...occurrence,
  input: maskPayload(occurrence.input, {
    valid: true,
    map: { paths: occurrence.inputSensitivityPaths },
  }),
});

const resolveInput = (
  definition: AnyWorkflowDefinition,
  scheduleKey: string,
  scheduledAtMs: number,
): unknown => {
  const schedule = definition.schedules?.find((candidate) => candidate.scheduleKey === scheduleKey);
  if (schedule === undefined) throw new Error("Workflow Schedule is not executable");
  const inputSchema = definition.inputSchema as typeof Schema.Unknown;
  const resolved = schedule.input.resolve({ scheduleKey, scheduledAt: new Date(scheduledAtMs) });
  return Schema.encodeSync(inputSchema)(Schema.decodeUnknownSync(inputSchema)(resolved));
};

const executableSchedule = (definition: AnyWorkflowDefinition, scheduleKey: string) =>
  definition.schedules?.find((candidate) => candidate.scheduleKey === scheduleKey);

/**
 * Reconciles one Project's durable occurrence record, private durable wake-up,
 * and scheduled Run acceptance while no client is involved.
 */
export const deliverWorkflowScheduleOccurrences = (
  identity: ProjectIdentity,
): Effect.Effect<
  void,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
  | WorkflowRunRepository
  | WorkflowBackend
> =>
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const clock = yield* ScheduleClock;
    const schedules = yield* WorkflowScheduleRepository;
    const runs = yield* WorkflowRunRepository;
    const backend = yield* WorkflowBackend;
    const indexed = (yield* index.read).projects.find((project) => project.identity === identity);
    if (indexed === undefined) return;
    const validation = yield* layout.validate(indexed.path);
    if (!validation.ok || !validation.definitions.ok) return;
    const definitions = yield* runtime.acceptDefinitions(
      validation.project,
      validation.definitions,
    );
    if (
      definitions === undefined ||
      (yield* runtime.readiness(indexed, validation.project, validation.definitions)) !== "ready"
    ) {
      return;
    }
    const executable = yield* Effect.promise(() =>
      loadAcceptedExecutableDefinitions(
        join(validation.project.path, "kojo.config.ts"),
        definitions,
      ),
    ).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (executable === undefined) return;

    yield* runtime.coordinateLifecycle(
      validation.project,
      Effect.gen(function* () {
        const now = clock.now();
        yield* backend.register(validation.project, executable.map(asLocalDefinition));
        const pendingSubmissions = yield* runs.pendingSubmissions(validation.project);
        for (const pending of pendingSubmissions) {
          const definition = executable.find(
            (candidate) =>
              candidate.workflowKey === pending.workflowKey &&
              candidate.revision === pending.workflowRevision,
          );
          if (definition !== undefined) {
            yield* reconcileWorkflowRun(
              backend,
              runs,
              validation.project,
              definition,
              pending.runId,
            );
          }
        }
        yield* schedules.reconcile(
          validation.project,
          definitions.workflows.flatMap((workflow) => workflow.schedules),
          now,
          nextWorkflowScheduleOccurrence,
        );
        const currentSchedules = yield* schedules.list(validation.project, {
          identity: validation.project.identity,
          workflowKeys: [],
          conditions: [],
        });
        for (const schedule of currentSchedules) {
          const scheduleDefinition = schedule.definition;
          if (
            !schedule.enabledIntent ||
            schedule.condition !== "available" ||
            scheduleDefinition === null ||
            schedule.nextOccurrenceMs === null
          ) {
            continue;
          }
          const definition = executable.find(
            (candidate) =>
              candidate.workflowKey === scheduleDefinition.workflowKey &&
              candidate.revision ===
                definitions.workflows.find(
                  (workflow) => workflow.workflowKey === scheduleDefinition.workflowKey,
                )?.revision,
          );
          if (
            definition === undefined ||
            executableSchedule(definition, schedule.scheduleKey) === undefined
          ) {
            continue;
          }
          let input: unknown;
          try {
            input = resolveInput(definition, schedule.scheduleKey, schedule.nextOccurrenceMs);
          } catch {
            continue;
          }
          const planned = yield* schedules.planOccurrence({
            project: validation.project,
            scheduleKey: schedule.scheduleKey,
            scheduledAtMs: schedule.nextOccurrenceMs,
            appliedRevision: scheduleDefinition.revision,
            input,
            inputSensitivityPaths: definition.sensitivity?.input ?? [],
            plannedAtMs: now,
          });
          if (planned?.outcome === "planned") {
            yield* backend.armScheduleWakeup?.(validation.project, {
              scheduleKey: planned.scheduleKey,
              scheduledAtMs: planned.scheduledAtMs,
              scheduleRevision: planned.appliedRevision,
            }) ?? Effect.void;
          } else if (planned?.outcome === "started") {
            const nextOccurrenceMs = nextWorkflowScheduleOccurrence(
              scheduleDefinition,
              planned.scheduledAtMs,
            );
            const advanced = yield* schedules.advanceAfterStart({
              project: validation.project,
              scheduleKey: planned.scheduleKey,
              scheduledAtMs: planned.scheduledAtMs,
              appliedRevision: planned.appliedRevision,
              nextOccurrenceMs,
              advancedAtMs: clock.now(),
            });
            if (
              advanced !== undefined &&
              advanced.definition !== null &&
              advanced.nextOccurrenceMs !== null
            ) {
              const nextInput = resolveInput(
                definition,
                planned.scheduleKey,
                advanced.nextOccurrenceMs,
              );
              const next = yield* schedules.planOccurrence({
                project: validation.project,
                scheduleKey: planned.scheduleKey,
                scheduledAtMs: advanced.nextOccurrenceMs,
                appliedRevision: planned.appliedRevision,
                input: nextInput,
                inputSensitivityPaths: definition.sensitivity?.input ?? [],
                plannedAtMs: clock.now(),
              });
              if (next?.outcome === "planned") {
                yield* backend.armScheduleWakeup?.(validation.project, {
                  scheduleKey: next.scheduleKey,
                  scheduledAtMs: next.scheduledAtMs,
                  scheduleRevision: next.appliedRevision,
                }) ?? Effect.void;
              }
            }
          }
        }

        const signalled = new Set(
          (yield* backend.takeDueScheduleWakeups?.(validation.project) ?? Effect.succeed([])).map(
            (wakeup) => `${wakeup.scheduleKey}:${wakeup.scheduledAtMs}`,
          ),
        );
        const occurrences = yield* schedules.listOccurrences(validation.project, {
          identity: validation.project.identity,
          scheduleKeys: [],
          outcomes: ["planned"],
          limit: 200,
        });
        for (const occurrence of occurrences) {
          if (
            occurrence.scheduledAtMs > now &&
            !signalled.has(`${occurrence.scheduleKey}:${occurrence.scheduledAtMs}`)
          ) {
            continue;
          }
          const schedule = currentSchedules.find(
            (candidate) => candidate.scheduleKey === occurrence.scheduleKey,
          );
          const scheduleDefinition = schedule?.definition;
          if (
            schedule === undefined ||
            !schedule.enabledIntent ||
            schedule.condition !== "available" ||
            scheduleDefinition === undefined ||
            scheduleDefinition === null ||
            scheduleDefinition.revision !== occurrence.appliedRevision
          ) {
            continue;
          }
          const workflow = definitions.workflows.find(
            (candidate) => candidate.workflowKey === scheduleDefinition.workflowKey,
          );
          const definition = executable.find(
            (candidate) =>
              candidate.workflowKey === scheduleDefinition.workflowKey &&
              candidate.revision === workflow?.revision,
          );
          if (workflow === undefined || definition === undefined) continue;
          const requestKey = occurrenceRequestKey(occurrence.scheduleKey, occurrence.scheduledAtMs);
          const acceptedAtMs = clock.now();
          const accepted = yield* runs.acceptScheduledStart({
            project: validation.project,
            requestKey,
            requestHash: hash(
              stableJson({
                input: occurrence.input,
                scheduleKey: occurrence.scheduleKey,
                scheduledAtMs: occurrence.scheduledAtMs,
                scheduleRevision: occurrence.appliedRevision,
                workflowKey: workflow.workflowKey,
                workflowRevision: workflow.revision,
              }),
            ),
            runId: randomUUID(),
            workflowKey: workflow.workflowKey,
            workflowRevision: workflow.revision,
            encodedInput: occurrence.input,
            inputSensitivityPaths: occurrence.inputSensitivityPaths,
            acceptedAtMs,
            scheduleKey: occurrence.scheduleKey,
            scheduledAtMs: occurrence.scheduledAtMs,
            scheduleRevision: occurrence.appliedRevision,
            startSnapshot: {
              workflow: {
                workflowKey: workflow.workflowKey,
                workflowRevision: workflow.revision,
                sourceIdentity: workflow.sourceIdentity,
                inputSchemaFingerprint: workflow.inputSchemaFingerprint,
              },
              trigger: {
                kind: "schedule" as const,
                requestKey,
                scheduleKey: occurrence.scheduleKey,
                occurrence: {
                  scheduleKey: occurrence.scheduleKey,
                  scheduledAtMs: occurrence.scheduledAtMs,
                },
                scheduledAtMs: occurrence.scheduledAtMs,
                scheduleRevision: occurrence.appliedRevision,
              },
              environment: {
                projectIdentity: validation.project.identity,
                definitionSnapshotId: definitions.snapshotId,
                runtimeKind: "local-effect-workflow" as const,
              },
              input: occurrence.input,
              inputSensitivityPaths: occurrence.inputSensitivityPaths,
            },
          });
          if (accepted._tag !== "accepted") continue;
          const nextOccurrenceMs = nextWorkflowScheduleOccurrence(
            scheduleDefinition,
            occurrence.scheduledAtMs,
          );
          const advanced = yield* schedules.advanceAfterStart({
            project: validation.project,
            scheduleKey: occurrence.scheduleKey,
            scheduledAtMs: occurrence.scheduledAtMs,
            appliedRevision: occurrence.appliedRevision,
            nextOccurrenceMs,
            advancedAtMs: clock.now(),
          });
          if (
            advanced !== undefined &&
            advanced.definition !== null &&
            advanced.nextOccurrenceMs !== null
          ) {
            const nextInput = resolveInput(
              definition,
              occurrence.scheduleKey,
              advanced.nextOccurrenceMs,
            );
            const next = yield* schedules.planOccurrence({
              project: validation.project,
              scheduleKey: occurrence.scheduleKey,
              scheduledAtMs: advanced.nextOccurrenceMs,
              appliedRevision: occurrence.appliedRevision,
              input: nextInput,
              inputSensitivityPaths: definition.sensitivity?.input ?? [],
              plannedAtMs: clock.now(),
            });
            if (next?.outcome === "planned") {
              yield* backend.armScheduleWakeup?.(validation.project, {
                scheduleKey: next.scheduleKey,
                scheduledAtMs: next.scheduledAtMs,
                scheduleRevision: next.appliedRevision,
              }) ?? Effect.void;
            }
          }
          yield* reconcileWorkflowRun(
            backend,
            runs,
            validation.project,
            definition,
            accepted.run.run.runId,
          );
        }
      }),
    );
  }).pipe(Effect.catchCause(() => Effect.void));

const resolveOccurrenceProject = (
  identity: ProjectIdentity,
): Effect.Effect<
  ProjectSnapshot | WorkflowScheduleOccurrenceOperationError,
  never,
  ProjectIndexRepository | ProjectLayout | ProjectRuntime
> =>
  Effect.gen(function* () {
    const index = yield* ProjectIndexRepository;
    const layout = yield* ProjectLayout;
    const runtime = yield* ProjectRuntime;
    const indexed = (yield* index.read).projects.find((project) => project.identity === identity);
    if (indexed === undefined) {
      return operationError(
        "project-not-found",
        "Kojo Project was not found in the Project Index.",
        "Register the Project or choose a listed Project Identity.",
        { kind: "project", identity },
      );
    }
    const validation = yield* layout.validate(indexed.path);
    if (!validation.ok) {
      return operationError(
        "project-layout-invalid",
        validation.message,
        "Correct the Project layout and retry.",
        { kind: "project", identity },
        [validation.findingKey as never],
      );
    }
    if (!validation.definitions.ok) {
      return operationError(
        "project-runtime-not-ready",
        validation.definitions.message,
        "Correct the Kojo Configuration and retry.",
        { kind: "project", identity },
        validation.definitions.findings.map((finding) => finding.findingKey),
      );
    }
    const accepted = yield* runtime.acceptDefinitions(validation.project, validation.definitions);
    if (
      accepted === undefined ||
      (yield* runtime.readiness(indexed, validation.project, validation.definitions)) !== "ready"
    ) {
      return operationError(
        "project-runtime-not-ready",
        "Kojo Project Runtime is not ready to inspect Workflow Schedule Occurrences.",
        "Repair the Project Runtime and retry.",
        { kind: "project", identity },
      );
    }
    return validation.project;
  });

export const listWorkflowScheduleOccurrences = (
  input: WorkflowScheduleOccurrenceListInput,
): Effect.Effect<
  WorkflowScheduleOccurrenceListResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
  | WorkflowRunRepository
  | WorkflowBackend
> =>
  Effect.gen(function* () {
    yield* deliverWorkflowScheduleOccurrences(input.identity);
    const project = yield* resolveOccurrenceProject(input.identity);
    if ("code" in project) return { ok: false, error: project };
    const repository = yield* WorkflowScheduleRepository;
    const runtime = yield* ProjectRuntime;
    const occurrences = yield* runtime.coordinateLifecycle(
      project,
      repository.listOccurrences(project, input),
    );
    return { ok: true, occurrences: occurrences.map(maskedOccurrence) };
  });

export const showWorkflowScheduleOccurrence = (
  identity: ProjectIdentity,
  scheduleKey: string,
  scheduledAtMs: number,
): Effect.Effect<
  WorkflowScheduleOccurrenceQueryResult,
  never,
  | ProjectIndexRepository
  | ProjectLayout
  | ProjectRuntime
  | ScheduleClock
  | WorkflowScheduleRepository
  | WorkflowRunRepository
  | WorkflowBackend
> =>
  Effect.gen(function* () {
    yield* deliverWorkflowScheduleOccurrences(identity);
    const project = yield* resolveOccurrenceProject(identity);
    if ("code" in project) return { ok: false, error: project };
    const repository = yield* WorkflowScheduleRepository;
    const runtime = yield* ProjectRuntime;
    const occurrence = yield* runtime.coordinateLifecycle(
      project,
      repository.showOccurrence(project, scheduleKey, scheduledAtMs),
    );
    return occurrence === undefined
      ? {
          ok: false,
          error: operationError(
            "occurrence-not-found",
            "Workflow Schedule Occurrence was not found in this Project.",
            "List occurrences for the Schedule and choose a scheduled UTC instant.",
            { kind: "occurrence", identity, scheduleKey, scheduledAtMs },
          ),
        }
      : { ok: true, occurrence: maskedOccurrence(occurrence) };
  });
