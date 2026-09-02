import type { RunDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { TraceProjection } from "../../trace/models/DaemonTrace.ts";
import type { ArtifactRepository } from "../../trace/ports/ArtifactRepository.ts";
import type { DaemonRun, PhaseResult } from "../models/DaemonRun.ts";
import type { ExternalActionIntent } from "../models/ExternalAction.ts";

const internalPhaseDescription = "__kojo_internal_activity__";

const terminal = (run: DaemonRun): boolean =>
  run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";

/** Build the public Run document from durable execution, Trace, Artifact, and uncertainty state. */
export const runDocumentOf = (
  run: DaemonRun,
  phases: ReadonlyArray<PhaseResult>,
  trace: TraceProjection,
  artifacts: ReturnType<ArtifactRepository["list"]>,
  uncertainty?: ExternalActionIntent,
): RunDocument => ({
  runId: run.runId,
  projectId: run.projectId,
  workflowName: run.workflowName,
  revisionId: run.revisionId,
  packageGraphId: run.packageGraphId,
  state: run.state,
  ...(!terminal(run) && run.state === "queued"
    ? { queueReason: run.queueReason ?? ("runner-starting" as const) }
    : {}),
  admittedAt: run.admittedAt,
  ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
  ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  ...(run.executionFault === undefined ? {} : { executionFault: run.executionFault }),
  ...(run.cancellation === undefined ? {} : { cancellation: run.cancellation }),
  ...(run.recovery === undefined ? {} : { recovery: run.recovery }),
  ...(run.cleanup === undefined ? {} : { cleanup: run.cleanup }),
  ...(uncertainty === undefined
    ? {}
    : {
        uncertainty: {
          actionId: uncertainty.actionId,
          revisionId: uncertainty.revisionId,
          phasePath: uncertainty.phasePath,
          attempt: uncertainty.attempt,
          inputHash: uncertainty.inputHash,
          recoveryPolicy: uncertainty.recoveryPolicy,
          state: uncertainty.state,
          uncertaintyRevision: uncertainty.uncertaintyRevision,
          ...(uncertainty.evidence === undefined
            ? {}
            : {
                evidence: {
                  kind: uncertainty.evidence.kind,
                  detail: uncertainty.evidence.detail,
                  observedAt: uncertainty.evidence.observedAt,
                },
              }),
          ...(uncertainty.retryAuthorization === undefined
            ? {}
            : { retryAuthorization: uncertainty.retryAuthorization }),
        },
      }),
  phases:
    trace.phases.length === 0
      ? phases
          .filter((phase) => phase.description !== internalPhaseDescription)
          .map((phase) => ({
            phasePath: phase.phasePath,
            attempt: phase.attempt,
            kind: phase.kind,
            outcome: phase.outcome,
            description: phase.description,
            startedAt: phase.startedAt,
            endedAt: phase.endedAt,
            result: phase.encodedResult,
          }))
      : trace.phases.map((phase) => {
          const result = phases.find(
            (candidate) =>
              candidate.phasePath === phase.name && candidate.attempt === phase.attempt,
          );
          return {
            phasePath: String(phase.name),
            attempt: Number(phase.attempt),
            kind: phase.kind as "actor" | "code" | "agent",
            outcome: phase.outcome as "succeeded" | "failed" | "interrupted",
            description: String(phase.description),
            startedAt: new Date(Number(phase.startedAt)).toISOString(),
            endedAt: new Date(Number(phase.endedAt)).toISOString(),
            ...(typeof phase.sandboxId === "string" ? { sandboxId: phase.sandboxId } : {}),
            ...(typeof phase.errorTag === "string" ? { errorTag: phase.errorTag } : {}),
            ...(result === undefined ? {} : { result: result.encodedResult }),
          };
        }),
  gates: trace.gates.map((gate) => ({
    gate: String(gate.gate),
    asking: String(gate.asking),
    description: String(gate.description),
    actor: String(gate.actor),
    requestedAt: new Date(Number(gate.requestedAt)).toISOString(),
    deadlineAt: new Date(Number(gate.deadlineAt)).toISOString(),
    onExpiry: gate.onExpiry as "fail" | "reject" | "escalate",
    outcome: gate.outcome as "answered" | "expired",
    ...(typeof gate.answerer === "string" ? { answerer: gate.answerer } : {}),
    ...(typeof gate.choice === "string" ? { choice: gate.choice } : {}),
    ...(typeof gate.reason === "string" ? { reason: gate.reason } : {}),
    ...(typeof gate.answeredAt === "number"
      ? { answeredAt: new Date(gate.answeredAt).toISOString() }
      : {}),
  })),
  sandboxes: trace.sandboxes.map((sandbox) => ({
    sandboxId: String(sandbox.sandboxId),
    name: String(sandbox.name),
    provider: String(sandbox.provider),
    kind: sandbox.kind as "bind-mount" | "isolated" | "none",
    branch: String(sandbox.branch),
    worktreePath: String(sandbox.worktreePath),
    environment: sandbox.environment as Readonly<Record<string, string>>,
    acquiredAt: new Date(Number(sandbox.acquiredAt)).toISOString(),
    releasedAt: new Date(Number(sandbox.releasedAt)).toISOString(),
    outcome: sandbox.outcome as "released" | "interrupted" | "failed",
  })),
  artifacts: artifacts.map(({ artifactId, name, mediaType, size, sha256 }) => ({
    artifactId,
    name,
    mediaType,
    size,
    sha256,
  })),
});
