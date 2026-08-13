/**
 * How a run is being looked at — the one piece of view state that lives in the URL.
 *
 * console.md §8 puts the timeline-or-table toggle there rather than in a store, because the URL is
 * what a person pastes to a colleague and *"look at it as a table"* has to survive being pasted. It
 * is stated here rather than beside the run view so that the detail panel's links can carry it
 * without importing a component.
 */
export type RunViewMode = "timeline" | "table";

/**
 * Keep the current mode across a link into or out of the detail panel.
 *
 * Opening a phase must not silently put somebody back on the timeline they had just switched away
 * from. The fallback is the route validator's own: an absent or unknown `view` is the timeline, so
 * a mistyped query string is never an error page over a run somebody is trying to read.
 */
export const keepView = (previous: {
  readonly view?: RunViewMode;
}): { readonly view: RunViewMode } => ({ view: previous.view ?? "timeline" });
