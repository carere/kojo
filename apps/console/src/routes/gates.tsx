import { createFileRoute } from "@tanstack/solid-router";
import { GateQueue } from "../contexts/gate/components/GateQueue.tsx";

/** Show the Daemon Gate queue. TanStack Query owns its reads, polling, and retries. */
export const Route = createFileRoute("/gates")({
  component: GateQueue,
});
