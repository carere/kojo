import { join } from "node:path";
import type {
  DeletionOperationError,
  DeletionPreview,
  DeletionReceipt,
  DeletionResult,
  DeletionScope,
  ProjectIdentity,
  ProjectSnapshot,
  RequestKey,
} from "@kojo/control";
import { Cause, Effect, Exit } from "effect";
import { ProjectIndexRepository } from "../../../workflow-authoring/projects/repositories/project-index-repository";
import { ProjectLayout } from "../../../workflow-authoring/projects/services/project-layout";
import { HostDiagnosticLogger } from "../../control/services/host-diagnostic-logger";
import { ProjectRuntime } from "../../projects/services/project-runtime";
import { WorkflowBackend } from "../../projects/services/workflow-backend";
import type { DisposableFileUnlinker } from "../../retention/repositories/disposable-file-unlinker";
import { NoFollowDisposableFileUnlinker } from "../../retention/repositories/no-follow-disposable-file";
import { ProviderRuntime } from "../../sandboxes/services/provider-runtime";
import { WorkflowScheduleRepository } from "../../schedules/repositories/workflow-schedule-repository";
import { ScheduleClock } from "../../schedules/services/schedule-clock";
import { nextWorkflowScheduleOccurrence } from "../../schedules/services/schedule-timing";
import {
  type DeletionPlanRecord,
  type DeletionWorkItem,
  deletionPlanMatches,
  isDeletionPlanExpired,
  makeDeletionPlan,
  newDeletionPlanKey,
  publicPlanItems,
} from "../models/deletion-plan";
import { type DeletionItemState, DeletionRepository } from "../repositories/deletion-repository";
import { DeletionClock } from "../services/deletion-clock";
import { DeletionHooks } from "../services/deletion-hooks";
import { DeletionPlanStore } from "../services/deletion-plan-store";

const missingProject = (identity: ProjectIdentity, requestKey: RequestKey): DeletionResult => ({
  ok: false,
  requestKey,
  error: {
    code: "project-not-found",
    message: "Kojo Project was not found in the Project Index.",
    next: "Register the Project or choose a listed Project Identity.",
    affectedResource: { kind: "project", identity },
    findingKeys: [],
  },
});

const errorFor = (
  code: DeletionOperationError["code"],
  message: string,
  next: string,
  scope: DeletionScope,
  requestKey: RequestKey,
): DeletionResult => ({
  ok: false,
  requestKey,
  error: {
    code,
    message,
    next,
    affectedResource:
      scope.kind === "run"
        ? { kind: "run", identity: scope.identity, runId: scope.runId }
        : scope.kind === "schedule"
          ? { kind: "schedule", identity: scope.identity, scheduleKey: scope.scheduleKey }
          : scope.kind === "occurrences"
            ? { kind: "occurrences", identity: scope.identity }
            : { kind: "project", identity: scope.identity },
    findingKeys: [],
  },
});

const preview = (plan: DeletionPlanRecord): DeletionPreview => ({
  version: 1,
  planKey: plan.planKey,
  scope: plan.target.scope,
  scopeDigest: plan.target.scopeDigest,
  observedAtMs: plan.observedAtMs,
  expiresAtMs: plan.expiresAtMs,
  items: publicPlanItems(plan.target.items),
  counts: plan.target.counts,
});

const targetFreeReceipt = (receipt: DeletionReceipt): DeletionResult => ({
  ok: true,
  kind: "completed",
  receipt,
});

type PendingWorkEntry<K extends DeletionWorkItem["kind"]> = DeletionItemState & {
  readonly item: Extract<DeletionWorkItem, { readonly kind: K }>;
};

const pendingWork = <K extends DeletionWorkItem["kind"]>(
  items: ReadonlyArray<DeletionItemState>,
  kind: K,
): ReadonlyArray<PendingWorkEntry<K>> =>
  items.filter(
    (entry): entry is PendingWorkEntry<K> =>
      entry.item.kind === kind && (entry.state === "pending" || entry.state === "needs-attention"),
  );

const safeFailureCode = (cause: unknown) => {
  const message = Cause.isCause(cause)
    ? Cause.pretty(cause)
    : cause instanceof Error
      ? cause.message
      : String(cause);
  if (message.toLowerCase().includes("unsupported")) {
    return "owned-file-cleanup-failed" as const;
  }
  return "deletion-needs-attention" as const;
};

const providerFailureCode = (cause: unknown) => {
  const message = Cause.isCause(cause)
    ? Cause.pretty(cause)
    : cause instanceof Error
      ? cause.message
      : String(cause);
  return message.toLowerCase().includes("unsupported")
    ? ("provider-unsupported" as const)
    : ("provider-failed" as const);
};

const ensureBackendForDeletion = (project: ProjectSnapshot, backend: WorkflowBackend["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const readiness = yield* backend.readiness(project);
      if (readiness === "ready") return true;
      // A Host restart can leave an in-memory backend scope that has lost
      // shard ownership while its durable runner rows are being reclaimed.
      // Rebuild that scope before retrying; the deletion intent already makes
      // the target unavailable, so this cannot reopen user work.
      if (readiness === "needs-attention") yield* backend.quiesce(project);
      if ((yield* backend.acquire(project)) && (yield* backend.initialize(project))) {
        return true;
      }
      yield* backend.quiesce(project);
      if (attempt === 0) yield* Effect.sleep("50 millis");
    }
    return false;
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));

const cleanupOwnedFile = async (
  project: ProjectSnapshot,
  item: Extract<DeletionWorkItem, { readonly kind: "owned-file" }>,
  unlinker: DisposableFileUnlinker,
) => {
  const result = await unlinker.unlinkRegularFile(project, join(project.path, item.relativePath));
  return result;
};

const rediscoverDisabledSchedules = (
  project: ProjectSnapshot,
  layout: ProjectLayout["Service"],
  schedules: WorkflowScheduleRepository["Service"],
  clock: ScheduleClock["Service"],
) =>
  Effect.gen(function* () {
    const validation = yield* layout.validate(project.path);
    if (!validation.ok || !validation.definitions.ok) return;
    yield* schedules.reconcile(
      project,
      validation.definitions.snapshot.workflows.flatMap((workflow) => workflow.schedules),
      clock.now(),
      nextWorkflowScheduleOccurrence,
    );
  }).pipe(Effect.catchCause(() => Effect.void));

const resumeDeletion = (
  project: ProjectSnapshot,
  plan: DeletionPlanRecord,
  deletionId: string,
  now: () => number,
  repository: DeletionRepository["Service"],
  backend: WorkflowBackend["Service"],
  provider: ProviderRuntime["Service"],
  unlinker: DisposableFileUnlinker,
  hooks: DeletionHooks["Service"],
  diagnosticLogger: HostDiagnosticLogger["Service"],
) =>
  Effect.gen(function* () {
    yield* repository.setPhase(project, deletionId, "clearing-engine");
    yield* hooks.afterPhase("clearing-engine");

    let items = yield* repository.readItems(project, deletionId);
    for (const entry of pendingWork(items, "engine")) {
      if (backend.clearExecution === undefined) {
        yield* repository.markItem(
          project,
          deletionId,
          entry.item,
          "needs-attention",
          "engine-cleanup-unsupported",
        );
        yield* repository.setPhase(
          project,
          deletionId,
          "needs-attention",
          "engine-cleanup-unsupported",
        );
        return yield* Effect.succeed(
          errorFor(
            "deletion-needs-attention",
            "The Workflow Engine did not expose the known execution cleanup seam.",
            "Repair the Project Runtime and retry the same confirmed deletion command.",
            plan.target.scope,
            plan.planKey,
          ),
        );
      }
      const result = yield* Effect.exit(
        backend.clearExecution(project, {
          workflowKey: entry.item.workflowKey,
          workflowRevision: entry.item.workflowRevision,
          runId: entry.item.runId,
          engineGeneration: entry.item.engineGeneration,
        }),
      );
      if (Exit.isFailure(result)) {
        yield* repository.markItem(
          project,
          deletionId,
          entry.item,
          "needs-attention",
          "engine-cleanup-failed",
        );
        yield* repository.setPhase(project, deletionId, "needs-attention", "engine-cleanup-failed");
        return yield* Effect.succeed(
          errorFor(
            "deletion-needs-attention",
            "Known Workflow Engine state could not be cleared safely.",
            "Repair the Project Runtime and retry the same confirmed deletion command.",
            plan.target.scope,
            plan.planKey,
          ),
        );
      }
      yield* repository.markItem(project, deletionId, entry.item, "completed");
    }

    if (backend.clearScheduleWakeup !== undefined) {
      const wakeupItems = [...pendingWork(items, "schedule"), ...pendingWork(items, "occurrence")];
      const clearedWakeups = new Set<string>();
      for (const entry of wakeupItems) {
        const hasWakeup =
          entry.item.scheduledAtMs !== undefined || entry.item.scheduleRevision !== undefined;
        if (!hasWakeup) {
          yield* repository.markItem(project, deletionId, entry.item, "completed");
          continue;
        }
        if (
          entry.item.scheduleKey === undefined ||
          entry.item.scheduledAtMs === undefined ||
          entry.item.scheduleRevision === undefined
        ) {
          yield* repository.markItem(
            project,
            deletionId,
            entry.item,
            "needs-attention",
            "engine-cleanup-failed",
          );
          yield* repository.setPhase(
            project,
            deletionId,
            "needs-attention",
            "engine-cleanup-failed",
          );
          return yield* Effect.succeed(
            errorFor(
              "deletion-needs-attention",
              "A known Schedule wake-up is missing its durable identity.",
              "Repair the Project Runtime and retry the same confirmed deletion command.",
              plan.target.scope,
              plan.planKey,
            ),
          );
        }
        const wakeupKey = `${entry.item.scheduleKey}:${entry.item.scheduledAtMs}`;
        const cleared = clearedWakeups.has(wakeupKey)
          ? Exit.succeed(undefined)
          : yield* Effect.exit(
              backend.clearScheduleWakeup(project, {
                scheduleKey: entry.item.scheduleKey,
                scheduledAtMs: entry.item.scheduledAtMs,
                scheduleRevision: entry.item.scheduleRevision,
              }),
            );
        if (Exit.isFailure(cleared)) {
          yield* repository.markItem(
            project,
            deletionId,
            entry.item,
            "needs-attention",
            "engine-cleanup-failed",
          );
          yield* repository.setPhase(
            project,
            deletionId,
            "needs-attention",
            "engine-cleanup-failed",
          );
          return yield* Effect.succeed(
            errorFor(
              "deletion-needs-attention",
              "A known Schedule wake-up could not be cleared safely.",
              "Repair the Project Runtime and retry the same confirmed deletion command.",
              plan.target.scope,
              plan.planKey,
            ),
          );
        }
        clearedWakeups.add(wakeupKey);
        yield* repository.markItem(project, deletionId, entry.item, "completed");
      }
    }

    // Engine mailboxes are cleared while the active backend still owns the
    // MessageStorage service. The durable intent already made the target
    // unavailable before this external step began.
    yield* backend.quiesce(project);
    yield* repository.setPhase(project, deletionId, "clearing-owned-content");
    yield* hooks.afterPhase("clearing-owned-content");
    let reconciliationComplete = false;
    for (let pass = 0; pass < 3 && !reconciliationComplete; pass += 1) {
      const reconciliation = yield* repository.reconcileOwnedFiles(project, deletionId, now());
      if (reconciliation._tag === "needs-attention") {
        yield* repository.setPhase(
          project,
          deletionId,
          "needs-attention",
          "owned-file-scope-drift",
        );
        return yield* Effect.succeed(
          errorFor(
            "owned-file-cleanup-failed",
            "The Kojo-owned execution file scope changed during deletion.",
            "Repair or remove the late Kojo-owned execution file, then retry the original confirmed Plan Key; a new Plan Key cannot supersede this pending deletion.",
            plan.target.scope,
            plan.planKey,
          ),
        );
      }
      items = yield* repository.readItems(project, deletionId);
      for (const entry of pendingWork(items, "owned-file")) {
        const result = yield* Effect.tryPromise({
          try: () => cleanupOwnedFile(project, entry.item, unlinker),
          catch: (cause) => cause,
        }).pipe(Effect.exit);
        if (Exit.isFailure(result)) {
          yield* repository.markItem(
            project,
            deletionId,
            entry.item,
            "needs-attention",
            safeFailureCode(result.cause),
          );
          yield* repository.setPhase(
            project,
            deletionId,
            "needs-attention",
            "owned-file-cleanup-failed",
          );
          return yield* Effect.succeed(
            errorFor(
              "owned-file-cleanup-failed",
              "A Kojo-owned execution file could not be removed safely.",
              "Leave the file in place, repair its ownership or symlink state, and retry the same confirmed deletion command.",
              plan.target.scope,
              plan.planKey,
            ),
          );
        }
        if (result.value === "unsafe") {
          yield* repository.markItem(
            project,
            deletionId,
            entry.item,
            "needs-attention",
            "owned-file-unsafe",
          );
          yield* repository.setPhase(project, deletionId, "needs-attention", "owned-file-unsafe");
          return yield* Effect.succeed(
            errorFor(
              "owned-file-cleanup-failed",
              "A Kojo-owned execution path changed to an unsafe file or symlink.",
              "Repair the path without following it, then retry the same confirmed deletion command.",
              plan.target.scope,
              plan.planKey,
            ),
          );
        }
        if (result.value === "missing") {
          yield* repository.markItem(
            project,
            deletionId,
            entry.item,
            "warning",
            "owned-file-missing",
          );
        } else {
          yield* repository.markItem(project, deletionId, entry.item, "completed");
        }
      }
      const settled = yield* repository.reconcileOwnedFiles(project, deletionId, now());
      if (settled._tag === "needs-attention") {
        yield* repository.setPhase(
          project,
          deletionId,
          "needs-attention",
          "owned-file-scope-drift",
        );
        return yield* Effect.succeed(
          errorFor(
            "owned-file-cleanup-failed",
            "The Kojo-owned execution file scope changed during deletion.",
            "Repair or remove the late Kojo-owned execution file, then retry the original confirmed Plan Key; a new Plan Key cannot supersede this pending deletion.",
            plan.target.scope,
            plan.planKey,
          ),
        );
      }
      reconciliationComplete = settled._tag === "unchanged";
    }
    if (!reconciliationComplete) {
      yield* repository.setPhase(project, deletionId, "needs-attention", "owned-file-scope-drift");
      return yield* Effect.succeed(
        errorFor(
          "owned-file-cleanup-failed",
          "Kojo-owned execution files kept changing during deletion.",
          "Repair the Project Runtime and retry the same confirmed deletion command.",
          plan.target.scope,
          plan.planKey,
        ),
      );
    }
    for (const entry of pendingWork(yield* repository.readItems(project, deletionId), "provider")) {
      if (entry.item.providerCleanup === "unsupported") {
        yield* repository.markItem(
          project,
          deletionId,
          entry.item,
          "warning",
          "provider-unsupported",
        );
        continue;
      }
      if (provider.cleanupRun === undefined) {
        yield* repository.markItem(
          project,
          deletionId,
          entry.item,
          "warning",
          "provider-unsupported",
        );
        continue;
      }
      const result = yield* Effect.exit(
        provider.cleanupRun(
          project,
          entry.item.runId,
          entry.item.providerCleanup === undefined
            ? undefined
            : { capability: entry.item.providerCleanup },
        ),
      );
      if (Exit.isFailure(result)) {
        yield* repository.markItem(
          project,
          deletionId,
          entry.item,
          "warning",
          providerFailureCode(result.cause),
        );
      } else {
        yield* repository.markItem(project, deletionId, entry.item, "completed");
      }
    }

    yield* repository.setPhase(project, deletionId, "deleting-records");
    yield* hooks.afterPhase("deleting-records");
    if (plan.target.scope.kind === "project") {
      // Stop the Effect runner and release Project ownership before the reset
      // transaction clears its private durable tables. Otherwise a live
      // runner can recreate a cluster row after the deletion transaction.
      const released = yield* Effect.exit(backend.release(project));
      if (Exit.isFailure(released)) {
        yield* repository.setPhase(
          project,
          deletionId,
          "needs-attention",
          "runtime-release-failed",
        );
        return yield* Effect.succeed(
          errorFor(
            "deletion-needs-attention",
            "The Project Runtime could not be released before the Project reset.",
            "Repair the Project Runtime and retry the same confirmed deletion command.",
            plan.target.scope,
            plan.planKey,
          ),
        );
      }
    }
    // Release is a recoverable boundary: Provider cleanup can fail after the
    // engine has quiesced. Keep the diagnostic item pending until that
    // boundary succeeds so a retry removes diagnostics exactly once before a
    // target-free receipt is committed.
    for (const entry of pendingWork(
      yield* repository.readItems(project, deletionId),
      "diagnostic",
    )) {
      const removed = yield* Effect.exit(
        diagnosticLogger.removeProject(entry.item.projectIdentity),
      );
      if (Exit.isFailure(removed)) {
        yield* repository.markItem(
          project,
          deletionId,
          entry.item,
          "needs-attention",
          "diagnostic-cleanup-failed",
        );
        yield* repository.setPhase(
          project,
          deletionId,
          "needs-attention",
          "diagnostic-cleanup-failed",
        );
        return yield* Effect.succeed(
          errorFor(
            "deletion-needs-attention",
            "Project diagnostics could not be removed safely.",
            "Repair the diagnostic store and retry the same confirmed deletion command.",
            plan.target.scope,
            plan.planKey,
          ),
        );
      }
      yield* repository.markItem(project, deletionId, entry.item, "completed");
    }
    const receipt = yield* repository.complete(project, deletionId, now());
    return yield* Effect.succeed(targetFreeReceipt(receipt));
  });

export const deleteExecutionData = (
  scope: DeletionScope,
  suppliedPlanKey?: RequestKey,
): Effect.Effect<
  DeletionResult,
  never,
  | ProjectIndexRepository
  | DeletionRepository
  | DeletionPlanStore
  | DeletionClock
  | DeletionHooks
  | ProjectRuntime
  | ProjectLayout
  | WorkflowScheduleRepository
  | ScheduleClock
  | WorkflowBackend
  | ProviderRuntime
  | HostDiagnosticLogger
> =>
  Effect.gen(function* () {
    const planKey = suppliedPlanKey ?? newDeletionPlanKey();
    const indexed = yield* (yield* ProjectIndexRepository).read;
    const project = indexed.projects.find((candidate) => candidate.identity === scope.identity);
    if (project === undefined) return missingProject(scope.identity, planKey);

    const repository = yield* DeletionRepository;
    const clock = yield* DeletionClock;
    const hooks = yield* DeletionHooks;
    const plans = yield* DeletionPlanStore;
    const now = clock.now();

    if (suppliedPlanKey === undefined) {
      const inspected = yield* repository.inspect(project, scope);
      if (inspected._tag === "rejected")
        return { ok: false, requestKey: planKey, error: inspected.error };
      const plan = makeDeletionPlan(inspected.target, now, planKey);
      yield* plans.write(plan);
      return { ok: true, kind: "preview", preview: preview(plan) };
    }

    const persisted = yield* repository.readRequest(project, suppliedPlanKey, now);
    if (persisted?._tag === "completed") return targetFreeReceipt(persisted.receipt);

    let plan = yield* plans.read(suppliedPlanKey);
    if (plan === undefined && persisted?._tag === "pending") {
      plan = {
        planKey: suppliedPlanKey,
        target: persisted.target,
        observedAtMs: now,
        expiresAtMs: now + 15 * 60 * 1_000,
      };
    }
    if (plan === undefined) {
      return errorFor(
        "plan-expired",
        "This Plan Key is no longer available.",
        "Create a new deletion preview and confirm it within 15 minutes.",
        scope,
        suppliedPlanKey,
      );
    }
    if (persisted?._tag !== "pending" && isDeletionPlanExpired(plan, now)) {
      return errorFor(
        "plan-expired",
        "This deletion Plan Key expired after 15 minutes.",
        "Create a new deletion preview and confirm it within 15 minutes.",
        scope,
        suppliedPlanKey,
      );
    }
    if (
      !deletionPlanMatches(plan, scope, persisted?._tag === "pending" ? plan.observedAtMs : now)
    ) {
      return errorFor(
        "plan-drifted",
        "The confirmed command no longer matches the versioned deletion preview.",
        "Create a new deletion preview using the current complete scope.",
        scope,
        suppliedPlanKey,
      );
    }

    const runtime = yield* ProjectRuntime;
    const layout = yield* ProjectLayout;
    const schedules = yield* WorkflowScheduleRepository;
    const scheduleClock = yield* ScheduleClock;
    const backend = yield* WorkflowBackend;
    const provider = yield* ProviderRuntime;
    const diagnosticLogger = yield* HostDiagnosticLogger;
    const coordinateDeletion = runtime.coordinateDeletion ?? runtime.coordinateLifecycle;
    const result = yield* coordinateDeletion(
      project,
      Effect.gen(function* () {
        const started = yield* repository.begin(project, plan as DeletionPlanRecord, clock.now());
        if (started._tag === "completed") return targetFreeReceipt(started.receipt);
        if (started._tag === "conflict") {
          return errorFor(
            "plan-drifted",
            "A checked deletion scope or precondition changed before confirmation.",
            "Create a new deletion preview using the current complete scope.",
            scope,
            suppliedPlanKey,
          );
        }
        if (started._tag === "in-progress") {
          return errorFor(
            "deletion-in-progress",
            "Another deletion is already making this Project unavailable.",
            "Retry the original pending confirmed Plan Key after the Host resumes the pending deletion; do not retry this superseding Plan Key.",
            scope,
            suppliedPlanKey,
          );
        }
        yield* hooks.afterPhase("quiescing");
        if (!(yield* ensureBackendForDeletion(project, backend))) {
          yield* repository.setPhase(
            project,
            started.deletionId,
            "needs-attention",
            "engine-owner-unavailable",
          );
          return errorFor(
            "deletion-needs-attention",
            "The Project Runtime could not be reacquired for deletion recovery.",
            "Restart or repair the Project Runtime and retry the same confirmed deletion command.",
            scope,
            suppliedPlanKey,
          );
        }
        return yield* resumeDeletion(
          project,
          plan as DeletionPlanRecord,
          started.deletionId,
          clock.now,
          repository,
          backend,
          provider,
          NoFollowDisposableFileUnlinker,
          hooks,
          diagnosticLogger,
        );
      }),
    );
    if (result.ok && result.kind === "completed" && scope.kind === "project") {
      // Rebuild only the declared schedule rows. Reconciliation inserts them
      // disabled, preserving source and identity while keeping the reset
      // quiescent until an explicit enable operation.
      yield* rediscoverDisabledSchedules(project, layout, schedules, scheduleClock);
    }
    if (result.ok && result.kind === "completed") yield* plans.remove(suppliedPlanKey);
    return result;
  });
