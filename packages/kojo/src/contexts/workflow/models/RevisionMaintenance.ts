import type { RevisionManifest } from "./RevisionManifest.ts";

export type RevisionProtectionReason =
  | "current-workflow"
  | "retained-run"
  | "validation"
  | "active-reader"
  | "loaded-registration";

export interface RevisionProtection {
  readonly reason: RevisionProtectionReason;
  readonly ownerId: string;
  readonly detail: string;
}

export interface RevisionReader {
  readonly readerId: string;
  readonly kind: "active" | "loaded";
  readonly acquiredAt: string;
  readonly runnerInstanceId?: string;
}

export interface RevisionFault {
  readonly code:
    | "CONTENT_MISSING"
    | "CONTENT_CORRUPT"
    | "HOST_INCOMPATIBLE"
    | "BUN_INCOMPATIBLE"
    | "COLLECTION_INTERRUPTED";
  readonly objectHash?: string;
  readonly path?: string;
  readonly detail: string;
  readonly remedy: string;
}

export interface RevisionDetails {
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly manifest: RevisionManifest;
  readonly packages: ReadonlyArray<{
    readonly packageId: string;
    readonly name: string;
    readonly version: string;
    readonly fileCount: number;
  }>;
  readonly dependentRuns: ReadonlyArray<{
    readonly runId: string;
    readonly state: string;
  }>;
  readonly activeReaders: ReadonlyArray<RevisionReader>;
  readonly protections: ReadonlyArray<RevisionProtection>;
  readonly faults: ReadonlyArray<RevisionFault>;
  readonly collection:
    | { readonly state: "protected" }
    | { readonly state: "grace"; readonly eligibleAt: string }
    | { readonly state: "collecting" }
    | { readonly state: "collected"; readonly collectedAt: string };
}

export interface RevisionReaderRequest {
  readonly readerId: string;
  readonly revisionId: string;
  readonly kind: "active" | "loaded";
  readonly acquiredAt: string;
  readonly runnerInstanceId?: string;
}

export type ReaderReleaseEvidence =
  | { readonly kind: "disposed"; readonly confirmedAt: string }
  | {
      readonly kind: "process-exit";
      readonly runnerInstanceId: string;
      readonly confirmedAt: string;
    };

export interface CollectionResult {
  readonly revisionId: string;
  readonly state: "protected" | "grace" | "collected";
  readonly eligibleAt?: string;
  readonly removedObjects?: number;
}
