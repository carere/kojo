import { expect, it } from "@effect/vitest";
import {
  ProjectIdentity,
  type ProjectRetentionSnapshot,
  type ProjectSnapshot,
} from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  ProjectIndexRepository,
  type ProjectIndexRepositoryShape,
} from "../../../../../../src/contexts/workflow-authoring/projects/repositories/project-index-repository";
import { HostIdentity } from "../../../../../../src/contexts/workflow-execution/control/models/host-identity";
import {
  HostDiagnosticLogger,
  type HostRequestDiagnosticEvent,
} from "../../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";
import {
  ProjectRuntime,
  type ProjectRuntimeShape,
} from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import {
  RetentionRepository,
  type RetentionRepositoryShape,
} from "../../../../../../src/contexts/workflow-execution/retention/repositories/retention-repository";
import { makeRetentionSupervisorLayer } from "../../../../../../src/contexts/workflow-execution/retention/services/retention-supervisor";

const project: ProjectSnapshot = {
  identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001"),
  path: "/project",
};
const snapshot = {
  warnings: [{ code: "protected-over-limit" }],
} as unknown as ProjectRetentionSnapshot;

it.effect("runs retention cleanup at activation and on the periodic interval", () => {
  let cleanups = 0;
  const safeDiagnostics: Array<string | undefined> = [];
  const index: ProjectIndexRepositoryShape = {
    read: Effect.succeed({ layoutVersion: 1, projects: [project], receipts: [] }),
    update: () => Effect.die("Project Index updates are not used by this test"),
  };
  const retention: RetentionRepositoryShape = {
    policy: () => Effect.die("Retention policy is not used by this test"),
    show: () => Effect.succeed(snapshot),
    set: () => Effect.die("Retention mutations are not used by this test"),
    reset: () => Effect.die("Retention mutations are not used by this test"),
    cleanup: () =>
      Effect.sync(() => {
        cleanups += 1;
        return snapshot;
      }),
  };
  const runtime = {
    coordinateRetention: (_project: ProjectSnapshot, operation: Effect.Effect<unknown>) =>
      operation,
  } as ProjectRuntimeShape;
  const logger = {
    cleanup: Effect.void,
    hostIdentity: Schema.decodeUnknownSync(HostIdentity)(
      "host:00000000-0000-4000-8000-000000000001",
    ),
    emit: (event: HostRequestDiagnosticEvent) =>
      Effect.sync(() => {
        safeDiagnostics.push(event.safeErrorCode);
      }),
  };
  const supervisor = makeRetentionSupervisorLayer({ interval: "5 millis" }).pipe(
    Layer.provide([
      Layer.succeed(ProjectIndexRepository, index),
      Layer.succeed(RetentionRepository, retention),
      Layer.succeed(ProjectRuntime, runtime),
      Layer.succeed(HostDiagnosticLogger, logger),
    ]),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 millis");
      yield* Effect.yieldNow;
      expect(cleanups).toBeGreaterThanOrEqual(2);
      expect(safeDiagnostics.length).toBe(cleanups);
      expect(safeDiagnostics.every((code) => code === "retention-protected-over-limit")).toBe(true);
    }).pipe(Effect.provide(supervisor)),
  );
});

const runCompletionCase = (
  snapshotOrFailure: ProjectRetentionSnapshot | "failure",
  expectedOutcome: "success" | "error",
  expectedSafeErrorCode: string | undefined,
) => {
  let cleanups = 0;
  const events: Array<HostRequestDiagnosticEvent> = [];
  const index: ProjectIndexRepositoryShape = {
    read: Effect.succeed({ layoutVersion: 1, projects: [project], receipts: [] }),
    update: () => Effect.die("Project Index updates are not used by this test"),
  };
  const retention: RetentionRepositoryShape = {
    policy: () => Effect.die("Retention policy is not used by this test"),
    show: () => Effect.die("Retention show is not used by this test"),
    set: () => Effect.die("Retention mutations are not used by this test"),
    reset: () => Effect.die("Retention mutations are not used by this test"),
    cleanup: () =>
      Effect.sync(() => {
        cleanups += 1;
        if (snapshotOrFailure === "failure") throw new Error("native unlink is unavailable");
        return snapshotOrFailure;
      }),
  };
  const runtime = {
    coordinateRetention: (_project: ProjectSnapshot, operation: Effect.Effect<unknown>) =>
      operation,
  } as ProjectRuntimeShape;
  const logger = {
    cleanup: Effect.void,
    hostIdentity: Schema.decodeUnknownSync(HostIdentity)(
      "host:00000000-0000-4000-8000-000000000001",
    ),
    emit: (event: HostRequestDiagnosticEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
  };
  const supervisor = makeRetentionSupervisorLayer({ interval: "5 millis" }).pipe(
    Layer.provide([
      Layer.succeed(ProjectIndexRepository, index),
      Layer.succeed(RetentionRepository, retention),
      Layer.succeed(ProjectRuntime, runtime),
      Layer.succeed(HostDiagnosticLogger, logger),
    ]),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 millis");
      yield* Effect.yieldNow;
      expect(cleanups).toBeGreaterThanOrEqual(2);
      expect(events.length).toBe(cleanups);
      expect(events.every((event) => event.eventKind === "retention.cleanup.completed")).toBe(true);
      expect(events.every((event) => event.outcome === expectedOutcome)).toBe(true);
      expect(events.every((event) => event.safeErrorCode === expectedSafeErrorCode)).toBe(true);
      expect(events.every((event) => event.durationMs >= 0)).toBe(true);
    }).pipe(Effect.provide(supervisor)),
  );
};

it.effect("emits exactly one successful completion Diagnostic Event per retention pass", () =>
  runCompletionCase({ warnings: [] } as unknown as ProjectRetentionSnapshot, "success", undefined),
);

it.effect("emits exactly one warning completion Diagnostic Event per retention pass", () =>
  runCompletionCase(snapshot, "error", "retention-protected-over-limit"),
);

it.effect("emits exactly one failure completion Diagnostic Event without leaking the error", () =>
  runCompletionCase("failure", "error", "retention-cleanup-failed"),
);
