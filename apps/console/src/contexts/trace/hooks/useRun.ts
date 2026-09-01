import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readRun } from "../../daemon/services/browserAccess.ts";
import { fetchJson, refused } from "../../shared/services/api.ts";
import { pollMillis } from "../../shared/services/queryClient.ts";
import type { RunDoc } from "../models/RunDoc.ts";

/**
 * One whole run, polled whole while it can still move.
 *
 * console.md §7: the run document is the run record with its in-flight phase, every phase record,
 * every settled asking and every acquisition, in one read. It is ten to forty records and a few
 * kilobytes, so replacing it wholesale removes every merge concern a cursor would create — no
 * de-duplication, no reconciling a record that changed, no gap when a poll is missed. The one
 * genuinely unbounded stream inside a run is a phase's occurrences, and that one is ticket 29's.
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
      try {
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
          })),
          gates: [],
          sandboxes: [],
          artifacts: run.artifacts ?? [],
        } satisfies RunDoc;
      } catch {
        return fetchJson<RunDoc>(`/api/runs/${encodeURIComponent(runId())}`);
      }
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
