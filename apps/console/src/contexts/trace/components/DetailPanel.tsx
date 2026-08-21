import { Link } from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { keepView } from "../models/view.ts";

/**
 * The dock everything known about one thing is drawn in — console.md §6.
 *
 * **It is a panel and not a page**, and that is the decision the whole ticket turns on. A phase
 * detail has to be deep-linkable, because it is the thing a person pastes into a chat when they ask a
 * colleague why a run died; but replacing the waterfall with a full page would throw away the
 * position they clicked from, and the whole job is investigation *in context*. So the route is
 * nested, the waterfall stays on screen above it — pinned there, rather than beside it — and
 * closing the panel is a link back to the run
 * rather than a piece of component state.
 *
 * Two subjects share this shell: a phase, and a **sandbox acquisition**. The band on the waterfall is
 * not scenery — it is a whole record — so the panel says which of the two it is holding, both as a
 * heading and as the attribute the browser tier reads.
 */
export const DetailPanel = (props: {
  /** `phase` or `sandbox`. The panel has two subjects, not one. */
  readonly subject: string;
  readonly title: string;
  readonly subtitle: string;
  readonly runId: string;
  /** Badges beside the title — outcome, kind, whatever states the subject in one word. */
  readonly states?: JSX.Element;
  readonly children: JSX.Element;
}): JSX.Element => (
  <aside
    data-detail-panel={props.subject}
    // Full width, below the timeline, and with no height cap.
    //
    // **The `lg:max-h-[80vh]` this used to carry was never right.** It measures against the
    // viewport, but the panel starts wherever flow put it — so on a run with a gate card above it
    // the panel began at y=484 in a 720-pixel window and its own scrollbar owned the rest. A cap
    // that assumes it starts at the top of the screen cannot work anywhere it does not.
    //
    // A 448-pixel dock also cost the timeline a third of its width: the axis is a fixed 1136-pixel
    // canvas, and beside a panel it was clipped on every screen size measured. One page scroll
    // beats two nested ones.
    class="border-border bg-background flex w-full flex-col gap-4 rounded-lg border p-4"
  >
    <header class="flex flex-col gap-2">
      <div class="flex items-start justify-between gap-2">
        <div class="flex min-w-0 flex-col">
          <h2 class="truncate font-mono text-sm font-semibold">{props.title}</h2>
          <p class="text-muted-foreground truncate text-[11px]">{props.subtitle}</p>
        </div>
        {/*
         * A link, not a button. Closing the panel is a move to the run's own URL, so it goes in the
         * history and the back button does what a person expects — which a piece of state could not.
         */}
        <Link
          to="/runs/$runId"
          params={{ runId: props.runId }}
          search={keepView}
          data-panel-close
          aria-label="close the detail panel"
          class="border-border hover:bg-muted shrink-0 rounded-md border px-2 py-0.5 text-xs"
        >
          Close
        </Link>
      </div>
      <div class="flex flex-wrap items-center gap-1">{props.states}</div>
    </header>
    {props.children}
  </aside>
);
