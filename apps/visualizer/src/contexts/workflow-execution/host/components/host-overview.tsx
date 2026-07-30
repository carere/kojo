import type { HostOverview as HostOverviewSnapshot } from "@kojo/control";
import { Effect } from "effect";
import { createResource, Show } from "solid-js";
import { m } from "../../../../i18n/messages";
import { LanguageToggle } from "../../../preferences/components/language-toggle";
import { ThemeToggle } from "../../../preferences/components/theme-toggle";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";
import { ProjectNavigator } from "../../../workflow-authoring/projects/components/project-navigator";
import { WorkflowDefinitionSnapshots } from "../../../workflow-authoring/projects/components/workflow-definition-snapshots";

export interface HostOverviewProps {
  readonly loadOverview?: () => Promise<HostOverviewSnapshot | undefined>;
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

export function HostOverview(props: HostOverviewProps) {
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
        <Show when={overview()}>
          {(current) => (
            <section aria-live="polite" class="space-y-4">
              <h2 class="font-semibold text-lg">
                Connected to Kojo Host {current().host.hostVersion}
              </h2>
              <ProjectNavigator projects={current().projects} />
              <WorkflowDefinitionSnapshots snapshots={current().projectDefinitions} />
            </section>
          )}
        </Show>
      </section>
    </main>
  );
}
