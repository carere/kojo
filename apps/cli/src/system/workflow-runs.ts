import { randomUUID } from "node:crypto";
import type { ExecutionWriteScope, SystemStore } from "./storage";

export type WorkflowStartErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_UNAVAILABLE"
  | "RUNTIME_START_FAILED"
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

export interface PreparedWorkflowRun {
  readonly encodedInput: unknown;
  readonly execute: (scope: {
    readonly attempt: 1;
    readonly leaseGeneration: 1;
    readonly leaseHolder: string;
    readonly projectId: string;
    readonly rootRunId: string;
    readonly runId: string;
  }) => Promise<WorkflowTerminalOutcome>;
  readonly revision: PinnedWorkflowRevision;
  readonly revisionSnapshot: WorkflowRevisionSnapshot;
}

export interface WorkflowRuntimeAdapter {
  readonly prepare: (request: WorkflowStartRequest) => Promise<PreparedWorkflowRun>;
}

export interface WorkflowStartRequest {
  readonly fromCheckout: boolean;
  readonly input: unknown;
  readonly projectId: string;
  readonly workflowName: string;
}

const encoded = (value: unknown) => JSON.stringify({ encodingVersion: 1, value });
const decoded = <A>(value: string | null): A | null =>
  value === null ? null : (JSON.parse(value) as A);
const decodedValue = <A>(value: string): A => (JSON.parse(value) as { readonly value: A }).value;

export const makeWorkflowRunService = (store: SystemStore, runtime: WorkflowRuntimeAdapter) => {
  const settlements = new Map<string, Promise<void>>();

  const finalize = (
    runId: string,
    outcome: WorkflowTerminalOutcome,
    scope: ExecutionWriteScope,
  ) => {
    const inspected = store.workflowRuns.find(runId);
    if (inspected === undefined) throw new Error(`Workflow Run ${runId} was not found`);
    const now = new Date().toISOString();
    const type = `WorkflowRun.${outcome.state}`;
    const sequence = inspected.evidence.length + 1;
    store.workflowRuns.finalize(
      {
        evidence: {
          attempt: 1,
          causationId: inspected.evidence[0]?.eventId ?? null,
          details: encoded(outcome.value),
          eventId: randomUUID(),
          idempotencyKey: `${runId}:terminal`,
          parentEventId: inspected.evidence[0]?.eventId ?? null,
          recordedAt: now,
          runId,
          sequence,
          subject: runId,
          type,
        },
        journal: {
          attempt: 1,
          idempotencyKey: `${runId}:terminal`,
          operation: type,
          payload: encoded(outcome.value),
          runId,
          sequence,
          writtenAt: now,
        },
        outcome: encoded(outcome.value),
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
      ({ stableName }) => stableName === revisionSnapshot.rootWorkflow,
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
        attempt: event.attempt,
        details: decoded(event.details),
        eventId: event.eventId,
        recordedAt: event.recordedAt,
        sequence: event.sequence,
        subject: event.subject,
        type: event.type,
      })),
      input: decoded(stored.run.input),
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
      projectId: stored.run.projectId,
      revision: {
        declaredVersion: pinnedRevision?.declaredVersion ?? stored.revision.declaredVersion,
        fingerprint: pinnedRevision?.fingerprint ?? stored.revision.fingerprint,
        source: revisionSnapshot?.source ?? (JSON.parse(stored.revision.source) as unknown),
        stableName: pinnedRevision?.stableName ?? stored.revision.stableName,
        workflowAbi: pinnedRevision?.workflowAbi ?? stored.revision.workflowAbi,
      },
      revisionSnapshot: revisionSnapshot ?? null,
      rootRunId: stored.run.rootRunId,
      runId: stored.run.runId,
      state: stored.run.state,
      trigger: JSON.parse(stored.run.trigger) as unknown,
      updatedAt: stored.run.updatedAt,
    };
  };

  return {
    inspect,
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
    settle: async (runId: string) => {
      await settlements.get(runId);
      return inspect(runId);
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
      const settlement = Promise.resolve().then(async () => {
        const heartbeat = setInterval(() => {
          try {
            store.workflowRuns.renewLease(
              executionScope,
              new Date(Date.now() + 5 * 60_000).toISOString(),
            );
          } catch {
            // The next fenced write or finalization will reconcile lost authority.
          }
        }, 60_000);
        heartbeat.unref();
        let outcome: WorkflowTerminalOutcome;
        try {
          outcome = await prepared.execute(executionScope);
        } catch (error) {
          outcome = {
            state: "Failed",
            value: {
              _tag: "RuntimeDefect",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        } finally {
          clearInterval(heartbeat);
        }
        finalize(runId, outcome, executionScope);
      });
      settlements.set(runId, settlement);
      void settlement.catch(() => undefined);

      return { attempt: 1 as const, runId, state: "Running" as const };
    },
  };
};
