import type { ExecutionTracePage, ProjectIdentity, WorkflowRunId } from "@kojo/control";
import { Effect } from "effect";
import { createResource, For, onCleanup, onMount, Show } from "solid-js";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";

export interface ExecutionTraceSelection {
  readonly identity: ProjectIdentity;
  readonly runId: WorkflowRunId;
}

export interface ExecutionTraceProps {
  readonly loadTrace?: (
    selection: ExecutionTraceSelection,
  ) => Promise<ExecutionTracePage | undefined>;
  readonly refreshIntervalMs?: number;
  readonly selection: ExecutionTraceSelection | undefined;
}

const readTrace = async (
  selection: ExecutionTraceSelection,
): Promise<ExecutionTracePage | undefined> => {
  try {
    const events: Array<ExecutionTracePage["events"][number]> = [];
    let cursor: string | undefined;
    let latest: ExecutionTracePage | undefined;
    do {
      const result = await visualizerApiRuntime.runPromise(
        Effect.flatMap(VisualizerApiClient, (client) =>
          client.ReadExecutionTrace({
            identity: selection.identity,
            runId: selection.runId,
            ...(cursor === undefined ? {} : { cursor }),
            filters: {
              activityAttemptIds: [],
              childRunIds: [],
              engineOperationIds: [],
              kinds: [],
            },
            limit: 200,
          }),
        ),
      );
      if (!result.ok) return undefined;
      events.push(...result.page.events);
      latest = result.page;
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return latest === undefined ? undefined : { ...latest, events };
  } catch {
    return undefined;
  }
};

/** Chronological evidence is deliberately rendered apart from the Run tree. */
export function ExecutionTrace(props: ExecutionTraceProps) {
  const [trace, { refetch }] = createResource(
    () => props.selection,
    (selection) =>
      selection === undefined
        ? Promise.resolve(undefined)
        : (props.loadTrace ?? readTrace)(selection),
  );
  onMount(() => {
    const timer = setInterval(() => {
      if (props.selection !== undefined) void refetch();
    }, props.refreshIntervalMs ?? 250);
    onCleanup(() => clearInterval(timer));
  });
  return (
    <Show when={props.selection}>
      {(selection) => (
        <section aria-label="Execution Trace" class="space-y-2 border-muted border-t pt-4">
          <div>
            <h3 class="font-medium text-sm">Execution Trace</h3>
            <p class="text-muted-foreground text-xs">
              Chronological evidence for {selection().runId}. The Workflow Run tree above shows
              ownership and child relationships; it is not this Event order.
            </p>
          </div>
          <Show
            when={trace()}
            fallback={<p class="text-muted-foreground text-xs">Loading trace…</p>}
          >
            {(page) => (
              <>
                <p class="font-mono text-muted-foreground text-xs">
                  {page().runState} · sequence {page().highWaterSequence}
                  {page().final ? " · final" : " · following live evidence"}
                </p>
                <ol class="space-y-1 font-mono text-xs">
                  <For each={page().events}>
                    {(event) => (
                      <li data-event-sequence={event.sequence} data-run-id={event.runId}>
                        <span class="text-muted-foreground">{event.sequence}</span> {event.kind}@
                        {event.kindVersion}
                        <Show when={event.compatibility !== "supported"}>
                          <span class="text-amber-600"> · {event.compatibility}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ol>
              </>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
}
