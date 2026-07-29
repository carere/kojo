import type { HostOverview } from "@kojo/control";
import { Effect } from "effect";
import { createResource, Show } from "solid-js";
import { Button } from "#components/ui/button";
import { m } from "../../../i18n/messages";
import { LanguageToggle } from "../../preferences/components/language-toggle";
import { ThemeToggle } from "../../preferences/components/theme-toggle";
import { VisualizerApiClient, visualizerApiRuntime } from "../../shared/services/client";

export interface VisualizerHomeProps {
  readonly loadOverview?: () => Promise<HostOverview | undefined>;
}

const loadHostOverview = async () => {
  try {
    return await visualizerApiRuntime.runPromise(
      Effect.flatMap(VisualizerApiClient, (client) => client.HostOverview()),
    );
  } catch {
    return undefined;
  }
};

export function VisualizerHome(props: VisualizerHomeProps) {
  const [overview] = createResource(() => (props.loadOverview ?? loadHostOverview)());

  return (
    <main class="mx-auto flex min-h-screen max-w-3xl items-center px-6">
      <section class="w-full space-y-6">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <p class="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">
            {m.visualizer_eyebrow()}
          </p>
          <div class="flex items-center gap-2">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>
        <h1 class="font-semibold text-4xl tracking-tight">{m.visualizer_title()}</h1>
        <p class="max-w-xl text-base text-muted-foreground leading-7">
          {m.visualizer_description()}
        </p>
        <div class="flex items-center gap-3">
          <Button type="button">{m.visualizer_ready()}</Button>
          <span class="text-muted-foreground text-xs">{m.visualizer_rpc_ready()}</span>
        </div>
        <Show when={overview()}>
          {(current) => (
            <section aria-live="polite" class="space-y-2 rounded-lg border p-4">
              <h2 class="font-semibold text-lg">Kojo Host {current().host.hostVersion} is ready</h2>
              <p class="text-muted-foreground text-sm">
                {current().projects.length === 0
                  ? "No Kojo Projects yet."
                  : `${current().projects.length} Kojo Projects`}
              </p>
            </section>
          )}
        </Show>
      </section>
    </main>
  );
}
