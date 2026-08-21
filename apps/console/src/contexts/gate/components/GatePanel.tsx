import { useSolux } from "@carere/solux";
import { createEffect, For, type JSX, Show } from "solid-js";
import { Notice } from "../../shared/components/Notice.tsx";
import { Field, Pane } from "../../shared/components/Pane.tsx";
import { settled } from "../../shared/hooks/settled.ts";
import { axisDuration, deadlineLabel, humanDuration } from "../../shared/lib/duration.ts";
import { instant } from "../../shared/lib/instant.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { DetailPanel } from "../../trace/components/DetailPanel.tsx";
import { useRun } from "../../trace/hooks/useRun.ts";
import type { GateLine, RunDoc } from "../../trace/models/RunDoc.ts";
import { deselected, type WaterfallState } from "../../trace/services/waterfallStore.ts";
import { useAskings } from "../hooks/useAskings.ts";
import { type Asking, askingOf, waitedMillis } from "../models/Asking.ts";
import { GateAnswering } from "./GateAnswering.tsx";

/**
 * One asking of one gate — **the panel's third subject**.
 *
 * console.md §3 used to say a gate was a phase of kind `actor`, so its detail was the phase panel
 * plus a form. The engine never backed that: nothing writes an actor phase record, and a gate record
 * carries no phase id, so there was no recorded link between the two to follow. The record was
 * always the better subject anyway — it is richer than a phase row could be, carrying the token, the
 * choices, the deadline and its expiry branch, the answerer and the latency — and the identity is
 * already there, because an **asking** is what a gate is keyed by.
 *
 * The panel reads two sources and needs both, which is the whole shape of adr/gate/0001:
 *
 * | Source | What only it can say |
 * |---|---|
 * | `GET /api/gates` | the request, and whether a verdict has been **recorded** |
 * | the run document | whether the run **settled** this asking, which is the only proof it applied |
 *
 * A gate that settled long ago has a record and no asking — the askings table is the reference
 * adapter's, and a factory answered from somewhere else may never have had a row. So the panel
 * renders from whichever half it has, and says which facts the other half was carrying.
 */
export const GatePanel = (props: {
  readonly runId: string;
  readonly gate: string;
  readonly asking: string;
}): JSX.Element => {
  const now = useNow();
  const run = useRun(() => props.runId);
  const store = useSolux<WaterfallState>();

  const doc = (): RunDoc | undefined => settled(run);
  /**
   * The askings keep being polled while this panel is open, because the panel is *about* a question
   * that is waiting: a verdict written from a terminal, a webhook or another browser has to land
   * here without a reload. It stops when the run does, which is when nothing can arrive any more.
   */
  const live = () => {
    const outcome = doc()?.run.outcome;
    return outcome !== "succeeded" && outcome !== "failed";
  };
  const askings = useAskings(live);

  const asking = (): Asking | undefined =>
    askingOf(settled(askings) ?? [], {
      runId: props.runId,
      gate: props.gate,
      asking: props.asking,
    });
  /** The settled record, when the run has one. This is what makes *applied* provable. */
  const record = (): GateLine | undefined =>
    doc()?.gates.find((one) => one.asking === props.asking && one.gate === props.gate);

  const known = () => asking() !== undefined || record() !== undefined;

  // One subject at a time. Opening a gate lets go of whatever span or band the waterfall was ringing,
  // exactly as opening a phase lets go of an acquisition.
  createEffect(() => {
    if (known()) store.dispatch(deselected());
  });

  return (
    <DetailPanel
      subject="gate"
      title={props.gate}
      subtitle={props.asking}
      runId={props.runId}
      states={
        <Show when={record()}>
          {(one) => (
            <span data-gate-outcome={one().outcome} class="text-muted-foreground text-xs">
              {one().outcome}
            </span>
          )}
        </Show>
      }
    >
      <Show
        when={known()}
        fallback={
          <Show
            when={doc() !== undefined && settled(askings) !== undefined}
            fallback={<p class="text-muted-foreground text-sm">Loading the gate…</p>}
          >
            {/*
             * An asking one character wrong in a pasted URL. The run is on screen behind this panel,
             * so the only thing missing is the gate, and that is the only thing this says.
             */}
            <Notice tone="empty" title={`This run has no asking ${props.asking}.`}>
              <p class="mt-1">
                An asking is the engine's own name for one round of one gate. Close this panel and
                open the gate from the card beneath the run header.
              </p>
            </Notice>
          </Show>
        }
      >
        <Pane name="question" title="The question">
          <div class="flex flex-col gap-2">
            <Field name="description" label="what is being decided">
              {asking()?.request.description ?? record()?.gate}
            </Field>
            <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <Field name="run" label="run">
                {props.runId}
              </Field>
              <Field name="actor" label="asked of">
                {asking()?.request.actor ?? record()?.actor}
              </Field>
              <Field
                name="choices"
                label="choices"
                when={asking() !== undefined}
                absent="the request is not in the askings table"
              >
                {asking()?.request.choices.join(", ")}
              </Field>
              {/*
               * The token is the whole of the authority to answer, and it is on the panel because it
               * is what a person pastes into `kojo gate answer` when they would rather not use a
               * browser at all. The Console earns no privilege that a terminal lacks.
               */}
              <Field
                name="token"
                label="token"
                when={asking() !== undefined}
                absent="only kept while the asking is open"
              >
                {asking()?.request.token}
              </Field>
            </div>
          </div>
        </Pane>

        <Pane name="waiting" title="What the wait cost">
          <div class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <Field name="requested" label="asked at">
              {instant(asking()?.request.requestedAt ?? record()?.requestedAt ?? 0)}
            </Field>
            {/*
             * Request to answer, or request to now. The metric a factory lives or dies by, and the
             * one number in the Console that no other view can state for a gate still waiting.
             */}
            <Field name="waited" label="waited">
              {axisDuration(waited(asking(), record(), now()))}
            </Field>
            <Field
              name="deadline"
              label="deadline"
              when={asking() !== undefined}
              absent="settled; the deadline no longer applies"
            >
              {deadlineLabel(asking()?.request.deadlineAt ?? 0, now())}
            </Field>
            <Field
              name="on-expiry"
              label="if it expires"
              when={asking() !== undefined}
              absent={record()?.outcome === "expired" ? "it did expire" : "—"}
            >
              {asking()?.request.onExpiry}
            </Field>
          </div>
        </Pane>

        <Pane name="answer" title="The answer">
          <Show
            when={asking()}
            fallback={
              // Settled, and the askings table never had it — or no longer does. The trace's record
              // is the authority here, and it carries everything but the token.
              <div
                class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                data-gate-from="trace"
              >
                <Field name="choice" label="choice" when={record()?.choice !== undefined}>
                  {record()?.choice}
                </Field>
                <Field name="answerer" label="answered by" when={record()?.answerer !== undefined}>
                  {record()?.answerer}
                </Field>
                <Field name="reason" label="reason" when={record()?.reason !== undefined}>
                  {record()?.reason}
                </Field>
                <Field
                  name="answered-at"
                  label="answered at"
                  when={record()?.answeredAt !== undefined}
                  absent="nobody answered"
                >
                  {instant(record()?.answeredAt ?? 0)}
                </Field>
              </div>
            }
          >
            {(open) => (
              <GateAnswering asking={open()} settled={doc()?.gates ?? []} runId={props.runId} />
            )}
          </Show>
        </Pane>

        {/*
         * What a gate costs the factory beyond the wait, when the run is one that paid it: a
         * suspension tears every container down, so the acquisitions after this asking are the
         * rebuild. Named rather than counted, because the acquisition panel is where the number is.
         */}
        <Pane name="cost" title="What the suspension cost">
          <Show
            when={rebuilt(doc(), asking(), record()).length > 0}
            fallback={
              <p data-rebuilds="none" class="text-muted-foreground text-xs italic">
                No sandbox was acquired again after this asking.
              </p>
            }
          >
            <div class="flex flex-col gap-1">
              <For each={rebuilt(doc(), asking(), record())}>
                {(sandbox) => (
                  <span data-rebuild={sandbox.sandboxId} class="font-mono text-xs break-all">
                    {sandbox.name} rebuilt —{" "}
                    {humanDuration(sandbox.releasedAt - sandbox.acquiredAt)} held
                  </span>
                )}
              </For>
            </div>
          </Show>
        </Pane>
      </Show>
    </DetailPanel>
  );
};

/** Request to answer, or request to now, from whichever half of the pair is present. */
const waited = (asking: Asking | undefined, record: GateLine | undefined, now: number): number => {
  if (asking !== undefined) return waitedMillis(asking, now);
  if (record === undefined) return 0;
  return (record.answeredAt ?? now) - record.requestedAt;
};

/** Every acquisition made after this asking was requested — the containers the suspension cost. */
const rebuilt = (
  doc: RunDoc | undefined,
  asking: Asking | undefined,
  record: GateLine | undefined,
) => {
  const requestedAt = asking?.request.requestedAt ?? record?.requestedAt;
  if (doc === undefined || requestedAt === undefined) return [];
  return doc.sandboxes.filter((sandbox) => sandbox.acquiredAt > requestedAt);
};
