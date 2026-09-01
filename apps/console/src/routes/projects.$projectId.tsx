import { createFileRoute } from "@tanstack/solid-router";
import { Workflows } from "../contexts/workflow/components/Workflows.tsx";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectWorkflows,
});

function ProjectWorkflows() {
  const params = Route.useParams();
  return <Workflows projectId={params().projectId} />;
}
