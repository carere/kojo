import { QueryClientProvider } from "@tanstack/solid-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/solid-router";
import { type JSX, onCleanup, onMount } from "solid-js";
import { HydrationScript } from "solid-js/web";
import { DaemonConnectionNotice } from "../contexts/daemon/components/DaemonConnectionNotice.tsx";
import { daemonMutationsAllowed } from "../contexts/daemon/services/connectionState.ts";
import { observeDaemonNotifications } from "../contexts/daemon/services/observeDaemonNotifications.ts";
import { browserNow } from "../contexts/shared/adapters/browserNow.ts";
import { NowProvider } from "../contexts/shared/ports/Now.tsx";
import { consoleQueryClient } from "../contexts/shared/services/queryClient.ts";
import appCss from "../styles/app.css?url";

/** Provide the shared query cache and clock above all routes. Tests can replace the clock before the page loads. */

const queryClient = consoleQueryClient();

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Kojo Console" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
});

function RootDocument(props: { readonly children: JSX.Element }): JSX.Element {
  const now = browserNow();
  let stopNotifications: (() => void) | undefined;
  onMount(() => {
    stopNotifications = observeDaemonNotifications(queryClient);
  });
  onCleanup(() => stopNotifications?.());
  return (
    <html lang="en">
      <head>
        <HydrationScript />
      </head>
      <body>
        <HeadContent />
        <QueryClientProvider client={queryClient}>
          <DaemonConnectionNotice />
          <fieldset
            class="contents"
            data-daemon-mutation-scope
            disabled={!daemonMutationsAllowed()}
          >
            <NowProvider now={now}>{props.children}</NowProvider>
          </fieldset>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
