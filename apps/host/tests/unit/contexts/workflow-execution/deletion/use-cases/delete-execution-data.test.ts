import { expect, it } from "@effect/vitest";
import {
  ProjectIdentity,
  type ProjectSnapshot,
  type RequestKey,
  WorkflowRunId,
} from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import { ProjectIndexRepository } from "../../../../../../src/contexts/workflow-authoring/projects/repositories/project-index-repository";
import { ProjectLayout } from "../../../../../../src/contexts/workflow-authoring/projects/services/project-layout";
import { HostDiagnosticLogger } from "../../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";
import {
  countsFor,
  type DeletionTargetSnapshot,
  type DeletionWorkItem,
  deletionScopeDigest,
} from "../../../../../../src/contexts/workflow-execution/deletion/models/deletion-plan";
import {
  type DeletionItemState,
  DeletionRepository,
  type DeletionRepositoryShape,
} from "../../../../../../src/contexts/workflow-execution/deletion/repositories/deletion-repository";
import { DeletionClock } from "../../../../../../src/contexts/workflow-execution/deletion/services/deletion-clock";
import { DeletionHooks } from "../../../../../../src/contexts/workflow-execution/deletion/services/deletion-hooks";
import { DeletionPlanStoreLive } from "../../../../../../src/contexts/workflow-execution/deletion/services/deletion-plan-store";
import { deleteExecutionData } from "../../../../../../src/contexts/workflow-execution/deletion/use-cases/delete-execution-data";
import { ProjectRuntime } from "../../../../../../src/contexts/workflow-execution/projects/services/project-runtime";
import { WorkflowBackend } from "../../../../../../src/contexts/workflow-execution/projects/services/workflow-backend";
import {
  ProviderRuntime,
  ProviderRuntimeUnavailable,
} from "../../../../../../src/contexts/workflow-execution/sandboxes/services/provider-runtime";
import { WorkflowScheduleRepository } from "../../../../../../src/contexts/workflow-execution/schedules/repositories/workflow-schedule-repository";
import { ScheduleClock } from "../../../../../../src/contexts/workflow-execution/schedules/services/schedule-clock";

const project: ProjectSnapshot = {
  identity: Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-7000-8000-000000000001"),
  path: "/project",
};
const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000002");
const scope = { kind: "run", identity: project.identity, runId } as const;
const providerItem: DeletionWorkItem = {
  kind: "provider",
  key: "provider:run-1",
  runId,
};
const projectScope = { kind: "project", identity: project.identity } as const;
const diagnosticItem: DeletionWorkItem = {
  kind: "diagnostic",
  key: "diagnostic:project",
  projectIdentity: project.identity,
};
const target: DeletionTargetSnapshot = {
  version: 1,
  scope,
  scopeDigest: deletionScopeDigest(scope),
  items: [providerItem],
  counts: countsFor([providerItem]),
  preconditions: [],
};

it.effect("maps failed Provider cleanup to a warning while completing local deletion", () => {
  let itemState: DeletionItemState["state"] = "pending";
  let safeErrorCode: string | null = null;
  let requestKey: RequestKey | undefined;
  const repository: DeletionRepositoryShape = {
    inspect: () => Effect.succeed({ _tag: "accepted", target }),
    readRequest: () => Effect.succeed(undefined),
    begin: (_project, plan) =>
      Effect.sync(() => {
        requestKey = plan.planKey;
        return { _tag: "started" as const, deletionId: "deletion-1", resumed: false };
      }),
    readItems: () => Effect.succeed([{ item: providerItem, state: itemState, safeErrorCode }]),
    markItem: (_project, _deletionId, _item, state, code) =>
      Effect.sync(() => {
        itemState = state;
        safeErrorCode = code ?? null;
      }),
    reconcileOwnedFiles: () => Effect.succeed({ _tag: "unchanged" as const }),
    setPhase: () => Effect.void,
    complete: () =>
      Effect.succeed({
        version: 1 as const,
        requestKey: requestKey as RequestKey,
        completedAtMs: 2,
        counts: target.counts,
        warnings: [
          {
            code: "provider-failed" as const,
            message: "The Provider cleanup request failed after local deletion completed.",
            next: "Inspect the Provider and remove any remote session or workspace separately.",
          },
        ],
      }),
    hasCompletedProjectReset: () => Effect.succeed(false),
  };
  const runtime = {
    coordinateLifecycle: (_project: ProjectSnapshot, operation: Effect.Effect<unknown>) =>
      operation,
  } as ProjectRuntime["Service"];
  const backend = {
    ...ProviderRuntimeUnavailable,
    acquire: () => Effect.succeed(true),
    initialize: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
    readiness: () => Effect.succeed("ready" as const),
    quiesce: () => Effect.void,
    release: () => Effect.void,
    register: () => Effect.void,
    submit: () => Effect.die("not used"),
    observe: () => Effect.die("not used"),
  } as WorkflowBackend["Service"];
  const provider = {
    ...ProviderRuntimeUnavailable,
    cleanupRun: () => Effect.fail(new Error("remote cleanup failed")),
  } as unknown as ProviderRuntime["Service"];
  const layers = Layer.mergeAll(
    Layer.succeed(ProjectIndexRepository, {
      read: Effect.succeed({ layoutVersion: 1 as const, projects: [project], receipts: [] }),
      update: () => Effect.die("not used"),
    }),
    Layer.succeed(ProjectLayout, {} as ProjectLayout["Service"]),
    Layer.succeed(DeletionRepository, repository),
    Layer.succeed(DeletionClock, { now: () => 0 }),
    Layer.succeed(DeletionHooks, { afterPhase: () => Effect.void }),
    DeletionPlanStoreLive,
    Layer.succeed(ProjectRuntime, runtime),
    Layer.succeed(WorkflowBackend, backend),
    Layer.succeed(ProviderRuntime, provider),
    Layer.succeed(HostDiagnosticLogger, {
      cleanup: Effect.void,
      emit: () => Effect.void,
      removeProject: () => Effect.void,
    }),
    Layer.succeed(WorkflowScheduleRepository, {} as WorkflowScheduleRepository["Service"]),
    Layer.succeed(ScheduleClock, { now: () => 0 }),
  );

  return Effect.gen(function* () {
    const preview = yield* deleteExecutionData(scope);
    if (!preview.ok || preview.kind !== "preview") throw new Error("Expected a deletion preview");
    const completed = yield* deleteExecutionData(scope, preview.preview.planKey);
    expect(completed).toMatchObject({
      ok: true,
      kind: "completed",
      receipt: { warnings: [{ code: "provider-failed" }] },
    });
    expect(safeErrorCode).toBe("provider-failed");
  }).pipe(Effect.provide(layers));
});

it.effect("does not complete diagnostic cleanup before a recoverable Project release", () => {
  let diagnosticState: DeletionItemState["state"] = "pending";
  let releaseAttempts = 0;
  let diagnosticRemovals = 0;
  let completionCalls = 0;
  const projectTarget: DeletionTargetSnapshot = {
    version: 1,
    scope: projectScope,
    scopeDigest: deletionScopeDigest(projectScope),
    items: [diagnosticItem],
    counts: countsFor([diagnosticItem]),
    preconditions: [],
  };
  const repository: DeletionRepositoryShape = {
    inspect: () => Effect.succeed({ _tag: "accepted", target: projectTarget }),
    readRequest: () => Effect.succeed(undefined),
    begin: () =>
      Effect.succeed({ _tag: "started" as const, deletionId: "deletion-1", resumed: false }),
    readItems: () =>
      Effect.succeed([{ item: diagnosticItem, state: diagnosticState, safeErrorCode: null }]),
    markItem: (_project, _deletionId, item, state) =>
      Effect.sync(() => {
        if (item.kind === "diagnostic") diagnosticState = state;
      }),
    reconcileOwnedFiles: () => Effect.succeed({ _tag: "unchanged" as const }),
    setPhase: () => Effect.void,
    complete: () =>
      Effect.sync(() => {
        completionCalls += 1;
        return {
          version: 1 as const,
          requestKey: "10000000-0000-4000-8000-000000000010" as RequestKey,
          completedAtMs: 2,
          counts: projectTarget.counts,
          warnings: [],
        };
      }),
    hasCompletedProjectReset: () => Effect.succeed(false),
  };
  const runtime = {
    coordinateLifecycle: (_project: ProjectSnapshot, operation: Effect.Effect<unknown>) =>
      operation,
  } as ProjectRuntime["Service"];
  const backend = {
    ...ProviderRuntimeUnavailable,
    acquire: () => Effect.succeed(true),
    initialize: () => Effect.succeed(true),
    postflight: () => Effect.succeed(true),
    readiness: () => Effect.succeed("ready" as const),
    quiesce: () => Effect.void,
    release: () => {
      releaseAttempts += 1;
      return releaseAttempts === 1
        ? Effect.fail(new Error("release temporarily unavailable"))
        : Effect.void;
    },
    register: () => Effect.void,
    submit: () => Effect.die("not used"),
    observe: () => Effect.die("not used"),
  } as WorkflowBackend["Service"];
  const layers = Layer.mergeAll(
    Layer.succeed(ProjectIndexRepository, {
      read: Effect.succeed({ layoutVersion: 1 as const, projects: [project], receipts: [] }),
      update: () => Effect.die("not used"),
    }),
    Layer.succeed(ProjectLayout, {
      inspectIndexedPath: () => Effect.succeed({ status: "missing" as const }),
      validate: () =>
        Effect.succeed({
          ok: false as const,
          message: "reset test does not rediscover schedules",
          findingKey: "configuration.invalid" as const,
        }),
    }),
    Layer.succeed(DeletionRepository, repository),
    Layer.succeed(DeletionClock, { now: () => 0 }),
    Layer.succeed(DeletionHooks, { afterPhase: () => Effect.void }),
    DeletionPlanStoreLive,
    Layer.succeed(ProjectRuntime, runtime),
    Layer.succeed(WorkflowBackend, backend),
    Layer.succeed(ProviderRuntime, ProviderRuntimeUnavailable),
    Layer.succeed(HostDiagnosticLogger, {
      cleanup: Effect.void,
      emit: () => Effect.void,
      removeProject: () =>
        Effect.sync(() => {
          diagnosticRemovals += 1;
        }),
    }),
    Layer.succeed(WorkflowScheduleRepository, {} as WorkflowScheduleRepository["Service"]),
    Layer.succeed(ScheduleClock, { now: () => 0 }),
  );

  return Effect.gen(function* () {
    const preview = yield* deleteExecutionData(projectScope);
    if (!preview.ok || preview.kind !== "preview") throw new Error("Expected a deletion preview");
    const firstAttempt = yield* deleteExecutionData(projectScope, preview.preview.planKey);
    expect(firstAttempt).toMatchObject({ ok: false, error: { code: "deletion-needs-attention" } });
    expect(diagnosticState).toBe("pending");
    expect(diagnosticRemovals).toBe(0);
    expect(completionCalls).toBe(0);

    const secondAttempt = yield* deleteExecutionData(projectScope, preview.preview.planKey);
    expect(secondAttempt).toMatchObject({ ok: true, kind: "completed" });
    expect(diagnosticState).toBe("completed");
    expect(diagnosticRemovals).toBe(1);
    expect(completionCalls).toBe(1);
  }).pipe(Effect.provide(layers));
});
