import {
  type ControlSubscriptionDelivery,
  type ControlSubscriptionUpdate,
  EMPTY_EXECUTION_TRACE_FILTERS,
  type ExecutionTracePage,
  type ProjectIdentity,
  type WorkflowRunId,
} from "@kojo/control";
import { Effect, Fiber, Stream } from "effect";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";

export interface ExecutionTraceSelection {
  readonly identity: ProjectIdentity;
  readonly runId: WorkflowRunId;
}

export interface ExecutionTraceProps {
  /** Browser-test seam for acknowledgement after rendering an update. */
  readonly acknowledgeTrace?: (delivery: ControlSubscriptionDelivery) => Effect.Effect<void>;
  /** A browser-test seam for the same live subscription the production path consumes. */
  readonly followTrace?: (
    selection: ExecutionTraceSelection,
    afterSequence: number,
  ) => Stream.Stream<ControlSubscriptionUpdate>;
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
            filters: EMPTY_EXECUTION_TRACE_FILTERS,
            limit: 500,
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
  const [liveTrace, setLiveTrace] = createSignal<ExecutionTracePage | undefined>();
  const [trace, { refetch }] = createResource(
    () => props.selection,
    (selection) =>
      selection === undefined
        ? Promise.resolve(undefined)
        : (props.loadTrace ?? readTrace)(selection),
  );
  createEffect(() => {
    const selection = props.selection;
    const history = trace();
    setLiveTrace(undefined);
    if (
      selection === undefined ||
      history === undefined ||
      (props.loadTrace !== undefined && props.followTrace === undefined)
    ) {
      return;
    }
    const acknowledge = (delivery: ControlSubscriptionDelivery) =>
      props.acknowledgeTrace === undefined
        ? Effect.flatMap(VisualizerApiClient, (client) =>
            client.AcknowledgeControlSubscription(delivery).pipe(Effect.asVoid),
          )
        : props.acknowledgeTrace(delivery);
    const consume = <E,>(updates: Stream.Stream<ControlSubscriptionUpdate, E>) =>
      Stream.runForEach(updates, (update) => {
        const reloadBeforeAcknowledging =
          update.kind === "resync-required" &&
          "runId" in update &&
          update.identity === selection.identity &&
          update.runId === selection.runId;
        const processed = reloadBeforeAcknowledging
          ? Effect.tryPromise({
              try: () => Promise.resolve(refetch()),
              catch: () => new Error("Execution Trace reload failed."),
            }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              if (
                update.kind !== "trace-event" ||
                update.identity !== selection.identity ||
                update.runId !== selection.runId
              ) {
                return;
              }
              setLiveTrace((current) => {
                const base = current ?? history;
                if (update.sequence <= base.highWaterSequence) return base;
                const events = [...base.events, update.event];
                return {
                  ...base,
                  events,
                  firstSequence: events[0]?.sequence ?? null,
                  hasMore: false,
                  highWaterSequence: update.sequence,
                  lastSequence: update.sequence,
                  nextCursor: null,
                };
              });
            });
        // A failed browser reload intentionally leaves the delivery
        // unacknowledged. The Host can then send a bounded resync instead of
        // treating unavailable browser state as processed.
        return processed.pipe(Effect.andThen(acknowledge(update)));
      });
    const fiber = visualizerApiRuntime.runFork(
      props.followTrace === undefined
        ? Effect.flatMap(VisualizerApiClient, (client) =>
            consume(
              client.SubscribeControl({
                projects: [selection.identity],
                topics: ["traces"],
                traces: [
                  {
                    identity: selection.identity,
                    runId: selection.runId,
                    afterSequence: history.highWaterSequence,
                  },
                ],
              }),
            ),
          )
        : consume(props.followTrace(selection, history.highWaterSequence)),
    );
    onCleanup(() => {
      void visualizerApiRuntime.runPromise(Fiber.interrupt(fiber));
    });
  });
  // Test or embedded loaders are a one-way page seam, not the production
  // follow transport. Keep their explicit refresh contract for browser tests.
  onMount(() => {
    if (props.loadTrace === undefined || props.followTrace !== undefined) return;
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
            when={liveTrace() ?? trace()}
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
