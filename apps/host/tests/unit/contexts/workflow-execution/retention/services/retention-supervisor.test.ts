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
import { HostDiagnosticLogger } from "../../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";
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
    show: () => Effect.succeed(snapshot),
    set: () => Effect.die("Retention mutations are not used by this test"),
    reset: () => Effect.die("Retention mutations are not used by this test"),
    cleanup: () =>
      Effect.sync(() => {
        cleanups += 1;
        return snapshot;
      }),
  };
  const logger = {
    cleanup: Effect.void,
    hostIdentity: Schema.decodeUnknownSync(HostIdentity)(
      "host:00000000-0000-4000-8000-000000000001",
    ),
    emit: (event: { readonly safeErrorCode?: string }) =>
      Effect.sync(() => {
        safeDiagnostics.push(event.safeErrorCode);
      }),
  };
  const supervisor = makeRetentionSupervisorLayer({ interval: "5 millis" }).pipe(
    Layer.provide([
      Layer.succeed(ProjectIndexRepository, index),
      Layer.succeed(RetentionRepository, retention),
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
