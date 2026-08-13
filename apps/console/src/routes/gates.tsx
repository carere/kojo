import { createFileRoute } from "@tanstack/solid-router";
import { GateQueue } from "../contexts/gate/components/GateQueue.tsx";

/**
 * `/gates` — the queue: what waits on a human, and for how long.
 *
 * A page of its own rather than a panel, because it is the one view in the Console that is not about
 * a run. A person opens it to find the question nobody has answered, which is a question about the
 * factory, and the run it belongs to is what they leave here for.
 *
 * No loader, like every other route: console.md §7 puts every read through TanStack Query, which
 * owns the polling, the retry and the cache.
 */
export const Route = createFileRoute("/gates")({
  component: GateQueue,
});
