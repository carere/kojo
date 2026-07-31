import type { ProjectRetentionSnapshot, ProjectSnapshot } from "@kojo/control";
import { Effect, Exit } from "effect";
import { HOST_INFORMATION } from "../../control/models/host-information";
import type {
  HostDiagnosticLoggerShape,
  HostRequestDiagnosticEvent,
} from "../../control/services/host-diagnostic-logger";

const warningCode = (
  snapshot: ProjectRetentionSnapshot,
): HostRequestDiagnosticEvent["safeErrorCode"] => {
  const warning = snapshot.warnings[0];
  if (warning === undefined) return undefined;
  if (warning.code === "protected-over-limit") return "retention-protected-over-limit";
  if (warning.code === "missing-retained-content") return "retention-missing-retained-content";
  return undefined;
};

export const withRetentionCompletionDiagnostic = <E, R>(
  project: ProjectSnapshot,
  cleanup: Effect.Effect<ProjectRetentionSnapshot, E, R>,
  logger: HostDiagnosticLoggerShape | undefined,
): Effect.Effect<ProjectRetentionSnapshot, E, R> =>
  Effect.gen(function* () {
    const startedAtMs = Date.now();
    const exit = yield* Effect.exit(cleanup);
    if (logger?.hostIdentity !== undefined) {
      const event = Exit.isSuccess(exit)
        ? {
            eventVersion: 1 as const,
            eventKind: "retention.cleanup.completed" as const,
            hostIdentity: logger.hostIdentity,
            operation: "RetentionCleanup" as const,
            outcome: snapshotHasWarnings(exit.value) ? ("error" as const) : ("success" as const),
            durationMs: Math.max(0, Date.now() - startedAtMs),
            hostVersion: HOST_INFORMATION.hostVersion,
            protocolMajor: HOST_INFORMATION.protocol.major,
            protocolMinor: HOST_INFORMATION.protocol.minor,
            projectIdentity: project.identity,
            ...(warningCode(exit.value) === undefined
              ? {}
              : { safeErrorCode: warningCode(exit.value) }),
            timestamp: new Date().toISOString(),
          }
        : {
            eventVersion: 1 as const,
            eventKind: "retention.cleanup.completed" as const,
            hostIdentity: logger.hostIdentity,
            operation: "RetentionCleanup" as const,
            outcome: "error" as const,
            durationMs: Math.max(0, Date.now() - startedAtMs),
            hostVersion: HOST_INFORMATION.hostVersion,
            protocolMajor: HOST_INFORMATION.protocol.major,
            protocolMinor: HOST_INFORMATION.protocol.minor,
            projectIdentity: project.identity,
            safeErrorCode: "retention-cleanup-failed" as const,
            timestamp: new Date().toISOString(),
          };
      yield* logger.emit(event).pipe(Effect.ignore);
    }
    return yield* exit;
  });

const snapshotHasWarnings = (snapshot: ProjectRetentionSnapshot) => snapshot.warnings.length > 0;
