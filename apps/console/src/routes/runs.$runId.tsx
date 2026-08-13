import { createFileRoute } from "@tanstack/solid-router";
import { RunView } from "../contexts/trace/components/RunView.tsx";
import type { RunViewMode } from "../contexts/trace/models/view.ts";

/**
 * `/runs/:runId` — the run view.
 *
 * No loader, for the same reason `/` has none: console.md §7 puts every read through TanStack Query,
 * which owns the polling, the retry and the cache, and a route loader would be a second thing
 * fetching the same run on a different schedule.
 *
 * The one thing the route does own is `?view=`. console.md §8 puts the timeline-or-table toggle in
 * the URL because the URL is what a person pastes to a colleague, and an unknown value falls back to
 * the timeline rather than throwing — a mistyped query string must not be an error page over a run
 * somebody is trying to read.
 */
export const Route = createFileRoute("/runs/$runId")({
  validateSearch: (search: Record<string, unknown>): { readonly view: RunViewMode } => ({
    view: search["view"] === "table" ? "table" : "timeline",
  }),
  component: RunRoute,
});

function RunRoute() {
  const params = Route.useParams();
  const search = Route.useSearch();
  return <RunView runId={params().runId} mode={search().view} />;
}
