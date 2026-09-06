import { createRouter } from "@tanstack/solid-router";
import { routeTree } from "./routeTree.gen.ts";

/** Build the router from the generated route tree. */
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
  });
}
