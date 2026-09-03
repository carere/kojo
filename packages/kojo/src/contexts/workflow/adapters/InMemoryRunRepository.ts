import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { WorkflowMode } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { Effect, Layer } from "effect";
import type { DaemonRun, PhaseResult, RunAuthority } from "../models/DaemonRun.ts";
import { RunStoreError } from "../models/RunStoreError.ts";
import { CONTINUATION_BURST, DEFAULT_DAEMON_EXECUTING_RUNS } from "../models/SchedulingDefaults.ts";
import { type Admission, type AdmitRunRequest, RunRepository } from "../ports/RunRepository.ts";
import { runIdOf } from "../services/runIdentity.ts";

interface MemoryState {
  readonly runs: Map<string, DaemonRun>;
  readonly tupleRunIds: Map<string, string>;
  readonly receipts: Map<string, { readonly canonical: string; readonly admission: Admission }>;
  readonly claims: Map<string, RunAuthority>;
  readonly generations: Map<string, number>;
  readonly slots: Map<string, RunAuthority>;
  readonly results: Map<string, PhaseResult>;
  readonly reservations: Map<string, string>;
  readonly cancellationRequests: Map<string, string>;
  readonly forcedStops: Map<
    string,
    {
      readonly canonical: string;
      readonly targetSetId: string;
      readonly targetRunIds: ReadonlyArray<string>;
    }
  >;
  readonly workflows: Map<
    string,
    {
      readonly mode: WorkflowMode;
      readonly revisionId: string;
      readonly activity: "inactive" | "active";
    }
  >;
  readonly activityReceipts: Map<string, string>;
  readonly operationReceipts: Map<
    string,
    { readonly canonical: string; readonly receipt: OperationReceipt }
  >;
  sequence: number;
  lastProjectId?: string;
  readonly continuationStreaks: Map<string, number>;
}

const emptyState = (): MemoryState => ({
  runs: new Map(),
  tupleRunIds: new Map(),
  receipts: new Map(),
  claims: new Map(),
  generations: new Map(),
  slots: new Map(),
  results: new Map(),
  reservations: new Map(),
  cancellationRequests: new Map(),
  forcedStops: new Map(),
  workflows: new Map(),
  activityReceipts: new Map(),
  operationReceipts: new Map(),
  continuationStreaks: new Map(),
  sequence: 0,
});

const cloneState = (state: MemoryState): MemoryState => ({
  runs: new Map(state.runs),
  tupleRunIds: new Map(state.tupleRunIds),
  receipts: new Map(state.receipts),
  claims: new Map(state.claims),
  generations: new Map(state.generations),
  slots: new Map(state.slots),
  results: new Map(state.results),
  reservations: new Map(state.reservations),
  cancellationRequests: new Map(state.cancellationRequests),
  forcedStops: new Map(state.forcedStops),
  workflows: new Map(state.workflows),
  activityReceipts: new Map(state.activityReceipts),
  operationReceipts: new Map(state.operationReceipts),
  continuationStreaks: new Map(state.continuationStreaks),
  sequence: state.sequence,
  ...(state.lastProjectId === undefined ? {} : { lastProjectId: state.lastProjectId }),
});

const restoreState = (state: MemoryState, snapshot: MemoryState): void => {
  const restoreMap = <K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void => {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  };
  restoreMap(state.runs, snapshot.runs);
  restoreMap(state.tupleRunIds, snapshot.tupleRunIds);
  restoreMap(state.receipts, snapshot.receipts);
  restoreMap(state.claims, snapshot.claims);
  restoreMap(state.generations, snapshot.generations);
  restoreMap(state.slots, snapshot.slots);
  restoreMap(state.results, snapshot.results);
  restoreMap(state.reservations, snapshot.reservations);
  restoreMap(state.cancellationRequests, snapshot.cancellationRequests);
  restoreMap(state.forcedStops, snapshot.forcedStops);
  restoreMap(state.workflows, snapshot.workflows);
  restoreMap(state.activityReceipts, snapshot.activityReceipts);
  restoreMap(state.operationReceipts, snapshot.operationReceipts);
  restoreMap(state.continuationStreaks, snapshot.continuationStreaks);
  state.sequence = snapshot.sequence;
  if (snapshot.lastProjectId === undefined) delete state.lastProjectId;
  else state.lastProjectId = snapshot.lastProjectId;
};

const workflowKey = (projectId: string, workflowName: string): string =>
  JSON.stringify([projectId, workflowName]);

const receiptKey = (dataIdentity: string, requestId: string): string =>
  JSON.stringify([dataIdentity, requestId]);

const tupleOf = (request: AdmitRunRequest): string =>
  JSON.stringify([request.projectId, request.workflowName, request.idempotencyKey]);

const resultKey = (runId: string, phasePath: string, attempt: number): string =>
  JSON.stringify([runId, phasePath, attempt]);

const stale = (): RunStoreError =>
  new RunStoreError({ code: "STALE_AUTHORITY", message: "the Runner Claim or slot is stale" });

const attempt = <A>(evaluate: () => A): Effect.Effect<A, RunStoreError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof RunStoreError
        ? cause
        : new RunStoreError({
            code: "STORE_FAILED",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });

const assertAuthority = (state: MemoryState, authority: RunAuthority): void => {
  const claim = state.claims.get(authority.runId);
  const slot = state.slots.get(authority.runId);
  if (
    claim === undefined ||
    slot === undefined ||
    claim.runnerInstanceId !== authority.runnerInstanceId ||
    slot.runnerInstanceId !== authority.runnerInstanceId ||
    claim.generation !== authority.generation ||
    slot.generation !== authority.generation ||
    claim.revisionId !== authority.revisionId
  ) {
    throw stale();
  }
};

const visible = (state: MemoryState, run: DaemonRun): DaemonRun => {
  if (run.state !== "queued") return run;
  const projectSlot = [...state.slots.values()].find(
    (slot) => state.runs.get(slot.runId)?.projectId === run.projectId,
  );
  const executing = projectSlot === undefined ? undefined : state.runs.get(projectSlot.runId);
  if (executing !== undefined && executing.packageGraphId !== run.packageGraphId) {
    return { ...run, queueReason: "package-switch" };
  }
  if (projectSlot !== undefined) return { ...run, queueReason: "project-capacity" };
  if (state.slots.size >= DEFAULT_DAEMON_EXECUTING_RUNS) {
    return { ...run, queueReason: "execution-capacity" };
  }
  return run;
};

const service = (state: MemoryState, beforeAtomicCommit: () => void): RunRepository["Service"] => {
  const admitSync = (request: AdmitRunRequest): Admission => {
    const key = receiptKey(request.dataIdentity, request.requestId);
    const prior = state.receipts.get(key);
    if (prior !== undefined) {
      if (prior.canonical !== request.canonicalRequest) {
        throw new RunStoreError({
          code: "REQUEST_CONFLICT",
          message: "the request ID already names different canonical content",
        });
      }
      return prior.admission;
    }
    const tuple = tupleOf(request);
    const runId = runIdOf(request.projectId, request.workflowName, request.idempotencyKey);
    const tupleRunId = state.tupleRunIds.get(tuple);
    const existing = state.runs.get(runId);
    if (tupleRunId !== undefined && tupleRunId !== runId) {
      throw new RunStoreError({
        code: "DEDUP_COLLISION",
        message: "the deduplication tuple is bound to a different Run",
      });
    }
    if (existing === undefined) state.sequence += 1;
    const run: DaemonRun =
      existing ??
      ({
        runId,
        projectId: request.projectId,
        workflowName: request.workflowName,
        idempotencyKey: request.idempotencyKey,
        payload: request.payload,
        revisionId: request.revisionId,
        packageGraphId: request.packageGraphId,
        state: "queued",
        queueKind: "new",
        queueReason: "runner-starting",
        admissionSequence: state.sequence,
        admittedAt: request.admittedAt,
      } satisfies DaemonRun);
    state.runs.set(runId, run);
    state.tupleRunIds.set(tuple, runId);
    const admission = { run, duplicate: existing !== undefined };
    state.receipts.set(key, { canonical: request.canonicalRequest, admission });
    return admission;
  };
  const admit: RunRepository["Service"]["admit"] = (request) => attempt(() => admitSync(request));
  return {
    admit,
    admitAndActivateWorkflow: (request) =>
      attempt(() => {
        const snapshot = cloneState(state);
        try {
          const key = workflowKey(request.projectId, request.workflowName);
          const workflow = state.workflows.get(key);
          if (
            workflow === undefined ||
            workflow.mode !== "no-trigger" ||
            request.reviewedMode !== workflow.mode ||
            request.reviewedRevisionId !== workflow.revisionId ||
            request.revisionId !== workflow.revisionId
          ) {
            throw new RunStoreError({
              code: "WORKFLOW_REVIEW_STALE",
              message: "the Workflow mode or Revision changed after Start was reviewed",
            });
          }
          const activityCanonical = JSON.stringify([
            request.projectId,
            request.workflowName,
            "start",
          ]);
          const requestReceiptKey = receiptKey(request.dataIdentity, request.requestId);
          const priorActivity = state.activityReceipts.get(requestReceiptKey);
          if (priorActivity !== undefined && priorActivity !== activityCanonical) {
            throw new RunStoreError({
              code: "REQUEST_CONFLICT",
              message: "the request ID already names different Workflow Activity content",
            });
          }
          const operationCanonical =
            request.mutation === undefined ? undefined : JSON.stringify(request.mutation);
          const priorOperation = state.operationReceipts.get(requestReceiptKey);
          if (
            priorOperation !== undefined &&
            (operationCanonical === undefined || priorOperation.canonical !== operationCanonical)
          ) {
            throw new RunStoreError({
              code: "REQUEST_CONFLICT",
              message: "the request ID already names different Operation content",
            });
          }
          const admission = admitSync(request);
          if (priorActivity !== undefined) return admission;
          state.workflows.set(key, { ...workflow, activity: "active" });
          state.activityReceipts.set(requestReceiptKey, activityCanonical);
          if (operationCanonical !== undefined) {
            state.operationReceipts.set(requestReceiptKey, {
              canonical: operationCanonical,
              receipt: priorOperation?.receipt ?? {
                receiptVersion: 1,
                requestId: request.requestId,
                dataIdentity: request.dataIdentity,
                operation: "startWorkflow",
                status: "committed",
                result: {
                  kind: "run",
                  runId: admission.run.runId,
                  duplicate: admission.duplicate,
                  revisionId: admission.run.revisionId,
                  state: admission.run.state,
                },
              },
            });
          }
          beforeAtomicCommit();
          return admission;
        } catch (cause) {
          restoreState(state, snapshot);
          throw cause;
        }
      }),
    claim: (runId, runnerInstanceId, claimedAt) =>
      attempt(() => {
        const run = state.runs.get(runId);
        if (run === undefined) {
          throw new RunStoreError({
            code: "RUN_NOT_FOUND",
            message: `Run ${runId} was not found`,
          });
        }
        if (
          run.state !== "queued" ||
          state.reservations.has(runId) ||
          state.slots.size >= DEFAULT_DAEMON_EXECUTING_RUNS
        ) {
          throw new RunStoreError({
            code: "RUN_NOT_ELIGIBLE",
            message: "the Run has no execution slot",
          });
        }
        if (
          [...state.slots.values()].some(
            (slot) => state.runs.get(slot.runId)?.projectId === run.projectId,
          )
        ) {
          throw new RunStoreError({
            code: "RUN_NOT_ELIGIBLE",
            message: "the Project execution slot is full",
          });
        }
        const generation = (state.generations.get(runId) ?? 0) + 1;
        state.generations.set(runId, generation);
        const authority = { runId, runnerInstanceId, generation, revisionId: run.revisionId };
        state.claims.set(runId, authority);
        state.slots.set(runId, authority);
        const { queueReason: _queueReason, ...runWithoutQueueReason } = run;
        state.runs.set(runId, {
          ...runWithoutQueueReason,
          state: "executing",
          startedAt: run.startedAt ?? claimedAt,
        });
        return authority;
      }),
    claimNext: (runnerInstanceId, claimedAt) =>
      attempt(() => {
        if (state.slots.size >= DEFAULT_DAEMON_EXECUTING_RUNS) return undefined;
        const occupied = new Set(
          [...state.slots.values()].flatMap((slot) => {
            const projectId = state.runs.get(slot.runId)?.projectId;
            return projectId === undefined ? [] : [projectId];
          }),
        );
        for (const runId of state.reservations.keys()) {
          const projectId = state.runs.get(runId)?.projectId;
          if (projectId !== undefined) occupied.add(projectId);
        }
        const eligible = [...state.runs.values()].filter(
          (run) =>
            run.state === "queued" &&
            !state.reservations.has(run.runId) &&
            !occupied.has(run.projectId),
        );
        const projects = [...new Set(eligible.map((run) => run.projectId))].sort();
        if (projects.length === 0) return undefined;
        const following = projects.find((projectId) => projectId > (state.lastProjectId ?? ""));
        const projectId = following ?? projects[0];
        if (projectId === undefined) return undefined;
        const projectRuns = eligible
          .filter((run) => run.projectId === projectId)
          .sort((left, right) => left.admissionSequence - right.admissionSequence);
        const continuations = projectRuns.filter((run) => run.queueKind === "continuation");
        const newRuns = projectRuns.filter((run) => run.queueKind !== "continuation");
        const streak = state.continuationStreaks.get(projectId) ?? 0;
        const selected =
          streak >= CONTINUATION_BURST && newRuns.length > 0
            ? newRuns[0]
            : (continuations[0] ?? newRuns[0]);
        if (selected === undefined) return undefined;
        const generation = (state.generations.get(selected.runId) ?? 0) + 1;
        state.generations.set(selected.runId, generation);
        const claimed = {
          runId: selected.runId,
          runnerInstanceId,
          generation,
          revisionId: selected.revisionId,
        };
        state.claims.set(selected.runId, claimed);
        state.slots.set(selected.runId, claimed);
        const { queueReason: _queueReason, ...runWithoutQueueReason } = selected;
        const run = {
          ...runWithoutQueueReason,
          state: "executing" as const,
          startedAt: selected.startedAt ?? claimedAt,
        };
        state.runs.set(selected.runId, run);
        state.lastProjectId = projectId;
        state.continuationStreaks.set(
          projectId,
          selected.queueKind === "continuation" ? streak + 1 : 0,
        );
        return { run, authority: claimed };
      }),
    reserveNext: (reservationId) =>
      attempt(() => {
        if (state.slots.size + state.reservations.size >= DEFAULT_DAEMON_EXECUTING_RUNS) {
          return undefined;
        }
        const occupied = new Set(
          [...state.slots.values()].flatMap((slot) => {
            const projectId = state.runs.get(slot.runId)?.projectId;
            return projectId === undefined ? [] : [projectId];
          }),
        );
        for (const runId of state.reservations.keys()) {
          const projectId = state.runs.get(runId)?.projectId;
          if (projectId !== undefined) occupied.add(projectId);
        }
        const eligible = [...state.runs.values()].filter(
          (run) => run.state === "queued" && !occupied.has(run.projectId),
        );
        const projects = [...new Set(eligible.map((run) => run.projectId))].sort();
        const projectId =
          projects.find((candidate) => candidate > (state.lastProjectId ?? "")) ?? projects[0];
        if (projectId === undefined) return undefined;
        const projectRuns = eligible
          .filter((run) => run.projectId === projectId)
          .sort((left, right) => left.admissionSequence - right.admissionSequence);
        const continuations = projectRuns.filter((run) => run.queueKind === "continuation");
        const newRuns = projectRuns.filter((run) => run.queueKind !== "continuation");
        const streak = state.continuationStreaks.get(projectId) ?? 0;
        const selected =
          streak >= CONTINUATION_BURST && newRuns.length > 0
            ? newRuns[0]
            : (continuations[0] ?? newRuns[0]);
        if (selected === undefined) return undefined;
        state.reservations.set(selected.runId, reservationId);
        state.lastProjectId = projectId;
        state.continuationStreaks.set(
          projectId,
          selected.queueKind === "continuation" ? streak + 1 : 0,
        );
        return { run: visible(state, selected), reservationId };
      }),
    claimReserved: (reservationId, runnerInstanceId, claimedAt) =>
      attempt(() => {
        const selected = [...state.reservations.entries()].find(
          ([, candidate]) => candidate === reservationId,
        );
        if (selected === undefined) {
          throw new RunStoreError({
            code: "RUN_NOT_ELIGIBLE",
            message: "the reservation is stale",
          });
        }
        const run = state.runs.get(selected[0]);
        if (run === undefined || run.state !== "queued") throw stale();
        const generation = (state.generations.get(run.runId) ?? 0) + 1;
        state.generations.set(run.runId, generation);
        const authority = {
          runId: run.runId,
          runnerInstanceId,
          generation,
          revisionId: run.revisionId,
        };
        state.claims.set(run.runId, authority);
        state.slots.set(run.runId, authority);
        state.reservations.delete(run.runId);
        const { queueReason: _queueReason, ...withoutQueue } = run;
        state.runs.set(run.runId, {
          ...withoutQueue,
          state: "executing",
          startedAt: run.startedAt ?? claimedAt,
        });
        return authority;
      }),
    holdReserved: (reservationId, fault) =>
      attempt(() => {
        const selected = [...state.reservations.entries()].find(
          ([, candidate]) => candidate === reservationId,
        );
        if (selected === undefined) throw stale();
        const run = state.runs.get(selected[0]);
        if (run === undefined) throw stale();
        state.reservations.delete(run.runId);
        state.runs.set(run.runId, {
          ...run,
          state: "held",
          queueReason: "pinned-content",
          executionFault: fault,
        });
      }),
    suspend: (authority) =>
      attempt(() => {
        assertAuthority(state, authority);
        const run = state.runs.get(authority.runId);
        if (run === undefined) throw stale();
        state.runs.set(authority.runId, { ...run, state: "suspended" });
        state.claims.delete(authority.runId);
        state.slots.delete(authority.runId);
      }),
    hold: (authority, fault) =>
      attempt(() => {
        assertAuthority(state, authority);
        const run = state.runs.get(authority.runId);
        if (run === undefined) throw stale();
        state.runs.set(authority.runId, {
          ...run,
          state: "held",
          queueReason: "pinned-content",
          executionFault: fault,
        });
        state.claims.delete(authority.runId);
        state.slots.delete(authority.runId);
      }),
    continueRun: (runId) =>
      attempt(() => {
        const run = state.runs.get(runId);
        if (run === undefined) {
          throw new RunStoreError({
            code: "RUN_NOT_FOUND",
            message: `Run ${runId} was not found`,
          });
        }
        if (run.state !== "suspended") {
          throw new RunStoreError({
            code: "RUN_NOT_ELIGIBLE",
            message: "only a suspended Run can continue",
          });
        }
        state.runs.set(runId, {
          ...run,
          state: "queued",
          queueKind: "continuation",
          queueReason: "runner-starting",
        });
      }),
    read: (runId) =>
      Effect.sync(() => {
        const run = state.runs.get(runId);
        return run === undefined ? undefined : visible(state, run);
      }),
    list: Effect.sync(() =>
      [...state.runs.values()]
        .sort((left, right) => right.admissionSequence - left.admissionSequence)
        .map((run) => visible(state, run)),
    ),
    readResult: (authority, phasePath, attemptNumber) =>
      attempt(() => {
        assertAuthority(state, authority);
        return state.results.get(resultKey(authority.runId, phasePath, attemptNumber))
          ?.encodedResult;
      }),
    completePhase: (authority, phase) =>
      attempt(() => {
        assertAuthority(state, authority);
        const key = resultKey(authority.runId, phase.phasePath, phase.attempt);
        if (!state.results.has(key)) state.results.set(key, phase);
      }),
    completeRun: (authority, runState, finishedAt) =>
      attempt(() => {
        assertAuthority(state, authority);
        const run = state.runs.get(authority.runId);
        if (run === undefined) throw stale();
        if (run.cancellation !== undefined) {
          throw new RunStoreError({
            code: "RUN_NOT_ELIGIBLE",
            message: "a Run with durable cancellation intent cannot complete",
          });
        }
        state.runs.set(authority.runId, { ...run, state: runState, finishedAt });
        state.claims.delete(authority.runId);
        state.slots.delete(authority.runId);
      }),
    requestCancellation: (runId, requestId, requestedAt) =>
      attempt(() => {
        const run = state.runs.get(runId);
        if (run === undefined) {
          throw new RunStoreError({
            code: "RUN_NOT_FOUND",
            message: `Run ${runId} was not found`,
          });
        }
        const priorRunId = state.cancellationRequests.get(requestId);
        if (priorRunId !== undefined && priorRunId !== runId) {
          throw new RunStoreError({
            code: "REQUEST_CONFLICT",
            message: "the cancellation request ID already names another Run",
          });
        }
        state.cancellationRequests.set(requestId, runId);
        const alreadyRequested = run.cancellation !== undefined;
        if (run.state === "succeeded" || run.state === "failed") {
          throw new RunStoreError({
            code: "RUN_NOT_ELIGIBLE",
            message: "a completed Run cannot be cancelled",
          });
        }
        if (run.state === "cancelled") {
          return { run, alreadyRequested: true, requiresExecutionStop: false };
        }
        const requiresExecutionStop = run.state === "executing";
        const next: DaemonRun = {
          ...run,
          ...(!requiresExecutionStop
            ? { state: "cancelled" as const, finishedAt: requestedAt }
            : {}),
          cancellation: {
            state: requiresExecutionStop ? "requested" : "confirmed",
            source: "run",
            requestedAt: run.cancellation?.requestedAt ?? requestedAt,
            ...(!requiresExecutionStop ? { confirmedAt: requestedAt } : {}),
          },
          cleanup: { state: requiresExecutionStop ? "pending" : "not-required" },
        };
        state.runs.set(runId, next);
        if (!requiresExecutionStop) {
          state.reservations.delete(runId);
          state.claims.delete(runId);
          state.slots.delete(runId);
        }
        return { run: next, alreadyRequested, requiresExecutionStop };
      }),
    forceStopWorkflow: (request) =>
      attempt(() => {
        const receiptKey = JSON.stringify([request.dataIdentity, request.requestId]);
        const prior = state.forcedStops.get(receiptKey);
        if (prior !== undefined) {
          if (prior.canonical !== request.canonicalRequest) {
            throw new RunStoreError({
              code: "REQUEST_CONFLICT",
              message: "the forced Stop request ID already names different content",
            });
          }
          return { ...prior, alreadyAccepted: true };
        }
        const targetSetId = crypto.randomUUID();
        const targets = [...state.runs.values()].filter(
          (run) =>
            run.projectId === request.projectId &&
            run.workflowName === request.workflowName &&
            run.state !== "succeeded" &&
            run.state !== "failed" &&
            run.state !== "cancelled",
        );
        const targetRunIds = targets.map((run) => run.runId);
        for (const run of targets) {
          const executing = run.state === "executing";
          state.runs.set(run.runId, {
            ...run,
            ...(executing ? {} : { state: "cancelled" as const, finishedAt: request.acceptedAt }),
            cancellation: {
              state: executing ? "requested" : "confirmed",
              source: "forced-workflow-stop",
              requestedAt: request.acceptedAt,
              targetSetId,
              ...(executing ? {} : { confirmedAt: request.acceptedAt }),
            },
            cleanup: { state: executing ? "pending" : "not-required" },
          });
          if (!executing) {
            state.reservations.delete(run.runId);
            state.claims.delete(run.runId);
            state.slots.delete(run.runId);
          }
        }
        const receipt = { canonical: request.canonicalRequest, targetSetId, targetRunIds };
        state.forcedStops.set(receiptKey, receipt);
        return { ...receipt, alreadyAccepted: false };
      }),
    confirmProjectRunnerStopped: (projectId, targetRunIds, stoppedAt, cleanup) =>
      attempt(() => {
        const targets = new Set(targetRunIds);
        for (const run of state.runs.values()) {
          if (run.projectId !== projectId || run.state !== "executing") continue;
          state.claims.delete(run.runId);
          state.slots.delete(run.runId);
          if (targets.has(run.runId)) {
            state.runs.set(run.runId, {
              ...run,
              state: "cancelled",
              finishedAt: stoppedAt,
              cancellation: {
                ...(run.cancellation ?? {
                  source: "run" as const,
                  requestedAt: stoppedAt,
                }),
                state: "confirmed",
                confirmedAt: stoppedAt,
              },
              cleanup,
            });
            continue;
          }
          state.runs.set(run.runId, {
            ...run,
            state: "queued",
            queueKind: "continuation",
            queueReason: "runner-starting",
            recovery: {
              state: "interrupted-sibling",
              interruptedAt: stoppedAt,
              detail:
                "The Project Runner stopped for another Run. This Run keeps its identity and pinned revision.",
            },
          });
        }
      }),
    recordCleanupFault: (targetRunIds, detail) =>
      attempt(() => {
        for (const runId of targetRunIds) {
          const run = state.runs.get(runId);
          if (run?.cancellation?.state !== "requested") continue;
          state.runs.set(runId, { ...run, cleanup: { state: "fault", detail } });
        }
      }),
    releaseReservation: () => Effect.void,
    recoverInterruptedExecutions: () => Effect.void,
    recoverProjectRunnerAfterRestart: () => Effect.succeed(0),
    holdProjectRunnerAfterRestart: () => Effect.succeed(0),
    recoverProjectRunnerFailure: () => Effect.void,
    repairProjectRecoveryHolds: () => Effect.succeed(0),
    phases: (runId) =>
      Effect.sync(() =>
        [...state.results.entries()]
          .filter(([key]) => (JSON.parse(key) as [string, string, number])[0] === runId)
          .map(([, phase]) => phase)
          .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      ),
  };
};

/** Inspectable in-memory Run owner for unit tests of cross-record atomicity. */
export class InMemoryRunRepository {
  readonly #state = emptyState();
  #failBeforeCommit = false;

  readonly layer = Layer.succeed(
    RunRepository,
    service(this.#state, () => {
      if (!this.#failBeforeCommit) return;
      this.#failBeforeCommit = false;
      throw new RunStoreError({
        code: "STORE_FAILED",
        message: "controlled failure before the in-memory atomic commit",
      });
    }),
  );

  readonly reviewWorkflow = (
    projectId: string,
    workflowName: string,
    mode: WorkflowMode,
    revisionId: string,
  ): void => {
    const prior = this.#state.workflows.get(workflowKey(projectId, workflowName));
    this.#state.workflows.set(workflowKey(projectId, workflowName), {
      mode,
      revisionId,
      activity: prior?.activity ?? "inactive",
    });
  };

  readonly workflow = (projectId: string, workflowName: string) =>
    this.#state.workflows.get(workflowKey(projectId, workflowName));

  readonly operationReceipt = (dataIdentity: string, requestId: string) =>
    this.#state.operationReceipts.get(receiptKey(dataIdentity, requestId))?.receipt;

  readonly failNextAtomicCommit = (): void => {
    this.#failBeforeCommit = true;
  };
}

/** Fresh in-memory adapter for Run admission and Claim use-case tests. */
export const layer: Layer.Layer<RunRepository> = Layer.effect(
  RunRepository,
  Effect.sync(() => service(emptyState(), () => undefined)),
);
