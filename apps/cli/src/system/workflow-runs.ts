import { randomUUID } from "node:crypto";
import type { ExecutionWriteScope, ScheduleEvaluationCommit, SystemStore } from "./storage";

export type WorkflowStartErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_UNAVAILABLE"
  | "RUNTIME_START_FAILED"
  | "WORKFLOW_INCOMPATIBLE"
  | "WORKFLOW_NOT_FOUND";

export class WorkflowStartError extends Error {
  constructor(
    readonly code: WorkflowStartErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkflowStartError";
  }
}

export interface PinnedWorkflowRevision {
  readonly declaredVersion: string;
  readonly fingerprint: string;
  readonly source: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly kind: "CheckoutSourceSnapshot" | "ProjectSourceRevision";
    readonly [key: string]: unknown;
  };
  readonly stableName: string;
  readonly workflowAbi: string;
}

export interface WorkflowRevisionSnapshot {
  readonly rootWorkflow: string;
  readonly source: PinnedWorkflowRevision["source"];
  readonly workflows: ReadonlyArray<Omit<PinnedWorkflowRevision, "source">>;
}

export type WorkflowTerminalOutcome =
  | { readonly state: "Completed"; readonly value: unknown }
  | { readonly state: "Failed"; readonly value: unknown };

export type WorkflowExecutionOutcome =
  | WorkflowTerminalOutcome
  | { readonly state: "Discarded" | "Suspended"; readonly value?: unknown };

export interface PreparedWorkflowRun {
  readonly dispose?: () => Promise<void>;
  readonly encodedInput: unknown;
  readonly execute: (scope: {
    readonly attempt: number;
    readonly leaseGeneration: number;
    readonly leaseHolder: string;
    readonly projectId: string;
    readonly rootRunId: string;
    readonly runId: string;
    readonly signal: AbortSignal;
  }) => Promise<WorkflowExecutionOutcome>;
  readonly revision: PinnedWorkflowRevision;
  readonly revisionSnapshot: WorkflowRevisionSnapshot;
}

export interface WorkflowRuntimeAdapter {
  readonly prepare: (request: WorkflowStartRequest) => Promise<PreparedWorkflowRun>;
  readonly prepareResume?: (
    request: WorkflowResumePreflightRequest,
  ) => Promise<PreparedWorkflowResume>;
}

export interface WorkflowResumePreflightRequest {
  readonly attempt: number;
  readonly descendantFailures: ReadonlyArray<{
    readonly input: unknown;
    readonly outcome: unknown;
    readonly workflowName: string;
  }>;
  readonly input: unknown;
  readonly outcome: unknown;
  readonly projectId: string;
  readonly revision: PinnedWorkflowRevision;
  readonly revisionSnapshot: WorkflowRevisionSnapshot;
  readonly rootRunId: string;
  readonly runId: string;
  readonly state: "Failed" | "Interrupted" | "Suspended";
}

export interface PreparedWorkflowResume {
  readonly execute: PreparedWorkflowRun["execute"];
  readonly leaseAvailability: "Available";
  readonly recoveryPolicy: "Available" | "NotRequired";
  readonly revisionCompatibility: "Compatible";
  readonly runtimeConfigurationCompatibility: "Compatible";
  readonly sourceAvailability: "Available";
}

export interface WorkflowStartRequest {
  readonly fromCheckout: boolean;
  readonly input: unknown;
  readonly projectId: string;
  readonly workflowName: string;
}

const encoded = (value: unknown) => JSON.stringify({ encodingVersion: 1, value });
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const encodedCanonical = (value: unknown) =>
  `{"encodingVersion":1,"value":${canonicalJson(value)}}`;
const decoded = <A>(value: string | null): A | null =>
  value === null ? null : (JSON.parse(value) as A);
const decodedValue = <A>(value: string): A => (JSON.parse(value) as { readonly value: A }).value;

export const makeWorkflowRunService = (store: SystemStore, runtime: WorkflowRuntimeAdapter) => {
  const executionControllers = new Map<string, AbortController>();
  const settlements = new Map<string, Promise<void>>();

  const finalize = (
    runId: string,
    outcome: WorkflowTerminalOutcome,
    scope: ExecutionWriteScope,
    parentNotification?: {
      readonly invocationKey: string;
      readonly scope: ExecutionWriteScope;
      readonly workflowName: string;
    },
  ) => {
    const inspected = store.workflowRuns.find(runId);
    if (inspected === undefined) throw new Error(`Workflow Run ${runId} was not found`);
    const now = new Date().toISOString();
    const type = `WorkflowRun.${outcome.state}`;
    const sequence = inspected.evidence.length + 1;
    store.workflowRuns.finalize(
      {
        evidence: {
          attempt: scope.attempt,
          causationId: inspected.evidence[0]?.eventId ?? null,
          details: encoded(outcome.value),
          eventId: randomUUID(),
          idempotencyKey: `${runId}:terminal:${scope.attempt}`,
          parentEventId: inspected.evidence[0]?.eventId ?? null,
          recordedAt: now,
          runId,
          sequence,
          subject: runId,
          type,
        },
        journal: {
          attempt: scope.attempt,
          idempotencyKey: `${runId}:terminal:${scope.attempt}`,
          operation: type,
          payload: encoded(outcome.value),
          runId,
          sequence,
          writtenAt: now,
        },
        outcome: encoded(outcome.value),
        ...(parentNotification === undefined ? {} : { parentNotification }),
        runId,
        state: outcome.state,
      },
      scope,
    );
  };

  const inspect = (runId: string) => {
    const stored = store.workflowRuns.find(runId);
    if (stored === undefined) return undefined;
    const revisionSnapshot =
      stored.revisionSnapshot === undefined
        ? undefined
        : decodedValue<WorkflowRevisionSnapshot>(stored.revisionSnapshot.snapshot);
    const pinnedRevision = revisionSnapshot?.workflows.find(
      ({ stableName }) => stableName === stored.revision.stableName,
    );
    return {
      attempts: stored.attempts.map((attempt) => ({
        finishedAt: attempt.finishedAt,
        number: attempt.number,
        startedAt: attempt.startedAt,
        state: attempt.state,
      })),
      createdAt: stored.run.createdAt,
      evidence: stored.evidence.map((event) => ({
        artifacts: event.artifacts ?? [],
        attempt: event.attempt,
        causationId: event.causationId,
        details: decoded(event.details),
        eventId: event.eventId,
        parentEventId: event.parentEventId,
        recordedAt: event.recordedAt,
        sequence: event.sequence,
        subject: event.subject,
        type: event.type,
      })),
      input: decoded(stored.run.input),
      invocationKey: stored.run.invocationKey ?? null,
      lease:
        stored.lease === undefined
          ? null
          : {
              acquiredAt: stored.lease.acquiredAt,
              expiresAt: stored.lease.expiresAt,
              generation: stored.lease.generation,
              state: stored.lease.state,
            },
      outcome: decoded(stored.run.outcome),
      parentRunId: stored.run.parentRunId ?? null,
      projectId: stored.run.projectId,
      revision: {
        declaredVersion: pinnedRevision?.declaredVersion ?? stored.revision.declaredVersion,
        fingerprint: pinnedRevision?.fingerprint ?? stored.revision.fingerprint,
        source:
          revisionSnapshot?.source ??
          (JSON.parse(stored.revision.source) as PinnedWorkflowRevision["source"]),
        stableName: pinnedRevision?.stableName ?? stored.revision.stableName,
        workflowAbi: pinnedRevision?.workflowAbi ?? stored.revision.workflowAbi,
      },
      revisionSnapshot: revisionSnapshot ?? null,
      resumeCompatibility: { status: "NotChecked" as const },
      rootRunId: stored.run.rootRunId,
      runId: stored.run.runId,
      state: stored.run.state,
      runtimeConfigurationCompatibility: { status: "NotChecked" as const },
      trigger: JSON.parse(stored.run.trigger) as unknown,
      updatedAt: stored.run.updatedAt,
    };
  };

  const executeAttempt = async (
    execute: PreparedWorkflowRun["execute"],
    scope: ExecutionWriteScope,
    controller: AbortController,
  ) => {
    const heartbeat = setInterval(() => {
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const runningTree = store.workflowRuns
        .list()
        .filter((run) => run.rootRunId === scope.rootRunId && run.state === "Running");
      for (const run of runningTree) {
        try {
          const stored = store.workflowRuns.find(run.runId);
          const lease = stored?.lease;
          const attempt = stored?.attempts.at(-1);
          if (lease === undefined || attempt === undefined) continue;
          store.workflowRuns.renewLease(
            {
              attempt: attempt.number,
              leaseGeneration: lease.generation,
              leaseHolder: lease.holder,
              projectId: run.projectId,
              rootRunId: run.rootRunId,
              runId: run.runId,
            },
            expiresAt,
          );
        } catch {
          // The next fenced write or finalization will reconcile lost authority.
        }
      }
    }, 60_000);
    heartbeat.unref();
    let outcome: WorkflowExecutionOutcome;
    try {
      outcome = await execute({ ...scope, signal: controller.signal });
    } catch {
      const running = store.workflowRuns
        .list()
        .filter((run) => run.rootRunId === scope.rootRunId && run.state === "Running");
      for (const run of [...running].reverse()) {
        const lease = store.workflowRuns.find(run.runId)?.lease;
        const attempt = store.workflowRuns.find(run.runId)?.attempts.at(-1)?.number;
        if (lease !== undefined && attempt !== undefined) {
          store.workflowRuns.interruptScope(
            {
              attempt,
              leaseGeneration: lease.generation,
              leaseHolder: lease.holder,
              projectId: run.projectId,
              rootRunId: run.rootRunId,
              runId: run.runId,
            },
            "ProjectRuntimeProcessLost",
          );
        }
      }
      return;
    } finally {
      clearInterval(heartbeat);
      if (executionControllers.get(scope.runId) === controller) {
        executionControllers.delete(scope.runId);
      }
    }
    if (outcome.state === "Completed" || outcome.state === "Failed") {
      finalize(scope.runId, outcome, scope);
    } else if (outcome.state === "Suspended") {
      store.workflowRuns.appendBoundary({
        ...scope,
        details: encoded({ descendants: "Settled" }),
        idempotencyKey: `${scope.runId}:suspension:${scope.attempt}:descendants-settled`,
        operation: "WorkflowRun.DescendantsSettled",
        subject: scope.runId,
      });
    }
  };

  return {
    inspect,
    inspectTree: (runId: string) => {
      const selected = inspect(runId);
      if (selected === undefined) return undefined;
      const rootRunId = selected.rootRunId;
      const runIds = store.workflowRuns
        .list()
        .filter((run) => run.rootRunId === rootRunId)
        .map(({ runId: candidate }) => candidate);
      const inspected = runIds
        .map((candidate) => inspect(candidate))
        .filter((run) => run !== undefined);
      const build = (parentRunId: string): unknown => {
        const run = inspected.find(({ runId: candidate }) => candidate === parentRunId);
        if (run === undefined) return undefined;
        return {
          ...run,
          children: inspected
            .filter(({ parentRunId: parent }) => parent === parentRunId)
            .map(({ runId: childRunId }) => build(childRunId)),
        };
      };
      return build(rootRunId);
    },
    startChild: (
      request: ExecutionWriteScope & {
        readonly input: unknown;
        readonly invocationKey: string;
        readonly recoveryPolicies?: ReadonlyArray<{
          readonly recoveryTags: ReadonlyArray<string>;
          readonly workflowName: string;
        }>;
        readonly recoveryTags: ReadonlyArray<string>;
        readonly workflowName: string;
      },
    ) => {
      const parent = inspect(request.runId);
      if (parent === undefined) throw new Error(`Workflow Run ${request.runId} was not found`);
      const snapshot = parent.revisionSnapshot;
      if (snapshot === null) throw new Error("The root Workflow Revision Snapshot is missing");
      const revision = snapshot.workflows.find(
        ({ stableName }) => stableName === request.workflowName,
      );
      if (revision === undefined) {
        throw new Error(
          `Child Workflow '${request.workflowName}' is not part of the root Workflow Revision Snapshot`,
        );
      }
      const runId = randomUUID();
      const now = new Date().toISOString();
      const leaseHolder = request.leaseHolder;
      const encodedInput = encodedCanonical(request.input);
      const existingChild = store.workflowRuns
        .list()
        .find(
          (run) => run.parentRunId === request.runId && run.invocationKey === request.invocationKey,
        );
      const existingOutcome =
        existingChild?.outcome === null || existingChild?.outcome === undefined
          ? undefined
          : decodedValue<unknown>(existingChild.outcome);
      const existingFailureTag =
        typeof existingOutcome === "object" &&
        existingOutcome !== null &&
        "_tag" in existingOutcome &&
        typeof existingOutcome._tag === "string"
          ? existingOutcome._tag
          : undefined;
      const recoveryPolicies = new Map(
        (
          request.recoveryPolicies ?? [
            { recoveryTags: request.recoveryTags, workflowName: request.workflowName },
          ]
        ).map((policy) => [policy.workflowName, policy.recoveryTags]),
      );
      const allRuns = store.workflowRuns.list();
      const isInExistingSubtree = (candidate: (typeof allRuns)[number]) => {
        if (existingChild === undefined) return false;
        let current: (typeof allRuns)[number] | undefined = candidate;
        while (current?.parentRunId !== null && current?.parentRunId !== undefined) {
          if (current.parentRunId === existingChild.runId) return true;
          current = allRuns.find(
            ({ runId: candidateRunId }) => candidateRunId === current?.parentRunId,
          );
        }
        return false;
      };
      const recoverableDescendant = allRuns.some((candidate) => {
        if (candidate.state !== "Failed" || !isInExistingSubtree(candidate)) return false;
        const stored = store.workflowRuns.find(candidate.runId);
        if (stored?.run.outcome === null || stored?.run.outcome === undefined) return false;
        const outcome = decodedValue<unknown>(stored.run.outcome);
        const tag =
          typeof outcome === "object" &&
          outcome !== null &&
          "_tag" in outcome &&
          typeof outcome._tag === "string"
            ? outcome._tag
            : undefined;
        return (
          tag !== undefined &&
          recoveryPolicies.get(stored.revision.stableName)?.includes(tag) === true
        );
      });
      const start = store.workflowRuns.startChild({
        attempt: { finishedAt: null, number: 1, runId, startedAt: now, state: "Running" },
        evidence: {
          attempt: 1,
          causationId: parent.evidence[0]?.eventId ?? null,
          details: encoded({ input: request.input, invocationKey: request.invocationKey }),
          eventId: randomUUID(),
          idempotencyKey: `${runId}:start`,
          parentEventId: null,
          recordedAt: now,
          runId,
          sequence: 1,
          subject: request.workflowName,
          type: "WorkflowRun.Started",
        },
        invocationKey: request.invocationKey,
        journal: {
          attempt: 1,
          idempotencyKey: `${runId}:start`,
          operation: "WorkflowRun.Started",
          payload: encoded({ input: request.input, invocationKey: request.invocationKey }),
          runId,
          sequence: 1,
          writtenAt: now,
        },
        lease: {
          acquiredAt: now,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          generation: 1,
          holder: leaseHolder,
          runId,
          state: "Active",
        },
        parentScope: request,
        resumeFailed:
          (existingFailureTag !== undefined && request.recoveryTags.includes(existingFailureTag)) ||
          recoverableDescendant,
        revision: {
          createdAt: now,
          declaredVersion: revision.declaredVersion,
          fingerprint: revision.fingerprint,
          source: JSON.stringify(snapshot.source),
          stableName: revision.stableName,
          workflowAbi: revision.workflowAbi,
        },
        run: {
          createdAt: now,
          input: encodedInput,
          invocationKey: request.invocationKey,
          outcome: null,
          parentRunId: request.runId,
          projectId: request.projectId,
          revisionFingerprint: revision.fingerprint,
          rootRunId: request.rootRunId,
          runId,
          state: "Running",
          trigger: JSON.stringify({ parentRunId: request.runId, type: "ChildWorkflow" }),
          updatedAt: now,
        },
      });
      const stored = inspect(start.run.runId);
      if (stored === undefined) throw new Error(`Workflow Run ${start.run.runId} was not found`);
      return {
        attempt: stored.attempts.at(-1)?.number ?? 1,
        input: decodedValue(start.run.input),
        leaseGeneration: stored.lease?.generation ?? 1,
        leaseHolder,
        outcome: stored.outcome,
        runId: stored.runId,
        state: stored.state,
        status: start.status,
      };
    },
    finalizeChild: (
      request: ExecutionWriteScope &
        WorkflowTerminalOutcome & {
          readonly invocationKey: string;
          readonly parentScope: ExecutionWriteScope;
          readonly workflowName: string;
        },
    ) => {
      finalize(request.runId, request, request, {
        invocationKey: request.invocationKey,
        scope: request.parentScope,
        workflowName: request.workflowName,
      });
      return inspect(request.runId);
    },
    claimActivity: (request: {
      readonly attempt: number;
      readonly completionIdempotencyKey: string;
      readonly idempotencyKey: string;
      readonly leaseGeneration: number;
      readonly leaseHolder: string;
      readonly payload: unknown;
      readonly projectId: string;
      readonly rootRunId: string;
      readonly runId: string;
      readonly subject: string;
    }) => {
      const result = store.workflowRuns.claimActivity({
        ...request,
        details: encoded(request.payload),
        operation: "Activity.Started",
      });
      return result.status === "replay"
        ? { payload: decodedValue(result.payload), status: result.status }
        : result;
    },
    readBoundary: (
      scope: {
        readonly attempt: number;
        readonly leaseGeneration: number;
        readonly leaseHolder: string;
        readonly projectId: string;
        readonly rootRunId: string;
        readonly runId: string;
      },
      idempotencyKey: string,
    ) => {
      const entry = store.workflowRuns.readBoundary(scope, idempotencyKey);
      return entry === undefined ? undefined : decodedValue(entry.payload);
    },
    registerArtifact: (request: {
      readonly attempt: number;
      readonly byteLength: number;
      readonly fingerprint: string;
      readonly leaseGeneration: number;
      readonly leaseHolder: string;
      readonly mediaType: string;
      readonly path: string;
      readonly projectId: string;
      readonly rootRunId: string;
      readonly runId: string;
    }) => store.workflowRuns.registerArtifact(request),
    recordBoundary: (request: {
      readonly attempt: number;
      readonly idempotencyKey: string;
      readonly leaseGeneration: number;
      readonly leaseHolder: string;
      readonly operation: string;
      readonly payload: unknown;
      readonly projectId: string;
      readonly rootRunId: string;
      readonly runId: string;
      readonly subject: string;
    }) =>
      store.workflowRuns.appendBoundary({
        ...request,
        details: encoded(request.payload),
      }),
    verifyRuntimeConfiguration: (request: {
      readonly attempt: number;
      readonly leaseGeneration: number;
      readonly leaseHolder: string;
      readonly projectId: string;
      readonly rootRunId: string;
      readonly runId: string;
      readonly snapshot: unknown;
      readonly subject: string;
    }) =>
      store.workflowRuns.verifyRuntimeConfiguration({
        ...request,
        snapshot: encodedCanonical(request.snapshot),
      }),
    discard: (runId: string) => {
      const selected = inspect(runId);
      if (selected === undefined) throw new Error(`Workflow Run ${runId} was not found`);
      if (selected.parentRunId !== null) {
        throw new Error(`Lifecycle requests must target root Workflow Run ${selected.rootRunId}`);
      }
      if (selected.state === "Completed" || selected.state === "Discarded") {
        throw new Error(`Workflow Run ${runId} is immutable in ${selected.state} state`);
      }
      const tree = store.workflowRuns.list().filter((run) => run.rootRunId === runId);
      const deepestFirst: typeof tree = [];
      const visit = (parentRunId: string) => {
        for (const child of tree.filter((run) => run.parentRunId === parentRunId)) {
          visit(child.runId);
          deepestFirst.push(child);
        }
      };
      visit(runId);
      deepestFirst.push(tree.find((run) => run.runId === runId) as (typeof tree)[number]);
      for (const run of deepestFirst) {
        if (run.state !== "Completed" && run.state !== "Discarded") {
          store.workflowRuns.discard(run.runId);
        }
      }
      executionControllers.get(runId)?.abort();
      return { runId, state: "Discarded" as const, status: "discarded" as const };
    },
    gracefulStop: async () => {
      const runningRoots = store.workflowRuns
        .list()
        .filter((run) => run.runId === run.rootRunId && run.state === "Running")
        .map(({ runId }) => runId);
      const requestedRoots: Array<string> = [];
      for (const runId of runningRoots) {
        try {
          store.workflowRuns.requestSuspend(runId, "SystemProcessStop");
          requestedRoots.push(runId);
        } catch {
          // A terminal boundary may win the race after the Running roots were listed.
        }
      }
      await Promise.allSettled(
        requestedRoots
          .map((runId) => settlements.get(runId))
          .filter((value) => value !== undefined),
      );
      return requestedRoots;
    },
    resume: (runId: string) => {
      const inspected = inspect(runId);
      if (inspected === undefined) throw new Error(`Workflow Run ${runId} was not found`);
      if (inspected.parentRunId !== null) {
        throw new Error(`Lifecycle requests must target root Workflow Run ${inspected.rootRunId}`);
      }
      if (
        inspected.state !== "Suspended" &&
        inspected.state !== "Interrupted" &&
        inspected.state !== "Failed"
      ) {
        throw new Error(`Workflow Run ${runId} is immutable in ${inspected.state} state`);
      }
      if (inspected.revisionSnapshot === null) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          `Workflow Run ${runId} has no Workflow Revision Snapshot`,
        );
      }
      const outcome =
        typeof inspected.outcome === "object" &&
        inspected.outcome !== null &&
        "value" in inspected.outcome
          ? inspected.outcome.value
          : inspected.outcome;
      if (
        inspected.state === "Failed" &&
        typeof outcome === "object" &&
        outcome !== null &&
        "_tag" in outcome &&
        outcome._tag === "Defect"
      ) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          `Workflow Run ${runId} failed with a non-resumable Defect`,
        );
      }
      if (inspected.evidence.some(({ type }) => type === "Activity.Uncertain")) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          `Workflow Run ${runId} has an Uncertain Activity Outcome that requires reconciliation`,
        );
      }
      if (
        inspected.lease?.state === "Active" &&
        inspected.lease.expiresAt > new Date().toISOString()
      ) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          `Workflow Run ${runId} still has active execution authority`,
        );
      }
      const prepareResume = runtime.prepareResume;
      if (prepareResume === undefined) {
        throw new WorkflowStartError(
          "WORKFLOW_INCOMPATIBLE",
          "The runtime cannot perform complete resume preflight",
        );
      }
      const nextAttempt = (inspected.attempts.at(-1)?.number ?? 0) + 1;
      const descendantFailures = store.workflowRuns
        .list()
        .filter(
          (run) =>
            run.rootRunId === inspected.rootRunId &&
            run.runId !== inspected.runId &&
            run.state === "Failed",
        )
        .flatMap((run) => {
          const stored = store.workflowRuns.find(run.runId);
          if (stored?.run.outcome === null || stored?.run.outcome === undefined) return [];
          const descendantOutcome = decodedValue<unknown>(stored.run.outcome);
          if (canonicalJson(descendantOutcome) !== canonicalJson(outcome)) return [];
          return [
            {
              input: decodedValue<unknown>(stored.run.input),
              outcome: descendantOutcome,
              workflowName: stored.revision.stableName,
            },
          ];
        });
      return prepareResume({
        attempt: nextAttempt - 1,
        descendantFailures,
        input: decodedValue(store.workflowRuns.find(runId)?.run.input ?? encoded(undefined)),
        outcome,
        projectId: inspected.projectId,
        revision: inspected.revision,
        revisionSnapshot: inspected.revisionSnapshot,
        rootRunId: inspected.rootRunId,
        runId,
        state: inspected.state,
      }).then((prepared) => {
        const now = new Date().toISOString();
        const leaseHolder = randomUUID();
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const eventId = randomUUID();
        const sequence = inspected.evidence.length + 1;
        const idempotencyKey = `${runId}:resume:${nextAttempt}`;
        const details = encoded({
          leaseAvailability: prepared.leaseAvailability,
          recoveryPolicy: prepared.recoveryPolicy,
          revisionCompatibility: prepared.revisionCompatibility,
          runtimeConfigurationCompatibility: prepared.runtimeConfigurationCompatibility,
          sourceAvailability: prepared.sourceAvailability,
        });
        store.workflowRuns.resume({
          attempt: {
            finishedAt: null,
            number: nextAttempt,
            runId,
            startedAt: now,
            state: "Running",
          },
          evidence: {
            attempt: nextAttempt,
            causationId: inspected.evidence[0]?.eventId ?? null,
            details,
            eventId,
            idempotencyKey,
            parentEventId: inspected.evidence[0]?.eventId ?? null,
            recordedAt: now,
            runId,
            sequence,
            subject: runId,
            type: "WorkflowRun.Resumed",
          },
          journal: {
            attempt: nextAttempt,
            idempotencyKey,
            operation: "WorkflowRun.Resumed",
            payload: details,
            runId,
            sequence,
            writtenAt: now,
          },
          lease: {
            acquiredAt: now,
            expiresAt,
            generation: nextAttempt,
            holder: leaseHolder,
            runId,
            state: "Active",
          },
          runId,
        });
        const executionScope = {
          attempt: nextAttempt,
          leaseGeneration: nextAttempt,
          leaseHolder,
          projectId: inspected.projectId,
          rootRunId: inspected.rootRunId,
          runId,
        };
        const controller = new AbortController();
        executionControllers.set(runId, controller);
        const settlement = Promise.resolve().then(() =>
          executeAttempt(prepared.execute, executionScope, controller),
        );
        settlements.set(runId, settlement);
        void settlement.catch(() => undefined);
        return { attempt: nextAttempt, runId, state: "Running" as const };
      });
    },
    settle: async (runId: string) => {
      await settlements.get(runId);
      return inspect(runId);
    },
    suspend: (runId: string) => {
      const selected = inspect(runId);
      if (selected === undefined) throw new Error(`Workflow Run ${runId} was not found`);
      if (selected.parentRunId !== null) {
        throw new Error(`Lifecycle requests must target root Workflow Run ${selected.rootRunId}`);
      }
      const tree = store.workflowRuns.list().filter((run) => run.rootRunId === runId);
      const deepestFirst: typeof tree = [];
      const visit = (parentRunId: string) => {
        for (const child of tree.filter((run) => run.parentRunId === parentRunId)) {
          visit(child.runId);
          deepestFirst.push(child);
        }
      };
      visit(runId);
      deepestFirst.push(tree.find((run) => run.runId === runId) as (typeof tree)[number]);
      for (const run of deepestFirst) {
        if (run.state === "Running") store.workflowRuns.requestSuspend(run.runId, "Operator");
      }
      return { runId, state: selected.state, status: "requested" as const };
    },
    startScheduled: async (
      request: Omit<WorkflowStartRequest, "fromCheckout">,
      evaluation: Omit<ScheduleEvaluationCommit, "start">,
      trigger: {
        readonly catchUp?: {
          readonly count: number;
          readonly earliest: string;
          readonly latest: string;
        };
        readonly occurrence: string;
        readonly scheduleName: string;
        readonly scheduledAt: string;
        readonly type: "Scheduled";
      },
    ) => {
      const prepared = await runtime.prepare({ ...request, fromCheckout: false });
      const runId = randomUUID();
      const leaseHolder = randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const startEventId = randomUUID();
      const record = {
        attempt: {
          finishedAt: null,
          number: 1,
          runId,
          startedAt: now,
          state: "Running" as const,
        },
        evidence: {
          attempt: 1,
          causationId: null,
          details: encoded({ trigger }),
          eventId: startEventId,
          idempotencyKey: `${runId}:start`,
          parentEventId: null,
          recordedAt: now,
          runId,
          sequence: 1,
          subject: runId,
          type: "WorkflowRun.Started",
        },
        journal: {
          attempt: 1,
          idempotencyKey: `${runId}:start`,
          operation: "WorkflowRun.Started",
          payload: encoded({ trigger }),
          runId,
          sequence: 1,
          writtenAt: now,
        },
        lease: {
          acquiredAt: now,
          expiresAt,
          generation: 1,
          holder: leaseHolder,
          runId,
          state: "Active" as const,
        },
        revision: {
          createdAt: now,
          declaredVersion: prepared.revision.declaredVersion,
          fingerprint: prepared.revision.fingerprint,
          source: JSON.stringify(prepared.revision.source),
          stableName: prepared.revision.stableName,
          workflowAbi: prepared.revision.workflowAbi,
        },
        revisionSnapshot: {
          createdAt: now,
          rootRunId: runId,
          snapshot: encoded(prepared.revisionSnapshot),
        },
        run: {
          createdAt: now,
          input: encoded(prepared.encodedInput),
          outcome: null,
          projectId: request.projectId,
          revisionFingerprint: prepared.revision.fingerprint,
          rootRunId: runId,
          runId,
          state: "Running" as const,
          trigger: JSON.stringify(trigger),
          updatedAt: now,
        },
      };
      let committed: ReturnType<SystemStore["workflowSchedules"]["commitEvaluation"]>;
      try {
        committed = store.workflowSchedules.commitEvaluation({ ...evaluation, start: record });
      } catch (error) {
        await prepared.dispose?.().catch(() => undefined);
        throw error;
      }
      if (committed.outcome !== "Started") {
        await prepared.dispose?.();
        return { ...committed, runId: committed.runId };
      }
      const executionScope = {
        attempt: 1 as const,
        leaseGeneration: 1 as const,
        leaseHolder,
        projectId: request.projectId,
        rootRunId: runId,
        runId,
      };
      const controller = new AbortController();
      executionControllers.set(runId, controller);
      const settlement = Promise.resolve().then(() =>
        executeAttempt(prepared.execute, executionScope, controller),
      );
      settlements.set(runId, settlement);
      void settlement.catch(() => undefined);
      return { ...committed, runId };
    },
    start: async (request: WorkflowStartRequest) => {
      // Preparation owns Project/source discovery, complete registry validation,
      // runtime configuration preflight, and schema decoding. Nothing durable is
      // written until all of it succeeds.
      const prepared = await runtime.prepare(request);
      const runId = randomUUID();
      const leaseHolder = randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const trigger = { type: "Direct" as const };
      const startEventId = randomUUID();
      store.workflowRuns.start({
        attempt: {
          finishedAt: null,
          number: 1,
          runId,
          startedAt: now,
          state: "Running",
        },
        evidence: {
          attempt: 1,
          causationId: null,
          details: JSON.stringify({ encodingVersion: 1, value: { trigger } }),
          eventId: startEventId,
          idempotencyKey: `${runId}:start`,
          parentEventId: null,
          recordedAt: now,
          runId,
          sequence: 1,
          subject: runId,
          type: "WorkflowRun.Started",
        },
        journal: {
          attempt: 1,
          idempotencyKey: `${runId}:start`,
          operation: "WorkflowRun.Started",
          payload: encoded({ trigger }),
          runId,
          sequence: 1,
          writtenAt: now,
        },
        lease: {
          acquiredAt: now,
          expiresAt,
          generation: 1,
          holder: leaseHolder,
          runId,
          state: "Active",
        },
        revision: {
          createdAt: now,
          declaredVersion: prepared.revision.declaredVersion,
          fingerprint: prepared.revision.fingerprint,
          source: JSON.stringify(prepared.revision.source),
          stableName: prepared.revision.stableName,
          workflowAbi: prepared.revision.workflowAbi,
        },
        revisionSnapshot: {
          createdAt: now,
          rootRunId: runId,
          snapshot: encoded(prepared.revisionSnapshot),
        },
        run: {
          createdAt: now,
          input: encoded(prepared.encodedInput),
          outcome: null,
          projectId: request.projectId,
          revisionFingerprint: prepared.revision.fingerprint,
          rootRunId: runId,
          runId,
          state: "Running",
          trigger: JSON.stringify(trigger),
          updatedAt: now,
        },
      });

      const executionScope = {
        attempt: 1 as const,
        leaseGeneration: 1 as const,
        leaseHolder,
        projectId: request.projectId,
        rootRunId: runId,
        runId,
      };
      const controller = new AbortController();
      executionControllers.set(runId, controller);
      const settlement = Promise.resolve().then(async () => {
        await executeAttempt(prepared.execute, executionScope, controller);
      });
      settlements.set(runId, settlement);
      void settlement.catch(() => undefined);

      return { attempt: 1 as const, runId, state: "Running" as const };
    },
  };
};
