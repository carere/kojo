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

const request = (kind: "stop" | "restart" | "enable" | "disable" | "disable-now" = "stop") => ({
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
});
