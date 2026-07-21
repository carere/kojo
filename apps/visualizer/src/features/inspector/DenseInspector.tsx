import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { inspectWorkflowRun, listInspectorRuns } from "./api";
import type {
  InspectorEvidence,
  InspectorRun,
  InspectorRunSummary,
  WorkflowRunState,
} from "./types";

const shortId = (value: string) =>
  value.length > 15 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
const timestamp = (value: string) => value.replace("T", " ").replace(".000Z", "Z");
const titleCase = (value: string) => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
const workflowFacetKey = (projectId: string, workflowName: string) =>
  `${encodeURIComponent(projectId)}:${encodeURIComponent(workflowName)}`;

const flattenRuns = (run: InspectorRun): ReadonlyArray<InspectorRun> => [
  run,
  ...run.children.flatMap(flattenRuns),
];

const traceFor = (root: InspectorRun, selectedRunId: string) => {
  const selected = flattenRuns(root).find(({ runId }) => runId === selectedRunId) ?? root;
  const runs = selected.runId === root.runId ? flattenRuns(root) : [selected];
  return runs
    .flatMap((run) => run.evidence.map((event) => ({ event, run })))
    .sort(
      (left, right) =>
        left.event.recordedAt.localeCompare(right.event.recordedAt) ||
        left.run.runId.localeCompare(right.run.runId) ||
        left.event.sequence - right.event.sequence,
    );
};

export function DenseInspector() {
  const [includeArchived, setIncludeArchived] = createSignal(false);
  const [runs] = createResource<ReadonlyArray<InspectorRunSummary>, "exclude" | "include">(
    () => (includeArchived() ? "include" : "exclude"),
    (archiveMode) => listInspectorRuns(archiveMode === "include"),
  );
  const [selectedRootId, setSelectedRootId] = createSignal<string>();
  const [selectedRootSummary, setSelectedRootSummary] = createSignal<InspectorRunSummary>();
  const [selectedRunId, setSelectedRunId] = createSignal<string>();
  const [selectedEventId, setSelectedEventId] = createSignal<string>();
  const [projectFilter, setProjectFilter] = createSignal("all");
  const [workflowFilter, setWorkflowFilter] = createSignal("all");
  const [stateFilter, setStateFilter] = createSignal<"all" | WorkflowRunState>("all");
  const [run] = createResource<InspectorRun, string>(selectedRootId, inspectWorkflowRun);

  createEffect(() => {
    const first = runs()?.[0];
    if (selectedRootId() === undefined && first !== undefined) {
      setSelectedRootId(first.runId);
      setSelectedRootSummary(first);
    }
  });

  createEffect(() => {
    const current = run();
    if (current === undefined) return;
    setSelectedRunId(current.runId);
    setSelectedEventId(traceFor(current, current.runId)[0]?.event.eventId);
  });

  const visibleRuns = createMemo(() =>
    (runs() ?? []).filter(
      (candidate) =>
        (includeArchived() || candidate.project.registrationState !== "Archived") &&
        (projectFilter() === "all" || candidate.project.id === projectFilter()) &&
        (workflowFilter() === "all" ||
          workflowFacetKey(candidate.project.id, candidate.workflowName) === workflowFilter()) &&
        (stateFilter() === "all" || candidate.state === stateFilter()),
    ),
  );
  const selectedSummary = createMemo(
    () => runs()?.find(({ runId }) => runId === selectedRootId()) ?? selectedRootSummary(),
  );
  const pinned = createMemo(() => {
    const selected = selectedSummary();
    return selected !== undefined && !visibleRuns().some(({ runId }) => runId === selected.runId)
      ? selected
      : undefined;
  });
  const selectedRun = createMemo(() => {
    const root = run();
    if (root === undefined) return undefined;
    return flattenRuns(root).find(({ runId }) => runId === selectedRunId()) ?? root;
  });
  const trace = createMemo(() => {
    const root = run();
    return root === undefined ? [] : traceFor(root, selectedRunId() ?? root.runId);
  });
  const selectedEvidence = createMemo(
    () => trace().find(({ event }) => event.eventId === selectedEventId())?.event,
  );
  const projects = createMemo(() => {
    const unique = new Map(
      (runs() ?? []).map((candidate) => [candidate.project.id, candidate.project]),
    );
    return [...unique.values()];
  });
  const workflows = createMemo(() => {
    const unique = new Map(
      (runs() ?? []).map((candidate) => [
        workflowFacetKey(candidate.project.id, candidate.workflowName),
        candidate,
      ]),
    );
    return [...unique.entries()];
  });

  return (
    <main class="dense-inspector">
      <header class="inspector-header">
        <div>
          <span class="product-mark">KOJO</span>
          <span class="header-kicker">ACTUAL EXECUTION</span>
        </div>
        <h1>Dense Inspector</h1>
        <span class="system-status">
          <i /> SYSTEM PROCESS
        </span>
      </header>

      <Switch>
        <Match when={runs.loading}>
          <p class="inspector-message">Loading Workflow Runs…</p>
        </Match>
        <Match when={runs.error}>
          <p class="inspector-message failure">System Process unavailable</p>
        </Match>
        <Match when={runs()}>
          <div class="inspector-grid">
            <aside class="run-pane">
              <PaneHeading label="ROOT WORKFLOW RUNS" count={visibleRuns().length} />
              <div class="filters">
                <label>
                  <span>PROJECT</span>
                  <select
                    aria-label="Project"
                    value={projectFilter()}
                    onChange={(event) => setProjectFilter(event.currentTarget.value)}
                  >
                    <option value="all">All Projects</option>
                    <For each={projects()}>
                      {(project) => (
                        <option value={project.id}>
                          {project.displayName} · {shortId(project.id)}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <label>
                  <span>WORKFLOW</span>
                  <select
                    aria-label="Workflow"
                    value={workflowFilter()}
                    onChange={(event) => setWorkflowFilter(event.currentTarget.value)}
                  >
                    <option value="all">All workflows</option>
                    <For each={workflows()}>
                      {([value, workflow]) => (
                        <option value={value}>
                          {workflow.project.displayName} · {shortId(workflow.project.id)}
                          {" / "}
                          {workflow.workflowName}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <label>
                  <span>STATE</span>
                  <select
                    aria-label="State"
                    value={stateFilter()}
                    onChange={(event) =>
                      setStateFilter(event.currentTarget.value as "all" | WorkflowRunState)
                    }
                  >
                    <option value="all">All states</option>
                    <For
                      each={
                        [
                          "Running",
                          "Suspended",
                          "Interrupted",
                          "Failed",
                          "Completed",
                          "Discarded",
                        ] as const
                      }
                    >
                      {(state) => <option value={state}>{state}</option>}
                    </For>
                  </select>
                </label>
                <label class="archive-toggle">
                  <input
                    checked={includeArchived()}
                    type="checkbox"
                    onChange={(event) => setIncludeArchived(event.currentTarget.checked)}
                  />
                  Archived history
                </label>
              </div>
              <Show when={pinned()}>
                {(summary) => (
                  <div class="pinned">
                    <small>PINNED OUTSIDE FILTERS</small>
                    <RunRow
                      run={summary()}
                      selected
                      onSelect={() => {
                        setSelectedRootId(summary().runId);
                        setSelectedRootSummary(summary());
                      }}
                    />
                  </div>
                )}
              </Show>
              <div class="run-list">
                <For each={visibleRuns()}>
                  {(summary) => (
                    <RunRow
                      run={summary}
                      selected={selectedRootId() === summary.runId}
                      onSelect={() => {
                        setSelectedRootId(summary.runId);
                        setSelectedRootSummary(summary);
                      }}
                    />
                  )}
                </For>
                <Show when={visibleRuns().length === 0}>
                  <p class="empty-filter">No runs match these filters.</p>
                </Show>
              </div>
            </aside>

            <section class="trace-pane">
              <Show when={run()}>
                {(root) => (
                  <>
                    <div class="run-facts">
                      <div>
                        <small>PROJECT REGISTRATION</small>
                        <strong data-testid="project-registration-state">
                          {root().project.registrationState}
                        </strong>
                      </div>
                      <div>
                        <small>PROJECT AVAILABILITY</small>
                        <strong data-testid="project-availability">
                          {root().project.availability.status}
                        </strong>
                      </div>
                      <div>
                        <small>RUN STATE</small>
                        <strong
                          class={`state-${root().state.toLowerCase()}`}
                          data-testid="run-state"
                        >
                          {root().state}
                        </strong>
                      </div>
                      <div>
                        <small>RESUME COMPATIBILITY</small>
                        <strong data-testid="resume-compatibility">
                          {root().resumeCompatibility.status}
                        </strong>
                      </div>
                      <div>
                        <small>RUNTIME CONFIGURATION</small>
                        <strong>{root().runtimeConfigurationCompatibility.status}</strong>
                      </div>
                      <div class="actions">
                        <For each={root().actions}>
                          {(action) => (
                            <button disabled={!action.enabled} title={action.reason} type="button">
                              {titleCase(action.name)}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                    <Show when={root().project.availability.reason}>
                      {(reason) => <p class="project-availability-reason">{reason()}</p>}
                    </Show>
                    <For each={root().actions.filter((action) => !action.enabled && action.reason)}>
                      {(action) => (
                        <p class="action-disabled-reason" data-testid="action-disabled-reason">
                          {titleCase(action.name)}: {action.reason}
                        </p>
                      )}
                    </For>
                    <Show when={root().resumeCompatibility.reason}>
                      {(reason) => <p class="compatibility-reason">{reason()}</p>}
                    </Show>
                    <Show when={root().runtimeConfigurationCompatibility.reason}>
                      {(reason) => <p class="compatibility-reason">{reason()}</p>}
                    </Show>
                    <PaneHeading label="WORKFLOW RUN TREE" count={flattenRuns(root()).length} />
                    <div class="run-tree">
                      <RunTree
                        run={root()}
                        selectedRunId={selectedRunId()}
                        onSelect={(id) => {
                          setSelectedRunId(id);
                          const selected = flattenRuns(root()).find(
                            (candidate) => candidate.runId === id,
                          );
                          setSelectedEventId(selected?.evidence[0]?.eventId);
                        }}
                      />
                    </div>
                    <PaneHeading label="CHRONOLOGICAL EXECUTION TRACE" count={trace().length} />
                    <div class="trace-list" data-testid="selected-subject">
                      <span class="selected-subject">
                        SUBJECT / {selectedRun()?.workflowName} / {selectedRun()?.runId}
                      </span>
                      <div class="attempt-history">
                        <For each={selectedRun()?.attempts}>
                          {(attempt) => (
                            <span>
                              Attempt {attempt.number} · {attempt.state}
                            </span>
                          )}
                        </For>
                      </div>
                      <For each={trace()}>
                        {({ event, run: eventRun }) => (
                          <TraceRow
                            event={event}
                            run={eventRun}
                            selected={selectedEventId() === event.eventId}
                            onSelect={() => setSelectedEventId(event.eventId)}
                          />
                        )}
                      </For>
                    </div>
                  </>
                )}
              </Show>
            </section>

            <aside class="evidence-pane">
              <PaneHeading label="EXECUTION EVIDENCE" />
              <Show
                when={selectedEvidence()}
                fallback={<p class="empty-filter">Select an Evidence Event.</p>}
              >
                {(event) => <EvidenceDetails event={event()} />}
              </Show>
            </aside>
          </div>
        </Match>
      </Switch>
    </main>
  );
}

function PaneHeading(props: { readonly count?: number; readonly label: string }) {
  return (
    <div class="pane-heading">
      <span>{props.label}</span>
      <Show when={props.count !== undefined}>
        <span>{props.count}</span>
      </Show>
    </div>
  );
}

function RunRow(props: {
  readonly onSelect: () => void;
  readonly run: InspectorRunSummary;
  readonly selected: boolean;
}) {
  return (
    <button
      class="run-row"
      classList={{ selected: props.selected }}
      onClick={props.onSelect}
      type="button"
    >
      <span>
        <strong>{props.run.workflowName}</strong>
        <small>
          {props.run.project.displayName} · {shortId(props.run.project.id)}
        </small>
      </span>
      <span>
        <b class={`state-${props.run.state.toLowerCase()}`}>{props.run.state}</b>
        <small>A{props.run.attempt}</small>
      </span>
      <code>{props.run.runId}</code>
      <time>{timestamp(props.run.createdAt)}</time>
      <Show when={props.run.project.availability.status === "Unavailable"}>
        <em>{props.run.project.availability.reason ?? "Project unavailable"}</em>
      </Show>
    </button>
  );
}

function RunTree(props: {
  readonly onSelect: (id: string) => void;
  readonly run: InspectorRun;
  readonly selectedRunId: string | undefined;
}) {
  return (
    <div class="tree-node">
      <button
        classList={{ selected: props.selectedRunId === props.run.runId }}
        data-testid={`run-tree-${props.run.runId}`}
        onClick={() => props.onSelect(props.run.runId)}
        type="button"
      >
        <span>{props.run.workflowName}</span>
        <code>{props.run.runId}</code>
        <b class={`state-${props.run.state.toLowerCase()}`}>{props.run.state}</b>
      </button>
      <For each={props.run.children}>
        {(child) => (
          <RunTree run={child} selectedRunId={props.selectedRunId} onSelect={props.onSelect} />
        )}
      </For>
    </div>
  );
}

function TraceRow(props: {
  readonly event: InspectorEvidence;
  readonly onSelect: () => void;
  readonly run: InspectorRun;
  readonly selected: boolean;
}) {
  const semantic = () =>
    props.event.type.includes("Failed") || props.event.type.includes("Defect")
      ? "failure"
      : props.event.type.includes("Decision") || props.event.type.includes("Loop")
        ? "decision"
        : "neutral";
  return (
    <button
      class={`trace-row ${semantic()}`}
      classList={{ selected: props.selected }}
      onClick={props.onSelect}
      type="button"
    >
      <time>{timestamp(props.event.recordedAt)}</time>
      <span class="trace-line" />
      <span>
        <strong>{props.event.type}</strong>
        <small>
          {props.event.subject} · {shortId(props.run.runId)}
        </small>
      </span>
      <code>
        A{props.event.attempt}.{props.event.sequence}
      </code>
    </button>
  );
}

function EvidenceDetails(props: { readonly event: InspectorEvidence }) {
  return (
    <article class="evidence-details">
      <header>
        <small>EVENT TYPE</small>
        <h2>{props.event.type}</h2>
        <code>{props.event.eventId}</code>
      </header>
      <dl>
        <div>
          <dt>RECORDED</dt>
          <dd>{timestamp(props.event.recordedAt)}</dd>
        </div>
        <div>
          <dt>ATTEMPT / ORDER</dt>
          <dd>
            {props.event.attempt} / {props.event.sequence}
          </dd>
        </div>
        <div>
          <dt>SUBJECT</dt>
          <dd>{props.event.subject}</dd>
        </div>
        <div>
          <dt>PARENT EVENT</dt>
          <dd>{props.event.parentEventId ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>CAUSATION</dt>
          <dd>{props.event.causationId ?? "Unavailable"}</dd>
        </div>
      </dl>
      <Show when={props.event.schema.status === "Unknown"}>
        <p class="unknown-schema">Unknown schema v{props.event.schema.version}</p>
      </Show>
      <section>
        <h3>DETAILS</h3>
        <pre>{JSON.stringify(props.event.details, null, 2)}</pre>
      </section>
      <section>
        <h3>ARTIFACTS / {props.event.artifacts.length}</h3>
        <Show when={props.event.artifacts.length === 0}>
          <p class="unavailable">No artifacts recorded.</p>
        </Show>
        <For each={props.event.artifacts}>
          {(artifact) => (
            <div class="artifact">
              <strong>{artifact.name}</strong>
              <span>
                {artifact.mediaType} · {artifact.byteLength} B
              </span>
              <code>{artifact.fingerprint}</code>
              <b classList={{ unavailable: artifact.availability === "Unavailable" }}>
                {artifact.availability}
              </b>
            </div>
          )}
        </For>
      </section>
    </article>
  );
}
