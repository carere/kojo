import { createFileRoute } from "@tanstack/solid-router";
import { WorkflowInspector } from "../contexts/workflow-execution/workflow-inspector/components/workflow-inspector";

export const Route = createFileRoute("/")({
  component: WorkflowInspector,
});
