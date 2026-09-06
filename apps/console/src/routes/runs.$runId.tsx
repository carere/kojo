import { createFileRoute } from "@tanstack/solid-router";
import { RunView } from "../contexts/trace/components/RunView.tsx";
import type { RunViewMode } from "../contexts/trace/models/view.ts";

/** Show one Run. TanStack Query owns the snapshot. The URL keeps the timeline-or-table choice so links preserve it. */
export const Route = createFileRoute("/runs/$runId")({
  validateSearch: (search: Record<string, unknown>): { readonly view: RunViewMode } => ({
    view: search.view === "table" ? "table" : "timeline",
  }),
  component: RunRoute,
});

function RunRoute() {
  const params = Route.useParams();
  const search = Route.useSearch();
  return <RunView runId={params().runId} mode={search().view} />;
}
