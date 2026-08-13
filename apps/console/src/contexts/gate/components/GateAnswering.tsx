import { createSignal, For, type JSX, Show } from "solid-js";
import { Badge, type BadgeTone } from "../../shared/components/Badge.tsx";
import { refusal, settled } from "../../shared/hooks/settled.ts";
import { useHealth } from "../../shared/hooks/useHealth.ts";
import { humanDuration } from "../../shared/lib/duration.ts";
import type { RunnerPresence } from "../../shared/models/Health.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { useAnswerGate } from "../hooks/useAnswerGate.ts";
import type { Asking } from "../models/Asking.ts";
import {
  type AnsweringState,
  answerable,
  answeringDetail,
  answeringHeadline,
  answeringState,
  isRecorded,
  isSettled,
  type SettledAsking,
} from "../models/answering.ts";

/**
 * One click, and then the truth about what that click did — console.md §9.
 *
 * **This is the component adr/gate/0001 exists to constrain.** The `POST` records a verdict; it does
 * not apply one. So nothing here ever draws a tick on the strength of a 200: the answer resolves
 * into one of three states, each with its own word, and *applied* is drawn from the run's own
 * settled record and from nothing else.
 *
 * Where the runner presence comes from is the other half of that honesty:
 *
 * - **The receipt**, at the instant the verdict was written. The server reads the runner table as it
 *   writes, so the first rendering after a click is right with no second round trip.
 * - **The health document afterwards**, polled while — and only while — a verdict is recorded and
 *   nothing has applied it. A watcher can be killed while this card sits on screen, and a card still
 *   saying *applying…* half an hour later would be the same lie in slow motion.
 *
 * The two are ordered by which was measured later, using the cache's own timestamps rather than a
 * clock read here: `dataUpdatedAt` and `submittedAt` are both stamped by TanStack, so the comparison
 * needs no `Date.now()` and the injected clock stays the only time this component renders.
 */

const tones: Record<AnsweringState, BadgeTone> = {
  waiting: "waiting",
  overdue: "danger",
  applying: "running",
  applied: "good",
  // Not *good*. A gate that ran out of time is a decision the factory asked for and never got, and
  // drawing it in the colour of a success would hide the one thing worth noticing about it.
  expired: "danger",
  idle: "waiting",
};

export const GateAnswering = (props: {
  readonly asking: Asking;
  /** Every settled asking of this run, from the run document. The only proof of *applied*. */
  readonly settled: ReadonlyArray<SettledAsking>;
  readonly runId: string;
}): JSX.Element => {
  const now = useNow();
  const answer = useAnswerGate({ runId: () => props.runId });
  const [reason, setReason] = createSignal("");

  const receipt = () => answer.data;

  /**
   * Is a verdict written down with nothing yet to show for it? That is when presence is worth asking.
   *
   * It stops at any settlement, not only at an applied one: once the run has recorded how this
   * asking ended — answered or expired — no runner is going to apply anything to it, and a poll that
   * kept running would be asking a question whose answer can no longer change what is on screen.
   */
  const pending = () =>
    (props.asking.verdict !== undefined || receipt() !== undefined) &&
    !isSettled(props.asking, props.settled);

  const health = useHealth(pending);

  /**
   * Whether anybody can apply an answer, from whichever source measured it last.
   *
   * `undefined` while nothing has answered yet, which `answeringState` reads as *nothing is
   * running* — the safe direction, and it is corrected within one poll.
   */
  const runner = (): RunnerPresence | undefined => {
    const document = settled(health);
    if (document !== undefined && health.dataUpdatedAt > answer.submittedAt) return document.runner;
    return receipt()?.runner ?? document?.runner;
  };

  const state = (): AnsweringState =>
    answeringState({
      asking: props.asking,
      settled: props.settled,
      runner: runner(),
      now: now(),
    });

  /** The verdict on screen: the one this page wrote, or the one the askings already carried. */
  const verdict = () => receipt()?.verdict ?? props.asking.verdict;

  /** How long the answer has been waiting to be applied. Ten seconds is ordinary; ten minutes is not. */
  const sinceAnswer = () => {
    const answeredAt = verdict()?.answeredAt;
    return answeredAt === undefined ? undefined : humanDuration(Math.max(0, now() - answeredAt));
  };

  const give = (choice: string): void => {
    answer.mutate({ token: props.asking.request.token, answer: { choice, reason: reason() } });
  };

  return (
    <div class="flex flex-col gap-3" data-gate-answering={props.asking.request.asking}>
      <div
        data-answering={state()}
        class="border-border flex flex-col gap-1 rounded-md border px-3 py-2"
      >
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone={tones[state()]}>{answeringHeadline[state()]}</Badge>
          {/*
           * How long it has been in this state, drawn beside it rather than hidden. *Applying* is
           * normal for around ten seconds; the only way somebody can tell that from an apply that is
           * never coming is to be shown the number.
           */}
          <Show when={isRecorded(state()) && sinceAnswer() !== undefined}>
            <span data-answering-since class="text-muted-foreground text-xs">
              {sinceAnswer()} ago
            </span>
          </Show>
        </div>
        <p class="text-muted-foreground text-xs">{answeringDetail[state()]}</p>
        <Show when={verdict()}>
          {(given) => (
            <p data-answering-verdict class="text-xs">
              <span class="font-mono">{given().choice}</span> by{" "}
              <span class="font-mono">{given().answerer}</span>
              <Show when={given().reason !== ""}> — {given().reason}</Show>
            </p>
          )}
        </Show>
      </div>

      {/*
       * The controls disappear once a verdict exists, and that is not cosmetic: the engine keeps the
       * first answer, so a second click could only ever produce a refusal over a decision already
       * made. What replaces them is the state above, which is the thing worth looking at by then.
       *
       * They disappear over an **expired** asking for the stronger reason: the run has already taken
       * its expiry branch, so there is no longer a decision to make. Offering a button there would
       * invite somebody to answer a question the factory stopped asking.
       */}
      <Show when={answerable(state())}>
        <div class="flex flex-col gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-muted-foreground text-[10px] tracking-wide uppercase">
              reason — the next attempt is re-prompted from it
            </span>
            <textarea
              data-gate-reason
              rows="2"
              value={reason()}
              onInput={(event) => setReason(event.currentTarget.value)}
              placeholder="Why this answer? An empty reason costs the next attempt its only clue."
              class="border-border bg-background rounded-md border px-2 py-1 text-xs"
            />
          </label>
          <div class="flex flex-wrap items-center gap-2">
            {/*
             * One button per **declared** choice. The gate says what it accepts and the API refuses
             * anything else, so a page that drew *approve* and *reject* would be inventing a
             * vocabulary and hiding whatever third answer the workflow was written to handle.
             */}
            <For each={props.asking.request.choices}>
              {(choice) => (
                <button
                  type="button"
                  data-gate-choice={choice}
                  disabled={answer.isPending}
                  onClick={() => give(choice)}
                  class="border-border hover:bg-muted rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50"
                >
                  {choice}
                </button>
              )}
            </For>
            <Show when={answer.isPending}>
              <span data-gate-sending class="text-muted-foreground text-xs">
                writing it down…
              </span>
            </Show>
          </div>
        </div>
      </Show>

      {/*
       * A refusal is the server answering, and each of the three says something different: a token
       * this factory never asked, a gate somebody else answered first, and a choice this gate does
       * not accept. Drawn with the API's own code so none of them reads as an outage.
       */}
      <Show when={refusal(answer)}>
        {(problem) => (
          <p data-gate-refusal={problem().code} class="text-xs text-red-700 dark:text-red-300">
            {problem().message}
          </p>
        )}
      </Show>
    </div>
  );
};
