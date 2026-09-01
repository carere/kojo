import { Effect } from "effect";
import type { RunApi } from "../../workflow/services/RunApi.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { LifecycleRecordedOwner } from "../models/LifecycleOperation.ts";
import type { DaemonLifecycleControl, LifecycleHandoff } from "../ports/DaemonLifecycleControl.ts";
import type { DaemonLifecycleReceiptRepository } from "../ports/DaemonLifecycleReceiptRepository.ts";

const asLifecycleError = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "DAEMON_LIFECYCLE_CONTROL_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

const digestOf = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

export class DaemonLifecycleApi implements DaemonLifecycleControl {
  readonly #dataIdentity: string;
  readonly #runs: RunApi;
  readonly #receipts: DaemonLifecycleReceiptRepository;
  readonly #ready: Effect.Effect<void, LifecycleError>;
  readonly #activatePendingConfiguration: Effect.Effect<void, LifecycleError>;
  readonly #recordPlannedStop: Effect.Effect<void, LifecycleError>;
  readonly #cleanupMillis: () => number;

  constructor(options: {
    readonly dataIdentity: string;
    readonly runs: RunApi;
    readonly receipts: DaemonLifecycleReceiptRepository;
    readonly ready?: Effect.Effect<void, LifecycleError>;
    readonly activatePendingConfiguration?: Effect.Effect<void, LifecycleError>;
    readonly recordPlannedStop?: Effect.Effect<void, LifecycleError>;
    readonly cleanupMillis?: () => number;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#runs = options.runs;
    this.#receipts = options.receipts;
    this.#ready = options.ready ?? Effect.void;
    this.#activatePendingConfiguration = options.activatePendingConfiguration ?? Effect.void;
    this.#recordPlannedStop = options.recordPlannedStop ?? Effect.void;
    this.#cleanupMillis = options.cleanupMillis ?? (() => 30_000);
  }

  #owner(): LifecycleRecordedOwner {
    return this.#runs.lifecycleOwner();
  }

  readonly inspectPreflight = (
    operationId: string,
    dataIdentity: string,
    requestHash: string,
  ): Effect.Effect<LifecycleRecordedOwner, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      if (dataIdentity !== api.#dataIdentity) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_DATA_IDENTITY_CHANGED",
            "the lifecycle operation names different Daemon data",
          ),
        );
      }
      const owner = api.#owner();
      yield* api.#receipts.prepare({ operationId, dataIdentity, requestHash, owner });
      return owner;
    });
  };

  readonly beginDrain = (
    operationId: string,
    dataIdentity: string,
    requestHash: string,
  ): Effect.Effect<
    {
      readonly held: true;
      readonly executingRunIds: ReadonlyArray<string>;
      readonly observedAt: string;
    },
    LifecycleError
  > => {
    const api = this;
    return Effect.gen(function* () {
      const owner = yield* api.inspectPreflight(operationId, dataIdentity, requestHash);
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_LIFECYCLE_RECEIPT_NOT_FOUND",
            "the Daemon lifecycle receipt was not found",
          ),
        );
      }
      if (receipt.stage === "prepared") {
        yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: "draining",
          owner,
          drainHeld: true,
        });
      }
      return yield* api.#runs.beginDaemonDrain().pipe(Effect.mapError(asLifecycleError));
    });
  };

  readonly readDrain = (operationId: string) =>
    this.#receipts
      .read(operationId)
      .pipe(
        Effect.flatMap((receipt) =>
          receipt === undefined || !receipt.drainHeld
            ? Effect.fail(
                new LifecycleError(
                  "DAEMON_DRAIN_NOT_HELD",
                  "the Daemon has no durable hold for this operation",
                ),
              )
            : this.#runs.daemonDrainProgress().pipe(Effect.mapError(asLifecycleError)),
        ),
      );

  readonly prepareHandoff = (
    operationId: string,
  ): Effect.Effect<LifecycleHandoff, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      let receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined || !receipt.drainHeld) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_DRAIN_NOT_HELD",
            "the Daemon has no durable hold for this handoff",
          ),
        );
      }
      if (receipt.handoffDigest !== undefined) {
        return { digest: receipt.handoffDigest, owner: receipt.owner };
      }
      const owner = api.#owner();
      const digest = digestOf({
        operationId,
        dataIdentity: receipt.dataIdentity,
        requestHash: receipt.requestHash,
        owner,
      });
      receipt = yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "handoff-prepared",
        owner,
        handoffDigest: digest,
      });
      return { digest: receipt.handoffDigest ?? digest, owner: receipt.owner };
    });
  };

  readonly confirmControllerReady = (
    operationId: string,
    handoffDigest: string,
  ): Effect.Effect<void, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined || receipt.handoffDigest !== handoffDigest) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_HANDOFF_MISMATCH",
            "the controller does not name the prepared Daemon handoff",
          ),
        );
      }
      if (receipt.stage === "controller-accepted") return;
      yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "controller-accepted",
        owner: api.#owner(),
        handoffDigest,
      });
    });
  };

  readonly stopOwnedProcesses = (
    operationId: string,
    _cleanupMillis: number,
    replacementExpected: boolean,
    forceAuthorizationId?: string,
  ): Effect.Effect<LifecycleRecordedOwner, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      let receipt = yield* api.#receipts.read(operationId);
      if (
        receipt === undefined ||
        (receipt.stage !== "controller-accepted" &&
          receipt.stage !== "cleanup-started" &&
          receipt.stage !== "process-stopped")
      ) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_HANDOFF_INCOMPLETE",
            "both lifecycle owners must accept handoff before cleanup",
          ),
        );
      }
      if (receipt.stage === "process-stopped") {
        if (
          receipt.drainHeld !== replacementExpected ||
          receipt.forceAuthorizationId !== forceAuthorizationId
        ) {
          return yield* Effect.fail(
            new LifecycleError(
              "DAEMON_LIFECYCLE_REPLAY_CONFLICT",
              "the repeated cleanup names different replacement or force evidence",
            ),
          );
        }
        return receipt.owner;
      }
      const progress = yield* api.#runs
        .daemonDrainProgress()
        .pipe(Effect.mapError(asLifecycleError));
      if (progress.executingRunIds.length > 0 && forceAuthorizationId === undefined) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_DRAIN_INCOMPLETE",
            "executing Runs still need suspension, completion, or explicit force",
          ),
        );
      }
      receipt = yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "cleanup-started",
        owner: api.#owner(),
        ...(forceAuthorizationId === undefined ? {} : { forceAuthorizationId }),
      });
      const owner = yield* api.#runs
        .stopForDaemonLifecycle(api.#cleanupMillis(), forceAuthorizationId !== undefined)
        .pipe(Effect.mapError(asLifecycleError));
      yield* api.#recordPlannedStop;
      yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "process-stopped",
        owner,
        drainHeld: replacementExpected,
        ...(forceAuthorizationId === undefined ? {} : { forceAuthorizationId }),
      });
      return owner;
    });
  };

  readonly confirmReplacementReady = (
    operationId: string,
    priorDaemonInstanceId: string,
  ): Effect.Effect<LifecycleRecordedOwner, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt?.stage === "replacement-ready") {
        if (receipt.owner.daemonInstanceId === priorDaemonInstanceId) {
          return yield* Effect.fail(
            new LifecycleError(
              "DAEMON_REPLACEMENT_NOT_OBSERVED",
              "replacement readiness needs a new Daemon instance owner",
            ),
          );
        }
        yield* api.#runs.releaseDaemonDispatch().pipe(Effect.mapError(asLifecycleError));
        return receipt.owner;
      }
      if (receipt === undefined || receipt.stage !== "process-stopped" || !receipt.drainHeld) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_REPLACEMENT_NOT_EXPECTED",
            "the lifecycle operation is not waiting for a replacement Daemon",
          ),
        );
      }
      const owner = api.#owner();
      if (owner.daemonInstanceId === priorDaemonInstanceId) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_REPLACEMENT_NOT_OBSERVED",
            "replacement readiness needs a new Daemon instance owner",
          ),
        );
      }
      yield* api.#ready;
      yield* api.#activatePendingConfiguration;
      yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "replacement-ready",
        owner,
        drainHeld: false,
      });
      yield* api.#runs.releaseDaemonDispatch().pipe(Effect.mapError(asLifecycleError));
      return owner;
    });
  };
}
