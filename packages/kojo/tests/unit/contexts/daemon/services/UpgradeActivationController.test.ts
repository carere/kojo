import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { InMemoryLifecycleJournalRepository } from "../../../../../src/contexts/daemon/adapters/InMemoryLifecycleJournalRepository.ts";
import { LifecycleError } from "../../../../../src/contexts/daemon/models/LifecycleError.ts";
import type {
  LifecycleOperation,
  LifecycleStage,
  UpgradeReadinessEvidence,
} from "../../../../../src/contexts/daemon/models/LifecycleOperation.ts";
import type { DaemonUpgradeControl } from "../../../../../src/contexts/daemon/ports/DaemonUpgradeControl.ts";
import type {
  AdvanceLifecycleOperation,
  BeginLifecycleOperation,
  LifecycleJournalRepository,
} from "../../../../../src/contexts/daemon/ports/LifecycleJournalRepository.ts";
import type { ManagedReleaseSelection } from "../../../../../src/contexts/daemon/ports/ManagedReleaseSelection.ts";
import type {
  NativeService,
  NativeServiceObservation,
} from "../../../../../src/contexts/daemon/ports/NativeService.ts";
import { UpgradeActivationController } from "../../../../../src/contexts/daemon/services/UpgradeActivationController.ts";

const sourceReleaseId = "kojo-source";
const candidateReleaseId = "kojo-candidate";
const oldOwner = {
  daemonInstanceId: "daemon-old",
  runnerInstanceIds: ["runner-one"],
  recordedAt: "2026-09-01T10:00:00.000Z",
};
const newOwner = {
  daemonInstanceId: "daemon-new",
  runnerInstanceIds: [],
  recordedAt: "2026-09-01T10:01:00.000Z",
};
const request = {
  operationId: "upgrade-one",
  dataIdentity: "data-one",
  originalRequestHash: "a".repeat(64),
  kind: "upgrade" as const,
  sourceReleaseId,
  candidateReleaseId,
  checkedRetainedSetHash: "b".repeat(64),
  startedAt: "2026-09-01T10:00:00.000Z",
};

const readiness = (releaseId: string): UpgradeReadinessEvidence => ({
  daemonInstanceId: "daemon-new",
  dataIdentity: "data-one",
  sourceReleaseId,
  candidateReleaseId: releaseId,
  receiptDigest: "c".repeat(64),
  wakeupDigest: "d".repeat(64),
  integrity: "ok",
  transports: "ready",
  workflowExecutions: 0,
  checkedAt: "2026-09-01T10:01:00.000Z",
});

class RecordingJournal implements LifecycleJournalRepository {
  readonly inner = new InMemoryLifecycleJournalRepository();
  readonly snapshots: Array<LifecycleOperation> = [];
  readonly begin = (input: BeginLifecycleOperation): LifecycleOperation => {
    const operation = this.inner.begin(input);
    this.snapshots.push(operation);
    return operation;
  };
  readonly read = (operationId: string) => this.inner.read(operationId);
  readonly current = () => this.inner.current();
  readonly advance = (input: AdvanceLifecycleOperation): LifecycleOperation => {
    const operation = this.inner.advance(input);
    this.snapshots.push(operation);
    return operation;
  };
  readonly authorizeForce = this.inner.authorizeForce;
  readonly controlSecret = this.inner.controlSecret;
  readonly forceAuthorizationFor = this.inner.forceAuthorizationFor;
}

class RetainedOperationJournal implements LifecycleJournalRepository {
  #operation: LifecycleOperation;
  readonly delegate = new InMemoryLifecycleJournalRepository();

  constructor(operation: LifecycleOperation) {
    this.#operation = operation;
  }

  readonly begin = (input: BeginLifecycleOperation): LifecycleOperation => {
    if (input.operationId !== this.#operation.operationId) throw new Error("operation changed");
    return this.#operation;
  };
  readonly read = (operationId: string): LifecycleOperation | undefined =>
    operationId === this.#operation.operationId ? this.#operation : undefined;
  readonly current = (): LifecycleOperation => this.#operation;
  readonly advance = (input: AdvanceLifecycleOperation): LifecycleOperation => {
    if (input.expectedRevision !== this.#operation.stageRevision) {
      throw new LifecycleError("LIFECYCLE_REVISION_CONFLICT", "the revision changed");
    }
    this.#operation = {
      ...this.#operation,
      ...input.changes,
      stage: input.stage,
      stageRevision: input.expectedRevision + 1,
      updatedAt: input.updatedAt,
    };
    return this.#operation;
  };
  readonly authorizeForce = this.delegate.authorizeForce;
  readonly controlSecret = () => "e".repeat(64);
  readonly forceAuthorizationFor = () => undefined;
}

const fixture = (
  options: {
    readonly journal?: LifecycleJournalRepository;
    readonly finalPreflight?: "accepted" | "refused";
    readonly candidateReady?: boolean;
    readonly rollbackSafe?: boolean;
    readonly rollbackReadyAfter?: number;
    readonly selectedRelease?: string;
    readonly process?: "running" | "stopped";
    readonly releaseReplyLostOnce?: boolean;
  } = {},
) => {
  const events: Array<string> = [];
  let selectedRelease = options.selectedRelease ?? sourceReleaseId;
  let observation: NativeServiceObservation = {
    automaticStart: "enabled",
    manager: "loaded",
    process: options.process ?? "running",
    loginLifetime: "test",
    logoutPersistence: "disabled",
  };
  const native: NativeService = {
    serviceDocument: () => "fixture",
    assertSupported: () => {},
    inspect: () => observation,
    installAndStart: () => {},
    start: () => {
      events.push(`native:start:${selectedRelease}`);
      observation = { ...observation, process: "running" };
    },
    stop: () => {
      events.push(`native:stop:${selectedRelease}`);
      observation = { ...observation, process: "stopped" };
    },
    enable: () => {},
    disable: () => {},
    keepRunningAfterLogout: () => {},
  };
  const releases: ManagedReleaseSelection = {
    read: () => selectedRelease,
    select: (expected, next) => {
      if (selectedRelease !== expected && selectedRelease !== next) {
        throw new Error("release selection changed");
      }
      selectedRelease = next;
      events.push(`release:${next}`);
      return selectedRelease;
    },
  };
  let rollbackReadinessCalls = 0;
  let releaseCalls = 0;
  const control: DaemonUpgradeControl = {
    inspectPreflight: () => Effect.succeed(oldOwner),
    beginDrain: () =>
      Effect.succeed({
        held: true,
        executingRunIds: [],
        observedAt: "2026-09-01T10:00:01.000Z",
      }),
    readDrain: () =>
      Effect.succeed({
        held: true,
        executingRunIds: [],
        observedAt: "2026-09-01T10:00:02.000Z",
      }),
    forceDrain: (_operationId, _cleanupMillis, forceAuthorizationId) => {
      events.push(`daemon:force-drain:${forceAuthorizationId}`);
      return Effect.succeed({
        held: true,
        executingRunIds: [],
        observedAt: "2026-09-01T10:00:02.000Z",
      });
    },
    holdMutations: () => {
      events.push("daemon:mutations-held");
      return Effect.void;
    },
    repeatFinalPreflight: () =>
      Effect.succeed({
        outcome: options.finalPreflight ?? "accepted",
        retainedSetHash: request.checkedRetainedSetHash,
        owner: oldOwner,
        detail:
          options.finalPreflight === "refused"
            ? "the retained set changed after ordinary mutations stopped"
            : "the final retained set is compatible",
      }),
    releaseUpgradeHolds: () => {
      events.push("daemon:holds-released");
      releaseCalls += 1;
      return options.releaseReplyLostOnce === true && releaseCalls === 1
        ? Effect.fail(
            new LifecycleError(
              "LIFECYCLE_CONTROL_UNAVAILABLE",
              "the refusal release reply was lost",
            ),
          )
        : Effect.void;
    },
    prepareHandoff: () => Effect.succeed({ digest: "f".repeat(64), owner: oldOwner }),
    confirmControllerReady: () => Effect.void,
    createVerifiedBackup: () =>
      Effect.succeed({
        backupId: "backup-one",
        sha256: "1".repeat(64),
        dataVersion: "2".repeat(64),
        verifiedAt: "2026-09-01T10:00:03.000Z",
      }),
    stopOwnedProcesses: () => Effect.succeed(oldOwner),
    readCandidateReadiness: () =>
      options.candidateReady === false
        ? Effect.fail(new LifecycleError("UPGRADE_READINESS_FAILED", "candidate is not ready"))
        : Effect.succeed(readiness(candidateReleaseId)),
    authorizeActivation: () => {
      events.push("daemon:activation-authorized");
      return Effect.succeed(newOwner);
    },
    inspectRollbackSafety: () =>
      Effect.succeed({
        safe: options.rollbackSafe ?? true,
        sourceReleaseId,
        dataVersion: "2".repeat(64),
        executionStopped: true,
        detail: options.rollbackSafe === false ? "source cannot read current data" : "safe",
      }),
    readRollbackReadiness: () =>
      Effect.suspend(() => {
        rollbackReadinessCalls += 1;
        return rollbackReadinessCalls < (options.rollbackReadyAfter ?? 1)
          ? Effect.fail(
              new LifecycleError("UPGRADE_ROLLBACK_NOT_READY", "source release is not ready"),
            )
          : Effect.succeed(readiness(sourceReleaseId));
      }),
    authorizeRollback: () => {
      events.push("daemon:rollback-authorized");
      return Effect.succeed(newOwner);
    },
  };
  return {
    events,
    controller: new UpgradeActivationController({
      journal: options.journal ?? new RecordingJournal(),
      control,
      nativeService: native,
      releases,
      serviceDefinition: "fixture",
      pollIntervalMillis: 1,
      readinessMillis: 5,
    }),
    selected: () => selectedRelease,
  };
};

describe("managed upgrade activation", () => {
  it("activates only after restricted candidate readiness and durable authorization", async () => {
    const test = fixture();

    const status = await Effect.runPromise(test.controller.request(request));

    expect(status.outcome).toBe("activated");
    expect(test.selected()).toBe(candidateReleaseId);
    expect(status.operation.readiness).toMatchObject({
      integrity: "ok",
      transports: "ready",
      workflowExecutions: 0,
    });
    expect(test.events.indexOf("release:kojo-candidate")).toBeLessThan(
      test.events.indexOf("daemon:activation-authorized"),
    );
  });

  it("releases the old holds and refuses activation when final preflight changes", async () => {
    const test = fixture({ finalPreflight: "refused" });

    const status = await Effect.runPromise(test.controller.request(request));

    expect(status.outcome).toBe("upgrade-refused");
    expect(test.selected()).toBe(sourceReleaseId);
    expect(test.events).toContain("daemon:holds-released");
    expect(test.events).not.toContain("native:stop:kojo-source");
  });

  it("reconciles a lost refusal-release reply to Upgrade refused", async () => {
    const journal = new RecordingJournal();
    const test = fixture({
      journal,
      finalPreflight: "refused",
      releaseReplyLostOnce: true,
    });

    await expect(Effect.runPromise(test.controller.request(request))).rejects.toThrow(
      /refusal release reply was lost/,
    );
    expect(journal.read(request.operationId)?.stage).toBe("mutations-held");

    const resumed = await Effect.runPromise(test.controller.resume(request.operationId));

    expect(resumed.outcome).toBe("upgrade-refused");
    expect(test.events.filter((event) => event === "daemon:holds-released")).toHaveLength(2);
  });

  it("uses one exact-source rollback before activation", async () => {
    const test = fixture({ candidateReady: false });

    const status = await Effect.runPromise(test.controller.request(request));

    expect(status.outcome, status.operation.detail).toBe("rolled-back");
    expect(status.operation.rollbackAttempted).toBe(true);
    expect(test.selected()).toBe(sourceReleaseId);
    expect(test.events.filter((event) => event === "release:kojo-source")).toHaveLength(1);
  });

  it("stops every executing Run before forced final preflight", async () => {
    const journal = new RecordingJournal();
    const prepared = journal.begin(request);
    journal.advance({
      operationId: prepared.operationId,
      expectedRevision: prepared.stageRevision,
      stage: "draining",
      updatedAt: "2026-09-01T10:00:01.000Z",
      changes: {
        drain: {
          held: true,
          executingRunIds: ["run-one"],
          observedAt: "2026-09-01T10:00:01.000Z",
        },
      },
    });
    const test = fixture({ journal });

    const status = await Effect.runPromise(
      test.controller.force({
        formatVersion: 1,
        authorizationId: "force-one",
        pendingOperationId: request.operationId,
        requestHash: "e".repeat(64),
        authorizedAt: "2026-09-01T10:00:02.000Z",
      }),
    );

    expect(status.outcome).toBe("activated");
    expect(test.events).toContain("daemon:force-drain:force-one");
    expect(test.events.indexOf("daemon:force-drain:force-one")).toBeLessThan(
      test.events.indexOf("daemon:mutations-held"),
    );
  });

  it("requires repair when current evidence cannot prove rollback safe", async () => {
    const test = fixture({ candidateReady: false, rollbackSafe: false });

    const status = await Effect.runPromise(test.controller.request(request));

    expect(status.outcome).toBe("repair-required");
    expect(test.selected()).toBe(candidateReleaseId);
    expect(status.operation.detail).toContain("cannot be used safely");
  });

  it("records Repair required from rollback-selected when source readiness fails", async () => {
    const test = fixture({ candidateReady: false, rollbackReadyAfter: 100 });

    const status = await Effect.runPromise(test.controller.request(request));

    expect(status.outcome).toBe("repair-required");
    expect(status.operation.stage).toBe("repair-required");
    expect(status.operation.rollbackAttempted).toBe(true);
    expect(test.selected()).toBe(sourceReleaseId);
  });

  it("waits through delayed source readiness during the one rollback", async () => {
    const test = fixture({ candidateReady: false, rollbackReadyAfter: 2 });

    const status = await Effect.runPromise(test.controller.request(request));

    expect(status.outcome, status.operation.detail).toBe("rolled-back");
    expect(status.operation.readiness?.candidateReleaseId).toBe(sourceReleaseId);
  });

  it("resumes every durable handoff and activation boundary with the original operation", async () => {
    const recording = new RecordingJournal();
    const completed = fixture({ journal: recording });
    await Effect.runPromise(completed.controller.request(request));
    const resumable = recording.snapshots.filter(
      (snapshot) => snapshot.outcome === undefined && snapshot.stage !== "prepared",
    );
    const expectedStages: ReadonlyArray<LifecycleStage> = [
      "draining",
      "drained",
      "mutations-held",
      "final-preflight-accepted",
      "handoff-prepared",
      "controller-ready",
      "controller-accepted",
      "backup-verified",
      "cleanup-started",
      "owned-processes-stopped",
      "process-stopped",
      "candidate-selected",
      "candidate-ready",
      "activation-authorized",
    ];
    expect(new Set(resumable.map((snapshot) => snapshot.stage))).toEqual(new Set(expectedStages));

    for (const snapshot of resumable) {
      const candidateSelected = [
        "candidate-selected",
        "candidate-ready",
        "activation-authorized",
      ].includes(snapshot.stage);
      const sourceStopped = ["process-stopped", "candidate-selected"].includes(snapshot.stage);
      const replacement = fixture({
        journal: new RetainedOperationJournal(snapshot),
        selectedRelease: candidateSelected ? candidateReleaseId : sourceReleaseId,
        process: sourceStopped ? "stopped" : "running",
      });

      const resumed = await Effect.runPromise(replacement.controller.resume(request.operationId));

      expect(resumed.operation.operationId).toBe(request.operationId);
      expect(resumed.outcome).toBe("activated");
    }
  });
});
