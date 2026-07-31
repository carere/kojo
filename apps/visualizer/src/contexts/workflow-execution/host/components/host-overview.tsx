import {
  type ControlSubscriptionDelivery,
  type ControlSubscriptionUpdate,
  type ExecutionTracePage,
  type HostOverview as HostOverviewSnapshot,
  type ProjectIdentity,
  type ProjectReadinessActionKey,
  RequestKey,
  type WorkflowRunId,
  type WorkflowScheduleAllowedAction,
  type WorkflowScheduleSnapshot,
} from "@kojo/control";
import type { Stream } from "effect";
import { Effect, Schema } from "effect";
import { createResource, createSignal, Show } from "solid-js";
import { m } from "../../../../i18n/messages";
import { LanguageToggle } from "../../../preferences/components/language-toggle";
import { ThemeToggle } from "../../../preferences/components/theme-toggle";
import { ProjectReadiness } from "../../../readiness/components/project-readiness";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";
import { ProjectNavigator } from "../../../workflow-authoring/projects/components/project-navigator";
import { WorkflowDefinitionSnapshots } from "../../../workflow-authoring/projects/components/workflow-definition-snapshots";
import { WorkflowRuns } from "../../runs/components/workflow-runs";
import { WorkflowScheduleOccurrences } from "../../schedules/components/workflow-schedule-occurrences";
import { WorkflowSchedules } from "../../schedules/components/workflow-schedules";
import {
  ExecutionTrace,
  type ExecutionTraceSelection,
} from "../../traces/components/execution-trace";

export interface HostOverviewProps {
  readonly acknowledgeTrace?: (delivery: ControlSubscriptionDelivery) => Effect.Effect<void>;
  readonly followTrace?: (
    selection: ExecutionTraceSelection,
    afterSequence: number,
  ) => Stream.Stream<ControlSubscriptionUpdate>;
  readonly loadOverview?: () => Promise<HostOverviewSnapshot | undefined>;
  readonly loadTrace?: (
    selection: ExecutionTraceSelection,
  ) => Promise<ExecutionTracePage | undefined>;
  readonly traceRefreshIntervalMs?: number;
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
  const [navigation, setNavigation] = createSignal<string>();
  const [selectedTrace, setSelectedTrace] = createSignal<
    { readonly identity: ProjectIdentity; readonly runId: WorkflowRunId } | undefined
  >();
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
  const refreshReadiness = async (identity: ProjectIdentity) => {
    if (props.loadOverview !== undefined) return;
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.RefreshProjectReadiness({ identity }),
        ),
      );
      if (result.ok) await refetch();
    } catch {
      // The next overview refresh is authoritative after a failed request.
    }
  };
  const repairReadiness = async (
    identity: ProjectIdentity,
    assessmentRevision: string,
    action: ProjectReadinessActionKey,
  ) => {
    if (props.loadOverview !== undefined) return;
    try {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.RepairProjectReadiness({
            identity,
            assessmentRevision,
            action,
            requestKey: Schema.decodeUnknownSync(RequestKey)(crypto.randomUUID()),
          }),
        ),
      );
      if (result.ok) await refetch();
    } catch {
      // A stale or rejected repair is safe to resolve by reloading the Host assessment.
      await refetch();
    }
  };
  const resume = async (identity: ProjectIdentity, runId: WorkflowRunId, value: unknown) => {
    await visualizerApiRuntime.runPromise(
      Effect.flatMap(VisualizerApiClient, (client) =>
        client.ResumeWorkflowRun({
          identity,
          runId,
          value,
          requestKey: crypto.randomUUID() as never,
        }),
      ),
    );
    await refetch();
  };
  const completeDeferred = async (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    token: string,
    value: unknown,
  ) => {
    await visualizerApiRuntime.runPromise(
      Effect.flatMap(VisualizerApiClient, (client) =>
        client.CompleteWorkflowDeferred({
          identity,
          runId,
          token,
          value,
          requestKey: crypto.randomUUID() as never,
        }),
      ),
    );
    await refetch();
  };
  const stop = async (identity: ProjectIdentity, runId: WorkflowRunId) => {
    await visualizerApiRuntime.runPromise(
      Effect.flatMap(VisualizerApiClient, (client) =>
        client.StopWorkflowRun({ identity, runId, requestKey: crypto.randomUUID() as never }),
      ),
    );
    await refetch();
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
              <ProjectReadiness
                assessments={current().readiness ?? []}
                onRefresh={refreshReadiness}
                onRepair={repairReadiness}
              />
              <WorkflowDefinitionSnapshots snapshots={current().projectDefinitions} />
              <WorkflowSchedules
                snapshots={current().workflowSchedules}
                onAction={controlSchedule}
                onShowOccurrences={(identity, scheduleKey) =>
                  setNavigation(
                    `Schedule ${scheduleKey} in Project ${identity} · occurrence history`,
                  )
                }
              />
              <WorkflowScheduleOccurrences
                snapshots={current().workflowOccurrences}
                onShowSchedule={(identity, scheduleKey) =>
                  setNavigation(`Schedule ${scheduleKey} in Project ${identity}`)
                }
                onShowRun={(identity, runId) => {
                  setSelectedTrace({ identity, runId: runId as WorkflowRunId });
                  setNavigation(`Workflow Run ${runId} in Project ${identity}`);
                }}
              />
              <WorkflowRuns
                snapshots={current().workflowRuns}
                onResume={resume}
                onCompleteDeferred={completeDeferred}
                onStop={stop}
                onShowRun={(identity, runId) => {
                  setSelectedTrace({ identity, runId: runId as WorkflowRunId });
                  setNavigation(`Workflow Run ${runId} in Project ${identity}`);
                }}
              />
              <ExecutionTrace
                {...(props.acknowledgeTrace === undefined
                  ? {}
                  : { acknowledgeTrace: props.acknowledgeTrace })}
                {...(props.followTrace === undefined ? {} : { followTrace: props.followTrace })}
                {...(props.loadTrace === undefined ? {} : { loadTrace: props.loadTrace })}
                {...(props.traceRefreshIntervalMs === undefined
                  ? {}
                  : { refreshIntervalMs: props.traceRefreshIntervalMs })}
                selection={selectedTrace()}
              />
              <Show when={navigation()}>
                {(target) => (
                  <p
                    aria-live="polite"
                    data-navigation-target={target()}
                    class="text-muted-foreground text-sm"
                  >
                    Navigated to {target()}
                  </p>
                )}
              </Show>
            </section>
          )}
        </Show>
      </section>
    </main>
  );
}
