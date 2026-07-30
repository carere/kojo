import {
  type HostOverview as HostOverviewSnapshot,
  RequestKey,
  type WorkflowScheduleAllowedAction,
  type WorkflowScheduleSnapshot,
} from "@kojo/control";
import { Effect, Schema } from "effect";
import { createResource, Show } from "solid-js";
import { m } from "../../../../i18n/messages";
import { LanguageToggle } from "../../../preferences/components/language-toggle";
import { ThemeToggle } from "../../../preferences/components/theme-toggle";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";
import { ProjectNavigator } from "../../../workflow-authoring/projects/components/project-navigator";
import { WorkflowDefinitionSnapshots } from "../../../workflow-authoring/projects/components/workflow-definition-snapshots";
import { WorkflowRuns } from "../../runs/components/workflow-runs";
import { WorkflowSchedules } from "../../schedules/components/workflow-schedules";

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
  const [overview, { refetch }] = createResource(() => (props.loadOverview ?? loadHostOverview)());
  const controlSchedule = async (
    identity: HostOverviewSnapshot["projects"][number]["identity"],
    schedule: WorkflowScheduleSnapshot,
    action: WorkflowScheduleAllowedAction,
  ) => {
    if (props.loadOverview !== undefined) return;
    const requestKey = Schema.decodeUnknownSync(RequestKey)(crypto.randomUUID());
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          action === "enable"
            ? client.EnableWorkflowSchedule({
                identity,
                scheduleKey: schedule.scheduleKey,
                scheduleRevision: schedule.definition?.revision ?? "",
                requestKey,
              })
            : client.DisableWorkflowSchedule({
                identity,
                scheduleKey: schedule.scheduleKey,
                requestKey,
              }),
        ),
      );
      if (result.ok) await refetch();
    } catch {
      // The next overview refresh is the authoritative recovery path for a failed control request.
    }
  };

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
              <WorkflowSchedules
                snapshots={current().workflowSchedules}
                onAction={controlSchedule}
              />
              <WorkflowRuns snapshots={current().workflowRuns} />
            </section>
          )}
        </Show>
      </section>
    </main>
  );
}
