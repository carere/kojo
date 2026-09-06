import { createFileRoute } from "@tanstack/solid-router";
import { Projects } from "../contexts/project/components/Projects.tsx";

/** Show the Project catalogue. TanStack Query owns its reads, polling, and retries. */
export const Route = createFileRoute("/")({
  component: Projects,
});
