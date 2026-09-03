import { createFileRoute } from "@tanstack/solid-router";
import { Runs } from "../contexts/trace/components/Runs.tsx";

/** The Run catalogue at the index of the Run resource route. */
export const Route = createFileRoute("/runs/")({ component: Runs });
