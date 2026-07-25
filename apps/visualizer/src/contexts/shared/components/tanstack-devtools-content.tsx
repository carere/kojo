import { TanStackDevtools as DevtoolsShell } from "@tanstack/solid-devtools";
import { SolidQueryDevtoolsPanel } from "@tanstack/solid-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/solid-router-devtools";

export function TanStackDevtoolsContent() {
  return (
    <DevtoolsShell
      config={{
        position: "top-right",
      }}
      plugins={[
        {
          name: "TanStack Query",
          render: <SolidQueryDevtoolsPanel />,
          defaultOpen: false,
        },
        {
          name: "TanStack Router",
          render: <TanStackRouterDevtoolsPanel />,
          defaultOpen: false,
        },
      ]}
    />
  );
}
