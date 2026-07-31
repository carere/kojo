import type {
  ProjectSnapshot,
  RequestKey,
  WorkflowScheduleDefinition,
  WorkflowScheduleListInput,
  WorkflowScheduleOccurrenceListInput,
  WorkflowScheduleOccurrenceSnapshot,
  WorkflowScheduleSnapshot,
} from "@kojo/control";
import type { WorkflowScheduleSnapshot as WorkflowScheduleDefinitionSnapshot } from "@kojo/control/project-definition-validation";
import { Context, type Effect } from "effect";

export interface ScheduleReceiptConflict {
  readonly _tag: "request-key-conflict";
}

export interface ScheduleMissing {
  readonly _tag: "schedule-not-found";
}

export interface ScheduleRevisionConflict {
  readonly _tag: "schedule-revision-conflict";
  readonly schedule: WorkflowScheduleSnapshot;
}

export interface ScheduleAccepted {
  readonly _tag: "accepted";
  readonly alreadyApplied: boolean;
  readonly schedule: WorkflowScheduleSnapshot;
}

export type WorkflowScheduleMutation =
  | ScheduleAccepted
  | ScheduleMissing
  | ScheduleReceiptConflict
  | ScheduleRevisionConflict;

export interface WorkflowScheduleRepositoryShape {
  readonly reconcile: (
    project: ProjectSnapshot,
    definitions: ReadonlyArray<WorkflowScheduleDefinitionSnapshot>,
    appliedAtMs: number,
    nextOccurrence: (definition: WorkflowScheduleDefinition, strictlyAfterMs: number) => number,
  ) => Effect.Effect<ReadonlyArray<WorkflowScheduleSnapshot>>;
  readonly list: (
    project: ProjectSnapshot,
    input: WorkflowScheduleListInput,
  ) => Effect.Effect<ReadonlyArray<WorkflowScheduleSnapshot>>;
  readonly show: (
    project: ProjectSnapshot,
    scheduleKey: string,
  ) => Effect.Effect<WorkflowScheduleSnapshot | undefined>;
  readonly enable: (input: {
    readonly project: ProjectSnapshot;
    readonly scheduleKey: string;
    readonly scheduleRevision: string;
    readonly requestKey: RequestKey;
    readonly requestHash: Uint8Array;
    readonly acceptedAtMs: number;
    readonly nextOccurrence: (
      definition: WorkflowScheduleDefinition,
      strictlyAfterMs: number,
    ) => number;
  }) => Effect.Effect<WorkflowScheduleMutation>;
  readonly disable: (input: {
    readonly project: ProjectSnapshot;
    readonly scheduleKey: string;
    readonly requestKey: RequestKey;
    readonly requestHash: Uint8Array;
    readonly acceptedAtMs: number;
  }) => Effect.Effect<WorkflowScheduleMutation>;
  /** Persists the exact validated input for the one future occurrence. */
  readonly planOccurrence: (input: {
    readonly project: ProjectSnapshot;
    readonly scheduleKey: string;
    readonly scheduledAtMs: number;
    readonly appliedRevision: string;
    readonly input: unknown;
    readonly inputSensitivityPaths: ReadonlyArray<string>;
    readonly plannedAtMs: number;
  }) => Effect.Effect<WorkflowScheduleOccurrenceSnapshot | undefined>;
  /** Collapses downtime to the newest due instant and records the older range. */
  readonly reconcileDueOccurrence: (input: {
    readonly project: ProjectSnapshot;
    readonly scheduleKey: string;
    readonly observedAtMs: number;
    readonly nextOccurrence: (
      definition: WorkflowScheduleDefinition,
      strictlyAfterMs: number,
    ) => number;
  }) => Effect.Effect<WorkflowScheduleSnapshot | undefined>;
  /** Finalizes a planned occurrence when the Schedule's skip policy is active. */
  readonly skipOccurrenceIfOverlapping: (input: {
    readonly project: ProjectSnapshot;
    readonly scheduleKey: string;
    readonly scheduledAtMs: number;
    readonly appliedRevision: string;
    readonly nextOccurrenceMs: number;
    readonly processedAtMs: number;
  }) => Effect.Effect<WorkflowScheduleSnapshot | undefined>;
  /** Finalizes one occurrence and blocks future delivery until its definition changes. */
  readonly failOccurrence: (input: {
    readonly project: ProjectSnapshot;
    readonly scheduleKey: string;
    readonly scheduledAtMs: number;
    readonly appliedRevision: string;
    readonly processedAtMs: number;
    readonly reasonCode: string;
  }) => Effect.Effect<WorkflowScheduleSnapshot | undefined>;
  readonly advanceAfterStart: (input: {
    readonly project: ProjectSnapshot;
    readonly scheduleKey: string;
    readonly scheduledAtMs: number;
    readonly appliedRevision: string;
    readonly nextOccurrenceMs: number;
    readonly advancedAtMs: number;
  }) => Effect.Effect<WorkflowScheduleSnapshot | undefined>;
  readonly listOccurrences: (
    project: ProjectSnapshot,
    input: WorkflowScheduleOccurrenceListInput,
  ) => Effect.Effect<ReadonlyArray<WorkflowScheduleOccurrenceSnapshot>>;
  readonly showOccurrence: (
    project: ProjectSnapshot,
    scheduleKey: string,
    scheduledAtMs: number,
  ) => Effect.Effect<WorkflowScheduleOccurrenceSnapshot | undefined>;
}

export class WorkflowScheduleRepository extends Context.Service<
  WorkflowScheduleRepository,
  WorkflowScheduleRepositoryShape
>()("kojo/host/WorkflowScheduleRepository") {}
