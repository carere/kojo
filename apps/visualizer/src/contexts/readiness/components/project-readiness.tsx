import type {
  ProjectIdentity,
  ProjectReadinessActionKey,
  ProjectReadinessAssessment,
} from "@kojo/control";
import { For, Show } from "solid-js";
import { Button } from "../../shared/components/ui/button";

export interface ProjectReadinessProps {
  readonly assessments: ReadonlyArray<ProjectReadinessAssessment>;
  readonly onRefresh?: (identity: ProjectIdentity) => Promise<void>;
  readonly onRepair?: (
    identity: ProjectIdentity,
    revision: string,
    action: ProjectReadinessActionKey,
  ) => Promise<void>;
}

/** Shows only Host-produced safe readiness guidance; implementation errors never cross this view. */
export function ProjectReadiness(props: ProjectReadinessProps) {
  return (
    <section aria-label="Project Runtime Readiness" class="w-full space-y-3 rounded-lg border p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p class="font-mono text-muted-foreground text-xs uppercase tracking-[0.2em]">
            Readiness
          </p>
          <h2 class="font-semibold text-lg">Project Runtime Readiness</h2>
        </div>
      </div>
      <Show
        when={props.assessments.length > 0}
        fallback={<p class="text-muted-foreground text-sm">No Project Runtime assessments yet.</p>}
      >
        <div class="space-y-4">
          <For each={props.assessments}>
            {(assessment) => (
              <section class="space-y-3 rounded border border-border/60 p-3">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p class="font-medium text-sm">{assessment.project.path}</p>
                    <p class="font-mono text-muted-foreground text-xs">
                      {assessment.project.identity} · {assessment.condition}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => props.onRefresh?.(assessment.project.identity)}
                  >
                    Refresh
                  </Button>
                </div>
                <div class="space-y-1 text-sm">
                  <For each={assessment.capabilities}>
                    {(capability) => (
                      <p
                        class={capability.available ? "text-muted-foreground" : "text-destructive"}
                      >
                        {capability.available ? "Available" : "Blocked"} · {capability.capability}
                      </p>
                    )}
                  </For>
                </div>
                <Show
                  when={assessment.findings.length > 0}
                  fallback={
                    <p class="text-muted-foreground text-sm">No active readiness findings.</p>
                  }
                >
                  <ul class="space-y-2">
                    <For each={assessment.findings}>
                      {(finding) => (
                        <li class="rounded bg-muted/40 p-2 text-sm">
                          <p class="font-medium">{finding.code}</p>
                          <p class="mt-1 text-muted-foreground">{finding.summary}</p>
                          <Show when={finding.actions.length > 0}>
                            <div class="mt-2 flex flex-wrap gap-2">
                              <For each={finding.actions}>
                                {(action) => (
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    onClick={() =>
                                      props.onRepair?.(
                                        assessment.project.identity,
                                        assessment.revision,
                                        action.key,
                                      )
                                    }
                                  >
                                    {action.label}
                                  </Button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <For each={assessment.repairs}>
                  {(repair) => (
                    <p class="text-muted-foreground text-sm">Completed: {repair.summary}</p>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
