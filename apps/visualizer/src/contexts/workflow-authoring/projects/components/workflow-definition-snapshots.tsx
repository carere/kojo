import type { ProjectWorkflowSnapshot } from "@kojo/control";
import { For, Show } from "solid-js";

export interface WorkflowDefinitionSnapshotsProps {
  readonly snapshots: ReadonlyArray<ProjectWorkflowSnapshot>;
}

export function WorkflowDefinitionSnapshots(props: WorkflowDefinitionSnapshotsProps) {
  return (
    <section
      aria-label="Accepted Workflow Definitions"
      class="w-full space-y-3 rounded-lg border p-4"
    >
      <div>
        <p class="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">
          Runtime snapshot
        </p>
        <h2 class="font-semibold text-lg">Accepted Workflow Definitions</h2>
      </div>
      <Show
        when={props.snapshots.length > 0}
        fallback={
          <p class="text-muted-foreground text-sm">No accepted Workflow Definitions yet.</p>
        }
      >
        <div class="space-y-3">
          <For each={props.snapshots}>
            {(snapshot) => (
              <section class="space-y-1" data-project-identity={snapshot.project.identity}>
                <p class="font-medium text-sm">{snapshot.project.path}</p>
                <p class="font-mono text-muted-foreground text-xs">
                  Snapshot {snapshot.definitions.snapshotId}
                </p>
                <ul class="space-y-1">
                  <For each={snapshot.definitions.workflows}>
                    {(workflow) => (
                      <li class="font-mono text-sm">
                        {workflow.workflowKey}{" "}
                        <span class="text-muted-foreground">{workflow.revision}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
