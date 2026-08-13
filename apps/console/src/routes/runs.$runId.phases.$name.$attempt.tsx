import { createFileRoute } from "@tanstack/solid-router";
import { PhasePanel } from "../contexts/trace/components/PhasePanel.tsx";

/**
 * `/runs/:runId/phases/:name/:attempt` — the run view, with a phase in the detail panel.
 *
 * **A nested route rendering into a docked panel, not a page** (console.md §3). The waterfall stays
 * on screen: a phase detail must be deep-linkable because it is the thing a person pastes into a
 * chat when they ask why a run died, but replacing the run view with a full page would throw away the
 * position they clicked from, and the whole job is investigation in context.
 *
 * ---
 *
 * **Why the path is `name/attempt` and not the phase id.**
 *
 * console.md §3 writes this route as `/runs/:runId/phases/:phaseId`, and a phase id is
 * `<run>/<name>/<attempt>` — three path segments, one of which is the run id that is already in the
 * URL. Spelling it as one parameter means percent-encoding it, and produces
 * `/runs/run-merged/phases/run-merged%2Fhotfix%2F1`: the run named twice, and the second time in a
 * form nobody can read. Both shapes were measured against the server and both are served — this is a
 * choice about the URL, not a workaround for one that does not work.
 *
 * Three reasons decided it, in order of weight:
 *
 * 1. **What is pasted is read by a human.** `/runs/run-merged/phases/hotfix/1` says which run, which
 *    phase and which attempt at a glance. That is the entire purpose the design gives this route.
 * 2. **A URL cannot then contradict itself.** With the id spelled whole, `/runs/A/phases/B/x/1` is a
 *    perfectly well-formed URL naming two different runs, and something has to decide which one
 *    wins. Addressing the *suffix* makes that state unrepresentable: the run comes from one place.
 * 3. **The segments need no escaping at all.** Every part of a Kojo identifier is
 *    `[A-Za-z0-9._-]+` — the trace's own path guard refuses anything else outright — so `name` and
 *    `attempt` are safe path segments by construction, and a link never has to encode one.
 *
 * The cost, stated plainly: the browser now knows that a phase id is `runId/name/attempt`. It is one
 * more place that has to agree with `makePhaseId`, and it is written down once, in
 * `contexts/trace/models/ids.ts`, beside the reading of a sandbox id the waterfall already needed.
 */
export const Route = createFileRoute("/runs/$runId/phases/$name/$attempt")({
  component: PhaseRoute,
});

function PhaseRoute() {
  const params = Route.useParams();
  return <PhasePanel runId={params().runId} name={params().name} attempt={params().attempt} />;
}
