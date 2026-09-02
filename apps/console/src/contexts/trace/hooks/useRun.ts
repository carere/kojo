import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readRun } from "../../daemon/services/browserAccess.ts";
import { refused } from "../../shared/services/api.ts";
import { pollMillis } from "../../shared/services/queryClient.ts";
import type { RunDoc } from "../models/RunDoc.ts";

/**
 * One whole run, polled whole while it can still move.
 *
 * console.md §7: the run document is the run record with its in-flight phase, every phase record,
 * every completed Phase and every captured Artifact in one read. Replacing it wholesale removes
 * every merge concern a partial update would create.
 *
 * **The interval is a function of the answer**, exactly as the run list's is, so the rule states
 * itself: once the run has reached a terminal outcome nothing else can change and the Console stops
 * asking for good. A suspended run keeps polling — it is waiting for a person and moves the moment
 * one answers.
 *
 * **A run that does not exist is also an answer, and it stops the polling too.** `404 no-such-run` is
 * refused rather than retried, but a retry policy alone would not be enough: the interval would keep
 * asking a settled question every second for as long as somebody left the tab open on a mistyped id.
 * Both halves are needed, and this is the second.
 */
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
            engineVersion: "Project runtime",
            engineCommit: run.revisionId.slice(0, 12),
            configDigest: run.packageGraphId.slice(0, 12),
            host: "local Host",
          },
          ...(run.state === "succeeded" || run.state === "failed" || run.state === "cancelled"
            ? { outcome: run.state }
            : {}),
          ...(run.finishedAt === undefined ? {} : { finishedAt: Date.parse(run.finishedAt) }),
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
      };
    }) => {
      if (refused(query.state.error)) return false as const;
      const outcome = query.state.data?.run.outcome;
      return outcome === "succeeded" || outcome === "failed" || outcome === "cancelled"
        ? (false as const)
        : pollMillis;
    },
  }));
