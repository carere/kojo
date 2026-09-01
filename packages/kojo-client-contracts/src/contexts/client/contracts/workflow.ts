import type { FactoryRefreshState, FactoryState, ProjectState } from "./project.ts";

export type WorkflowActivity = "active" | "inactive";
export type WorkflowAvailability = "available" | "invalid" | "removed";

export interface TriggerObservation {
  readonly state: "not-declared" | "not-observed" | "polling" | "delayed" | "failed";
  readonly observedAt?: string;
  readonly detail?: string;
}

/** One Project Workflow observation. Availability and activity are separate on purpose. */
export interface WorkflowDocument {
  readonly projectId: string;
  readonly projectLabel: string;
  readonly projectState: ProjectState;
  readonly factoryState: FactoryState;
  readonly refreshState: FactoryRefreshState;
  readonly workflowName: string;
  readonly activity: WorkflowActivity;
  readonly availability: WorkflowAvailability;
  readonly source: string;
  readonly sourceFault?: string;
  readonly remedy?: string;
  readonly currentRevisionId?: string;
  readonly candidateRevisionId?: string;
  readonly trigger: TriggerObservation;
  readonly refreshedAt: string;
}

export interface WorkflowCounts {
  readonly total: number;
  readonly available: number;
  readonly invalid: number;
  readonly removed: number;
  readonly active: number;
}

/** One complete, authoritative Workflow catalogue observation. */
export interface WorkflowSnapshot {
  readonly observationVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly snapshotVersion: number;
  readonly observedAt: string;
  readonly refreshAfterMillis: number;
  readonly counts: WorkflowCounts;
  readonly workflows: ReadonlyArray<WorkflowDocument>;
}
