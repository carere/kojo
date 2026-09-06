import { createFileRoute } from "@tanstack/solid-router";
import { GatePanel } from "../contexts/gate/components/GatePanel.tsx";

/**
 * Show one Asking in the Run detail panel.
 *
 * The Asking identity contains slashes. Links encode it as one route parameter, and the router
 * decodes it. Keep the full identity when selecting an Asking; do not infer its parts here.
 */
export const Route = createFileRoute("/runs/$runId/gates/$gate/$asking")({
  component: GateRoute,
});

function GateRoute() {
  const params = Route.useParams();
  return <GatePanel runId={params().runId} gate={params().gate} asking={params().asking} />;
}
