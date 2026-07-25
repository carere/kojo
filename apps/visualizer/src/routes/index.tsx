import { createFileRoute } from "@tanstack/solid-router";
import { VisualizerHome } from "../contexts/readiness/components/visualizer-home";

export const Route = createFileRoute("/")({
  component: VisualizerHome,
});
