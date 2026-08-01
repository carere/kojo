import type { WorkflowRunId, WorkflowRunListItem } from "@kojo/control";
import { GitBranch, Radio, Workflow } from "lucide-solid";
import { createMemo, For, type JSX, Show } from "solid-js";
import { type RunGraphProps, runTone } from "../models/workflow-inspector-models";

export function RunGraph(props: RunGraphProps) {
  const roots = createMemo(() => {
    const ids = new Set(props.runs.map((run) => run.runId));
    return props.runs.filter(
      (run) =>
        run.parentRunId === null || run.parentRunId === undefined || !ids.has(run.parentRunId),
    );
  });
  const childrenOf = (runId: WorkflowRunId) =>
    props.runs.filter((run) => run.parentRunId === runId);
  const renderNode = (run: WorkflowRunListItem, depth: number): JSX.Element => (
    <div
      class={`workflow-graph-branch ${depth > 0 ? "ml-5 border-zinc-300 border-l pl-4 dark:border-zinc-700" : ""}`}
      data-relationship={depth === 0 ? "root" : "child-owned"}
    >
      <div class="relative">
        <Show when={depth > 0}>
          <span
            class="absolute top-5 -left-4 w-4 border-zinc-300 border-t dark:border-zinc-700"
            aria-hidden="true"
          />
        </Show>
        <button
          type="button"
          aria-label={run.runId}
          data-run-id={run.runId}
          data-graph-node={run.runId}
          aria-current={props.selectedRunId === run.runId ? "true" : undefined}
          onClick={() => props.onSelectRun(run.runId)}
          class={`workflow-graph-node w-full text-left ${props.selectedRunId === run.runId ? "workflow-graph-node-selected" : ""}`}
        >
          <div class="flex items-center gap-2">
            {depth === 0 ? (
              <Workflow class="size-3.5 text-sky-600 dark:text-sky-300" />
            ) : (
              <GitBranch class="size-3.5 text-cyan-600 dark:text-cyan-300" />
            )}
            <span class="min-w-0 flex-1 truncate font-semibold text-[11px]">{run.workflowKey}</span>
            <span class={`rounded-full px-1.5 py-0.5 text-[8px] ${runTone[run.state]}`}>
              {run.state}
            </span>
          </div>
          <p class="mt-1 font-mono text-[9px] text-zinc-500">
            {run.runId} · revision {run.workflowRevision}
          </p>
          <p class="mt-1 text-[9px] text-zinc-500">
            {depth === 0
              ? "Root Workflow Run"
              : `Child Workflow Run · ${run.childInvocationKey ?? "owned invocation"}`}
          </p>
          <p class="mt-2 text-[9px] text-zinc-400">
            {run.activitySummary.invocationAttempts} Activity attempt(s) ·{" "}
            {run.activitySummary.replayReuses} replay reuse(s)
          </p>
        </button>
      </div>
      <div class="mt-2 space-y-2">
        <For each={childrenOf(run.runId)}>{(child) => renderNode(child, depth + 1)}</For>
      </div>
    </div>
  );

  return (
    <section aria-label="Workflow relationship graph" class="workflow-inspector-card min-h-72">
      <div class="flex flex-wrap items-start justify-between gap-3 border-zinc-200 border-b pb-3 dark:border-zinc-800">
        <div>
          <p class="font-semibold text-[9px] text-zinc-400 uppercase tracking-[0.15em]">
            Run graph
          </p>
          <h2 class="mt-0.5 font-heading font-semibold text-lg">
            Structural ownership and execution relationships
          </h2>
          <p class="mt-1 max-w-2xl text-[10px] text-zinc-500">
            Lines show parent ownership and Child Workflow Runs. The numbered Event feed below is
            the chronological source of evidence.
          </p>
        </div>
        <span
          class={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold text-[9px] ${props.hostLive ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300"}`}
        >
          <Radio class="size-2.5" /> {props.hostLive ? "Host live" : "Host snapshot stale"}
        </span>
      </div>
      <Show
        when={roots().length > 0}
        fallback={
          <div class="grid min-h-48 place-items-center rounded-lg border border-zinc-300 border-dashed p-6 text-center text-[11px] text-zinc-500 dark:border-zinc-700">
            No Workflow Runs in this Project yet. Start one from a validated Workflow Definition.
          </div>
        }
      >
        <div
          class="workflow-graph-canvas mt-3 space-y-4"
          role="img"
          aria-label="Workflow Run ownership graph"
        >
          <For each={roots()}>{(root) => renderNode(root, 0)}</For>
        </div>
      </Show>
    </section>
  );
}
