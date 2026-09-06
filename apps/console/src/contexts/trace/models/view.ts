/** Keep the timeline-or-table choice in the URL. Detail-panel links preserve it. */
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
