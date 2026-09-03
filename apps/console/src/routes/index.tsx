import { createFileRoute } from "@tanstack/solid-router";
import { Projects } from "../contexts/project/components/Projects.tsx";

/**
 * `/` — the authoritative Project catalogue.
 *
 * The route holds nothing but the component. It has no loader on purpose: console.md §7 puts every
 * read through TanStack Query, which owns the polling, the retry and the cache, and a route loader
 * would be a second thing fetching the same data on a different schedule.
 */
export const Route = createFileRoute("/")({
  component: Projects,
});
