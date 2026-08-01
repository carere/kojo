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
