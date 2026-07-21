import { createFileRoute } from "@tanstack/solid-router";
import { DenseInspector } from "@/features/inspector/DenseInspector";

export const Route = createFileRoute("/")({
  component: VisualizerHome,
});

function VisualizerHome() {
  return <DenseInspector />;
}
