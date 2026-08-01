import type {
  HostOverview as HostOverviewSnapshot,
  ProjectCondition,
  ProjectIdentity,
  WorkflowRunId,
  WorkflowRunSnapshot,
} from "@kojo/control";
import { Effect } from "effect";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  History,
  LoaderCircle,
  Menu,
  Radio,
  X,
} from "lucide-solid";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { LanguageToggle } from "../../../preferences/components/language-toggle";
import { ThemeToggle } from "../../../preferences/components/theme-toggle";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";
import {
  NAVIGATOR_PREFERENCES_KEY,
  type NavigatorPreferences,
  orderProjects,
  reconcileNavigatorPreferences,
} from "../../../workflow-authoring/projects/services/navigator-preferences";
import { ExecutionTrace } from "../../traces/components/execution-trace";
import {
  makeHostOverviewCoordinator,
  productionHostOverviewPolicy,
} from "../hooks/host-overview-coordinator";
import { useLiveProjectOverview } from "../hooks/use-live-project-overview";
import { usePanelLayout } from "../hooks/use-panel-layout";
import { useWorkflowInspectorActions } from "../hooks/use-workflow-inspector-actions";
import {
  conditionTone,
  type DialogKind,
  projectMatches,
  projectName,
  runTone,
  type WorkflowInspectorProps,
} from "../models/workflow-inspector-models";
import { InspectorPanel } from "./inspector-panel";
import { ProjectRail } from "./project-rail";
import { ResourceNavigator } from "./resource-navigator";
import { RunGraph } from "./run-graph";
import { WorkflowInspectorDialog } from "./workflow-inspector-dialog";

const interruptWhenAborted = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const onAbort = () => resume(Effect.interrupt);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const loadHostOverview = async (signal: AbortSignal) => {
  const request = Effect.flatMap(VisualizerApiClient, (client) => client.HostOverview());
  return await visualizerApiRuntime.runPromise(
    Effect.raceFirst(request, interruptWhenAborted(signal)),
  );
};

const freshStartOverviewRetryDelaysMs = [25, 50, 100, 200] as const;
const embeddedHostOverviewPolicy = {
  attemptTimeoutMs: 1_000,
  maxAttempts: 4,
  maxElapsedMs: 5_000,
  retryDelaysMs: [25, 50, 100],
} as const;

const hasRun = (snapshot: HostOverviewSnapshot, identity: ProjectIdentity, runId: WorkflowRunId) =>
  snapshot.workflowRuns.some(
    (projectRuns) =>
      projectRuns.project.identity === identity &&
      projectRuns.runs.some((run) => run.runId === runId),
  );

export function WorkflowInspector(props: WorkflowInspectorProps) {
  const overviewCoordinator = makeHostOverviewCoordinator({
    load: props.loadOverview ?? loadHostOverview,
    policy:
      props.loadOverview === undefined ? productionHostOverviewPolicy : embeddedHostOverviewPolicy,
  });
  const overview = overviewCoordinator.overview;
  const overviewError = overviewCoordinator.error;
  overviewCoordinator.start();
  onCleanup(() => overviewCoordinator.dispose());
  const [preferences, setPreferences] = createSignal<NavigatorPreferences>({
    version: 1,
    order: [],
  });
  const [selectedRunId, setSelectedRunId] = createSignal<WorkflowRunId | undefined>();
  const [revealedRun, setRevealedRun] = createSignal<WorkflowRunSnapshot | undefined>();
  const [dialog, setDialog] = createSignal<DialogKind>(null);
  const {
    navigatorWidth,
    inspectorWidth,
    navigatorCollapsed,
    inspectorCollapsed,
    setNavigatorCollapsed,
    setInspectorCollapsed,
    startResize,
    keyboardResize,
  } = usePanelLayout();

  createEffect(() => {
    const current = overview();
    if (current === undefined) return;
    const storedPreferences =
      typeof window === "undefined" ? null : window.localStorage.getItem(NAVIGATOR_PREFERENCES_KEY);
    // A failed refresh never clears the coordinator's last good snapshot. If a
    // Host reconnect briefly reports an empty index, keep the persisted order
    // until a non-empty authoritative replacement confirms the Project set.
    if (current.projects.length === 0 && storedPreferences !== null) return;
    const reconciled = reconcileNavigatorPreferences(current.projects, storedPreferences);
    setPreferences(reconciled);
    if (typeof window !== "undefined")
      window.localStorage.setItem(NAVIGATOR_PREFERENCES_KEY, JSON.stringify(reconciled));
  });

  const orderedProjects = createMemo(() =>
    orderProjects(overview()?.projects ?? [], preferences()),
  );
  const selectedProjectIdentity = createMemo(() => {
    const projects = orderedProjects();
    const selected = preferences().selectedProjectIdentity;
    return selected !== undefined && projects.some((project) => project.identity === selected)
      ? selected
      : projects[0]?.identity;
  });
  const selectedProject = createMemo(() =>
    orderedProjects().find((project) => project.identity === selectedProjectIdentity()),
  );
  const conditionFor = (identity: ProjectIdentity): ProjectCondition =>
    overview()?.readiness?.find((assessment) => assessment.project.identity === identity)
      ?.condition ?? "ready";
  const selectedCondition = createMemo(() => {
    const identity = selectedProjectIdentity();
    return identity === undefined ? "ready" : conditionFor(identity);
  });
  const selectedDefinitions = createMemo(() => {
    const identity = selectedProjectIdentity();
    return (
      overview()?.projectDefinitions.find((snapshot) => snapshot.project.identity === identity)
        ?.definitions.workflows ?? []
    );
  });
  const selectedSchedules = createMemo(() => {
    const identity = selectedProjectIdentity();
    if (identity === undefined) return [];
    return (
      overview()?.workflowSchedules.find((snapshot) => projectMatches(snapshot, identity))
        ?.schedules ?? []
    );
  });
  const selectedOccurrences = createMemo(() => {
    const identity = selectedProjectIdentity();
    if (identity === undefined) return [];
    return (
      overview()?.workflowOccurrences.find((snapshot) => projectMatches(snapshot, identity))
        ?.occurrences ?? []
    );
  });
  const selectedRuns = createMemo(() => {
    const identity = selectedProjectIdentity();
    if (identity === undefined) return [];
    return (
      overview()?.workflowRuns.find((snapshot) => projectMatches(snapshot, identity))?.runs ?? []
    );
  });
  const selectedRetention = createMemo(() => {
    const identity = selectedProjectIdentity();
    return overview()?.retention?.find((snapshot) => snapshot.project.identity === identity);
  });
  const selectedRun = createMemo(
    () => selectedRuns().find((run) => run.runId === selectedRunId()) ?? selectedRuns()[0],
  );
  const selectedDefinition = createMemo(() => {
    const run = selectedRun();
    return (
      selectedDefinitions().find(
        (definition) =>
          definition.workflowKey === run?.workflowKey &&
          definition.revision === run?.workflowRevision,
      ) ?? selectedDefinitions()[0]
    );
  });
  const traceSelection = createMemo(() => {
    const identity = selectedProjectIdentity();
    const runId = selectedRun()?.runId;
    return identity === undefined || runId === undefined ? undefined : { identity, runId };
  });
  const artifactIds = createMemo(() => {
    const run = selectedRun();
    if (run === undefined) return [];
    return [
      ...new Set([
        ...run.sandboxTrace.flatMap((entry) => entry.artifactIds),
        ...run.agentTrace.flatMap((entry) => entry.artifactIds),
      ]),
    ];
  });

  const reloadOverview = async (expectedRunId?: WorkflowRunId) => {
    if (props.loadOverview !== undefined) return;
    const expectedIdentity = selectedProjectIdentity();
    for (let attempt = 0; ; attempt += 1) {
      const refreshed = await overviewCoordinator.refresh();
      if (
        expectedRunId === undefined ||
        expectedIdentity === undefined ||
        hasRun(refreshed, expectedIdentity, expectedRunId)
      )
        return;
      const delay = freshStartOverviewRetryDelaysMs[attempt];
      if (delay === undefined) {
        throw new Error(`Host overview did not include Workflow Run ${expectedRunId}.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  };

  const reloadHostOverview = () => overviewCoordinator.refresh();

  createEffect(() => {
    const runs = selectedRuns();
    if (runs.length === 0) {
      setSelectedRunId(undefined);
      return;
    }
    if (selectedRunId() !== undefined && runs.some((run) => run.runId === selectedRunId())) return;
    const root = runs.find((run) => run.parentRunId === null || run.parentRunId === undefined);
    setSelectedRunId(root?.runId ?? runs[0]?.runId);
  });

  createEffect(on(selectedRunId, () => setRevealedRun(undefined), { defer: true }));
  useLiveProjectOverview({
    identity: selectedProjectIdentity,
    overview,
    refetch: reloadHostOverview,
    production: props.loadOverview === undefined,
    acknowledge: props.acknowledgeTrace,
  });
  const actions = useWorkflowInspectorActions({
    identity: selectedProjectIdentity,
    run: selectedRun,
    definition: selectedDefinition,
    production: props.loadOverview === undefined,
    reloadOverview,
    setDialog,
    setSelectedRunId,
    setRevealedRun,
  });

  const selectProject = (identity: ProjectIdentity) => {
    const next: NavigatorPreferences = { ...preferences(), selectedProjectIdentity: identity };
    setPreferences(next);
    if (typeof window !== "undefined")
      window.localStorage.setItem(NAVIGATOR_PREFERENCES_KEY, JSON.stringify(next));
    setSelectedRunId(undefined);
    actions.setNotice(
      `Project ${projectName(overview()?.projects.find((project) => project.identity === identity)?.path ?? identity)} selected. All resources are scoped to its Project Identity.`,
    );
  };

  return (
    <main class="workflow-inspector min-h-screen bg-[#f8f7f3] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Show
        when={overview()}
        fallback={
          <Show
            when={overviewError()}
            fallback={
              <div class="grid min-h-screen place-items-center p-6">
                <div class="workflow-inspector-card max-w-md text-center">
                  <LoaderCircle class="mx-auto size-5 animate-spin text-emerald-600" />
                  <h1 class="mt-3 font-heading font-semibold text-lg">Connecting to Kojo Host…</h1>
                  <p class="mt-2 text-xs text-zinc-500">
                    The Host-owned Project Index and Workflow resources will appear here when the
                    local service is available.
                  </p>
                </div>
              </div>
            }
          >
            {(error) => (
              <div class="grid min-h-screen place-items-center p-6">
                <div class="workflow-inspector-card max-w-md" role="alert">
                  <CircleAlert class="size-5 text-rose-500" />
                  <h1 class="mt-3 font-heading font-semibold text-lg">
                    Kojo Host connection needs attention
                  </h1>
                  <p class="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
                    {errorMessage(error())}
                  </p>
                  <button
                    class="mt-4 rounded-md bg-zinc-900 px-3 py-2 font-medium text-white text-xs dark:bg-zinc-100 dark:text-zinc-900"
                    type="button"
                    onClick={() => void overviewCoordinator.refresh().catch(() => undefined)}
                    disabled={overviewCoordinator.loading()}
                  >
                    {overviewCoordinator.loading() ? "Retrying…" : "Retry HostOverview"}
                  </button>
                </div>
              </div>
            )}
          </Show>
        }
      >
        {(current) => (
          <div
            class="workflow-inspector-layout"
            data-navigator-collapsed={navigatorCollapsed()}
            data-inspector-collapsed={inspectorCollapsed()}
            style={`--workflow-nav-width: ${navigatorWidth()}px; --workflow-inspector-width: ${inspectorWidth()}px;`}
          >
            <ProjectRail
              projects={orderedProjects()}
              selectedIdentity={selectedProjectIdentity()}
              conditionFor={conditionFor}
              onSelect={selectProject}
            />
            <Show when={!navigatorCollapsed() && selectedProject()}>
              {(project) => (
                <ResourceNavigator
                  project={project()}
                  condition={selectedCondition()}
                  definitions={selectedDefinitions()}
                  schedules={selectedSchedules()}
                  occurrences={selectedOccurrences()}
                  runs={selectedRuns()}
                  selectedRunId={selectedRunId()}
                  onSelectRun={setSelectedRunId}
                  onScheduleAction={actions.scheduleAction}
                />
              )}
            </Show>
            <Show when={!navigatorCollapsed()}>
              <hr
                class="workflow-inspector-resizer workflow-inspector-resizer-nav"
                aria-label="Resize Project resource navigator"
                aria-orientation="vertical"
                aria-valuemin="220"
                aria-valuemax="420"
                aria-valuenow={navigatorWidth()}
                tabIndex={0}
                onPointerDown={(event) => startResize("navigator", event)}
                onKeyDown={(event) => keyboardResize("navigator", event)}
              />
            </Show>

            <section class="workflow-inspector-workspace" aria-label="Workflow Inspector workspace">
              <header class="flex min-h-14 flex-wrap items-center justify-between gap-3 border-zinc-200 border-b bg-white/75 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
                <div class="min-w-0">
                  <p class="text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                    Workflow Inspector · production
                  </p>
                  <div class="mt-1 flex items-center gap-2">
                    <h1 class="truncate font-heading font-semibold text-lg">
                      {selectedProject() ? projectName(selectedProject()?.path ?? "") : "Projects"}
                    </h1>
                    <Show when={selectedProject()}>
                      {(project) => (
                        <span
                          class={`rounded-full px-2 py-0.5 text-[8px] ${conditionTone[selectedCondition()]}`}
                        >
                          {projectName(project().path)} · {selectedCondition()}
                        </span>
                      )}
                    </Show>
                  </div>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-1 font-semibold text-[9px] text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
                    <Radio class="size-2.5" /> Connected to Kojo Host {current().host.hostVersion} ·
                    Host live
                  </span>
                  <button
                    type="button"
                    class="grid size-7 place-items-center rounded-md border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
                    aria-label={
                      navigatorCollapsed()
                        ? "Expand Project resource navigator"
                        : "Collapse Project resource navigator"
                    }
                    onClick={() => setNavigatorCollapsed((value) => !value)}
                  >
                    <Menu class="size-3.5" />
                  </button>
                  <button
                    type="button"
                    class="grid size-7 place-items-center rounded-md border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
                    aria-label={
                      inspectorCollapsed()
                        ? "Expand Run inspection panel"
                        : "Collapse Run inspection panel"
                    }
                    onClick={() => setInspectorCollapsed((value) => !value)}
                  >
                    <ChevronRight
                      class={`size-3.5 transition ${inspectorCollapsed() ? "rotate-180" : ""}`}
                    />
                  </button>
                  <LanguageToggle />
                  <ThemeToggle />
                </div>
              </header>
              <div class="workflow-inspector-workspace-scroll">
                <Show when={actions.notice()}>
                  {(message) => (
                    <div
                      class="mx-4 mt-3 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[10px] text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                      role="status"
                    >
                      <CircleCheck class="mt-0.5 size-3 shrink-0" />
                      <span class="flex-1">{message()}</span>
                      <button
                        type="button"
                        aria-label="Dismiss notice"
                        onClick={() => actions.setNotice(undefined)}
                      >
                        <X class="size-3" />
                      </button>
                    </div>
                  )}
                </Show>
                <Show when={actions.error()}>
                  {(message) => (
                    <div
                      class="mx-4 mt-3 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300"
                      role="alert"
                    >
                      <CircleAlert class="mt-0.5 size-3 shrink-0" />
                      <span class="flex-1">{message()}</span>
                      <button
                        type="button"
                        aria-label="Dismiss error"
                        onClick={() => actions.setError(undefined)}
                      >
                        <X class="size-3" />
                      </button>
                    </div>
                  )}
                </Show>
                <Show
                  when={current().projects.length > 0}
                  fallback={
                    <div class="p-4">
                      <div class="workflow-inspector-card">
                        <h2 class="font-heading font-semibold text-lg">No Kojo Projects yet.</h2>
                        <p class="mt-2 text-xs text-zinc-500">
                          Register an initialized Project with the CLI. The Host Project Index is
                          the only authoritative Project list.
                        </p>
                      </div>
                    </div>
                  }
                >
                  <div class="workflow-inspector-content">
                    <div class="flex items-center justify-between gap-3 px-1">
                      <div>
                        <p class="text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
                          Selected Workflow Run
                        </p>
                        <p class="mt-1 text-[10px] text-zinc-500">
                          Project, Schedule, occurrence, relationship graph, and Event chronology
                          stay in separate Host-owned views.
                        </p>
                      </div>
                      <Show when={selectedRun()}>
                        {(run) => (
                          <span class={`rounded-full px-2 py-1 text-[9px] ${runTone[run().state]}`}>
                            {run().state}
                          </span>
                        )}
                      </Show>
                    </div>
                    <RunGraph
                      runs={selectedRuns()}
                      selectedRunId={selectedRunId()}
                      onSelectRun={setSelectedRunId}
                    />
                    <section aria-label="Live Event feed" class="workflow-inspector-card">
                      <div class="mb-2 flex items-center gap-2">
                        <History class="size-4 text-violet-600 dark:text-violet-300" />
                        <div>
                          <h2 class="font-heading font-semibold text-base">
                            Numbered live Event feed
                          </h2>
                          <p class="text-[10px] text-zinc-500">
                            Chronology is separate from the structural graph. Reconnects reload the
                            authoritative sequence before controls resume.
                          </p>
                        </div>
                      </div>
                      <ExecutionTrace
                        selection={traceSelection()}
                        {...(props.acknowledgeTrace === undefined
                          ? {}
                          : { acknowledgeTrace: props.acknowledgeTrace })}
                        {...(props.followTrace === undefined
                          ? {}
                          : { followTrace: props.followTrace })}
                        {...(props.loadTrace === undefined ? {} : { loadTrace: props.loadTrace })}
                        {...(props.traceRefreshIntervalMs === undefined
                          ? {}
                          : { refreshIntervalMs: props.traceRefreshIntervalMs })}
                      />
                    </section>
                  </div>
                </Show>
              </div>
            </section>

            <Show when={!inspectorCollapsed() && selectedProject()}>
              {(project) => (
                <InspectorPanel
                  project={project()}
                  run={selectedRun()}
                  definition={selectedDefinition()}
                  retention={selectedRetention()}
                  canStart={current().host.capabilities.includes("runs:start")}
                  canReveal={current().host.capabilities.includes("runs:reveal")}
                  revealedRun={revealedRun()}
                  artifactIds={artifactIds()}
                  busyAction={actions.busyAction()}
                  onResume={actions.resume}
                  onCompleteDeferred={actions.completeDeferred}
                  onStop={actions.requestStop}
                  onFreshStart={() => setDialog("fresh-start")}
                  onReveal={() => setDialog("reveal")}
                />
              )}
            </Show>
            <Show when={!inspectorCollapsed()}>
              <hr
                class="workflow-inspector-resizer workflow-inspector-resizer-inspector"
                aria-label="Resize Run inspection panel"
                aria-orientation="vertical"
                aria-valuemin="220"
                aria-valuemax="420"
                aria-valuenow={inspectorWidth()}
                tabIndex={0}
                onPointerDown={(event) => startResize("inspector", event)}
                onKeyDown={(event) => keyboardResize("inspector", event)}
              />
            </Show>
          </div>
        )}
      </Show>

      <WorkflowInspectorDialog
        dialog={dialog}
        freshInput={actions.freshInput}
        busyAction={actions.busyAction}
        onFreshInput={actions.setFreshInput}
        onClose={() => setDialog(null)}
        onFreshStart={() => void actions.freshStart()}
        onConfirmStop={() => void actions.confirmStop()}
        onReveal={() => void actions.reveal()}
      />
    </main>
  );
}

export type { WorkflowInspectorProps } from "../models/workflow-inspector-models";

const errorMessage = (error: unknown) => {
  if (typeof error !== "object" || error === null)
    return "The visualizer could not reach Kojo Host.";
  const candidate = error as { readonly message?: unknown; readonly next?: unknown };
  const message =
    typeof candidate.message === "string" ? candidate.message : "Host request failed.";
  const next = typeof candidate.next === "string" ? ` ${candidate.next}` : "";
  return `${message}${next}`;
};
