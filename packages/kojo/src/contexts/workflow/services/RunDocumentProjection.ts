import { decodeRollbackOutcome } from "@carere/kojo-client-contracts/contexts/client/contracts/rollback";
import type { RunDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { TraceProjection } from "../../trace/models/DaemonTrace.ts";
import type { ArtifactRepository } from "../../trace/ports/ArtifactRepository.ts";
import type { DaemonRun, PhaseResult } from "../models/DaemonRun.ts";
import type { ExternalActionIntent } from "../models/ExternalAction.ts";

const internalPhaseDescription = "__kojo_internal_activity__";

const terminal = (run: DaemonRun): boolean =>
  run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";

const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

const agentOf = (value: unknown): RunDocument["phases"][number]["agent"] | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const agent = value as Record<string, unknown>;
  if (
    typeof agent.agent !== "string" ||
    typeof agent.model !== "string" ||
    typeof agent.session !== "string" ||
    typeof agent.resumed !== "boolean" ||
    typeof agent.tokensIn !== "number" ||
    typeof agent.tokensOut !== "number" ||
    (agent.contextTokens !== undefined && typeof agent.contextTokens !== "number")
  )
    return undefined;
  return {
    agent: agent.agent,
    model: agent.model,
    session: agent.session,
    resumed: agent.resumed,
    tokensIn: agent.tokensIn,
    tokensOut: agent.tokensOut,
    ...(typeof agent.contextTokens === "number" ? { contextTokens: agent.contextTokens } : {}),
  };
};

const repoOf = (value: unknown): RunDocument["phases"][number]["repo"] | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const repo = value as Record<string, unknown>;
  const claimed = strings(repo.claimed);
  const changed = strings(repo.changed);
  const commits = strings(repo.commits);
  return claimed === undefined || changed === undefined || commits === undefined
    ? undefined
    : { claimed, changed, commits };
};

const breachesOf = (value: unknown): RunDocument["phases"][number]["breaches"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const breaches: Array<NonNullable<RunDocument["phases"][number]["breaches"]>[number]> = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const breach = item as Record<string, unknown>;
    const outcome = decodeRollbackOutcome(breach.outcome);
    if (typeof breach.path !== "string" || !outcome.ok) return undefined;
    breaches.push({ path: breach.path, outcome: outcome.value });
  }
  return breaches;
};

const verificationOf = (
  value: unknown,
): RunDocument["phases"][number]["verification"] | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const verification = value as Record<string, unknown>;
  const ran = strings(verification.ran);
  const failed = strings(verification.failed);
  if (
    typeof verification.envelope !== "string" ||
    ran === undefined ||
    failed === undefined ||
    typeof verification.corrections !== "number" ||
    typeof verification.correctable !== "boolean"
  )
    return undefined;
  return {
    envelope: verification.envelope,
    ran,
    failed,
    corrections: verification.corrections,
    correctable: verification.correctable,
  };
};

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
          const agent = agentOf(phase.agent);
          const repo = repoOf(phase.repo);
          const breaches = breachesOf(phase.breaches);
          const verification = verificationOf(phase.verification);
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
            ...(agent === undefined ? {} : { agent }),
            ...(repo === undefined ? {} : { repo }),
            ...(breaches === undefined ? {} : { breaches }),
            ...(verification === undefined ? {} : { verification }),
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
