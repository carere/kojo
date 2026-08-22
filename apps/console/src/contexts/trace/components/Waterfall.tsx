import { useSolux } from "@carere/solux";
import { createHotkey } from "@tanstack/solid-hotkeys";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import {
  Gantt,
  GanttCanvas,
  GanttHeader,
  GanttLane,
  GanttRow,
  GanttSidebar,
  sidebarWidth,
} from "../../shared/components/Gantt.tsx";
import { cn } from "../../shared/lib/cn.ts";
import { axisDuration } from "../../shared/lib/duration.ts";
import { useNow } from "../../shared/ports/Now.tsx";
import type { PhaseKind, PhaseState, RunDoc } from "../models/RunDoc.ts";
import {
  defaultBreakRule,
  type PhaseSpan,
  spansOfRow,
  spanWidth,
  type Waterfall as WaterfallView,
  waterfall,
} from "../models/waterfall.ts";
import {
  axisToggled,
  hovered,
  unhovered,
  type WaterfallState,
  zoomedIn,
  zoomedOut,
  zoomReset,
} from "../services/waterfallStore.ts";

/**
 * The centre of the product: what happened, left to right, on the row of the scope it happened in.
 *
 * The geometry is all in `models/waterfall.ts` and none of it is here — this file is markup plus the
 * grammar console.md §5 tabulates, and every element it draws carries the fact it is drawing as a
 * data attribute, so the browser tier grades the grammar rather than the colours.
 *
 * | Element | Drawn as |
 * |---|---|
 * | phase kind | span colour — `agent`, `code`, `actor` |
 * | scope | row; a sandbox row carries a band behind its spans |
 * | corrections | marks inside the **one** span, never separate spans |
 * | failure | span outline, plus the terminal error tag on the label |
 * | permission breach | its own mark — a breach is not a check violation |
 * | the in-flight phase | a span that grows to *now* |
 * | gate wait | a break carrying its duration |
 */

/**
 * How wide the axis is at zoom 1 when nothing has measured the card yet.
 *
 * **It used to be the answer rather than the fallback**, with the reason written here: *a constant
 * so a span's width is the same on every machine*. That reason was real — a screenshot of a run
 * meant the same thing everywhere — but the price turned out to be higher than the property was
 * worth. A fixed 960 plus a 176-pixel sidebar is a 1136-pixel canvas, so every card narrower than
 * that clipped the timeline and every card wider than it left the space empty. Measured with the
 * detail panel open at 1280: 382 pixels of axis unreachable, including the wall of the 41-hour
 * break — the one thing the run view exists to show.
 *
 * The property is kept where it actually mattered: **the browser tier freezes the viewport**, so
 * every fixture still draws to the same number in a test, and the spans are graded as ratios of
 * `data-canvas` rather than as absolute pixels. What changed is that a person's window now decides
 * how much room the run gets, which is what a person expects a window to do.
 */
const fallbackAxisWidth = 960;

/**
 * The narrowest axis worth drawing, below which the card scrolls instead of squeezing.
 *
 * A phone-width card would otherwise hand the timeline about 200 pixels and draw every phase in a
 * run on top of every other. Under this the canvas stops shrinking and `Gantt`'s own
 * `overflow-x-auto` takes over, which is the honest answer: the run does not fit, so it scrolls.
 */
const minimumAxisWidth = 480;

/**
 * What the axis gives back so its own last label fits.
 *
 * A tick is positioned by its `left` edge and its text runs to the right, so the final tick hangs
 * past the end of the canvas — measured at 11 px for `41h 26m`, which was enough to raise a
 * horizontal scrollbar on a timeline that otherwise fitted exactly. Reserving the room is the fix;
 * moving the label would put it left of the instant it names, and the position of a tick is the
 * whole of what it says.
 *
 * Wide enough for the longest label the formatter makes at a fine step — `41h 12m 0s`.
 */
const lastLabelWidth = 56;

/** `Gantt` draws a one-pixel border, and the canvas has to fit inside it rather than under it. */
const ganttBorder = 2;

/** A colour per kind, named after the kind. Nobody reading a component holds a colour in their head. */
const kindTone: Record<PhaseKind, string> = {
  agent: "bg-violet-500/70 text-violet-950 dark:text-violet-50",
  code: "bg-sky-500/70 text-sky-950 dark:text-sky-50",
  actor: "bg-amber-500/70 text-amber-950 dark:text-amber-50",
};

/**
 * What an outcome adds on top of the kind's colour.
 *
 * **Failure is an outline, not a different fill.** The fill already says what kind of phase it was,
 * and a run is investigated by asking *which agent phase died* — losing the kind to say "failed"
 * would answer a question nobody asked. `interrupted` is a dashed outline in a neutral colour on
 * purpose: a phase the suspension killed did nothing wrong.
 */
const stateTone: Record<PhaseState, string> = {
  succeeded: "",
  failed: "outline-2 outline-red-600 dark:outline-red-400",
  interrupted: "outline-2 outline-dashed outline-zinc-500",
  running: "outline-2 outline-sky-500 animate-pulse",
};

/** One phase, one span. Whatever it took inside, however many corrections — one. */
const Span = (props: {
  readonly span: PhaseSpan;
  readonly view: WaterfallView;
  readonly store: ReturnType<typeof useSolux<WaterfallState>>;
  readonly onPick: (span: PhaseSpan) => void;
}): JSX.Element => {
  const left = () => props.view.xOf(props.span.startedAt);
  const width = () => spanWidth(props.view, props.span);
  const breached = () => props.span.breaches.length > 0;
  /**
   * A span drawn wider than it really is has to paint over its neighbours, or it cannot be clicked.
   *
   * `spanWidth` floors the drawn width at two pixels so a very short phase still exists on screen,
   * but nothing reserves that space: `left` is the un-floored position, and the spans of a row are
   * sorted by start time, so the *next* phase is later in the DOM and paints on top of the floor.
   * Measured on the shipped fixtures: `in_progress` at x=201 w=2 sits under `route` at x=201.2
   * w=8.2, and `elementFromPoint` at its centre returns `route`. The short phase was unhoverable
   * and unclickable — and the browser suite already knew, because `realFactory.ts` pays 650 ms of
   * real sleep to give its phases enough width to be clicked.
   *
   * Raising the floor is not the fix: `Waterfall.tsx` records the decision that a span's width is
   * its duration, and a wider bar would be a lie about how long the phase took. So the narrow one
   * keeps its two pixels and wins the stack instead.
   */
  const floored = () =>
    props.view.xOf(props.span.endedAt) - props.view.xOf(props.span.startedAt) < width();

  return (
    <button
      type="button"
      data-phase={props.span.phaseId}
      data-kind={props.span.kind}
      data-state={props.span.state}
      data-corrections={props.span.corrections}
      data-breach={breached() ? "true" : "false"}
      data-error={props.span.errorTag}
      // Hover and selection are drawn as brightness and a ring, and a colour is the one thing this
      // tier refuses to grade. So each of them also says what it is, on the same rule the rest of
      // this file follows: the element carries the fact, the class carries the look.
      data-hovered={props.store.state.hovered === props.span.phaseId ? "true" : "false"}
      data-selected={props.store.state.selected === props.span.phaseId ? "true" : "false"}
      title={`${props.span.name} — ${axisDuration(props.span.endedAt - props.span.startedAt)}`}
      class={cn(
        // **No horizontal padding on the span itself.** A border-box width can never fall below the
        // padding it carries, so a padded span has a floor of twelve pixels — and a two-second phase
        // beside a six-minute one would be drawn the same width as a phase four times its length.
        // The padding belongs to the label, which is clipped instead.
        "absolute top-1/2 flex h-6 -translate-y-1/2 items-center gap-1 overflow-hidden rounded-sm text-left text-[11px] font-medium",
        kindTone[props.span.kind],
        stateTone[props.span.state],
        props.store.state.hovered === props.span.phaseId ? "brightness-110" : undefined,
        props.store.state.selected === props.span.phaseId ? "ring-foreground ring-2" : undefined,
      )}
      style={{ left: `${left()}px`, width: `${width()}px`, "z-index": floored() ? 2 : 1 }}
      onMouseEnter={() => props.store.dispatch(hovered(props.span.phaseId))}
      onMouseLeave={() => props.store.dispatch(unhovered())}
      // A click is a **navigation**, not a dispatch. The detail panel is a nested route, so what is
      // open has to be in the URL — and the ring this span draws is written by the panel the route
      // mounts, which is what keeps the two from ever disagreeing about what is being looked at.
      onClick={() => props.onPick(props.span)}
    >
      <span class="truncate px-1.5">{props.span.name}</span>

      {/*
       * The corrections, inside the one span.
       *
       * adr/trace/0001: a corrected phase is one record, so the attempts are a detail-panel concern
       * and never a timeline concern. `fix_1` / `retest_1` / `fix_2` are four separate spans because
       * the **author** wrote four phases — that distinction is the whole reason these are marks.
       */}
      <For each={Array.from({ length: props.span.corrections })}>
        {() => (
          <i
            data-correction
            class="bg-foreground/50 inline-block h-3 w-[2px] shrink-0 rounded-full"
          />
        )}
      </For>

      {/*
       * A breach has its own mark, and it must not read like a check violation.
       *
       * A failed check is an answer that was refused, and re-prompting is the cure. A breach is a
       * change the agent had no permission to make: the phase is dead, the repository may still be
       * holding something the rollback could not undo, and no amount of re-prompting touches it.
       */}
      <Show when={breached()}>
        <span
          data-mark="breach"
          title={`changed without permission: ${props.span.breaches.join(", ")}`}
          class="ml-auto shrink-0 rounded-[2px] bg-red-600 px-1 text-[9px] leading-none font-bold text-white"
        >
          BREACH
        </span>
      </Show>

      <Show when={props.span.errorTag !== undefined && !breached()}>
        <span data-tag class="ml-auto shrink-0 text-[9px] opacity-90">
          {props.span.errorTag}
        </span>
      </Show>
    </button>
  );
};

/**
 * The waterfall of one run.
 *
 * It reads the clock through the port, never the machine, so a browser test freezes it and the
 * growing span stops growing.
 */
/**
 * Everything about a view that reaches the screen, as one string.
 *
 * Compared instead of the view itself because two views can be different objects and the same
 * picture — which is the normal case on a live run, where the clock moves and the in-flight span
 * grows by a fraction of a pixel that nothing can see.
 *
 * **It is stated in drawn pixels, not in timestamps.** An in-flight phase ends at `now` and the axis
 * also ends at `now`, so both move together every tick and the bar does not move at all. A signature
 * over the raw times would differ every second and prove nothing.
 */
const drawnAs = (view: WaterfallView): string =>
  [
    Math.round(view.width),
    view.scale,
    view.ticks.map((tick) => `${Math.round(tick.offset)}@${tick.label}`).join(","),
    view.segments
      .map(
        (segment) =>
          `${segment.kind}:${Math.round(segment.offset)}:${Math.round(segment.width)}:${segment.label ?? ""}`,
      )
      .join(","),
    view.rows
      .map(
        (row) =>
          `${row.rowId}:${row.depth}:${row.held}:${Math.round(view.xOf(row.from ?? view.from))}:${Math.round(view.xOf(row.to ?? view.to))}`,
      )
      .join(","),
    view.spans
      .map(
        (span) =>
          `${span.phaseId}:${span.state}:${span.corrections}:${span.errorTag ?? ""}:${span.breaches.length}:${Math.round(view.xOf(span.startedAt))}:${Math.round(spanWidth(view, span))}`,
      )
      .join(","),
  ].join("|");

export const Waterfall = (props: {
  readonly doc: RunDoc;
  /** What a click on a span does. It opens the detail panel, which is a route. */
  readonly onPickPhase: (span: PhaseSpan) => void;
  /** What a click on a sandbox row does. The band is a whole record, so it opens one too. */
  readonly onPickScope: (sandboxId: string) => void;
}): JSX.Element => {
  const now = useNow();
  const store = useSolux<WaterfallState>();

  /**
   * The view, computed once per change rather than once per read — and it only counts as a change
   * when something drawn actually moves.
   *
   * **Two faults, and the second is the one a person sees.** It was a plain function, so every
   * `view()` in the tree below re-ran the whole layout: six times per render, plus once more inside
   * every row. And because each run produced fresh arrays of fresh objects, Solid's `<For>` — which
   * is keyed by reference — destroyed and rebuilt every tick label, every row and every span.
   *
   * On a run that is still going that happened **once a second**, for ever: the clock ticks, and an
   * in-flight phase re-renders. Measured on `run-scout`, whose `explore` phase is in flight: the
   * span element was a different node on every sample while its width never left 136 px. Nothing
   * about the picture changed and the whole picture was rebuilt anyway, which is the flash.
   *
   * `equals` is what stops it. When the freshly computed view draws the same thing, the memo keeps
   * the **previous** object and tells nobody, so every `<For>` sees the array it already has and the
   * DOM survives. A live span still grows — the signature is in whole pixels, so it updates the
   * moment it moves one, and not before.
   */
  /**
   * How much room the card is giving the timeline, watched rather than assumed.
   *
   * The section is the measured element because `Gantt` is `w-full` inside it with nothing between
   * them, so the two always agree — and measuring the section avoids putting a `ref` through a
   * component that only spreads its props.
   *
   * A `ResizeObserver` rather than a window listener: the card changes width when the detail panel
   * opens or the sidebar collapses, and neither of those resizes the window.
   */
  const [available, setAvailable] = createSignal(fallbackAxisWidth + sidebarWidth);
  /**
   * A signal rather than a bare `let`, because the hotkeys below are scoped to this element and
   * have to register only once it exists. `createHotkey` takes its options as an accessor for
   * exactly this: the registration waits for the target to be attached.
   */
  const [card, setCard] = createSignal<HTMLElement>();

  /**
   * `Mod` + wheel zooms, and a wheel with no modifier is left alone.
   *
   * **A wheel event is the one thing a hotkey library cannot do**, so this is a listener rather
   * than a `createHotkey`: `@tanstack/hotkeys` binds keys, and its whole API surface has no wheel,
   * pointer or scroll in it. The keyboard half below is what it is for.
   *
   * `passive: false` is required, and it is why this is attached by hand rather than with `onWheel`.
   * `Mod` + wheel is the browser's own page zoom; without `preventDefault` the page would zoom and
   * the timeline would zoom at the same time. A trackpad pinch arrives here too — the browser sends
   * it as a wheel with `ctrlKey` set — so pinching the timeline zooms the timeline, which is what
   * somebody pinching a timeline means.
   *
   * A plain wheel is deliberately untouched. The scroller already pans left and right natively, and
   * a timeline that swallowed vertical scroll would trap the page behind it.
   */
  const onWheel = (event: WheelEvent): void => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    store.dispatch(event.deltaY < 0 ? zoomedIn() : zoomedOut());
  };

  onMount(() => {
    const element = card();
    if (element === undefined) return;

    element.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => element.removeEventListener("wheel", onWheel));

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured !== undefined && measured > 0) setAvailable(measured);
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  /** The lane, once the row labels, the border and the last tick's label have taken their room. */
  const axisWidth = (): number =>
    Math.max(available() - sidebarWidth - ganttBorder - lastLabelWidth, minimumAxisWidth) *
    store.state.zoom;

  const view = createMemo(
    (): WaterfallView =>
      waterfall(props.doc, now(), {
        width: axisWidth(),
        breaks: store.state.breaks,
        // Two floors, because a break over a bar and a break over a gap cost different things —
        // see `BreakRule.deadFloorMillis`. Only `share` is under the reader's control.
        rule: {
          share: store.state.share,
          floorMillis: defaultBreakRule.floorMillis,
          deadFloorMillis: defaultBreakRule.deadFloorMillis,
        },
      }),
    undefined,
    { equals: (before, after) => drawnAs(before) === drawnAs(after) },
  );

  /**
   * The keyboard half, scoped to the timeline rather than to the page.
   *
   * `target` is the card, so these only fire while something inside the timeline has focus — which
   * is why the section carries `tabindex`. Page-wide bindings would be worse than none: `+` and `-`
   * belong to whatever a person is typing into, and this Console has a textarea on the same screen
   * for answering a gate.
   *
   * Bare keys rather than `Mod+=` and `Mod+-` on purpose. Those two are the browser's own page zoom,
   * and taking them from a person who meant to make the whole page bigger is not a trade this
   * feature is worth.
   */
  createHotkey(
    "=",
    () => store.dispatch(zoomedIn()),
    () => ({ target: card() ?? null }),
  );
  createHotkey(
    "-",
    () => store.dispatch(zoomedOut()),
    () => ({ target: card() ?? null }),
  );
  createHotkey(
    "0",
    () => store.dispatch(zoomReset()),
    () => ({ target: card() ?? null }),
  );

  const breaks = () => view().segments.filter((segment) => segment.kind === "break");

  return (
    <section class="flex flex-col gap-2" data-waterfall ref={setCard} tabindex="0">
      <div class="flex flex-wrap items-center gap-3 text-xs">
        {/*
         * **The label used to name the action while the attribute named the state**, so the button
         * read `Break the axis` at exactly the moment the axis was *not* broken, and there was no
         * way to tell which of the two you were looking at. It is a switch now: the box says whether
         * it is on, the words never change, and what it does is written beside it in full rather
         * than left for the reader to infer from a word.
         */}
        <button
          type="button"
          data-axis={store.state.breaks ? "broken" : "wall-clock"}
          aria-pressed={store.state.breaks}
          title="A break hides a stretch of the run where nothing was happening, so the phases either side of it keep a readable width. The hidden time is written on the wall."
          class={cn(
            "flex items-center gap-2 rounded-md border px-2 py-1",
            store.state.breaks ? "border-foreground bg-muted" : "border-border hover:bg-muted",
          )}
          onClick={() => store.dispatch(axisToggled())}
        >
          <span
            aria-hidden="true"
            class={cn(
              "flex h-3 w-3 items-center justify-center rounded-[3px] border text-[9px] leading-none",
              store.state.breaks
                ? "border-foreground bg-foreground text-background"
                : "border-border",
            )}
          >
            {store.state.breaks ? "✓" : ""}
          </span>
          Hide long waits
        </button>

        <span class="text-muted-foreground" data-scale={view().scale}>
          scale {view().scale}
        </span>

        {/*
         * What the switch is actually doing to what you are looking at, in words. Without this the
         * only way to know whether anything was hidden — and how much — was to spot a wall in the
         * chart and read the label on it.
         */}
        <span class="text-muted-foreground" data-axis-note>
          {store.state.breaks
            ? breaks().length === 0
              ? "· nothing long enough to hide"
              : `· ${breaks().length} ${breaks().length === 1 ? "gap" : "gaps"} hidden: ${breaks()
                  .map((segment) => segment.label)
                  .join(", ")}`
            : "· every gap drawn to scale"}
        </span>
        <span class="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-zoom="out"
            class="border-border hover:bg-muted rounded-md border px-2 py-1"
            onClick={() => store.dispatch(zoomedOut())}
          >
            −
          </button>
          <button
            type="button"
            data-zoom="reset"
            class="border-border hover:bg-muted rounded-md border px-2 py-1"
            onClick={() => store.dispatch(zoomReset())}
          >
            {store.state.zoom}×
          </button>
          <button
            type="button"
            data-zoom="in"
            class="border-border hover:bg-muted rounded-md border px-2 py-1"
            onClick={() => store.dispatch(zoomedIn())}
          >
            +
          </button>
        </span>
      </div>

      <Gantt>
        {/* The axis is exactly this wide, so its right edge is *now* on a run that is still going. */}
        <GanttCanvas width={view().width} data-canvas={Math.round(view().width)}>
          <GanttHeader>
            <GanttSidebar class="text-muted-foreground text-[11px]">scope</GanttSidebar>
            <GanttLane>
              <For each={view().ticks}>
                {(tick) => (
                  <span
                    data-tick
                    class="text-muted-foreground absolute top-1 text-[10px] tabular-nums"
                    style={{ left: `${tick.offset}px` }}
                  >
                    {tick.label}
                  </span>
                )}
              </For>
              {/*
               * The break's label lives in the header, over the wall that crosses every row below —
               * one statement of what was elided, rather than one per row saying the same thing.
               */}
              <For each={breaks()}>
                {(segment) => (
                  <span
                    data-break-label={segment.label}
                    class="text-muted-foreground absolute inset-y-0 flex items-center justify-center text-[10px] font-medium"
                    style={{ left: `${segment.wallOffset}px`, width: `${segment.wallWidth}px` }}
                  >
                    ⏸ {segment.label}
                  </span>
                )}
              </For>
            </GanttLane>
          </GanttHeader>

          <div class="relative">
            <For each={view().rows}>
              {(row) => (
                <GanttRow
                  data-row={row.rowId}
                  data-scope={row.scope}
                  data-depth={row.depth}
                  data-held={row.held ? "true" : "false"}
                  data-selected={store.state.scope === row.rowId ? "true" : "false"}
                >
                  <GanttSidebar depth={row.depth}>
                    {/*
                     * The scope's own name, and on a sandbox row it is the way into the record
                     * behind the band. The host is not a record — it is the absence of one — so it
                     * is drawn as the plain word it is.
                     */}
                    <Show
                      when={row.scope === "sandbox"}
                      fallback={<span class="truncate text-xs font-medium">{row.label}</span>}
                    >
                      <button
                        type="button"
                        data-scope-open={row.rowId}
                        class={cn(
                          "truncate text-left text-xs font-medium underline-offset-2 hover:underline",
                          store.state.scope === row.rowId ? "underline" : undefined,
                        )}
                        onClick={() => props.onPickScope(row.rowId)}
                      >
                        {row.label}
                      </button>
                    </Show>
                    <Show when={row.acquisition}>
                      {(acquisition) => (
                        <span
                          data-acquisition={acquisition().ordinal}
                          class="text-muted-foreground text-[10px]"
                        >
                          acquisition {acquisition().ordinal} of {acquisition().of}
                        </span>
                      )}
                    </Show>
                    <Show when={row.scope === "host"}>
                      <span class="text-muted-foreground text-[10px]">no container</span>
                    </Show>
                  </GanttSidebar>
                  <GanttLane>
                    {/* The band: a sandbox row is a whole acquisition, from build to teardown. */}
                    <Show when={row.scope === "sandbox" && row.from !== undefined}>
                      <div
                        data-band={row.rowId}
                        class="bg-muted absolute inset-y-1 rounded-sm"
                        style={{
                          left: `${view().xOf(row.from ?? view().from)}px`,
                          width: `${Math.max(view().xOf(row.to ?? view().to) - view().xOf(row.from ?? view().from), 2)}px`,
                        }}
                      />
                    </Show>
                    <For each={spansOfRow(view().spans, row.rowId)}>
                      {(span) => (
                        <Span span={span} view={view()} store={store} onPick={props.onPickPhase} />
                      )}
                    </For>
                  </GanttLane>
                </GanttRow>
              )}
            </For>

            {/*
             * The breaks, drawn across every row.
             *
             * One wall through the whole run rather than a gap in each row: a gate stops the entire
             * run, and drawing it per row would say it stopped only the rows it happened to touch.
             */}
            <div
              class="pointer-events-none absolute inset-y-0 right-0"
              style={{ left: `${sidebarWidth}px` }}
            >
              <For each={breaks()}>
                {(segment) => (
                  <div
                    data-break={segment.label}
                    data-break-dense={segment.dense ? "true" : "false"}
                    class="border-border/80 bg-background/85 absolute inset-y-0 border-x border-dashed"
                    style={{ left: `${segment.wallOffset}px`, width: `${segment.wallWidth}px` }}
                  />
                )}
              </For>
            </div>
          </div>
        </GanttCanvas>
      </Gantt>
    </section>
  );
};
