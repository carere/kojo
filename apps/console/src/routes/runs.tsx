import { createFileRoute } from "@tanstack/solid-router";
import { Runs } from "../contexts/trace/components/Runs.tsx";

export const Route = createFileRoute("/runs")({ component: Runs });
