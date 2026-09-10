import { createFileRoute } from "@tanstack/solid-router";
import { Runs } from "../contexts/trace/components/Runs.tsx";

/** Show the Run list. TanStack Query owns its reads, polling, and retries. */
export const Route = createFileRoute("/")({
  component: Runs,
});
