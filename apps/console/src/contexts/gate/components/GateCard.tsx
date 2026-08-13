import { Link } from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { Field } from "../../shared/components/Pane.tsx";
import { axisDuration, deadlineLabel } from "../../shared/lib/duration.ts";
import { instant } from "../../shared/lib/instant.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import { keepView } from "../../trace/models/view.ts";
import { type Asking, waitedMillis } from "../models/Asking.ts";
import type { SettledAsking } from "../models/answering.ts";
import { GateAnswering } from "./GateAnswering.tsx";

/**
 * What this run is stopped on, directly beneath the header — console.md §4.
 *
 * It is placed there because it is the one thing on the page a person can *act* on. Everything below
 * it says what happened; this says what is being decided, how long it has already cost, when the
 * decision stops being possible, and which way the run goes if nobody makes it.
 *
 * **Human latency is the number a factory lives or dies by**, so the wait is stated on the card
 * rather than left to be worked out from two timestamps — and it is stated while the wait is still
 * happening, which is the only time anybody can shorten it.
 *
 * The card is not the whole record. The gate has a route of its own, and the link into it is what
 * makes the deeper facts — the token, the asking, the exact instants — one click away without
 * putting them all in the header of a run somebody is trying to read.
 */
export const GateCard = (props: {
  readonly asking: Asking;
  readonly settled: ReadonlyArray<SettledAsking>;
  readonly runId: string;
}): JSX.Element => {
  const now = useNow();
  const request = () => props.asking.request;

  return (
    <section
      data-gate-card={request().gate}
      data-gate-asking={request().asking}
      class="border-border bg-muted/30 flex flex-col gap-3 rounded-lg border p-4"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="flex min-w-0 flex-col gap-0.5">
          <h2 class="text-sm font-semibold">
            <span class="font-mono">{request().gate}</span> — {request().description}
          </h2>
          <p class="text-muted-foreground text-xs">
            asked of <span class="font-mono">{request().actor}</span>
          </p>
        </div>
        {/*
         * A link and not a button: the gate is a subject of the detail panel, so *the whole record*
         * is a URL somebody can paste, exactly as a phase and an acquisition are.
         */}
        <Link
          to="/runs/$runId/gates/$gate/$asking"
          params={{
            runId: props.runId,
            gate: request().gate,
            asking: request().asking,
          }}
          search={keepView}
          data-gate-open
          class="border-border hover:bg-muted shrink-0 rounded-md border px-2 py-0.5 text-xs"
        >
          the whole record →
        </Link>
      </div>

      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {/*
         * The metric the factory is judged on, readable while it is still being paid.
         *
         * In hours rather than days, on the same rule the time axis follows: *1d 17h* is the same
         * quantity written so that nobody can compare it with the two-minute phase beside it without
         * doing arithmetic, and comparing is the only reason the number is on screen.
         */}
        <Field name="waited" label="waited">
          {axisDuration(waitedMillis(props.asking, now()))}
        </Field>
        <Field name="deadline" label="deadline">
          {deadlineLabel(request().deadlineAt, now())}
        </Field>
        <Field name="deadline-at" label="deadline at">
          {instant(request().deadlineAt)}
        </Field>
        {/*
         * Which way the run goes if nobody answers. Without it the deadline is a number with no
         * consequence attached, and *fail* and *reject* are very different things to walk away from.
         */}
        <Field name="on-expiry" label="if it expires">
          {request().onExpiry}
        </Field>
      </div>

      <GateAnswering asking={props.asking} settled={props.settled} runId={props.runId} />
    </section>
  );
};
