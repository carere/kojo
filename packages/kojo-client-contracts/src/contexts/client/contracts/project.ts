import type { ReceiptStatus } from "./operation.ts";

export type ProjectState = "available" | "unavailable" | "archived";
export type FactoryState = "missing" | "invalid" | "available";
export type FactoryRefreshState = "pending" | "refreshing" | "failed" | "current";
export type ProjectLocationAction = "relocate" | "archive" | "restore";

export interface ProjectLocationChange {
  readonly state: "steady" | "draining";
  readonly action?: ProjectLocationAction;
  readonly requestedLocation?: string;
  readonly startedAt?: string;
}

export interface ProjectLocationRecord {
  readonly location: string;
  readonly activeFrom: string;
  readonly releasedAt?: string;
  readonly releaseReason?: "relocated" | "archived";
}

export interface ProjectDocument {
  readonly projectId: string;
  readonly label: string;
  readonly location: string;
  /** False for an Archived Project. `location` is then the retained last location. */
  readonly locationActive: boolean;
  readonly locationConfirmed: boolean;
  readonly projectState: ProjectState;
  readonly factoryState: FactoryState;
  readonly refreshState: FactoryRefreshState;
  readonly registeredAt: string;
  readonly refreshedAt: string;
  readonly locationChange: ProjectLocationChange;
  readonly locationHistory: ReadonlyArray<ProjectLocationRecord>;
  readonly fault?: string;
  readonly remedy?: string;
}

export interface ProjectLocationResult {
  readonly action: ProjectLocationAction;
  readonly project: ProjectDocument;
  readonly priorLocation: string;
  readonly consequences: ReadonlyArray<string>;
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
  readonly subject: {
    readonly requestId: string;
    readonly operation: string;
    readonly targetKind: string;
  };
  readonly status: "accepted" | ReceiptStatus;
}

/** Daemon-owned recent accepted client requests. */
export interface ClientRequestSnapshot {
  readonly observationVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly observedAt: string;
  readonly requests: ReadonlyArray<ClientRequestDocument>;
}
