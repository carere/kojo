import { Duration, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { InMemoryLifecycleJournalRepository } from "../../../../../src/contexts/daemon/adapters/InMemoryLifecycleJournalRepository.ts";
import { LifecycleError } from "../../../../../src/contexts/daemon/models/LifecycleError.ts";
import type { LifecycleDrainProgress } from "../../../../../src/contexts/daemon/models/LifecycleOperation.ts";
import type { DaemonLifecycleControl } from "../../../../../src/contexts/daemon/ports/DaemonLifecycleControl.ts";
import type {
  NativeService,
  NativeServiceObservation,
} from "../../../../../src/contexts/daemon/ports/NativeService.ts";
import {
  DAEMON_CLEANUP_MILLIS,
  LifecycleController,
} from "../../../../../src/contexts/daemon/services/LifecycleController.ts";

const owner = (daemonInstanceId: string) => ({
  daemonInstanceId,
  runnerInstanceIds: ["runner-1"],
  recordedAt: "2026-09-01T10:00:00.000Z",
});

const request = (
  kind: "stop" | "restart" | "enable" | "disable" | "disable-now" | "remove" = "stop",
) => ({
  operationId: `operation-${kind}`,
  dataIdentity: "data-1",
  originalRequestHash: "a".repeat(64),
  kind,
  sourceReleaseId: "kojo-0.1.0-bun-1.4.0",
  startedAt: "2026-09-01T10:00:00.000Z",
});

const fixture = (progresses: Array<LifecycleDrainProgress>) => {
  const events: Array<string> = [];
  const journal = new InMemoryLifecycleJournalRepository();
  let observation: NativeServiceObservation = {
    automaticStart: "enabled",
    manager: "loaded",
    process: "running",
    loginLifetime: "test",
    logoutPersistence: "disabled",
  };
  const native: NativeService = {
    serviceDocument: () => "test",
    assertSupported: () => {},
    inspect: () => observation,
    installAndStart: () => {},
    start: () => {
      events.push("native:start");
      observation = { ...observation, process: "running" };
    },
    stop: () => {
      events.push("native:stop");
      observation = { ...observation, process: "stopped" };
    },
    enable: () => events.push("native:enable"),
    disable: () => events.push("native:disable"),
    removeRegistration: () => events.push("native:remove-registration"),
    keepRunningAfterLogout: () => {},
  };
  let progressIndex = 0;
  const control: DaemonLifecycleControl = {
    inspectPreflight: () => Effect.succeed(owner("daemon-old")),
    beginDrain: () => {
      events.push("daemon:hold");
      return Effect.succeed(progresses[0] as LifecycleDrainProgress);
    },
    readDrain: () =>
      Effect.sync(() => {
        const progress = progresses[Math.min(progressIndex, progresses.length - 1)];
        progressIndex += 1;
        return progress as LifecycleDrainProgress;
      }),
    sealPurgeSafety: (operationId) => {
      events.push("daemon:seal-purge-safety");
      return Effect.succeed({
        formatVersion: 1,
        evidenceId: "evidence-1",
        operationId,
        dataIdentity: "data-1",
        stateVersion: "state-1",
        correctnessFingerprint: "d".repeat(64),
        correctness: {
          projects: 0,
          runs: 0,
          clientRequests: 0,
          askings: 0,
          artifacts: 0,
          recordsByTable: {},
        },
        resourceRisks: [],
        ownedScope: [],
        owner: owner("daemon-old"),
        ownerProcessState: { daemon: "sole-owner-finalizing", runners: "stopped" },
        issuedAt: "2026-09-01T10:00:00.000Z",
        expiresAt: "2026-09-01T10:10:00.000Z",
        seal: "signed",
      });
    },
    prepareHandoff: () => {
      events.push("daemon:handoff");
      return Effect.succeed({ digest: "b".repeat(64), owner: owner("daemon-old") });
    },
    confirmControllerReady: () => {
      events.push("daemon:accept-controller");
      return Effect.void;
    },
    stopOwnedProcesses: (_operationId, cleanupMillis, replacementExpected, forceId) => {
      events.push(`daemon:cleanup:${cleanupMillis}:${replacementExpected}:${forceId ?? "planned"}`);
      return Effect.succeed(owner("daemon-old"));
    },
    confirmReplacementReady: () => {
      events.push("daemon:replacement-ready");
      return Effect.succeed(owner("daemon-new"));
    },
  };
  return {
    events,
    journal,
    control,
    native,
    controller: new LifecycleController({
      journal,
      control,
      nativeService: native,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
      removeManagedInstallation: () => events.push("managed:remove-installation"),
    }),
  };
};

describe("the Daemon lifecycle controller", () => {
  it("holds every Project without a force deadline, then performs two-sided handoff before cleanup", async () => {
    const executing = {
      held: true as const,
      executingRunIds: ["run-1"],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:05:00.000Z",
    };
    const test = fixture([executing, executing, drained]);

    const status = await Effect.runPromise(test.controller.request(request()));

    expect(status.outcome).toBe("succeeded");
    expect(test.events).toEqual([
      "daemon:hold",
      "daemon:handoff",
      "daemon:accept-controller",
      `daemon:cleanup:${DAEMON_CLEANUP_MILLIS}:false:planned`,
      "native:stop",
    ]);
    expect(status.operation.drain?.executingRunIds).toEqual([]);
  });

  it("waits for native process exit and endpoint withdrawal before stop succeeds", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);
    let stopRequested = false;
    let postStopInspections = 0;
    let endpointInspections = 0;
    const delayedNative: NativeService = {
      ...test.native,
      stop: () => {
        stopRequested = true;
        test.events.push("native:stop");
      },
      inspect: () => {
        if (!stopRequested) return test.native.inspect();
        postStopInspections += 1;
        return {
          ...test.native.inspect(),
          process: postStopInspections >= 2 ? "stopped" : "running",
        };
      },
    };
    const controller = new LifecycleController({
      journal: test.journal,
      control: test.control,
      nativeService: delayedNative,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
      observedDaemonInstanceId: () => {
        endpointInspections += 1;
        return endpointInspections >= 4 ? undefined : "daemon-old";
      },
    });

    const status = await Effect.runPromise(controller.request(request()));

    expect(status.outcome).toBe("succeeded");
    expect(postStopInspections).toBeGreaterThanOrEqual(4);
    expect(endpointInspections).toBeGreaterThanOrEqual(4);
  });

  it("uses a separate durable force identity and keeps an interrupted Run out of cancellation", async () => {
    const executing = {
      held: true as const,
      executingRunIds: ["run-1"],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([executing]);
    let operation = test.journal.begin(request());
    operation = test.journal.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: "draining",
      updatedAt: "2026-09-01T10:00:01.000Z",
      changes: { drain: executing, recordedOwner: owner("daemon-old") },
    });

    const status = await Effect.runPromise(
      test.controller.force({
        formatVersion: 1,
        authorizationId: "force-1",
        pendingOperationId: operation.operationId,
        requestHash: "c".repeat(64),
        authorizedAt: "2026-09-01T10:00:02.000Z",
      }),
    );

    expect(status.operation.forceAuthorizationId).toBe("force-1");
    expect(test.events).toContain(`daemon:cleanup:${DAEMON_CLEANUP_MILLIS}:false:force-1`);
  });

  it("leaves a timed-out operation pending for a replacement controller to resume", async () => {
    const executing = {
      held: true,
      executingRunIds: ["run-1"],
      observedAt: "2026-09-01T10:00:01.000Z",
    } satisfies LifecycleDrainProgress;
    const progresses: Array<LifecycleDrainProgress> = [executing];
    const test = fixture(progresses);

    const timedOut = await Effect.runPromise(
      test.controller.request(request()).pipe(Effect.timeoutOption(Duration.millis(5))),
    );

    expect(Option.isNone(timedOut)).toBe(true);
    expect(test.journal.current()).toMatchObject({
      operationId: request().operationId,
      stage: "draining",
    });
    progresses.push({
      held: true,
      executingRunIds: [],
      observedAt: "2026-09-01T10:05:00.000Z",
    });
    const replacement = new LifecycleController({
      journal: test.journal,
      control: test.control,
      nativeService: test.native,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
    });

    const resumed = await Effect.runPromise(replacement.request(request()));

    expect(resumed.operation.operationId).toBe(request().operationId);
    expect(resumed.outcome).toBe("succeeded");
  });

  it("keeps restart pending until a replacement reports a different Daemon owner", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);

    const status = await Effect.runPromise(test.controller.request(request("restart")));

    expect(test.events).toContain("native:start");
    expect(test.events).toContain("daemon:replacement-ready");
    expect(status.recordedOwner?.daemonInstanceId).toBe("daemon-new");
  });

  it("resumes after native endpoint loss without repeating owned Runner cleanup", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);
    let operation = test.journal.begin(request());
    operation = test.journal.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: "owned-processes-stopped",
      updatedAt: "2026-09-01T10:00:02.000Z",
      changes: { recordedOwner: owner("daemon-old") },
    });
    test.native.stop();
    test.events.splice(0);
    const replacement = new LifecycleController({
      journal: test.journal,
      control: test.control,
      nativeService: test.native,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
    });

    const resumed = await Effect.runPromise(replacement.request(request()));

    expect(resumed.outcome).toBe("succeeded");
    expect(test.events).toEqual(["native:stop"]);
  });

  it("keeps cleanup pending when the Daemon finishes it but the reply is lost", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);
    let cleanupCalls = 0;
    const replayControl: DaemonLifecycleControl = {
      ...test.control,
      stopOwnedProcesses: () => {
        cleanupCalls += 1;
        return cleanupCalls === 1
          ? Effect.fail(
              new LifecycleError(
                "LIFECYCLE_CONTROL_UNAVAILABLE",
                "the cleanup reply was lost after commit",
              ),
            )
          : Effect.succeed(owner("daemon-old"));
      },
    };
    const controller = new LifecycleController({
      journal: test.journal,
      control: replayControl,
      nativeService: test.native,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
    });

    await expect(Effect.runPromise(controller.request(request()))).rejects.toThrow();
    expect(test.journal.current()?.stage).toBe("cleanup-started");
    expect(test.journal.current()?.outcome).toBeUndefined();

    const resumed = await Effect.runPromise(controller.resume(request().operationId));
    expect(resumed.outcome).toBe("succeeded");
    expect(cleanupCalls).toBe(2);
  });

  it("disables automatic start before it drains disable-now", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);

    await Effect.runPromise(test.controller.request(request("disable-now")));

    expect(test.events.indexOf("native:disable")).toBeLessThan(test.events.indexOf("daemon:hold"));
    expect(test.events).toContain("native:stop");
  });

  it("keeps enable and disable as separate automatic-start effects", async () => {
    const progress = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const enabled = fixture([progress]);
    const disabled = fixture([progress]);

    await Effect.runPromise(enabled.controller.request(request("enable")));
    await Effect.runPromise(disabled.controller.request(request("disable")));

    expect(enabled.events).toEqual(["native:enable"]);
    expect(disabled.events).toEqual(["native:disable"]);
  });

  it("seals final Daemon state, then removes registration and installation without purge", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);

    const status = await Effect.runPromise(test.controller.request(request("remove")));

    expect(status.outcome).toBe("succeeded");
    expect(status.operation.purgeSafetyEvidenceId).toBe("evidence-1");
    expect(test.events).toEqual([
      "daemon:hold",
      "daemon:handoff",
      "daemon:accept-controller",
      `daemon:cleanup:${DAEMON_CLEANUP_MILLIS}:false:planned`,
      "daemon:seal-purge-safety",
      "native:stop",
      "native:remove-registration",
      "managed:remove-installation",
    ]);
  });

  it("preserves a stopped installation until restricted recovery provides fresh safety", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);
    test.native.stop();
    let recovered = false;
    const controller = new LifecycleController({
      journal: test.journal,
      control: test.control,
      nativeService: test.native,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
      assertRemovalSafetyEvidence: () => {
        if (!recovered) {
          throw new LifecycleError(
            "PURGE_RESTRICTED_RECOVERY_REQUIRED",
            "restricted recovery is required",
          );
        }
        return "recovered-evidence";
      },
      removeManagedInstallation: () => test.events.push("managed:remove-installation"),
    });

    await expect(Effect.runPromise(controller.request(request("remove")))).rejects.toThrow(
      "restricted recovery is required",
    );
    expect(test.journal.current()?.stage).toBe("prepared");
    expect(test.events).not.toContain("native:remove-registration");
    expect(test.events).not.toContain("managed:remove-installation");

    recovered = true;
    const resumed = await Effect.runPromise(controller.resume(request("remove").operationId));
    expect(resumed.outcome).toBe("succeeded");
    expect(resumed.operation.purgeSafetyEvidenceId).toBe("recovered-evidence");
    expect(test.events).toContain("native:remove-registration");
    expect(test.events).toContain("managed:remove-installation");
  });

  it("resumes interrupted removal after native registration was removed", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);
    let failed = true;
    const controller = new LifecycleController({
      journal: test.journal,
      control: test.control,
      nativeService: test.native,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
      removeManagedInstallation: () => {
        if (failed) {
          failed = false;
          throw new Error("interrupted installation cleanup");
        }
        test.events.push("managed:remove-installation");
      },
    });

    await expect(Effect.runPromise(controller.request(request("remove")))).rejects.toThrow(
      "interrupted installation cleanup",
    );
    expect(test.journal.current()?.stage).toBe("service-unregistered");

    const resumed = await Effect.runPromise(controller.resume(request("remove").operationId));
    expect(resumed.outcome).toBe("succeeded");
    expect(test.events.filter((event) => event === "native:remove-registration")).toHaveLength(1);
  });

  it("preserves managed content when a manual start wins the stop-to-remove race", async () => {
    const drained = {
      held: true as const,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    };
    const test = fixture([drained]);
    const controller = new LifecycleController({
      journal: test.journal,
      control: test.control,
      nativeService: test.native,
      serviceDefinition: "/managed/service",
      pollIntervalMillis: 1,
      acquireRemovalGate: () => {
        test.native.start("/managed/service");
        return { release: () => undefined };
      },
      removeManagedInstallation: () => test.events.push("managed:remove-installation"),
    });

    await expect(Effect.runPromise(controller.request(request("remove")))).rejects.toThrow(
      "start won the stop-to-remove race",
    );

    expect(test.journal.current()?.stage).toBe("process-stopped");
    expect(test.events).not.toContain("native:remove-registration");
    expect(test.events).not.toContain("managed:remove-installation");
  });
});
