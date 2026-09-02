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

/**
 * The document every view of the Console lives in.
 *
 * **This is the whole of what gets prerendered.** In SPA mode the build fetches this shell once,
 * with no route matched, and writes the HTML; every route below it renders in the browser. So the
 * two providers go here rather than in a route, and nothing in this file may depend on data.
 *
 * The clock is built here, once, and handed down. That is the injection point console.md §11 asks
 * for: a test freezes it before the page loads and every duration on every view below becomes a
 * fixed string.
 */

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
