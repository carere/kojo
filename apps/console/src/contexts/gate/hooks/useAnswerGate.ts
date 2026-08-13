import { useMutation, useQueryClient } from "@tanstack/solid-query";
import type { RunnerPresence } from "../../shared/models/Health.ts";
import { postJson } from "../../shared/services/api.ts";

/**
 * What `POST /api/gates/:token/answer` gives back.
 *
 * **There is no `applied` field, and there cannot be one.** Applying is a runner picking the answer
 * up on its own poll, which by definition has not happened when this response is written. What the
 * receipt does carry is `runner`, read at the moment the verdict was written — so the card resolves
 * *recorded — applying…* against *recorded — nothing is running* with no second round trip and no
 * window in which it shows the wrong one.
 */
export interface GateReceipt {
  readonly verdict: {
    readonly choice: string;
    readonly reason: string;
    readonly answerer: string;
    readonly answeredAt: number;
  };
  readonly runner: RunnerPresence;
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
 * - **It does not retry.** The endpoint refuses a second answer with `409 already-answered` because
 *   the first answer is the one that counts, so a retry could only turn a success into a refusal
 *   over a verdict already written. Mutations do not retry by default and this one must not.
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
    mutationFn: (given: { readonly token: string; readonly answer: GateAnswer }) =>
      postJson<GateReceipt>(
        `/api/gates/${encodeURIComponent(given.token)}/answer`,
        given.answer satisfies GateAnswer,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["gates"] });
      void client.invalidateQueries({ queryKey: ["run", subject.runId()] });
    },
  }));
};
