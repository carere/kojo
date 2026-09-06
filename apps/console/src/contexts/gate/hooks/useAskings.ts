import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { readAskings } from "../../daemon/services/browserAccess.ts";
import { daemonPollInterval, pollMillis } from "../../shared/services/queryClient.ts";
import type { Asking } from "../models/Asking.ts";

/**
 * Read all Daemon Askings, including settled Askings. The caller controls polling while Runs are
 * live. The Gate queue and Run views share this query and filter its snapshot for their own view.
 */
export const useAskings = (live: Accessor<boolean>): UseQueryResult<ReadonlyArray<Asking>, Error> =>
  useQuery(() => ({
    queryKey: ["gates"],
    queryFn: async () => {
      const snapshot = await readAskings();
      return snapshot.askings.map(
        (asking): Asking => ({
          daemonState: asking.state,
          ...(asking.appliedAt === undefined ? {} : { appliedAt: Date.parse(asking.appliedAt) }),
          ...(asking.terminalInability === undefined
            ? {}
            : { terminalInability: asking.terminalInability }),
          request: {
            runId: asking.identity.runId,
            gate: asking.identity.gatePath,
            asking: `gate/${asking.identity.gatePath}/${asking.identity.askingNumber}/${asking.identity.escalationStage}`,
            description: asking.description,
            actor: asking.actor,
            choices: asking.choices,
            token: asking.token,
            requestedAt: Date.parse(asking.createdAt),
            deadlineAt: Date.parse(asking.deadline),
            onExpiry: asking.expiryBranch,
          },
          ...(asking.verdict === undefined
            ? {}
            : {
                verdict: {
                  choice: asking.verdict.choice,
                  reason: asking.verdict.reason,
                  answerer: asking.verdict.answerer,
                  answeredAt: Date.parse(asking.verdict.recordedAt),
                },
              }),
          ...(asking.expiredAt === undefined ? {} : { expiredAt: Date.parse(asking.expiredAt) }),
        }),
      );
    },
    refetchInterval: (query) => daemonPollInterval(query, live() ? pollMillis : false),
  }));
