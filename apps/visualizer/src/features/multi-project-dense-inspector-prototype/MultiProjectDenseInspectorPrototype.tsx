import { createMemo, createSignal, For, Show } from "solid-js";

// PROTOTYPE — Three multi-Project navigation and filtering variants on the existing `/` route,
// switchable via `?variant=`. This code is intentionally throwaway.

export type MultiProjectPrototypeVariant = "A" | "B" | "C";
type ProjectAvailability = "Available" | "Unavailable";
type ProjectRegistrationState = "Enabled" | "Disabled" | "Archived";
type RunState = "Running" | "Suspended" | "Interrupted" | "Failed" | "Completed" | "Discarded";
type TraceResult = "completed" | "decision" | "failed" | "unknown";

type Project = {
  availability: ProjectAvailability;
  availabilityReason?: string;
  displayName: string;
  id: string;
  path: string;
  registration: ProjectRegistrationState;
};

type Workflow = {
  name: string;
  projectId: string;
  revision: string;
};

type WorkflowRun = {
  age: string;
  attempt: number;
  id: string;
  projectId: string;
  resumeCompatibility: "Exact match" | "Source unavailable" | "Not applicable";
  state: RunState;
  title: string;
  workflow: string;
};

type TraceNode = {
  actor: string;
  detail: string;
  duration: string;
  id: string;
  kind: string;
  ordinal: number;
  result: TraceResult;
  time: string;
  title: string;
};

const projects: Project[] = [
  {
    availability: "Available",
    displayName: "kojo",
    id: "01K-KOJO-7A2",
    path: "~/Projects/oss/kojo",
    registration: "Enabled",
  },
  {
    availability: "Unavailable",
    availabilityReason: "Registered folder is missing",
    displayName: "checkout",
    id: "01K-CHK-1F9",
    path: "~/Projects/work/checkout",
    registration: "Enabled",
  },
  {
    availability: "Available",
    displayName: "storefront",
    id: "01K-STO-8C4",
    path: "~/Projects/work/storefront",
    registration: "Disabled",
  },
  {
    availability: "Available",
    displayName: "design-system",
    id: "01K-DSN-3E6",
    path: "~/Projects/work/design-system",
    registration: "Enabled",
  },
  {
    availability: "Unavailable",
    availabilityReason: "Archived registrations are not validated",
    displayName: "checkout",
    id: "01J-CHK-OLD",
    path: "/Volumes/archive/checkout",
    registration: "Archived",
  },
];

const workflows: Workflow[] = [
  { name: "delivery", projectId: "01K-KOJO-7A2", revision: "a8c41f2" },
  { name: "issue-triage", projectId: "01K-KOJO-7A2", revision: "81de903" },
  { name: "release-note-draft", projectId: "01K-KOJO-7A2", revision: "5ac9d70" },
  { name: "delivery", projectId: "01K-CHK-1F9", revision: "b11a029" },
  { name: "delivery", projectId: "01K-STO-8C4", revision: "f871bb4" },
  { name: "release-note-draft", projectId: "01K-STO-8C4", revision: "d041ac8" },
  { name: "delivery", projectId: "01K-DSN-3E6", revision: "a0de114" },
  { name: "delivery", projectId: "01J-CHK-OLD", revision: "18f0ed2" },
];

const runs: WorkflowRun[] = [
  {
    age: "2m",
    attempt: 1,
    id: "01JY7AW4Y4K8P38MN4D",
    projectId: "01K-KOJO-7A2",
    resumeCompatibility: "Exact match",
    state: "Failed",
    title: "Deliver product search",
    workflow: "delivery",
  },
  {
    age: "18m",
    attempt: 2,
    id: "01JY70A6D6T7K91BC2P",
    projectId: "01K-CHK-1F9",
    resumeCompatibility: "Source unavailable",
    state: "Interrupted",
    title: "Repair payment retry",
    workflow: "delivery",
  },
  {
    age: "41m",
    attempt: 1,
    id: "01JY6R9PXF6M54AQQ11",
    projectId: "01K-STO-8C4",
    resumeCompatibility: "Exact match",
    state: "Running",
    title: "Ship summer collection",
    workflow: "delivery",
  },
  {
    age: "3h",
    attempt: 1,
    id: "01JY61BNA7EDM0444AC",
    projectId: "01K-KOJO-7A2",
    resumeCompatibility: "Not applicable",
    state: "Completed",
    title: "Fix checkout retry",
    workflow: "delivery",
  },
  {
    age: "8h",
    attempt: 1,
    id: "01JY58DP9RAE0Z21M5K",
    projectId: "01K-KOJO-7A2",
    resumeCompatibility: "Not applicable",
    state: "Completed",
    title: "Draft 0.2 release notes",
    workflow: "release-note-draft",
  },
  {
    age: "1d",
    attempt: 1,
    id: "01JXW72M0GT4QAFB912",
    projectId: "01K-STO-8C4",
    resumeCompatibility: "Not applicable",
    state: "Discarded",
    title: "Replace storefront search",
    workflow: "delivery",
  },
  {
    age: "92d",
    attempt: 1,
    id: "01JOLD0F1AA4V8QX221",
    projectId: "01J-CHK-OLD",
    resumeCompatibility: "Not applicable",
    state: "Completed",
    title: "Migrate payment provider",
    workflow: "delivery",
  },
];

const traceNodes: TraceNode[] = [
  {
    actor: "Kojo",
    detail:
      "Pinned the Developer Workflow revision and captured the safe runtime configuration for this run.",
    duration: "11ms",
    id: "run-started",
    kind: "Workflow Run",
    ordinal: 1,
    result: "completed",
    time: "10:42:03",
    title: "Workflow Run started",
  },
  {
    actor: "delivery",
    detail:
      "Deterministic scheduling selected product-search before the independent documentation ticket.",
    duration: "2ms",
    id: "route-selected",
    kind: "Execution Decision",
    ordinal: 2,
    result: "decision",
    time: "10:42:03",
    title: "Selected next ticket: product-search",
  },
  {
    actor: "local-docker",
    detail:
      "Created the named Reusable Sandbox product-search on its recorded branch and starting commit.",
    duration: "4.8s",
    id: "sandbox-created",
    kind: "Sandbox",
    ordinal: 3,
    result: "completed",
    time: "10:42:08",
    title: "Sandbox “product-search”",
  },
  {
    actor: "claude-code / sonnet",
    detail:
      "The implementer changed eight files and produced a transcript artifact. Secret configuration was omitted.",
    duration: "6m 12s",
    id: "implementation",
    kind: "Agent Step",
    ordinal: 4,
    result: "completed",
    time: "10:48:20",
    title: "Implement product search",
  },
  {
    actor: "delivery",
    detail:
      "The Review Loop continued because one P2 finding remained and returned control to the implementer.",
    duration: "1ms",
    id: "loop-continue",
    kind: "Execution Decision",
    ordinal: 5,
    result: "decision",
    time: "10:51:02",
    title: "Continue Review Loop: 1 finding",
  },
  {
    actor: "git",
    detail:
      "The push may have completed, but process ownership was lost before its result was recorded.",
    duration: "30s",
    id: "publish-uncertain",
    kind: "Activity Attempt",
    ordinal: 6,
    result: "unknown",
    time: "10:56:21",
    title: "Publish branch · outcome uncertain",
  },
  {
    actor: "Kojo",
    detail:
      "The resumable Typed Failure ended Execution Attempt 1. Reconciliation is required before retry.",
    duration: "3ms",
    id: "run-failed",
    kind: "Typed Failure",
    ordinal: 7,
    result: "failed",
    time: "10:56:51",
    title: "Workflow Run failed",
  },
];

const workflowNames = ["delivery", "issue-triage", "release-note-draft"];
const lifecycleFilters: Array<"All" | RunState> = [
  "All",
  "Running",
  "Failed",
  "Interrupted",
  "Completed",
  "Discarded",
];

const projectById = (id: string) => projects.find((project) => project.id === id) ?? projects[0];
const shortId = (id: string) => id.slice(-7);

export function MultiProjectDenseInspectorPrototype(props: {
  serverState: "connected" | "connecting" | "unavailable";
  variant: MultiProjectPrototypeVariant;
}) {
  const [projectFilter, setProjectFilter] = createSignal("all");
  const [workflowFilter, setWorkflowFilter] = createSignal("all");
  const [lifecycleFilter, setLifecycleFilter] = createSignal<"All" | RunState>("All");
  const [includeArchived, setIncludeArchived] = createSignal(false);
  const [selectedRunId, setSelectedRunId] = createSignal(runs[0].id);
  const [selectedTraceId, setSelectedTraceId] = createSignal("publish-uncertain");

  const visibleProjects = createMemo(() =>
    projects.filter((project) => includeArchived() || project.registration !== "Archived"),
  );

  const visibleRuns = createMemo(() =>
    runs.filter((run) => {
      const project = projectById(run.projectId);
      return (
        (includeArchived() || project.registration !== "Archived") &&
        (projectFilter() === "all" || run.projectId === projectFilter()) &&
        (workflowFilter() === "all" || run.workflow === workflowFilter()) &&
        (lifecycleFilter() === "All" || run.state === lifecycleFilter())
      );
    }),
  );

  const selectedRun = createMemo(() => runs.find((run) => run.id === selectedRunId()) ?? runs[0]);
  const selectionIsVisible = createMemo(() =>
    visibleRuns().some((run) => run.id === selectedRun().id),
  );
  const selectedTrace = createMemo(
    () => traceNodes.find((node) => node.id === selectedTraceId()) ?? traceNodes[0],
  );

  const navigationProps = {
    includeArchived,
    lifecycleFilter,
    projectFilter,
    selectedRunId,
    setIncludeArchived,
    setLifecycleFilter,
    setProjectFilter,
    setSelectedRunId,
    setWorkflowFilter,
    visibleProjects,
    visibleRuns,
    workflowFilter,
  };

  const inspectorProps = {
    selectedRun,
    selectedTrace,
    selectedTraceId,
    selectionIsVisible,
    setSelectedRunId,
    setSelectedTraceId,
    visibleRuns,
  };

  return (
    <main class="min-h-svh bg-[#f4f2ec] pb-24 font-mono text-[#22221f]">
      <DenseHeader serverState={props.serverState} variant={props.variant} />
      <Show when={props.variant === "A"}>
        <DenseLayout
          inspector={<TraceInspector {...inspectorProps} outsidePolicy="pin" />}
          navigation={<ProjectDrillDown {...navigationProps} />}
        />
      </Show>
      <Show when={props.variant === "B"}>
        <DenseLayout
          inspector={<TraceInspector {...inspectorProps} outsidePolicy="pin-in-list" />}
          navigation={<FacetedRunInbox {...navigationProps} />}
        />
      </Show>
      <Show when={props.variant === "C"}>
        <DenseLayout
          inspector={<TraceInspector {...inspectorProps} outsidePolicy="clear" />}
          navigation={<ProjectWorkflowMatrix {...navigationProps} />}
          wideNavigation
        />
      </Show>
    </main>
  );
}

type NavigationProps = {
  includeArchived: () => boolean;
  lifecycleFilter: () => "All" | RunState;
  projectFilter: () => string;
  selectedRunId: () => string;
  setIncludeArchived: (value: boolean) => void;
  setLifecycleFilter: (value: "All" | RunState) => void;
  setProjectFilter: (value: string) => void;
  setSelectedRunId: (value: string) => void;
  setWorkflowFilter: (value: string) => void;
  visibleProjects: () => Project[];
  visibleRuns: () => WorkflowRun[];
  workflowFilter: () => string;
};

type InspectorProps = {
  selectedRun: () => WorkflowRun;
  selectedTrace: () => TraceNode;
  selectedTraceId: () => string;
  selectionIsVisible: () => boolean;
  setSelectedRunId: (value: string) => void;
  setSelectedTraceId: (value: string) => void;
  visibleRuns: () => WorkflowRun[];
};

function DenseHeader(props: {
  serverState: "connected" | "connecting" | "unavailable";
  variant: MultiProjectPrototypeVariant;
}) {
  const names: Record<MultiProjectPrototypeVariant, string> = {
    A: "PROJECT DRILL-DOWN",
    B: "FACETED RUN INBOX",
    C: "PROJECT / WORKFLOW MATRIX",
  };

  return (
    <header class="flex h-12 items-center justify-between border-[#292923] border-b-2 px-4">
      <div class="flex items-center gap-4 text-[10px]">
        <span class="bg-[#292923] px-2 py-1 font-bold text-[#f4f2ec]">KOJO / AGGREGATE TRACE</span>
        <span class="text-[#77766d]">{names[props.variant]}</span>
      </div>
      <div class="flex items-center gap-2 border border-[#b8b6ad] bg-[#e7e5dd] px-2.5 py-1 text-[9px]">
        <span
          class={`size-1.5 rounded-full ${
            props.serverState === "connected"
              ? "bg-emerald-600"
              : props.serverState === "connecting"
                ? "bg-amber-500"
                : "bg-rose-600"
          }`}
        />
        {props.serverState === "connected"
          ? "SYSTEM PROCESS"
          : props.serverState === "connecting"
            ? "CONNECTING"
            : "MOCK DATA"}
      </div>
    </header>
  );
}

function DenseLayout(props: { inspector: unknown; navigation: unknown; wideNavigation?: boolean }) {
  return (
    <div
      class={`grid min-h-[calc(100svh-3rem)] ${
        props.wideNavigation
          ? "grid-cols-[360px_minmax(560px,1fr)_320px]"
          : "grid-cols-[290px_minmax(560px,1fr)_320px]"
      }`}
    >
      <aside class="border-[#b8b6ad] border-r">{props.navigation as never}</aside>
      {props.inspector as never}
    </div>
  );
}

function ProjectDrillDown(props: NavigationProps) {
  const selectedProject = createMemo(() =>
    props.projectFilter() === "all"
      ? undefined
      : projects.find((project) => project.id === props.projectFilter()),
  );
  const scopedWorkflows = createMemo(() =>
    workflows.filter(
      (workflow) =>
        (props.includeArchived() || projectById(workflow.projectId).registration !== "Archived") &&
        (props.projectFilter() === "all" || workflow.projectId === props.projectFilter()),
    ),
  );

  return (
    <>
      <SectionHeader count={props.visibleProjects().length} title="1 / PROJECTS" />
      <div class="p-2">
        <button
          class={`w-full border px-2 py-2 text-left text-[10px] ${
            props.projectFilter() === "all"
              ? "border-[#292923] bg-[#292923] text-white"
              : "border-transparent hover:bg-[#e7e5dd]"
          }`}
          onClick={() => props.setProjectFilter("all")}
          type="button"
        >
          <strong>All Projects</strong>
          <span class="float-right">
            {runs.filter((run) => projectById(run.projectId).registration !== "Archived").length}
          </span>
        </button>
        <For each={props.visibleProjects()}>
          {(project) => (
            <ProjectRow
              onSelect={() => {
                props.setProjectFilter(project.id);
                props.setWorkflowFilter("all");
              }}
              project={project}
              selected={props.projectFilter() === project.id}
            />
          )}
        </For>
        <ArchiveToggle {...props} />
      </div>

      <SectionHeader count={scopedWorkflows().length} title="2 / DEVELOPER WORKFLOWS" />
      <div class="p-2">
        <button
          class={`w-full border-[#d2d0c7] border-b px-2 py-2 text-left text-[10px] ${
            props.workflowFilter() === "all" ? "bg-[#fff8ca] font-bold" : ""
          }`}
          onClick={() => props.setWorkflowFilter("all")}
          type="button"
        >
          All workflows
        </button>
        <For each={scopedWorkflows()}>
          {(workflow) => (
            <button
              class={`grid w-full grid-cols-[1fr_auto] border-[#d2d0c7] border-b px-2 py-2 text-left text-[9px] hover:bg-[#e7e5dd] ${
                props.workflowFilter() === workflow.name ? "bg-[#fff8ca]" : ""
              }`}
              onClick={() => {
                if (!selectedProject()) props.setProjectFilter(workflow.projectId);
                props.setWorkflowFilter(workflow.name);
              }}
              type="button"
            >
              <span>
                <strong>{workflow.name}</strong>
                <Show when={!selectedProject()}>
                  <span class="mt-0.5 block text-[#77766d]">
                    {projectById(workflow.projectId).displayName} · {shortId(workflow.projectId)}
                  </span>
                </Show>
              </span>
              <span class="text-[#77766d]">{workflow.revision}</span>
            </button>
          )}
        </For>
      </div>

      <SectionHeader count={props.visibleRuns().length} title="3 / WORKFLOW RUNS" />
      <LifecycleSelect {...props} />
      <RunRows
        runs={props.visibleRuns()}
        selectedRunId={props.selectedRunId()}
        setSelectedRunId={props.setSelectedRunId}
      />
      <Show when={props.visibleRuns().length === 0}>
        <EmptyScope
          detail={
            selectedProject()
              ? `${selectedProject()?.displayName} is registered, but this Project and workflow scope has no Workflow Runs.`
              : "No Workflow Runs match this scope."
          }
          title="NO RUNS IN PROJECT"
        />
      </Show>
    </>
  );
}

function FacetedRunInbox(props: NavigationProps) {
  const selectedOutsideScope = createMemo(
    () =>
      runs.find((run) => run.id === props.selectedRunId()) &&
      !props.visibleRuns().some((run) => run.id === props.selectedRunId()),
  );

  return (
    <>
      <SectionHeader count={props.visibleRuns().length} title="AGGREGATE RUN INBOX" />
      <div class="space-y-3 border-[#b8b6ad] border-b p-3">
        <FilterLabel label="PROJECT">
          <select
            class="w-full border border-[#b8b6ad] bg-[#f4f2ec] px-2 py-1.5 text-[10px]"
            onChange={(event) => props.setProjectFilter(event.currentTarget.value)}
            value={props.projectFilter()}
          >
            <option value="all">All Projects</option>
            <For each={props.visibleProjects()}>
              {(project) => (
                <option value={project.id}>
                  {project.displayName} · {shortId(project.id)}
                </option>
              )}
            </For>
          </select>
        </FilterLabel>
        <FilterLabel label="DEVELOPER WORKFLOW">
          <select
            class="w-full border border-[#b8b6ad] bg-[#f4f2ec] px-2 py-1.5 text-[10px]"
            onChange={(event) => props.setWorkflowFilter(event.currentTarget.value)}
            value={props.workflowFilter()}
          >
            <option value="all">All workflows</option>
            <For each={workflowNames}>
              {(workflow) => <option value={workflow}>{workflow}</option>}
            </For>
          </select>
        </FilterLabel>
        <FilterLabel label="LIFECYCLE">
          <div class="flex flex-wrap gap-1">
            <For each={lifecycleFilters}>
              {(state) => (
                <button
                  class={`border px-1.5 py-1 text-[9px] ${
                    props.lifecycleFilter() === state
                      ? "border-[#292923] bg-[#292923] text-white"
                      : "border-[#b8b6ad] hover:bg-[#e7e5dd]"
                  }`}
                  onClick={() => props.setLifecycleFilter(state)}
                  type="button"
                >
                  {state.toUpperCase()}
                </button>
              )}
            </For>
          </div>
        </FilterLabel>
        <ArchiveToggle {...props} />
      </div>

      <Show when={selectedOutsideScope()}>
        <div class="border-[#d4a81e] border-b-2 bg-[#fff8ca] px-3 py-2 text-[9px]">
          <strong>PINNED OUTSIDE FILTERS</strong>
          <p class="mt-1 font-sans text-[10px] leading-4">
            The inspected run stays open and appears above the matching inbox.
          </p>
          <RunRows
            runs={runs.filter((run) => run.id === props.selectedRunId())}
            selectedRunId={props.selectedRunId()}
            setSelectedRunId={props.setSelectedRunId}
          />
        </div>
      </Show>

      <div class="grid grid-cols-[1fr_58px] border-[#292923] border-b bg-[#dedcd4] px-3 py-2 font-bold text-[9px]">
        <span>PROJECT / WORKFLOW / RUN</span>
        <span>STATE</span>
      </div>
      <RunRows
        runs={props.visibleRuns()}
        selectedRunId={props.selectedRunId()}
        setSelectedRunId={props.setSelectedRunId}
      />
      <Show when={props.visibleRuns().length === 0}>
        <EmptyScope
          detail="Project, workflow, lifecycle, and Archived filters combine with AND. Remove one facet to widen the inbox."
          title="NO MATCHING RUNS"
        />
      </Show>
    </>
  );
}

function ProjectWorkflowMatrix(props: NavigationProps) {
  const matrixWorkflows = ["delivery", "issue-triage", "release-note-draft"];

  const selectCell = (projectId: string, workflow: string) => {
    props.setProjectFilter(projectId);
    props.setWorkflowFilter(workflow);
  };

  return (
    <>
      <SectionHeader count={props.visibleProjects().length} title="PROJECT × WORKFLOW MATRIX" />
      <div class="overflow-x-auto border-[#b8b6ad] border-b">
        <div class="grid min-w-[350px] grid-cols-[125px_repeat(3,74px)] bg-[#dedcd4] text-[8px]">
          <span class="border-[#b8b6ad] border-r p-2 font-bold">PROJECT</span>
          <For each={matrixWorkflows}>
            {(workflow) => (
              <span class="border-[#b8b6ad] border-r p-2 text-center last:border-r-0">
                {workflow === "release-note-draft" ? "release-note" : workflow}
              </span>
            )}
          </For>
        </div>
        <For each={props.visibleProjects()}>
          {(project) => (
            <div class="grid min-w-[350px] grid-cols-[125px_repeat(3,74px)] border-[#d2d0c7] border-t text-[9px]">
              <div class="min-w-0 border-[#b8b6ad] border-r p-2">
                <strong class="block truncate">{project.displayName}</strong>
                <span class="text-[#77766d]">{shortId(project.id)}</span>
                <span
                  class={`mt-1 block text-[8px] ${
                    project.availability === "Unavailable" ? "text-[#c7392f]" : "text-[#77766d]"
                  }`}
                >
                  {project.registration.toUpperCase()} / {project.availability.toUpperCase()}
                </span>
              </div>
              <For each={matrixWorkflows}>
                {(workflowName) => {
                  const count = () =>
                    runs.filter(
                      (run) =>
                        run.projectId === project.id &&
                        run.workflow === workflowName &&
                        (props.lifecycleFilter() === "All" ||
                          run.state === props.lifecycleFilter()),
                    ).length;
                  const exists = () =>
                    workflows.some(
                      (workflow) =>
                        workflow.projectId === project.id && workflow.name === workflowName,
                    );
                  const selected = () =>
                    props.projectFilter() === project.id && props.workflowFilter() === workflowName;
                  return (
                    <button
                      aria-label={`${project.displayName} ${shortId(project.id)} / ${workflowName}: ${
                        exists() ? `${count()} runs` : "absent"
                      }`}
                      class={`border-[#b8b6ad] border-r text-center last:border-r-0 ${
                        selected()
                          ? "bg-[#292923] text-white"
                          : exists()
                            ? count() === 0
                              ? "bg-[#fff8ca] hover:bg-[#f8ed9f]"
                              : "hover:bg-[#e7e5dd]"
                            : "bg-[#e7e5dd] text-[#aaa89f]"
                      }`}
                      disabled={!exists()}
                      onClick={() => selectCell(project.id, workflowName)}
                      type="button"
                    >
                      <strong class="block text-lg">{exists() ? count() : "—"}</strong>
                      <span class="text-[8px]">{exists() ? "RUNS" : "ABSENT"}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>

      <div class="flex items-center justify-between border-[#b8b6ad] border-b p-3">
        <FilterLabel label="LIFECYCLE">
          <select
            class="mt-1 border border-[#b8b6ad] bg-[#f4f2ec] px-2 py-1 text-[9px]"
            onChange={(event) =>
              props.setLifecycleFilter(event.currentTarget.value as "All" | RunState)
            }
            value={props.lifecycleFilter()}
          >
            <For each={lifecycleFilters}>{(state) => <option value={state}>{state}</option>}</For>
          </select>
        </FilterLabel>
        <ArchiveToggle {...props} />
      </div>

      <div class="border-[#292923] border-b bg-[#dedcd4] px-3 py-2 font-bold text-[9px]">
        RUNS IN SELECTED CELL
      </div>
      <RunRows
        runs={props.visibleRuns()}
        selectedRunId={props.selectedRunId()}
        setSelectedRunId={props.setSelectedRunId}
      />
      <Show when={props.visibleRuns().length === 0}>
        <EmptyScope
          detail="The selected Project has this Developer Workflow, but no Workflow Runs match the cell and lifecycle."
          title="EMPTY MATRIX CELL"
        />
      </Show>
    </>
  );
}

function TraceInspector(
  props: InspectorProps & { outsidePolicy: "clear" | "pin" | "pin-in-list" },
) {
  const strictScopeEmpty = createMemo(
    () => props.outsidePolicy === "clear" && !props.selectionIsVisible(),
  );
  const run = () => props.selectedRun();
  const project = () => projectById(run().projectId);

  return (
    <>
      <section class="min-w-0 border-[#b8b6ad] border-r">
        <Show
          when={!strictScopeEmpty()}
          fallback={
            <div class="grid h-full min-h-[520px] place-items-center p-10">
              <div class="max-w-md border-2 border-[#292923] bg-[#fff8ca] p-6 text-center">
                <p class="font-bold text-[10px]">SELECTION CLEARED BY SCOPE</p>
                <h2 class="mt-3 font-sans font-semibold text-xl">
                  Choose a run in this matrix cell
                </h2>
                <p class="mt-3 font-sans text-[#55544e] text-xs leading-5">
                  This variant makes the Project/workflow cell authoritative. A run outside the
                  current cell is not kept open.
                </p>
                <Show when={props.visibleRuns().length > 0}>
                  <button
                    class="mt-4 bg-[#292923] px-3 py-2 font-bold text-[#f4f2ec] text-[9px]"
                    onClick={() => props.setSelectedRunId(props.visibleRuns()[0].id)}
                    type="button"
                  >
                    OPEN FIRST MATCH
                  </button>
                </Show>
              </div>
            </div>
          }
        >
          <Show when={!props.selectionIsVisible() && props.outsidePolicy === "pin"}>
            <OutsideScopeBanner>
              Inspector selection is pinned. The Project browser changed, but this trace stays open
              until another run is selected.
            </OutsideScopeBanner>
          </Show>
          <Show when={!props.selectionIsVisible() && props.outsidePolicy === "pin-in-list"}>
            <OutsideScopeBanner>
              Inspector selection is pinned and repeated above the filtered run inbox.
            </OutsideScopeBanner>
          </Show>

          <div class="border-[#292923] border-b-2 px-4 py-3">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2 text-[#77766d] text-[9px]">
                  <span>{project().displayName.toUpperCase()}</span>
                  <span>· {shortId(project().id)}</span>
                  <span>/</span>
                  <span>{run().workflow.toUpperCase()}</span>
                  <span>/</span>
                  <span class="truncate">RUN {run().id}</span>
                </div>
                <div class="mt-2 flex items-center gap-3">
                  <h1 class="truncate font-sans font-semibold text-xl tracking-tight">
                    {run().title}
                  </h1>
                  <RunStateLabel state={run().state} />
                </div>
              </div>
              <RunAction run={run()} />
            </div>
          </div>

          <dl class="grid grid-cols-5 border-[#b8b6ad] border-b bg-[#e7e5dd] text-[9px]">
            <DenseFact
              label="PROJECT"
              value={`${project().displayName} · ${shortId(project().id)}`}
            />
            <DenseFact
              danger={project().availability === "Unavailable"}
              label="PROJECT.AVAILABILITY"
              value={project().availability.toUpperCase()}
            />
            <DenseFact
              danger={run().state === "Failed"}
              label="RUN.STATE"
              value={run().state.toUpperCase()}
            />
            <DenseFact label="RESUME.REVISION" value={run().resumeCompatibility.toUpperCase()} />
            <DenseFact label="ATTEMPT.CURRENT" value={String(run().attempt)} />
          </dl>

          <nav class="flex items-center justify-between border-[#b8b6ad] border-b px-4">
            <div class="flex gap-5">
              <button class="border-[#292923] border-b-2 py-2.5 font-bold text-[9px]" type="button">
                ACTUAL TRACE [7]
              </button>
              <button class="py-2.5 text-[#77766d] text-[9px]" type="button">
                RUN TREE [2]
              </button>
              <button class="py-2.5 text-[#77766d] text-[9px]" type="button">
                ARTIFACTS [4]
              </button>
            </div>
            <span class="text-[#77766d] text-[9px]">RUN-LOCAL ORDER / ASC</span>
          </nav>

          <div class="grid grid-cols-[42px_72px_minmax(260px,1fr)_92px] border-[#292923] border-b bg-[#dedcd4] px-3 py-2 font-bold text-[9px]">
            <span>ORD</span>
            <span>TIME</span>
            <span>EVENT / SUBJECT</span>
            <span>RESULT</span>
          </div>
          <For each={traceNodes}>
            {(node) => (
              <button
                class={`grid w-full grid-cols-[42px_72px_minmax(260px,1fr)_92px] items-center border-[#d2d0c7] border-b px-3 py-2.5 text-left text-[9px] hover:bg-[#ebe9e2] ${
                  props.selectedTraceId() === node.id ? "bg-[#fff8ca]" : ""
                }`}
                onClick={() => props.setSelectedTraceId(node.id)}
                type="button"
              >
                <span class="text-[#77766d]">{String(node.ordinal).padStart(3, "0")}</span>
                <span class="text-[#77766d]">{node.time}</span>
                <span class="min-w-0 truncate">
                  <strong>{node.kind.toUpperCase()}</strong>
                  <span class="mx-1.5 text-[#aaa89f]">/</span>
                  {node.title}
                </span>
                <TraceResultLabel result={node.result} />
              </button>
            )}
          </For>
        </Show>
      </section>

      <aside class="bg-[#e7e5dd]">
        <Show
          when={!strictScopeEmpty()}
          fallback={
            <div class="p-5">
              <p class="font-bold text-[9px]">SELECTED EVIDENCE</p>
              <p class="mt-3 font-sans text-[#77766d] text-xs leading-5">
                No trace is selected in the current Project/workflow scope.
              </p>
            </div>
          }
        >
          <div class="border-[#b8b6ad] border-b bg-[#dedcd4] px-4 py-2">
            <p class="font-bold text-[9px]">SELECTED EVIDENCE</p>
          </div>
          <div class="p-4">
            <div class="flex items-center justify-between">
              <TraceResultLabel result={props.selectedTrace().result} />
              <span class="text-[#77766d] text-[9px]">
                EVT-{String(props.selectedTrace().ordinal).padStart(3, "0")}
              </span>
            </div>
            <p class="mt-3 text-[#77766d] text-[9px]">{props.selectedTrace().kind.toUpperCase()}</p>
            <h2 class="mt-1 font-sans font-semibold text-lg leading-6">
              {props.selectedTrace().title}
            </h2>
            <p class="mt-3 font-sans text-[#55544e] text-xs leading-5">
              {props.selectedTrace().detail}
            </p>
            <dl class="mt-5 border-[#b8b6ad] border-t pt-3 text-[9px]">
              <DetailRow label="PROJECT.ID" value={shortId(project().id)} />
              <DetailRow label="WORKFLOW" value={run().workflow} />
              <DetailRow label="ACTOR" value={props.selectedTrace().actor} />
              <DetailRow label="STARTED" value={props.selectedTrace().time} />
              <DetailRow label="DURATION" value={props.selectedTrace().duration} />
            </dl>
            <Show when={project().availability === "Unavailable"}>
              <div class="mt-5 border-2 border-[#c7392f] bg-[#fff0ed] p-3">
                <p class="font-bold text-[9px]">PROJECT UNAVAILABLE</p>
                <p class="mt-2 font-sans text-[#55544e] text-[11px] leading-4">
                  Historical evidence remains readable. Resume is blocked:{" "}
                  {project().availabilityReason}.
                </p>
              </div>
            </Show>
            <Show when={project().registration === "Archived"}>
              <div class="mt-5 border-2 border-[#77766d] bg-[#f4f2ec] p-3">
                <p class="font-bold text-[9px]">ARCHIVED PROJECT HISTORY</p>
                <p class="mt-2 font-sans text-[#55544e] text-[11px] leading-4">
                  The Project ID disambiguates this “checkout” registration. Evidence is read-only.
                </p>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </>
  );
}

function ProjectRow(props: { onSelect: () => void; project: Project; selected: boolean }) {
  return (
    <button
      class={`grid w-full grid-cols-[1fr_auto] border-[#d2d0c7] border-b px-2 py-2 text-left text-[9px] ${
        props.selected ? "bg-[#fff8ca]" : "hover:bg-[#e7e5dd]"
      }`}
      onClick={props.onSelect}
      type="button"
    >
      <span class="min-w-0">
        <strong class="block truncate">{props.project.displayName}</strong>
        <span class="mt-0.5 block truncate text-[#77766d]">{props.project.path}</span>
        <span class="mt-1 block text-[#77766d]">
          {props.project.registration.toUpperCase()} · {shortId(props.project.id)}
        </span>
      </span>
      <span
        class={`mt-0.5 size-2 rounded-full ${
          props.project.availability === "Available" ? "bg-emerald-600" : "bg-rose-600"
        }`}
        title={props.project.availability}
      />
    </button>
  );
}

function RunRows(props: {
  runs: WorkflowRun[];
  selectedRunId: string;
  setSelectedRunId: (value: string) => void;
}) {
  return (
    <For each={props.runs}>
      {(run) => {
        const project = projectById(run.projectId);
        return (
          <button
            class={`w-full border-[#d2d0c7] border-b px-3 py-2.5 text-left text-[9px] hover:bg-[#e7e5dd] ${
              props.selectedRunId === run.id ? "bg-[#fff8ca]" : ""
            }`}
            onClick={() => props.setSelectedRunId(run.id)}
            type="button"
          >
            <div class="flex items-start justify-between gap-2">
              <strong class="font-sans text-[11px] leading-4">{run.title}</strong>
              <span class="text-[#77766d]">{run.age}</span>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2">
              <span class="min-w-0 truncate text-[#77766d]">
                {project.displayName} · {shortId(project.id)} / {run.workflow}
              </span>
              <RunStateLabel state={run.state} />
            </div>
          </button>
        );
      }}
    </For>
  );
}

function ArchiveToggle(props: NavigationProps) {
  return (
    <label class="mt-2 flex cursor-pointer items-center gap-2 text-[#77766d] text-[9px]">
      <input
        checked={props.includeArchived()}
        class="accent-[#292923]"
        onChange={(event) => props.setIncludeArchived(event.currentTarget.checked)}
        type="checkbox"
      />
      INCLUDE ARCHIVED PROJECTS
    </label>
  );
}

function LifecycleSelect(props: NavigationProps) {
  return (
    <div class="border-[#d2d0c7] border-b px-3 py-2">
      <label class="flex items-center justify-between text-[9px]">
        <span class="text-[#77766d]">LIFECYCLE</span>
        <select
          class="border border-[#b8b6ad] bg-[#f4f2ec] px-2 py-1"
          onChange={(event) =>
            props.setLifecycleFilter(event.currentTarget.value as "All" | RunState)
          }
          value={props.lifecycleFilter()}
        >
          <For each={lifecycleFilters}>{(state) => <option value={state}>{state}</option>}</For>
        </select>
      </label>
    </div>
  );
}

function SectionHeader(props: { count: number; title: string }) {
  return (
    <div class="flex items-center justify-between border-[#b8b6ad] border-b bg-[#dedcd4] px-3 py-2">
      <p class="font-bold text-[9px]">{props.title}</p>
      <span class="text-[#77766d] text-[9px]">{props.count}</span>
    </div>
  );
}

function FilterLabel(props: { children: unknown; label: string }) {
  return (
    <div class="block text-[9px]">
      <span class="mb-1 block text-[#77766d]">{props.label}</span>
      {props.children as never}
    </div>
  );
}

function EmptyScope(props: { detail: string; title: string }) {
  return (
    <div class="m-3 border border-[#b8b6ad] border-dashed p-4 text-center">
      <p class="font-bold text-[9px]">{props.title}</p>
      <p class="mt-2 font-sans text-[#77766d] text-[10px] leading-4">{props.detail}</p>
    </div>
  );
}

function OutsideScopeBanner(props: { children: unknown }) {
  return (
    <div class="border-[#d4a81e] border-b-2 bg-[#fff8ca] px-4 py-2 text-[9px]">
      <strong>SELECTION OUTSIDE CURRENT FILTERS</strong>
      <span class="ml-2 font-sans text-[10px]">{props.children as never}</span>
    </div>
  );
}

function DenseFact(props: { danger?: boolean; label: string; value: string }) {
  return (
    <div class="min-w-0 border-[#b8b6ad] border-r px-3 py-2 last:border-r-0">
      <dt class="truncate text-[#77766d]">{props.label}</dt>
      <dd class={`mt-1 truncate font-bold ${props.danger ? "text-[#c7392f]" : ""}`}>
        {props.value}
      </dd>
    </div>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-start justify-between gap-3 border-[#d2d0c7] border-b py-2 last:border-b-0">
      <dt class="text-[#77766d]">{props.label}</dt>
      <dd class="max-w-40 text-right font-bold">{props.value}</dd>
    </div>
  );
}

function RunStateLabel(props: { state: RunState }) {
  const color = () =>
    props.state === "Failed" || props.state === "Interrupted"
      ? "bg-[#c7392f] text-white"
      : props.state === "Running"
        ? "bg-[#d4a81e] text-[#292923]"
        : props.state === "Completed"
          ? "bg-emerald-700 text-white"
          : "bg-[#77766d] text-white";

  return (
    <span class={`shrink-0 px-1.5 py-0.5 font-bold text-[8px] ${color()}`}>
      {props.state.toUpperCase()}
    </span>
  );
}

function TraceResultLabel(props: { result: TraceResult }) {
  const label: Record<TraceResult, string> = {
    completed: "COMPLETED",
    decision: "DECISION",
    failed: "FAILED",
    unknown: "UNKNOWN",
  };
  const color: Record<TraceResult, string> = {
    completed: "text-emerald-700",
    decision: "text-sky-700",
    failed: "font-bold text-[#c7392f]",
    unknown: "font-bold text-[#c7392f]",
  };

  return <span class={color[props.result]}>{label[props.result]}</span>;
}

function RunAction(props: { run: WorkflowRun }) {
  const project = () => projectById(props.run.projectId);
  const canResume = () =>
    (props.run.state === "Failed" || props.run.state === "Interrupted") &&
    project().registration === "Enabled" &&
    project().availability === "Available" &&
    props.run.resumeCompatibility === "Exact match";

  const reason = () => {
    if (project().registration === "Archived") return "Archived Project: history only";
    if (project().availability === "Unavailable") return "Project unavailable";
    if (props.run.state === "Completed" || props.run.state === "Discarded") return "Terminal run";
    if (props.run.state === "Running") return "Run is active";
    return "Resume run";
  };

  return (
    <button
      class={`shrink-0 border px-3 py-1.5 font-bold text-[9px] ${
        canResume()
          ? "border-[#292923] bg-[#292923] text-white"
          : "cursor-not-allowed border-[#b8b6ad] text-[#77766d]"
      }`}
      disabled={!canResume()}
      title={reason()}
      type="button"
    >
      {canResume() ? "RESUME RUN" : reason().toUpperCase()}
    </button>
  );
}
