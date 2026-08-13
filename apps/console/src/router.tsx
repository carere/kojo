import { createRouter } from "@tanstack/solid-router";
import { routeTree } from "./routeTree.gen.ts";

/**
 * The router, built once per document.
 *
 * `/runs/:runId` and the detail panels below it are nested routes that ticket 28 adds; this file
 * stays as it is when they do, because the tree is generated from the files under `routes/`.
 */
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
  });
}
