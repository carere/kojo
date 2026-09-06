import { createFileRoute } from "@tanstack/solid-router";
import { PhasePanel } from "../contexts/trace/components/PhasePanel.tsx";

/** Show a Phase below the Waterfall. The route carries the name and attempt; the Run ID is already in the parent route. */
export const Route = createFileRoute("/runs/$runId/phases/$name/$attempt")({
  component: PhaseRoute,
});

function PhaseRoute() {
  const params = Route.useParams();
  return <PhasePanel runId={params().runId} name={params().name} attempt={params().attempt} />;
}
