import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { readDaemon, recordGateVerdict } from "../../daemon/services/browserAccess.ts";
import type { RunnerPresence } from "../../shared/models/Health.ts";

/**
 * What the Daemon Gate-answer endpoint gives back.
 *
 * **There is no `applied` field, and there cannot be one.** Applying is a runner picking the answer
 * up on its own poll, which by definition has not happened when this response is written. What the
 * The old Console adapter also returned a Runner observation. Keep it optional while the view moves
 * to Daemon-owned Run state; it is not execution authority.
 */
export interface GateReceipt {
  readonly verdict: {
    readonly choice: string;
    readonly reason: string;
    readonly answerer: string;
    readonly answeredAt: number;
  };
  readonly runner?: RunnerPresence;
}

/** What a browser sends. The answerer is not in it: the server records the OS user (console.md §9). */
export interface GateAnswer {
  readonly choice: string;
  readonly reason: string;
}

/**
 * Answering, as the one mutation this Console has.
 *
 * Three things it deliberately does not do:
 *
 * - **It does not resolve the deferred.** It posts, and a live runner applies (adr/gate/0001). The
 *   Console is one more answering half and earns no privilege a Slack adapter lacks.
 * - **It does not retry or fall back.** The request identity is the only safe way to recover an
 *   uncertain reply. A second endpoint call could duplicate a mutation.
 * - **It does not decide what happened.** It hands back the receipt; `answeringState` decides, from
 *   the receipt, the askings and the run document together.
 *
 * What it does do is invalidate both reads the answer changes — the askings, which gain the verdict,
 * and this run's document, which is where the settled record will appear when a runner applies it.
 * Without that the page would keep the pre-answer askings until the next poll tick.
 */
export const useAnswerGate = (subject: { readonly runId: () => string }) => {
  const client = useQueryClient();
  return useMutation(() => ({
    mutationKey: ["gate-answer"],
    mutationFn: async (given: {
      readonly token: string;
      readonly answer: GateAnswer;
    }): Promise<GateReceipt> => {
      const daemon = await readDaemon();
      const result = await recordGateVerdict({
        requestId: crypto.randomUUID(),
        dataIdentity: daemon.dataIdentity,
        token: given.token,
        choice: given.answer.choice,
        reason: given.answer.reason,
      });
      const verdict = result.asking.verdict;
      if (verdict === undefined) throw new Error("the Daemon did not return the Recorded Verdict");
      return {
        verdict: {
          choice: verdict.choice,
          reason: verdict.reason,
          answerer: verdict.answerer,
          answeredAt: Date.parse(verdict.recordedAt),
        },
      } satisfies GateReceipt;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["gates"] });
      void client.invalidateQueries({ queryKey: ["run", subject.runId()] });
    },
  }));
};
