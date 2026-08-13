import { configureStore, createEvent, createSlice, type Store } from "@carere/solux";

/**
 * The waterfall's own interaction state — Solux, scoped to one component.
 *
 * console.md §8 draws the line this file sits on, and it has two sides:
 *
 * - **TanStack Query loads data. Solux does not.** Nothing here fetches, nothing here holds a run,
 *   and no handler below is asynchronous. The run document arrives through `useRun`, and this store
 *   only ever answers *how is it being looked at*.
 * - **It is not a global store.** It is created inside the waterfall, provided to its own subtree,
 *   and discarded when the run view unmounts. Two run views would have two of them, which is right:
 *   a zoom is a property of a thing somebody is looking at, not of the application.
 *
 * What lives here is what §8 names — zoom, hover, selection, and the **break thresholds**. What does
 * not is the timeline-or-table toggle: §8 puts that in the URL, because the URL is what a person
 * pastes to a colleague, and "look at the table" has to survive being pasted. Wall-clock is a break
 * threshold rather than a view — it is the axis with every break given up — so it stays here.
 */

/**
 * The state, and it is deliberately not `readonly`.
 *
 * Solux's handlers take the state and mutate it — the store is a Solid store underneath, so a
 * mutation is a fine-grained update rather than a replacement. The immutability that matters is
 * elsewhere: nothing outside a handler ever writes it, because the only way in is `dispatch`.
 */
export interface WaterfallState {
  /**
   * Whether the axis breaks at all.
   *
   * `false` is wall-clock: one linear scale end to end, which console.md keeps available on purpose.
   * It is the honest control case — a person who does not believe a break can turn it off and watch
   * the run become a hairline beside a 41-hour bar.
   */
  breaks: boolean;
  /**
   * How much of the axis one stretch may take before it collapses. See `BreakRule.share`.
   *
   * The threshold itself, held here rather than in the geometry so that the toggle above and the
   * rule the waterfall is drawn from are one value. **No finer control ships in v1** — the only
   * threshold a person can move is *break or do not*, and an event for a number nothing dispatches
   * would be dead code wearing the shape of a feature.
   */
  share: number;
  /** How far the timeline is stretched. Pan is the container's own scroll, which needs no state. */
  zoom: number;
  /** The phase under the pointer, or nothing. */
  hovered: string | undefined;
  /**
   * The phase the detail panel is open on.
   *
   * **Written by the panel, not by the click.** The panel is a nested route, so what is open is what
   * the URL says — a person pastes a phase URL to a colleague and it must open selected. The span's
   * click navigates; the route renders the panel; the panel puts the id here and the waterfall draws
   * the ring. One direction, so the two can never disagree about what is being looked at.
   */
  selected: string | undefined;
  /** The sandbox acquisition the detail panel is open on. The panel's other subject. */
  scope: string | undefined;
}

const initialState: WaterfallState = {
  breaks: true,
  share: 0.6,
  zoom: 1,
  hovered: undefined,
  selected: undefined,
  scope: undefined,
};

/** How far a zoom step goes, and how far it may go. Bounded: an axis nobody can pan is not zoom. */
const zoomStep = 1.5;
const zoomRange = { least: 1, most: 12 } as const;

export const axisToggled = createEvent("waterfall/axis-toggled");
export const zoomedIn = createEvent("waterfall/zoomed-in");
export const zoomedOut = createEvent("waterfall/zoomed-out");
export const zoomReset = createEvent("waterfall/zoom-reset");
/**
 * Entering and leaving are two events, not one carrying `string | undefined`.
 *
 * A payload type that includes `undefined` makes Solux's own creator ambiguous — it cannot tell an
 * event that carries nothing from one that carries a value which may be nothing — and the shape it
 * forces is the better one anyway: *the pointer left* is a thing that happened.
 */
export const hovered = createEvent<string>("waterfall/hovered");
export const unhovered = createEvent("waterfall/unhovered");
export const selected = createEvent<string>("waterfall/selected");
/** The panel opened on an acquisition. The two subjects are exclusive: one panel, one thing in it. */
export const scoped = createEvent<string>("waterfall/scoped");
/**
 * The panel closed — by the close link, by the back button, or by clicking the open span again.
 *
 * Its own event rather than `selected` dispatched with the current value, for the reason the hover
 * pair already has: *the panel closed* is a thing that happened, and an event that means it only by
 * coincidence of its payload cannot be read by anybody.
 */
export const deselected = createEvent("waterfall/deselected");

const clamp = (value: number): number =>
  Math.min(zoomRange.most, Math.max(zoomRange.least, Number(value.toFixed(3))));

const slice = createSlice<WaterfallState>({
  initialState,
  handlers: (builder) => {
    builder
      .addHandler(axisToggled, (state) => {
        state.breaks = !state.breaks;
      })
      .addHandler(zoomedIn, (state) => {
        state.zoom = clamp(state.zoom * zoomStep);
      })
      .addHandler(zoomedOut, (state) => {
        state.zoom = clamp(state.zoom / zoomStep);
      })
      .addHandler(zoomReset, (state) => {
        state.zoom = zoomRange.least;
      })
      .addHandler(hovered, (state, event) => {
        state.hovered = event.payload;
      })
      .addHandler(unhovered, (state) => {
        state.hovered = undefined;
      })
      .addHandler(selected, (state, event) => {
        // Clicking the selected phase again clears it. A selection nothing can undo is a trap on a
        // surface whose only job is investigation. The click that does the undoing is a navigation
        // back to the run, so what actually arrives here is `deselected` — this stays a toggle so
        // that the invariant holds however the id got here.
        state.selected = state.selected === event.payload ? undefined : event.payload;
        state.scope = undefined;
      })
      .addHandler(scoped, (state, event) => {
        state.scope = event.payload;
        state.selected = undefined;
      })
      .addHandler(deselected, (state) => {
        state.selected = undefined;
        state.scope = undefined;
      });
  },
});

/** A store of its own, per waterfall. Never a module-level singleton — see the note above. */
export const waterfallStore = (): Store<WaterfallState> =>
  configureStore<WaterfallState>({ rootSlice: slice });
