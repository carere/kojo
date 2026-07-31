import type { ProjectIdentity, ProjectWorkflowRunsSnapshot, WorkflowRunId } from "@kojo/control";
import { createSignal, For, Show } from "solid-js";
import { Button } from "../../../shared/components/ui/button";

export interface WorkflowRunsProps {
  readonly snapshots: ReadonlyArray<ProjectWorkflowRunsSnapshot>;
  readonly onCompleteDeferred: (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    token: string,
    value: unknown,
  ) => Promise<void>;
  readonly onResume: (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    value: unknown,
  ) => Promise<void>;
  readonly onShowRun?: (identity: ProjectIdentity, runId: string) => void;
}

export function WorkflowRuns(props: WorkflowRunsProps) {
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [tokens, setTokens] = createSignal<Record<string, string>>({});
  const [error, setError] = createSignal<string | undefined>();
  const runs = () =>
    props.snapshots.flatMap((snapshot) =>
      snapshot.runs.map((run) => ({ project: snapshot.project, run })),
    );
  const parsedValue = (
    runId: string,
  ): { readonly ok: true; readonly value: unknown } | undefined => {
    const source = values()[runId];
    if (source === undefined || source.trim() === "") return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(source) as unknown };
    } catch {
      setError("Use valid JSON for the Workflow Run value.");
      return undefined;
    }
  };
  return (
    <section aria-label="Workflow Runs" class="space-y-2">
      <h3 class="font-medium text-sm">Workflow Runs</h3>
      <p class="text-muted-foreground text-sm">
        {runs().length === 0
          ? "No Workflow Runs."
          : `${runs().length} Workflow Run${runs().length === 1 ? "" : "s"}.`}
      </p>
      <Show when={error()}>{(message) => <p class="text-destructive text-sm">{message()}</p>}</Show>
      <ul class="space-y-1 font-mono text-xs">
        <For each={runs()}>
          {({ project, run }) => (
            <li>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => props.onShowRun?.(project.identity, run.runId)}
              >
                {run.runId}
              </Button>{" "}
              <span class="text-muted-foreground">{run.state}</span> {run.workflowKey}@
              {run.workflowRevision}
              <Show when={run.allowedActions.length > 0}>
                <div class="mt-2 flex flex-wrap items-center gap-2 font-sans">
                  <input
                    aria-label={`Value for ${run.runId}`}
                    class="rounded border bg-transparent px-2 py-1 text-xs"
                    placeholder="Optional JSON value"
                    value={values()[run.runId] ?? ""}
                    onInput={(event) =>
                      setValues((current) => ({
                        ...current,
                        [run.runId]: event.currentTarget.value,
                      }))
                    }
                  />
                  <Show when={run.allowedActions.includes("resume")}>
                    <button
                      class="rounded border px-2 py-1 text-xs"
                      type="button"
                      onClick={async () => {
                        const parsed = parsedValue(run.runId);
                        if (parsed === undefined) return;
                        setError(undefined);
                        try {
                          await props.onResume(project.identity, run.runId, parsed.value);
                        } catch {
                          setError("Kojo Host could not resume this Workflow Run.");
                        }
                      }}
                    >
                      Resume
                    </button>
                  </Show>
                  <Show when={run.allowedActions.includes("deferred-complete")}>
                    <input
                      aria-label={`Deferred token for ${run.runId}`}
                      class="rounded border bg-transparent px-2 py-1 text-xs"
                      placeholder="Workflow Deferred token"
                      value={tokens()[run.runId] ?? ""}
                      onInput={(event) =>
                        setTokens((current) => ({
                          ...current,
                          [run.runId]: event.currentTarget.value,
                        }))
                      }
                    />
                    <button
                      class="rounded border px-2 py-1 text-xs"
                      type="button"
                      onClick={async () => {
                        const parsed = parsedValue(run.runId);
                        if (parsed === undefined) return;
                        setError(undefined);
                        try {
                          await props.onCompleteDeferred(
                            project.identity,
                            run.runId,
                            tokens()[run.runId] ?? "",
                            parsed.value,
                          );
                        } catch {
                          setError("Kojo Host could not complete this Workflow Deferred.");
                        }
                      }}
                    >
                      Complete Deferred
                    </button>
                  </Show>
                </div>
              </Show>
              <span class="text-muted-foreground">
                {" "}
                · Activities: {run.activitySummary.invocationAttempts} attempts,{" "}
                {run.activitySummary.incompleteAttempts} incomplete,{" "}
                {run.activitySummary.durableCompletions} durable, {run.activitySummary.replayReuses}{" "}
                replay reuses
              </span>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
