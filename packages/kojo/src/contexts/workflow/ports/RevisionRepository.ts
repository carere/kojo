import { Context, type Effect } from "effect";
import type {
  CollectionResult,
  ReaderReleaseEvidence,
  RevisionDetails,
  RevisionReader,
  RevisionReaderRequest,
} from "../models/RevisionMaintenance.ts";
import type { RevisionMaintenanceError } from "../models/RevisionMaintenanceError.ts";

export class RevisionRepository extends Context.Service<
  RevisionRepository,
  {
    readonly details: (
      revisionId: string,
      observedAt: string,
    ) => Effect.Effect<RevisionDetails, RevisionMaintenanceError>;
    readonly protectValidation: (
      revisionId: string,
      validationId: string,
      protectedAt: string,
    ) => Effect.Effect<void, RevisionMaintenanceError>;
    readonly releaseValidation: (
      revisionId: string,
      validationId: string,
      releasedAt: string,
    ) => Effect.Effect<void, RevisionMaintenanceError>;
    readonly acquireReader: (
      request: RevisionReaderRequest,
    ) => Effect.Effect<RevisionReader, RevisionMaintenanceError>;
    readonly releaseReader: (
      readerId: string,
      evidence: ReaderReleaseEvidence,
    ) => Effect.Effect<void, RevisionMaintenanceError>;
    readonly confirmProcessExit: (
      runnerInstanceId: string,
      confirmedAt: string,
    ) => Effect.Effect<void, RevisionMaintenanceError>;
    readonly repairExact: (
      revisionId: string,
      source: string,
      repairedAt: string,
    ) => Effect.Effect<RevisionDetails, RevisionMaintenanceError>;
    readonly collect: (
      revisionId: string,
      observedAt: string,
    ) => Effect.Effect<CollectionResult, RevisionMaintenanceError>;
  }
>()("kojo/workflow/RevisionRepository") {}
