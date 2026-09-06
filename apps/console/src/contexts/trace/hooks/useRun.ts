import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readRun } from "../../daemon/services/browserAccess.ts";
import { refused } from "../../shared/services/api.ts";
import { daemonPollInterval, pollMillis } from "../../shared/services/queryClient.ts";
import type { RunDoc } from "../models/RunDoc.ts";

/** Read one complete Run snapshot and poll while it can change. Replace the snapshot as a whole. */
export const useRun = (runId: () => string): UseQueryResult<RunDoc, Error> =>
  useQuery(() => ({
    queryKey: ["run", runId()],
    queryFn: async () => {
      const run = await readRun(runId());
      return {
        daemon: {
          projectId: run.projectId,
          revisionId: run.revisionId,
          packageGraphId: run.packageGraphId,
          state: run.state,
          ...(run.queueReason === undefined ? {} : { queueReason: run.queueReason }),
          ...(run.executionFault === undefined ? {} : { executionFault: run.executionFault }),
          ...(run.cancellation === undefined ? {} : { cancellation: run.cancellation }),
          ...(run.recovery === undefined ? {} : { recovery: run.recovery }),
          ...(run.cleanup === undefined ? {} : { cleanup: run.cleanup }),
          ...(run.uncertainty === undefined ? {} : { uncertainty: run.uncertainty }),
        },
        run: {
          run: {
            runId: run.runId,
            workflow: run.workflowName,
            idempotencyKey: "retained by the Daemon",
            startedAt: Date.parse(run.startedAt ?? run.admittedAt),
            engineVersion: run.provenance?.engineVersion ?? "not recorded",
            engineCommit: run.provenance?.engineCommit ?? "not recorded",
            configDigest: run.provenance?.configDigest ?? "not recorded",
            host: run.provenance?.host ?? "not recorded",
          },
          ...(run.state === "succeeded" || run.state === "failed" || run.state === "cancelled"
            ? { outcome: run.state }
            : {}),
          ...(run.finishedAt === undefined ? {} : { finishedAt: Date.parse(run.finishedAt) }),
          ...(run.inFlight === undefined
            ? {}
            : {
                inFlight: {
                  phaseId: `${run.runId}/${run.inFlight.phasePath}/${run.inFlight.attempt}`,
                  name: run.inFlight.phasePath,
                  kind: run.inFlight.kind,
                  attempt: run.inFlight.attempt,
                  startedAt: Date.parse(run.inFlight.startedAt),
                  ...(run.inFlight.sandboxId === undefined
                    ? {}
                    : { sandboxId: run.inFlight.sandboxId }),
                },
              }),
        },
        phases: run.phases.map((phase) => ({
          phaseId: `${run.runId}/${phase.phasePath}/${phase.attempt}`,
          name: phase.phasePath,
          description: phase.description,
          kind: phase.kind,
          outcome: phase.outcome,
          attempt: phase.attempt,
          startedAt: Date.parse(phase.startedAt),
          endedAt: Date.parse(phase.endedAt),
          ...(phase.sandboxId === undefined ? {} : { sandboxId: phase.sandboxId }),
          ...(phase.errorTag === undefined ? {} : { errorTag: phase.errorTag }),
          ...(phase.breaches === undefined ? {} : { breaches: phase.breaches }),
          ...(phase.verification === undefined ? {} : { verification: phase.verification }),
          ...(phase.agent === undefined ? {} : { agent: phase.agent }),
          ...(phase.repo === undefined ? {} : { repo: phase.repo }),
        })),
        gates: (run.gates ?? []).map((gate) => ({
          gate: gate.gate,
          asking: gate.asking,
          description: gate.description,
          actor: gate.actor,
          requestedAt: Date.parse(gate.requestedAt),
          deadlineAt: Date.parse(gate.deadlineAt),
          onExpiry: gate.onExpiry,
          outcome: gate.outcome,
          ...(gate.answerer === undefined ? {} : { answerer: gate.answerer }),
          ...(gate.choice === undefined ? {} : { choice: gate.choice }),
          ...(gate.reason === undefined ? {} : { reason: gate.reason }),
          ...(gate.answeredAt === undefined ? {} : { answeredAt: Date.parse(gate.answeredAt) }),
        })),
        sandboxes: (run.sandboxes ?? []).map((sandbox) => ({
          sandboxId: sandbox.sandboxId,
          name: sandbox.name,
          provider: sandbox.provider,
          kind: sandbox.kind,
          branch: sandbox.branch,
          worktreePath: sandbox.worktreePath,
          environment: { ...sandbox.environment },
          acquiredAt: Date.parse(sandbox.acquiredAt),
          releasedAt: Date.parse(sandbox.releasedAt),
          outcome: sandbox.outcome,
        })),
        artifacts: run.artifacts ?? [],
      } satisfies RunDoc;
    },
    refetchInterval: (query: {
      readonly state: {
        readonly data: RunDoc | undefined;
        readonly error: Error | null;
        readonly fetchFailureCount: number;
      };
    }) => {
      if (refused(query.state.error)) return false as const;
      const outcome = query.state.data?.run.outcome;
      return daemonPollInterval(
        query,
        outcome === "succeeded" || outcome === "failed" || outcome === "cancelled"
          ? false
          : pollMillis,
      );
    },
  }));
