import type {
  ProjectIdentity,
  ProjectWorkflowSchedulesSnapshot,
  WorkflowScheduleAllowedAction,
  WorkflowScheduleSnapshot,
} from "@kojo/control";
import { For, Show } from "solid-js";
import { Button } from "../../../shared/components/ui/button";

export interface WorkflowSchedulesProps {
  readonly snapshots: ReadonlyArray<ProjectWorkflowSchedulesSnapshot>;
  readonly onAction?: (
    identity: ProjectIdentity,
    schedule: WorkflowScheduleSnapshot,
    action: WorkflowScheduleAllowedAction,
  ) => Promise<void>;
}

const renderTime = (value: number | null) =>
  value === null ? "No next occurrence" : new Date(value).toISOString();

/** Renders and submits only the actions the Host allows on each persisted state. */
export function WorkflowSchedules(props: WorkflowSchedulesProps) {
  return (
    <section aria-label="Workflow Schedules" class="w-full space-y-3 rounded-lg border p-4">
      <div>
        <p class="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">Schedules</p>
        <h2 class="font-semibold text-lg">Workflow Schedules</h2>
      </div>
      <Show
        when={props.snapshots.some((snapshot) => snapshot.schedules.length > 0)}
        fallback={<p class="text-muted-foreground text-sm">No Workflow Schedules yet.</p>}
      >
        <div class="space-y-4">
          <For each={props.snapshots}>
            {(snapshot) => (
              <section class="space-y-2" data-project-identity={snapshot.project.identity}>
                <p class="font-medium text-sm">{snapshot.project.path}</p>
                <ul class="space-y-2">
                  <For each={snapshot.schedules}>
                    {(schedule) => (
                      <li class="rounded border border-border/60 p-3 text-sm">
                        <div class="flex flex-wrap items-baseline justify-between gap-2">
                          <span class="font-medium font-mono">{schedule.scheduleKey}</span>
                          <span class="text-muted-foreground">
                            {schedule.enabledIntent ? "Enabled" : "Disabled"} · {schedule.condition}
                          </span>
                        </div>
                        <Show
                          when={schedule.definition}
                          fallback={
                            <p class="mt-1 text-muted-foreground">
                              Definition unavailable · applied revision{" "}
                              {schedule.appliedRevision ?? "unknown"}
                            </p>
                          }
                        >
                          {(definition) => (
                            <p class="mt-1 text-muted-foreground">
                              {definition().workflowKey} · {definition().cron} ·{" "}
                              {definition().timeZone} · {definition().overlapPolicy} overlap
                            </p>
                          )}
                        </Show>
                        <p class="mt-1 font-mono text-muted-foreground text-xs">
                          Next: {renderTime(schedule.nextOccurrenceMs)}
                        </p>
                        <Show when={schedule.allowedActions.length > 0}>
                          <div class="mt-2 flex gap-2">
                            <For each={schedule.allowedActions}>
                              {(action) => (
                                <Button
                                  size="xs"
                                  variant={action === "disable" ? "outline" : "default"}
                                  onClick={() =>
                                    props.onAction?.(snapshot.project.identity, schedule, action)
                                  }
                                >
                                  {action === "enable" ? "Enable" : "Disable"}
                                </Button>
                              )}
                            </For>
                          </div>
                        </Show>
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
