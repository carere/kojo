import { createFileRoute, Outlet } from "@tanstack/solid-router";

export const Route = createFileRoute("/runs")({ component: Outlet });
