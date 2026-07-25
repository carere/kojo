import type { QueryClient } from "@tanstack/solid-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/solid-router";
import { HydrationScript } from "solid-js/web";
import { TanStackDevtools } from "#components/tanstack-devtools";
import { ColorModeProvider, getClientColorMode } from "../contexts/preferences/services/color-mode";
import { getLocale } from "../i18n/runtime";
import appStyles from "../styles.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0",
      },
      {
        name: "theme-color",
        content: "#ffffff",
      },
      {
        title: "Kojo Visualizer",
      },
    ],
    links: [{ rel: "stylesheet", href: appStyles }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang={getLocale()}>
      <head>
        <HydrationScript />
      </head>
      <body>
        <ColorModeProvider initialColorMode={getClientColorMode()}>
          <HeadContent />
          <Outlet />
          <TanStackDevtools />
          <Scripts />
        </ColorModeProvider>
      </body>
    </html>
  );
}
