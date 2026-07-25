import { lazy } from "solid-js";

const Devtools = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import("./tanstack-devtools-content");

      return {
        default: module.TanStackDevtoolsContent,
      };
    })
  : undefined;

export function TanStackDevtools() {
  if (!Devtools) return null;

  return <Devtools />;
}
