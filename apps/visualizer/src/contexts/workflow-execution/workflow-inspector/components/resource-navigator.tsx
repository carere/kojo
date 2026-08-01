import type {
  ProjectCondition,
  ProjectSnapshot,
  WorkflowRunId,
  WorkflowRunListItem,
} from "@kojo/control";
import { CalendarClock, GitBranch, Search, Workflow } from "lucide-solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import {
  conditionTone,
  formatDateTime,
  formatTime,
  projectName,
  type ResourceNavigatorProps,
  runTone,
  type WorkflowDefinition,
} from "../models/workflow-inspector-models";

export function ResourceNavigator(props: ResourceNavigatorProps) {
  const [query, setQuery] = createSignal("");
  const normalizedQuery = createMemo(() => query().trim().toLowerCase());
  const filteredDefinitions = createMemo(() =>
    props.definitions.filter((definition) =>
      `${definition.workflowKey} ${definition.revision}`.toLowerCase().includes(normalizedQuery()),
    ),
  );
  const filteredSchedules = createMemo(() =>
    props.schedules.filter((schedule) =>
      `${schedule.scheduleKey} ${schedule.definition?.workflowKey ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery()),
    ),
  );
  const filteredRuns = createMemo(() =>
    props.runs.filter((run) =>
      `${run.runId} ${run.workflowKey} ${run.state}`.toLowerCase().includes(normalizedQuery()),
    ),
  );
  const roots = createMemo(() => {
    const ids = new Set(props.runs.map((run) => run.runId));
    return filteredRuns().filter(
      (run) =>
        run.parentRunId === null || run.parentRunId === undefined || !ids.has(run.parentRunId),
    );
  });
  const children = createMemo(() => {
    const ids = new Set(props.runs.map((run) => run.runId));
    return filteredRuns().filter(
      (run) =>
        run.parentRunId !== null && run.parentRunId !== undefined && ids.has(run.parentRunId),
    );
  });

  return (
    <aside class="workflow-inspector-resource-panel" aria-label="Project resource navigator">
      <header class="border-zinc-200 border-b px-3 py-3 dark:border-zinc-800">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="text-[9px] text-zinc-400 uppercase tracking-[0.16em]">Kojo Project</p>
            <h1 class="mt-0.5 truncate font-heading font-semibold text-lg">
              {projectName(props.project.path)}
            </h1>
          </div>
          <span
            class={`shrink-0 rounded-full px-2 py-0.5 font-semibold text-[9px] ${conditionTone[props.condition]}`}
          >
            {props.condition}
          </span>
        </div>
        <label class="mt-2 flex h-7 items-center gap-1.5 rounded-lg bg-zinc-100 px-2 text-zinc-400 dark:bg-zinc-800">
          <Search class="size-3" />
          <span class="sr-only">Find Project resources</span>
          <input
            aria-label="Find Project resources"
            class="min-w-0 flex-1 bg-transparent text-[10px] outline-none placeholder:text-zinc-400"
            placeholder="Find schedules or runs…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </header>

      <div class="h-[calc(100vh-101px)] overflow-y-auto px-2 py-3">
        <section aria-label="Accepted Workflow Definitions">
          <div class="mb-1 flex items-center justify-between px-2">
            <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
              Definitions
            </p>
            <span class="text-[9px] text-zinc-400">{filteredDefinitions().length}</span>
          </div>
          <Show
            when={filteredDefinitions().length > 0}
            fallback={
              <p class="px-2 text-[10px] text-zinc-400">No accepted Workflow Definitions.</p>
            }
          >
            <ul>
              <For each={filteredDefinitions()}>
                {(definition) => (
                  <li class="mb-0.5 rounded-lg px-2 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <div class="flex items-center gap-2">
                      <Workflow class="size-3 text-sky-600 dark:text-sky-300" />
                      <span class="min-w-0 flex-1 truncate font-semibold text-[10px]">
                        {definition.workflowKey} {definition.revision}
                      </span>
                    </div>
                    <p class="mt-1 pl-5 text-[9px] text-zinc-500">
                      source {definition.sourceIdentity}
                    </p>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="mt-4" aria-label="Workflow Schedules">
          <div class="mb-1 flex items-center justify-between px-2">
            <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
              Schedules
            </p>
            <span class="text-[9px] text-zinc-400">{filteredSchedules().length}</span>
          </div>
          <Show
            when={filteredSchedules().length > 0}
            fallback={<p class="px-2 text-[10px] text-zinc-400">No Workflow Schedules yet.</p>}
          >
            <ul>
              <For each={filteredSchedules()}>
                {(schedule) => (
                  <li class="mb-1 rounded-lg border border-zinc-200/80 p-2 dark:border-zinc-800">
                    <div class="flex items-start gap-2">
                      <CalendarClock
                        class={`mt-0.5 size-3.5 ${schedule.condition === "needs-attention" ? "text-rose-500" : "text-emerald-600"}`}
                      />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center justify-between gap-2">
                          <span class="truncate font-semibold text-[10px]">
                            {schedule.scheduleKey}
                          </span>
                          <span
                            class={`size-1.5 rounded-full ${schedule.enabledIntent ? "bg-emerald-500" : "bg-zinc-300"}`}
                            title={schedule.enabledIntent ? "Enabled" : "Disabled"}
                          />
                        </div>
                        <p class="mt-0.5 text-[9px] text-zinc-500">
                          {schedule.enabledIntent ? "Enabled" : "Disabled"} · {schedule.condition}
                        </p>
                        <Show
                          when={schedule.definition}
                          fallback={
                            <p class="mt-0.5 text-[9px] text-amber-700 dark:text-amber-300">
                              Definition unavailable · applied revision{" "}
                              {schedule.appliedRevision ?? "unknown"}
                            </p>
                          }
                        >
                          {(definition) => (
                            <p class="mt-0.5 text-[9px] text-zinc-500">
                              {definition().workflowKey} · {definition().cron} ·{" "}
                              {definition().timeZone} · {definition().overlapPolicy} overlap
                            </p>
                          )}
                        </Show>
                        <p class="mt-0.5 font-mono text-[9px] text-zinc-400">
                          Next: {formatTime(schedule.nextOccurrenceMs)}
                        </p>
                        <Show when={schedule.allowedActions.length > 0}>
                          <div class="mt-2 flex flex-wrap gap-1">
                            <For each={schedule.allowedActions}>
                              {(action) => (
                                <button
                                  type="button"
                                  class={`h-6 rounded-md border px-2 font-semibold text-[9px] ${action === "disable" ? "border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900" : "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500"}`}
                                  disabled={!props.mutationsEnabled}
                                  onClick={() => props.onScheduleAction(schedule, action)}
                                >
                                  {action === "enable" ? "Enable" : "Disable"}
                                </button>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="mt-4" aria-label="Workflow Schedule Occurrences">
          <div class="mb-1 flex items-center justify-between px-2">
            <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
              Occurrences
            </p>
            <span class="text-[9px] text-zinc-400">{props.occurrences.length}</span>
          </div>
          <Show
            when={props.occurrences.length > 0}
            fallback={
              <p class="px-2 text-[10px] text-zinc-400">No Workflow Schedule Occurrences yet.</p>
            }
          >
            <ul class="space-y-1">
              <For each={props.occurrences.slice(0, 12)}>
                {(occurrence) => (
                  <li class="rounded-lg px-2 py-1.5 text-[9px] hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-mono">{occurrence.scheduleKey}</span>
                      <span class="text-zinc-500">{occurrence.outcome}</span>
                    </div>
                    <p class="mt-0.5 text-zinc-400">{formatDateTime(occurrence.scheduledAtMs)}</p>
                    <Show when={occurrence.missedRange}>
                      {(range) => (
                        <p class="mt-0.5 text-amber-700 dark:text-amber-300">
                          {range().count} missed instant(s) retained as evidence
                        </p>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <RunListSection
          heading="Root Workflow Runs"
          runs={roots()}
          selectedRunId={props.selectedRunId}
          onSelectRun={props.onSelectRun}
        />
        <RunListSection
          heading="Child Workflow Runs"
          runs={children()}
          selectedRunId={props.selectedRunId}
          onSelectRun={props.onSelectRun}
          child
        />
      </div>
    </aside>
  );
}

function RunListSection(props: {
  readonly heading: string;
  readonly runs: ReadonlyArray<WorkflowRunListItem>;
  readonly selectedRunId: WorkflowRunId | undefined;
  readonly onSelectRun: (runId: WorkflowRunId) => void;
  readonly child?: boolean;
}) {
  return (
    <section class="mt-4" aria-label={props.heading}>
      <div class="mb-1 flex items-center justify-between px-2">
        <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.14em]">
          {props.heading}
        </p>
        <span class="text-[9px] text-zinc-400">{props.runs.length}</span>
      </div>
      <Show
        when={props.runs.length > 0}
        fallback={<p class="px-2 text-[10px] text-zinc-400">No {props.heading}.</p>}
      >
        <ul class="space-y-0.5">
          <For each={props.runs}>
            {(run) => (
              <li
                class={
                  props.child
                    ? "ml-3 border-zinc-200 border-l pl-2 dark:border-zinc-700"
                    : undefined
                }
              >
                <button
                  type="button"
                  aria-label={`Open Workflow Run ${run.runId}`}
                  data-run-id={run.runId}
                  data-parent-run-id={run.parentRunId ?? undefined}
                  onClick={() => props.onSelectRun(run.runId)}
                  class={`w-full rounded-lg px-2 py-2 text-left transition ${
                    props.selectedRunId === run.runId
                      ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  <div class="flex items-center gap-1.5">
                    {props.child ? (
                      <GitBranch class="size-3 shrink-0 text-cyan-500" />
                    ) : (
                      <Workflow class="size-3 shrink-0 text-zinc-400" />
                    )}
                    <span class="min-w-0 flex-1 truncate font-semibold text-[10px]">
                      {run.workflowKey}
                    </span>
                    <span class={`rounded-full px-1.5 py-0.5 text-[8px] ${runTone[run.state]}`}>
                      {run.state}
                    </span>
                  </div>
                  <div class="mt-1 flex items-center justify-between gap-2 pl-[18px] text-[8px] text-zinc-500">
                    <span class="truncate font-mono">{run.runId}</span>
                    <span>{props.child ? "child" : "root"}</span>
                  </div>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

export type { ProjectCondition, ProjectSnapshot, WorkflowDefinition };
