import type {
  ProjectSnapshot,
  RequestKey,
  WorkflowScheduleDefinition,
  WorkflowScheduleListInput,
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
}

export class WorkflowScheduleRepository extends Context.Service<
  WorkflowScheduleRepository,
  WorkflowScheduleRepositoryShape
>()("kojo/host/WorkflowScheduleRepository") {}
