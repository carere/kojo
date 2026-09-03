import { Effect, Layer } from "effect";
import type {
  CollectionResult,
  ReaderReleaseEvidence,
  RevisionDetails,
  RevisionProtection,
  RevisionReader,
  RevisionReaderRequest,
} from "../models/RevisionMaintenance.ts";
import { RevisionMaintenanceError } from "../models/RevisionMaintenanceError.ts";
import type { RevisionManifest } from "../models/RevisionManifest.ts";
import { RevisionRepository } from "../ports/RevisionRepository.ts";

export interface InMemoryRevisionSeed {
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly manifest: RevisionManifest;
  readonly protections?: ReadonlyArray<RevisionProtection>;
}

interface MemoryRevision {
  readonly seed: InMemoryRevisionSeed;
  readonly protections: Map<string, RevisionProtection>;
  readonly readers: Map<string, RevisionReader>;
  eligibleAt?: string;
  collectedAt?: string;
}

const keyOf = (reason: RevisionProtection["reason"], ownerId: string): string =>
  JSON.stringify([reason, ownerId]);

const missing = (revisionId: string): RevisionMaintenanceError =>
  new RevisionMaintenanceError({
    code: "REVISION_NOT_FOUND",
    message: `Workflow Revision ${revisionId} was not found`,
  });

/** In-memory adapter for reader and collection transition use-case tests. */
export const layer = (
  seeds: ReadonlyArray<InMemoryRevisionSeed>,
): Layer.Layer<RevisionRepository> =>
  Layer.effect(
    RevisionRepository,
    Effect.sync(() => {
      const revisions = new Map<string, MemoryRevision>(
        seeds.map((seed) => [
          seed.revisionId,
          {
            seed,
            protections: new Map(
              (seed.protections ?? []).map((protection) => [
                keyOf(protection.reason, protection.ownerId),
                protection,
              ]),
            ),
            readers: new Map(),
          },
        ]),
      );
      const selected = (revisionId: string): MemoryRevision => {
        const revision = revisions.get(revisionId);
        if (revision === undefined) throw missing(revisionId);
        return revision;
      };
      const protectReader = (revision: MemoryRevision, reader: RevisionReader): void => {
        revision.protections.set(
          keyOf(
            reader.kind === "loaded" ? "loaded-registration" : "active-reader",
            reader.readerId,
          ),
          {
            reason: reader.kind === "loaded" ? "loaded-registration" : "active-reader",
            ownerId: reader.readerId,
            detail: `reader ${reader.readerId} protects the exact revision`,
          },
        );
        delete revision.eligibleAt;
      };
      const details = (revision: MemoryRevision, observedAt: string): RevisionDetails => {
        if (
          revision.protections.size === 0 &&
          revision.eligibleAt === undefined &&
          revision.collectedAt === undefined
        ) {
          revision.eligibleAt = new Date(
            Date.parse(observedAt) + 24 * 60 * 60 * 1_000,
          ).toISOString();
        }
        return {
          revisionId: revision.seed.revisionId,
          packageGraphId: revision.seed.packageGraphId,
          manifest: revision.seed.manifest,
          packages: revision.seed.manifest.packages.map((entry) => ({
            packageId: entry.packageId,
            name: entry.name,
            version: entry.version,
            fileCount: entry.files.length,
          })),
          dependentRuns: [],
          activeReaders: [...revision.readers.values()],
          protections: [...revision.protections.values()],
          faults: [],
          collection:
            revision.collectedAt !== undefined
              ? { state: "collected", collectedAt: revision.collectedAt }
              : revision.protections.size > 0
                ? { state: "protected" }
                : { state: "grace", eligibleAt: revision.eligibleAt ?? observedAt },
        };
      };
      return {
        details: (revisionId, observedAt) =>
          Effect.try({
            try: () => details(selected(revisionId), observedAt),
            catch: (cause) => cause as RevisionMaintenanceError,
          }),
        protectValidation: (revisionId, validationId, _protectedAt) =>
          Effect.sync(() => {
            const revision = selected(revisionId);
            revision.protections.set(keyOf("validation", validationId), {
              reason: "validation",
              ownerId: validationId,
              detail: `validation ${validationId} protects the exact revision`,
            });
            delete revision.eligibleAt;
          }),
        releaseValidation: (revisionId, validationId, releasedAt) =>
          Effect.sync(() => {
            const revision = selected(revisionId);
            revision.protections.delete(keyOf("validation", validationId));
            if (revision.protections.size === 0) {
              revision.eligibleAt = new Date(
                Date.parse(releasedAt) + 24 * 60 * 60 * 1_000,
              ).toISOString();
            }
          }),
        acquireReader: (request: RevisionReaderRequest) =>
          Effect.try({
            try: () => {
              const revision = selected(request.revisionId);
              if (revision.collectedAt !== undefined) {
                throw new RevisionMaintenanceError({
                  code: "READER_CONFLICT",
                  message: "collection already excludes new readers",
                });
              }
              const current = revision.readers.get(request.readerId);
              if (current !== undefined) return current;
              const reader: RevisionReader = {
                readerId: request.readerId,
                kind: request.kind,
                acquiredAt: request.acquiredAt,
                ...(request.runnerInstanceId === undefined
                  ? {}
                  : { runnerInstanceId: request.runnerInstanceId }),
              };
              revision.readers.set(reader.readerId, reader);
              protectReader(revision, reader);
              return reader;
            },
            catch: (cause) => cause as RevisionMaintenanceError,
          }),
        releaseReader: (readerId: string, evidence: ReaderReleaseEvidence) =>
          Effect.try({
            try: () => {
              for (const revision of revisions.values()) {
                const reader = revision.readers.get(readerId);
                if (reader === undefined) continue;
                if (
                  evidence.kind === "process-exit" &&
                  reader.runnerInstanceId !== evidence.runnerInstanceId
                ) {
                  throw new RevisionMaintenanceError({
                    code: "READER_RELEASE_REFUSED",
                    message: "the process exit does not own this reader",
                  });
                }
                revision.readers.delete(readerId);
                revision.protections.delete(
                  keyOf(
                    reader.kind === "loaded" ? "loaded-registration" : "active-reader",
                    readerId,
                  ),
                );
                if (revision.protections.size === 0) {
                  revision.eligibleAt = new Date(
                    Date.parse(evidence.confirmedAt) + 24 * 60 * 60 * 1_000,
                  ).toISOString();
                }
                return;
              }
              throw new RevisionMaintenanceError({
                code: "READER_RELEASE_REFUSED",
                message: "the reader registration was not found",
              });
            },
            catch: (cause) => cause as RevisionMaintenanceError,
          }),
        confirmProcessExit: (runnerInstanceId, confirmedAt) =>
          Effect.sync(() => {
            for (const revision of revisions.values()) {
              for (const reader of [...revision.readers.values()]) {
                if (reader.runnerInstanceId !== runnerInstanceId) continue;
                revision.readers.delete(reader.readerId);
                revision.protections.delete(keyOf("loaded-registration", reader.readerId));
              }
              if (revision.protections.size === 0 && revision.eligibleAt === undefined) {
                revision.eligibleAt = new Date(
                  Date.parse(confirmedAt) + 24 * 60 * 60 * 1_000,
                ).toISOString();
              }
            }
          }),
        repairExact: (revisionId, _source, repairedAt) =>
          Effect.sync(() => details(selected(revisionId), repairedAt)),
        collect: (revisionId, observedAt) =>
          Effect.sync((): CollectionResult => {
            const revision = selected(revisionId);
            if (revision.protections.size > 0) return { revisionId, state: "protected" };
            const snapshot = details(revision, observedAt);
            if (snapshot.collection.state === "collected")
              return { revisionId, state: "collected" };
            if (
              snapshot.collection.state === "grace" &&
              Date.parse(observedAt) < Date.parse(snapshot.collection.eligibleAt)
            ) {
              return { revisionId, state: "grace", eligibleAt: snapshot.collection.eligibleAt };
            }
            revision.collectedAt = observedAt;
            return { revisionId, state: "collected", removedObjects: 0 };
          }),
      };
    }),
  );
