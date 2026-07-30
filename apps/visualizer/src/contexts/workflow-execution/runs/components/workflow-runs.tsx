import type { ProjectWorkflowRunsSnapshot } from "@kojo/control";
import { For } from "solid-js";

export interface WorkflowRunsProps {
  readonly snapshots: ReadonlyArray<ProjectWorkflowRunsSnapshot>;
}

export function WorkflowRuns(props: WorkflowRunsProps) {
  const runs = () => props.snapshots.flatMap((snapshot) => snapshot.runs);
  return (
    <section aria-label="Workflow Runs" class="space-y-2">
      <h3 class="font-medium text-sm">Workflow Runs</h3>
      <p class="text-muted-foreground text-sm">
        {runs().length === 0
          ? "No Workflow Runs."
          : `${runs().length} Workflow Run${runs().length === 1 ? "" : "s"}.`}
      </p>
      <ul class="space-y-1 font-mono text-xs">
        <For each={runs()}>
          {(run) => (
            <li>
              {run.runId} <span class="text-muted-foreground">{run.state}</span> {run.workflowKey}@
              {run.workflowRevision}
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
