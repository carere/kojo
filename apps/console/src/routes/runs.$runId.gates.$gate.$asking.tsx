import { createFileRoute } from "@tanstack/solid-router";
import { GatePanel } from "../contexts/gate/components/GatePanel.tsx";

/**
 * `/runs/:runId/gates/:gate/:asking` — the run view, with a gate in the detail panel.
 *
 * **A gate has a route of its own, and until ticket 29 the design said it did not.** console.md §3
 * read *"a gate is a phase of kind `actor`, so its detail panel is the phase detail panel, plus the
 * answer form."* The engine never backed it: only the agent and code primitives construct a
 * `PhaseRecord`, nothing anywhere writes `kind: "actor"`, and a gate record carries **no phase id**
 * — so even a hand-made actor phase would have had no recorded link to the gate it stood for. The
 * record is the better subject in any case: the token, the choices, the deadline and its expiry
 * branch, the answerer and the latency are all on it, and none of them fits a phase row.
 *
 * ---
 *
 * **Why the asking is one segment, and why it is the one segment here that gets encoded.**
 *
 * The two routes beside this one address a Kojo identifier's *suffix*, and they can: every segment
 * of a phase id or a sandbox id is `[A-Za-z0-9._-]+` by the trace's own path guard, so `name` and
 * `attempt` are safe path segments by construction and no link ever has to escape one.
 *
 * An **asking** is not a Kojo identifier. It is the engine's durable deferred name, built by
 * `phase/gate.ts` as `gate/<lane>/<name>/<round>`, and it carries slashes — it was never held to
 * that guard because nothing ever puts it on disk. So it travels percent-encoded in one parameter:
 * the router leaves `%2F` alone when it splits the path and decodes it when it fills the parameter,
 * which is the same round trip the API already relies on for a phase id.
 *
 * It is carried **whole and unparsed**, which is the important half. The Console could read the
 * round number off the end and print something shorter, and it would be inventing a grammar the
 * engine never promised. An asking is an identity; this route moves it and reads nothing out of it.
 */
export const Route = createFileRoute("/runs/$runId/gates/$gate/$asking")({
  component: GateRoute,
});

function GateRoute() {
  const params = Route.useParams();
  return <GatePanel runId={params().runId} gate={params().gate} asking={params().asking} />;
}
