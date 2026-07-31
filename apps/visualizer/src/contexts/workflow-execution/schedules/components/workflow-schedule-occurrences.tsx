import type {
  ProjectIdentity,
  ProjectWorkflowScheduleOccurrencesSnapshot,
  WorkflowScheduleOccurrenceSnapshot,
} from "@kojo/control";
import { For, Show } from "solid-js";
import { Button } from "../../../shared/components/ui/button";

export interface WorkflowScheduleOccurrencesProps {
  readonly snapshots: ReadonlyArray<ProjectWorkflowScheduleOccurrencesSnapshot>;
  readonly onShowRun?: ((identity: ProjectIdentity, runId: string) => void) | undefined;
  readonly onShowSchedule?: ((identity: ProjectIdentity, scheduleKey: string) => void) | undefined;
}

const renderTime = (value: number) => new Date(value).toISOString();

const Occurrence = (props: {
  readonly identity: ProjectIdentity;
  readonly occurrence: WorkflowScheduleOccurrenceSnapshot;
  readonly onShowRun?: ((identity: ProjectIdentity, runId: string) => void) | undefined;
  readonly onShowSchedule?: ((identity: ProjectIdentity, scheduleKey: string) => void) | undefined;
}) => (
  <li class="rounded border border-border/60 p-3 text-sm">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <span class="font-medium font-mono">{renderTime(props.occurrence.scheduledAtMs)}</span>
      <span class="text-muted-foreground">{props.occurrence.outcome}</span>
    </div>
    <p class="mt-1 text-muted-foreground">
      {props.occurrence.scheduleKey} · revision {props.occurrence.appliedRevision}
    </p>
    <Show when={props.occurrence.missedRange}>
      {(range) => (
        <p class="mt-1 text-muted-foreground text-xs">
          Missed {range().count} instants through {renderTime(range().lastScheduledAtMs)}
        </p>
      )}
    </Show>
    <div class="mt-2 flex flex-wrap gap-2">
      <Button
        size="xs"
        variant="outline"
        onClick={() => props.onShowSchedule?.(props.identity, props.occurrence.scheduleKey)}
      >
        View Schedule
      </Button>
      <Show when={props.occurrence.linkedRunId}>
        {(runId) => (
          <Button size="xs" onClick={() => props.onShowRun?.(props.identity, runId())}>
            View linked Run
          </Button>
        )}
      </Show>
    </div>
  </li>
);

/** Keeps occurrence history visibly separate while preserving its Schedule and Run links. */
export function WorkflowScheduleOccurrences(props: WorkflowScheduleOccurrencesProps) {
  return (
    <section
      aria-label="Workflow Schedule Occurrences"
      class="w-full space-y-3 rounded-lg border p-4"
    >
      <div>
        <p class="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">
          Occurrences
        </p>
        <h2 class="font-semibold text-lg">Workflow Schedule Occurrences</h2>
      </div>
      <Show
        when={props.snapshots.some((snapshot) => snapshot.occurrences.length > 0)}
        fallback={
          <p class="text-muted-foreground text-sm">No Workflow Schedule Occurrences yet.</p>
        }
      >
        <div class="space-y-4">
          <For each={props.snapshots}>
            {(snapshot) => (
              <section class="space-y-2" data-project-identity={snapshot.project.identity}>
                <p class="font-medium text-sm">{snapshot.project.path}</p>
                <ul class="space-y-2">
                  <For each={snapshot.occurrences}>
                    {(occurrence) => (
                      <Occurrence
                        identity={snapshot.project.identity}
                        occurrence={occurrence}
                        onShowRun={props.onShowRun}
                        onShowSchedule={props.onShowSchedule}
                      />
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
