import { createFileRoute } from "@tanstack/solid-router";
import { SandboxPanel } from "../contexts/trace/components/SandboxPanel.tsx";

/**
 * `/runs/:runId/sandboxes/:name/:acquisition` — the run view, with an acquisition in the panel.
 *
 * The panel's second subject, and it has a route of its own for the same reason the phase does: the
 * band on the waterfall is a whole record, and *what did the rebuild after the gate cost* is a
 * question somebody asks a colleague with a link.
 *
 * The path is split on the same rule as the phase route, and for the same reasons — an acquisition id
 * is `<run>/<name>/<millis>-<sequence>`, so the run is already in the URL and the two segments that
 * are left need no encoding. `acquisition` is the discriminator whole: the moment it was acquired and
 * where it fell in the acquiring process's order, which together are what make two acquisitions of
 * one scope in one millisecond distinguishable.
 */
export const Route = createFileRoute("/runs/$runId/sandboxes/$name/$acquisition")({
  component: SandboxRoute,
});

function SandboxRoute() {
  const params = Route.useParams();
  return (
    <SandboxPanel runId={params().runId} name={params().name} acquisition={params().acquisition} />
  );
}
