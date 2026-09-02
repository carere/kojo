import { Duration, Effect, Result, Schedule } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleForceAuthorization,
  LifecycleOperation,
  LifecycleOutcome,
} from "../models/LifecycleOperation.ts";
import type { DaemonUpgradeControl } from "../ports/DaemonUpgradeControl.ts";
import type {
  BeginLifecycleOperation,
  LifecycleJournalRepository,
} from "../ports/LifecycleJournalRepository.ts";
import type { ManagedReleaseSelection } from "../ports/ManagedReleaseSelection.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { DAEMON_CLEANUP_MILLIS } from "./LifecycleController.ts";

export interface UpgradeActivationStatus {
  readonly operation: LifecycleOperation;
  readonly outcome: Extract<
    LifecycleOutcome,
    "in-progress" | "upgrade-refused" | "activated" | "rolled-back" | "repair-required"
  >;
  readonly nextPermittedAction:
    | "wait-for-drain"
    | "force-pending-operation"
    | "resume"
    | "repair"
    | "none";
}

const failure = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "UPGRADE_ACTIVATION_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

const terminalOutcome = (operation: LifecycleOperation): UpgradeActivationStatus["outcome"] => {
  switch (operation.outcome) {
    case "upgrade-refused":
    case "activated":
    case "rolled-back":
    case "repair-required":
      return operation.outcome;
    case undefined:
      return "in-progress";
    default:
      throw new LifecycleError(
        "UPGRADE_OPERATION_DAMAGED",
        "the managed upgrade has a non-upgrade outcome",
      );
  }
};

export class UpgradeActivationController {
  readonly #journal: LifecycleJournalRepository;
  readonly #control: DaemonUpgradeControl;
  readonly #nativeService: NativeService;
  readonly #releases: ManagedReleaseSelection;
  readonly #serviceDefinition: string;
  readonly #now: () => number;
  readonly #pollIntervalMillis: number;
  readonly #readinessMillis: number;
  readonly #stopMillis: number;
  readonly #observedDaemonInstanceId: () => string | undefined;

  constructor(options: {
    readonly journal: LifecycleJournalRepository;
    readonly control: DaemonUpgradeControl;
    readonly nativeService: NativeService;
    readonly releases: ManagedReleaseSelection;
    readonly serviceDefinition: string;
    readonly now?: () => number;
    readonly pollIntervalMillis?: number;
    readonly readinessMillis?: number;
    readonly stopMillis?: number;
    readonly observedDaemonInstanceId?: () => string | undefined;
  }) {
    this.#journal = options.journal;
    this.#control = options.control;
    this.#nativeService = options.nativeService;
    this.#releases = options.releases;
    this.#serviceDefinition = options.serviceDefinition;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMillis = options.pollIntervalMillis ?? 100;
    this.#readinessMillis = options.readinessMillis ?? 60_000;
    this.#stopMillis = options.stopMillis ?? DAEMON_CLEANUP_MILLIS;
    this.#observedDaemonInstanceId = options.observedDaemonInstanceId ?? (() => undefined);
  }

  #time(): string {
    return new Date(this.#now()).toISOString();
  }

  #sync<A>(body: () => A): Effect.Effect<A, LifecycleError> {
    return Effect.try({ try: body, catch: failure });
  }

  #awaitNativeStop(): Effect.Effect<void, LifecycleError> {
    const controller = this;
    return Effect.gen(function* () {
      while (true) {
        const observation = yield* controller.#sync(controller.#nativeService.inspect);
        const observedDaemonInstanceId = yield* controller.#sync(
          controller.#observedDaemonInstanceId,
        );
        if (observation.process === "stopped" && observedDaemonInstanceId === undefined) return;
        yield* Effect.sleep(controller.#pollIntervalMillis);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(controller.#stopMillis),
        orElse: () =>
          Effect.fail(
            new LifecycleError(
              "UPGRADE_STOP_UNCONFIRMED",
              "the native manager did not confirm that the source Daemon stopped and withdrew its endpoint",
            ),
          ),
      }),
    );
  }

  #advance(
    operation: LifecycleOperation,
    stage: LifecycleOperation["stage"],
    changes?: Parameters<LifecycleJournalRepository["advance"]>[0]["changes"],
  ): Effect.Effect<LifecycleOperation, LifecycleError> {
    return Effect.try({
      try: () =>
        this.#journal.advance({
          operationId: operation.operationId,
          expectedRevision: operation.stageRevision,
          stage,
          updatedAt: this.#time(),
          ...(changes === undefined ? {} : { changes }),
        }),
      catch: failure,
    }).pipe(
      Effect.catch((cause) =>
        this.#sync(() => {
          const retained = this.#journal.read(operation.operationId);
          if (
            retained !== undefined &&
            retained.stage === stage &&
            retained.stageRevision > operation.stageRevision
          ) {
            return retained;
          }
          throw cause;
        }),
      ),
    );
  }

  readonly request = (
    request: BeginLifecycleOperation & { readonly kind: "upgrade" },
  ): Effect.Effect<UpgradeActivationStatus, LifecycleError> =>
    this.#sync(() => this.#journal.begin(request)).pipe(
      Effect.flatMap((operation) => this.resume(operation.operationId)),
    );

  readonly force = (
    authorization: LifecycleForceAuthorization,
  ): Effect.Effect<UpgradeActivationStatus, LifecycleError> =>
    this.#sync(() => this.#journal.authorizeForce(authorization)).pipe(
      Effect.flatMap((operation) => this.resume(operation.operationId)),
    );

  #repair(
    operation: LifecycleOperation,
    cause: unknown,
  ): Effect.Effect<UpgradeActivationStatus, LifecycleError> {
    const fault = failure(cause);
    return this.#sync(() => this.#journal.read(operation.operationId)).pipe(
      Effect.flatMap((retained) => {
        const current = retained ?? operation;
        if (current.outcome !== undefined) return this.status(current.operationId);
        return this.#advance(current, "repair-required", {
          outcome: "repair-required",
          detail: fault.message,
        }).pipe(Effect.flatMap((updated) => this.status(updated.operationId)));
      }),
    );
  }

  #rollback(
    operation: LifecycleOperation,
    cause: unknown,
  ): Effect.Effect<UpgradeActivationStatus, LifecycleError> {
    const controller = this;
    const fault = failure(cause);
    return Effect.gen(function* () {
      if (operation.rollbackAttempted) return yield* controller.#repair(operation, fault);
      const safety = yield* controller.#control.inspectRollbackSafety(
        operation.operationId,
        operation.sourceReleaseId,
      );
      if (!safety.safe || !safety.executionStopped) {
        return yield* controller.#repair(
          operation,
          new LifecycleError(
            "UPGRADE_ROLLBACK_UNSAFE",
            `the exact source release cannot be used safely: ${safety.detail}`,
          ),
        );
      }
      yield* controller.#sync(controller.#nativeService.stop);
      const selected = yield* controller.#sync(() =>
        controller.#releases.select(
          operation.candidateReleaseId as string,
          operation.sourceReleaseId,
        ),
      );
      if (selected !== operation.sourceReleaseId) {
        return yield* controller.#repair(
          operation,
          new LifecycleError(
            "UPGRADE_ROLLBACK_SELECTION_FAILED",
            "the managed launcher did not select the exact source release",
          ),
        );
      }
      let current = yield* controller.#advance(operation, "rollback-selected", {
        rollbackAttempted: true,
        detail: fault.message,
      });
      yield* controller.#sync(() => controller.#nativeService.start(controller.#serviceDefinition));
      const readiness = yield* Effect.retry(
        controller.#control.readRollbackReadiness(current.operationId),
        {
          schedule: Schedule.spaced(Duration.millis(controller.#pollIntervalMillis)),
          times: Math.max(
            1,
            Math.ceil(controller.#readinessMillis / controller.#pollIntervalMillis),
          ),
        },
      );
      current = yield* controller.#advance(current, "rollback-ready", { readiness });
      const owner = yield* controller.#control.authorizeRollback(current.operationId, readiness);
      current = yield* controller.#advance(current, "rolled-back", {
        outcome: "rolled-back",
        recordedOwner: owner,
      });
      return yield* controller.status(current.operationId);
    }).pipe(Effect.catch((rollbackCause) => controller.#repair(operation, rollbackCause)));
  }

  readonly resume = (
    operationId: string,
  ): Effect.Effect<UpgradeActivationStatus, LifecycleError> => {
    const controller = this;
    return Effect.gen(function* () {
      const found = yield* controller.#sync(() => controller.#journal.read(operationId));
      if (found === undefined) {
        return yield* Effect.fail(
          new LifecycleError(
            "LIFECYCLE_OPERATION_NOT_FOUND",
            "the managed upgrade operation was not found",
          ),
        );
      }
      if (found.kind !== "upgrade" || found.candidateReleaseId === undefined) {
        return yield* Effect.fail(
          new LifecycleError(
            "LIFECYCLE_CONTROLLER_MISMATCH",
            "the operation is not a managed upgrade activation",
          ),
        );
      }
      if (found.checkedRetainedSetHash === undefined) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_OPERATION_DAMAGED",
            "the managed upgrade has no checked retained-state identity",
          ),
        );
      }
      const candidateReleaseId = found.candidateReleaseId;
      const checkedRetainedSetHash = found.checkedRetainedSetHash;
      let operation = found;
      if (operation.outcome !== undefined) return yield* controller.status(operationId);

      if (operation.stage === "prepared") {
        const owner = yield* controller.#control.inspectPreflight(
          operation.operationId,
          operation.dataIdentity,
          operation.originalRequestHash,
          operation.sourceReleaseId,
          candidateReleaseId,
          checkedRetainedSetHash,
        );
        const drain = yield* controller.#control.beginDrain(operation.operationId);
        operation = yield* controller.#advance(operation, "draining", {
          drain,
          recordedOwner: owner,
        });
      }
      if (operation.stage === "draining" && operation.forceAuthorizationId === undefined) {
        while (true) {
          const progress = yield* controller.#control.readDrain(operation.operationId);
          if (
            operation.drain?.observedAt !== progress.observedAt ||
            operation.drain.executingRunIds.join("\0") !== progress.executingRunIds.join("\0")
          ) {
            operation = yield* controller.#advance(operation, "draining", { drain: progress });
          }
          if (progress.executingRunIds.length === 0) {
            operation = yield* controller.#advance(operation, "drained", { drain: progress });
            break;
          }
          yield* Effect.sleep(controller.#pollIntervalMillis);
        }
      }
      if (operation.stage === "draining") {
        const forceAuthorizationId = operation.forceAuthorizationId;
        if (forceAuthorizationId === undefined) {
          return yield* controller.#repair(
            operation,
            new LifecycleError(
              "UPGRADE_DRAIN_DAMAGED",
              "the managed upgrade left its planned drain without force authorization",
            ),
          );
        }
        const progress = yield* controller.#control.forceDrain(
          operation.operationId,
          DAEMON_CLEANUP_MILLIS,
          forceAuthorizationId,
        );
        if (progress.executingRunIds.length > 0) {
          return yield* controller.#repair(
            operation,
            new LifecycleError(
              "UPGRADE_FORCE_INCOMPLETE",
              "forced drain did not stop every executing Run",
            ),
          );
        }
        operation = yield* controller.#advance(operation, "drained", { drain: progress });
      }
      if (operation.stage === "drained") {
        yield* controller.#control.holdMutations(operation.operationId);
        operation = yield* controller.#advance(operation, "mutations-held");
      }
      if (operation.stage === "mutations-held") {
        const finalPreflight = yield* controller.#control.repeatFinalPreflight(
          operation.operationId,
          candidateReleaseId,
          checkedRetainedSetHash,
        );
        if (finalPreflight.outcome === "refused") {
          yield* controller.#control.releaseUpgradeHolds(operation.operationId);
          operation = yield* controller.#advance(operation, "upgrade-refused", {
            outcome: "upgrade-refused",
            compatibility: "refused",
            recordedOwner: finalPreflight.owner,
            detail: finalPreflight.detail,
          });
          return yield* controller.status(operation.operationId);
        }
        operation = yield* controller.#advance(operation, "final-preflight-accepted", {
          compatibility: "accepted",
          recordedOwner: finalPreflight.owner,
        });
      }
      if (operation.stage === "final-preflight-accepted") {
        const handoff = yield* controller.#control.prepareHandoff(operation.operationId);
        operation = yield* controller.#advance(operation, "handoff-prepared", {
          handoffDigest: handoff.digest,
          recordedOwner: handoff.owner,
        });
      }
      if (operation.stage === "handoff-prepared") {
        operation = yield* controller.#advance(operation, "controller-ready", {
          controllerAcceptedAt: controller.#time(),
        });
      }
      if (operation.stage === "controller-ready") {
        if (operation.handoffDigest === undefined) {
          return yield* controller.#repair(
            operation,
            new LifecycleError(
              "UPGRADE_HANDOFF_DAMAGED",
              "the managed upgrade handoff has no durable digest",
            ),
          );
        }
        yield* controller.#control.confirmControllerReady(
          operation.operationId,
          operation.handoffDigest,
        );
        operation = yield* controller.#advance(operation, "controller-accepted");
      }
      if (operation.stage === "controller-accepted") {
        const backup = yield* controller.#control.createVerifiedBackup(operation.operationId);
        operation = yield* controller.#advance(operation, "backup-verified", { backup });
      }
      if (operation.stage === "backup-verified") {
        operation = yield* controller.#advance(operation, "cleanup-started");
      }
      if (operation.stage === "cleanup-started") {
        const owner = yield* controller.#control.stopOwnedProcesses(
          operation.operationId,
          DAEMON_CLEANUP_MILLIS,
          operation.forceAuthorizationId,
        );
        operation = yield* controller.#advance(operation, "owned-processes-stopped", {
          recordedOwner: owner,
        });
      }
      if (operation.stage === "owned-processes-stopped") {
        yield* controller.#sync(controller.#nativeService.stop);
        const stopped = yield* controller.#awaitNativeStop().pipe(Effect.result);
        if (Result.isFailure(stopped)) {
          return yield* controller.#repair(operation, stopped.failure);
        }
        operation = yield* controller.#advance(operation, "process-stopped");
      }
      if (operation.stage === "process-stopped") {
        const selected = yield* controller.#sync(() =>
          controller.#releases.select(operation.sourceReleaseId, candidateReleaseId),
        );
        if (selected !== candidateReleaseId) {
          return yield* controller.#repair(
            operation,
            new LifecycleError(
              "UPGRADE_CANDIDATE_SELECTION_FAILED",
              "the managed launcher did not select the checked candidate",
            ),
          );
        }
        operation = yield* controller.#advance(operation, "candidate-selected");
      }
      if (operation.stage === "candidate-selected") {
        const candidateOperation = operation;
        const candidateResult = yield* Effect.gen(function* () {
          yield* controller.#sync(() =>
            controller.#nativeService.start(controller.#serviceDefinition),
          );
          const priorOwner = candidateOperation.recordedOwner?.daemonInstanceId;
          if (priorOwner === undefined) {
            return yield* Effect.fail(
              new LifecycleError(
                "UPGRADE_OWNER_DAMAGED",
                "the managed upgrade has no recorded source Daemon owner",
              ),
            );
          }
          const readiness = yield* Effect.retry(
            controller.#control.readCandidateReadiness(candidateOperation.operationId, priorOwner),
            {
              schedule: Schedule.spaced(Duration.millis(controller.#pollIntervalMillis)),
              times: Math.max(
                1,
                Math.ceil(controller.#readinessMillis / controller.#pollIntervalMillis),
              ),
            },
          );
          return yield* controller.#advance(candidateOperation, "candidate-ready", { readiness });
        }).pipe(Effect.result);
        if (Result.isFailure(candidateResult)) {
          return yield* controller.#rollback(candidateOperation, candidateResult.failure);
        }
        operation = candidateResult.success;
      }
      if (operation.stage === "rollback-selected") {
        const rollbackOperation = operation;
        const rollback = yield* Effect.gen(function* () {
          yield* controller.#sync(() =>
            controller.#nativeService.start(controller.#serviceDefinition),
          );
          const readiness = yield* Effect.retry(
            controller.#control.readRollbackReadiness(rollbackOperation.operationId),
            {
              schedule: Schedule.spaced(Duration.millis(controller.#pollIntervalMillis)),
              times: Math.max(
                1,
                Math.ceil(controller.#readinessMillis / controller.#pollIntervalMillis),
              ),
            },
          );
          return yield* controller.#advance(rollbackOperation, "rollback-ready", { readiness });
        }).pipe(Effect.result);
        if (Result.isFailure(rollback)) {
          return yield* controller.#repair(operation, rollback.failure);
        }
        operation = rollback.success;
      }
      if (operation.stage === "rollback-ready") {
        const owner = yield* controller.#control.authorizeRollback(
          operation.operationId,
          operation.readiness as NonNullable<LifecycleOperation["readiness"]>,
        );
        operation = yield* controller.#advance(operation, "rolled-back", {
          outcome: "rolled-back",
          recordedOwner: owner,
        });
      }
      if (operation.stage === "candidate-ready") {
        const owner = yield* controller.#control.authorizeActivation(
          operation.operationId,
          operation.readiness as NonNullable<LifecycleOperation["readiness"]>,
        );
        operation = yield* controller.#advance(operation, "activation-authorized", {
          recordedOwner: owner,
        });
      }
      if (operation.stage === "activation-authorized") {
        operation = yield* controller.#advance(operation, "activated", {
          outcome: "activated",
        });
      }
      return yield* controller.status(operation.operationId);
    });
  };

  readonly status = (operationId: string): Effect.Effect<UpgradeActivationStatus, LifecycleError> =>
    this.#sync(() => {
      const operation = this.#journal.read(operationId);
      if (operation === undefined || operation.kind !== "upgrade") {
        throw new LifecycleError(
          "LIFECYCLE_OPERATION_NOT_FOUND",
          "the managed upgrade operation was not found",
        );
      }
      const outcome = terminalOutcome(operation);
      return {
        operation,
        outcome,
        nextPermittedAction:
          outcome === "repair-required"
            ? "repair"
            : outcome !== "in-progress"
              ? "none"
              : operation.stage === "draining" &&
                  operation.drain !== undefined &&
                  operation.drain.executingRunIds.length > 0 &&
                  operation.forceAuthorizationId === undefined
                ? "force-pending-operation"
                : operation.stage === "draining"
                  ? "wait-for-drain"
                  : "resume",
      };
    });
}
