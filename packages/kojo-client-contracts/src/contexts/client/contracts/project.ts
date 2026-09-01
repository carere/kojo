import type { MutationEnvelope } from "./mutation.ts";
import type { OperationReceipt } from "./operation.ts";

export type ProjectState = "available" | "unavailable" | "archived";
export type FactoryState = "missing" | "invalid" | "available";

export interface ProjectDocument {
  readonly projectId: string;
  readonly label: string;
  readonly location: string;
  readonly projectState: ProjectState;
  readonly factoryState: FactoryState;
  readonly registeredAt: string;
  readonly refreshedAt: string;
  readonly fault?: string;
  readonly remedy?: string;
}

export interface ProjectCounts {
  readonly total: number;
  readonly available: number;
  readonly unavailable: number;
  readonly archived: number;
  readonly missingFactories: number;
  readonly invalidFactories: number;
}

/** One complete, authoritative Project catalogue observation. */
export interface ProjectSnapshot {
  readonly observationVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly snapshotVersion: number;
  readonly observedAt: string;
  /** The bounded delay before a client reads another authoritative snapshot. */
  readonly refreshAfterMillis: number;
  readonly counts: ProjectCounts;
  readonly projects: ReadonlyArray<ProjectDocument>;
}

export interface ClientRequestDocument {
  readonly request: MutationEnvelope;
  readonly receipt?: OperationReceipt;
}
