import { Duration, Effect, Schedule } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleForceAuthorization,
  LifecycleNextAction,
  LifecycleOperation,
  LifecycleOperationStatus,
} from "../models/LifecycleOperation.ts";
import type { DaemonLifecycleControl } from "../ports/DaemonLifecycleControl.ts";
import type {
  BeginLifecycleOperation,
  LifecycleJournalRepository,
} from "../ports/LifecycleJournalRepository.ts";
import type { NativeService } from "../ports/NativeService.ts";

export const DAEMON_CLEANUP_MILLIS = 30_000;

const lifecycleError = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "LIFECYCLE_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

const nextAction = (operation: LifecycleOperation): LifecycleNextAction => {
  if (operation.outcome === "repair-required") return "repair";
  if (operation.outcome === "succeeded") return "none";
  switch (operation.stage) {
    case "prepared":
    case "draining":
      return operation.forceAuthorizationId === undefined
        ? operation.drain !== undefined && operation.drain.executingRunIds.length > 0
          ? "force-pending-operation"
          : "wait-for-drain"
        : "complete-handoff";
    case "drained":
    case "handoff-prepared":
    case "controller-ready":
      return "complete-handoff";
    case "controller-accepted":
    case "cleanup-started":
    case "owned-processes-stopped":
      return "stop-native-service";
    case "process-stopped":
      return operation.kind === "restart" ? "start-replacement" : "inspect-result";
    case "replacement-started":
      return "inspect-result";
    case "completed":
      return "none";
    case "repair-required":
      return "repair";
  }
};

export class LifecycleController {
  readonly #journal: LifecycleJournalRepository;
  readonly #control: DaemonLifecycleControl;
  readonly #nativeService: NativeService;
  readonly #now: () => number;
  readonly #pollIntervalMillis: number;
  readonly #serviceDefinition: string;
  readonly #observedDaemonInstanceId: () => string | undefined;

  constructor(options: {
    readonly journal: LifecycleJournalRepository;
    readonly control: DaemonLifecycleControl;
    readonly nativeService: NativeService;
    readonly now?: () => number;
    readonly pollIntervalMillis?: number;
    readonly serviceDefinition: string;
    readonly observedDaemonInstanceId?: () => string | undefined;
  }) {
    this.#journal = options.journal;
    this.#control = options.control;
    this.#nativeService = options.nativeService;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMillis = options.pollIntervalMillis ?? 100;
    this.#serviceDefinition = options.serviceDefinition;
    this.#observedDaemonInstanceId = options.observedDaemonInstanceId ?? (() => undefined);
  }

  #time(): string {
    return new Date(this.#now()).toISOString();
  }

  #sync<A>(body: () => A): Effect.Effect<A, LifecycleError> {
    return Effect.try({ try: body, catch: lifecycleError });
  }

  #advance(
    operation: LifecycleOperation,
    stage: LifecycleOperation["stage"],
    changes?: Parameters<LifecycleJournalRepository["advance"]>[0]["changes"],
  ): Effect.Effect<LifecycleOperation, LifecycleError> {
    return this.#sync(() =>
      this.#journal.advance({
        operationId: operation.operationId,
        expectedRevision: operation.stageRevision,
        stage,
        updatedAt: this.#time(),
        ...(changes === undefined ? {} : { changes }),
      }),
    );
  }

  readonly request = (
    request: BeginLifecycleOperation,
  ): Effect.Effect<LifecycleOperationStatus, LifecycleError> =>
    this.#sync(() => this.#journal.begin(request)).pipe(
      Effect.flatMap((operation) => this.resume(operation.operationId)),
    );

  readonly force = (
    authorization: LifecycleForceAuthorization,
  ): Effect.Effect<LifecycleOperationStatus, LifecycleError> =>
    this.#sync(() => this.#journal.authorizeForce(authorization)).pipe(
      Effect.flatMap((operation) => this.resume(operation.operationId)),
    );

  readonly resume = (
    operationId: string,
  ): Effect.Effect<LifecycleOperationStatus, LifecycleError> => {
    const controller = this;
    return Effect.gen(function* () {
      const found = yield* controller.#sync(() => controller.#journal.read(operationId));
      if (found === undefined) {
        return yield* Effect.fail(
          new LifecycleError(
            "LIFECYCLE_OPERATION_NOT_FOUND",
            "the lifecycle operation was not found",
          ),
        );
      }
      let operation: LifecycleOperation = found;
      if (operation.outcome !== undefined) return yield* controller.status(operationId);

      if (operation.kind === "enable") {
        yield* controller.#sync(controller.#nativeService.enable);
        operation = yield* controller.#advance(operation, "completed", { outcome: "succeeded" });
        return yield* controller.status(operation.operationId);
      }
      if (operation.kind === "disable") {
        yield* controller.#sync(() => controller.#nativeService.disable(false));
        operation = yield* controller.#advance(operation, "completed", { outcome: "succeeded" });
        return yield* controller.status(operation.operationId);
      }
      if (operation.kind === "disable-now" && operation.stage === "prepared") {
        yield* controller.#sync(() => controller.#nativeService.disable(false));
      }
      if (
        operation.stage === "prepared" &&
        (operation.kind === "stop" || operation.kind === "disable-now") &&
        (yield* controller.#sync(controller.#nativeService.inspect)).process === "stopped"
      ) {
        operation = yield* controller.#advance(operation, "completed", {
          outcome: "succeeded",
          detail: "the native manager already confirmed that the Daemon was stopped",
        });
        return yield* controller.status(operation.operationId);
      }

      if (operation.stage === "prepared") {
        const owner = yield* controller.#control.inspectPreflight(
          operation.operationId,
          operation.dataIdentity,
          operation.originalRequestHash,
        );
        const drain = yield* controller.#control.beginDrain(
          operation.operationId,
          operation.dataIdentity,
          operation.originalRequestHash,
        );
        operation = yield* controller.#advance(operation, "draining", {
          drain,
          recordedOwner: owner,
        });
      }

      if (operation.stage === "draining" && operation.forceAuthorizationId === undefined) {
        while (true) {
          const drain = yield* controller.#control.readDrain(operation.operationId);
          if (
            operation.drain?.held !== drain.held ||
            operation.drain?.executingRunIds.join("\0") !== drain.executingRunIds.join("\0")
          ) {
            operation = yield* controller.#advance(operation, "draining", { drain });
          }
          if (drain.executingRunIds.length === 0) {
            operation = yield* controller.#advance(operation, "drained", { drain });
            break;
          }
          yield* Effect.sleep(controller.#pollIntervalMillis);
        }
      }

      if (operation.stage === "draining" || operation.stage === "drained") {
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
          return yield* Effect.fail(
            new LifecycleError(
              "LIFECYCLE_HANDOFF_DAMAGED",
              "the lifecycle handoff has no durable digest",
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
        operation = yield* controller.#advance(operation, "cleanup-started");
      }
      if (operation.stage === "cleanup-started") {
        const cleanupOperation = operation;
        operation = yield* Effect.gen(function* () {
          const owner = yield* controller.#control.stopOwnedProcesses(
            cleanupOperation.operationId,
            DAEMON_CLEANUP_MILLIS,
            cleanupOperation.kind === "restart",
            cleanupOperation.forceAuthorizationId,
          );
          return yield* controller.#advance(cleanupOperation, "owned-processes-stopped", {
            recordedOwner: owner,
          });
        }).pipe(
          Effect.catch((cause) =>
            lifecycleError(cause).code === "LIFECYCLE_CONTROL_UNAVAILABLE"
              ? Effect.fail(cause)
              : controller
                  .#advance(cleanupOperation, "repair-required", {
                    outcome: "repair-required",
                    detail: lifecycleError(cause).message,
                  })
                  .pipe(Effect.flatMap(() => Effect.fail(cause))),
          ),
        );
      }
      if (operation.stage === "owned-processes-stopped") {
        const ownedProcessesStopped = operation;
        operation = yield* Effect.gen(function* () {
          yield* controller.#sync(controller.#nativeService.stop);
          const observation = yield* controller.#sync(controller.#nativeService.inspect);
          if (observation.process !== "stopped") {
            return yield* Effect.fail(
              new LifecycleError(
                "LIFECYCLE_STOP_UNCONFIRMED",
                "the native manager did not confirm that the Daemon stopped",
              ),
            );
          }
          return yield* controller.#advance(ownedProcessesStopped, "process-stopped");
        }).pipe(
          Effect.catch((cause) =>
            controller
              .#advance(ownedProcessesStopped, "repair-required", {
                outcome: "repair-required",
                detail: lifecycleError(cause).message,
              })
              .pipe(Effect.flatMap(() => Effect.fail(cause))),
          ),
        );
      }
      if (operation.stage === "process-stopped" && operation.kind === "restart") {
        yield* controller.#sync(() =>
          controller.#nativeService.start(controller.#serviceDefinition),
        );
        operation = yield* controller.#advance(operation, "replacement-started");
      }
      if (operation.stage === "replacement-started") {
        const priorDaemonInstanceId = operation.recordedOwner?.daemonInstanceId;
        if (priorDaemonInstanceId === undefined) {
          return yield* Effect.fail(
            new LifecycleError(
              "LIFECYCLE_OWNER_DAMAGED",
              "the restart has no recorded prior Daemon owner",
            ),
          );
        }
        const replacement = yield* Effect.retry(
          controller.#control.confirmReplacementReady(operation.operationId, priorDaemonInstanceId),
          {
            schedule: Schedule.spaced(Duration.millis(controller.#pollIntervalMillis)),
            times: Math.max(1, Math.ceil(60_000 / controller.#pollIntervalMillis)),
          },
        );
        operation = yield* controller.#advance(operation, "completed", {
          outcome: "succeeded",
          recordedOwner: replacement,
        });
      } else if (operation.stage === "process-stopped") {
        operation = yield* controller.#advance(operation, "completed", { outcome: "succeeded" });
      }
      return yield* controller.status(operation.operationId);
    });
  };

  readonly status = (
    operationId?: string,
  ): Effect.Effect<LifecycleOperationStatus, LifecycleError> =>
    this.#sync(() => {
      const operation =
        operationId === undefined ? this.#journal.current() : this.#journal.read(operationId);
      if (operation === undefined) {
        throw new LifecycleError(
          "LIFECYCLE_OPERATION_NOT_FOUND",
          "the lifecycle operation was not found",
        );
      }
      const native = this.#nativeService.inspect();
      const observedDaemonInstanceId = this.#observedDaemonInstanceId();
      return {
        operation,
        outcome: operation.outcome ?? "in-progress",
        ...(operation.recordedOwner === undefined
          ? {}
          : { recordedOwner: operation.recordedOwner }),
        observedOwner: {
          ...(observedDaemonInstanceId === undefined
            ? {}
            : { daemonInstanceId: observedDaemonInstanceId }),
          manager: native.manager,
          process: native.process,
          observedAt: this.#time(),
          ...(native.detail === undefined ? {} : { detail: native.detail }),
        },
        progress: operation.drain,
        nextPermittedAction: nextAction(operation),
      };
    });
}
