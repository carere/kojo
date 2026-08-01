import {
  type ControlSubscriptionDelivery,
  type ControlSubscriptionUpdate,
  EMPTY_EXECUTION_TRACE_FILTERS,
  type ExecutionTracePage,
  type ProjectIdentity,
  type WorkflowRunId,
} from "@kojo/control";
import { Effect, Exit, Fiber, Stream } from "effect";
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
  ) => Stream.Stream<ControlSubscriptionUpdate, unknown>;
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

const artifactIdsFromPayload = (payload: unknown): ReadonlyArray<string> => {
  if (typeof payload !== "object" || payload === null || !("artifactIds" in payload)) return [];
  const artifactIds = (payload as { readonly artifactIds?: unknown }).artifactIds;
  return Array.isArray(artifactIds)
    ? artifactIds.filter(
        (artifactId): artifactId is string =>
          typeof artifactId === "string" && artifactId.length > 0 && artifactId.length <= 128,
      )
    : [];
};

const artifactDownloadHref = (selection: ExecutionTraceSelection, artifactId: string) => {
  const search = new URLSearchParams({
    artifact: artifactId,
    project: selection.identity,
    run: selection.runId,
  });
  return `/api/artifacts?${search}`;
};

const eventEvidenceLabel = (kind: string) => {
  if (kind === "artifact.unavailable")
    return "Artifact unavailable or pruned; trace evidence retained";
  if (kind === "reconciliation.observation-restored") return "Recovery evidence restored";
  if (kind === "run.stop-requested") return "Safe stop requested";
  if (kind === "run.suspended") return "Workflow Run suspended";
  if (kind === "run.resumed") return "Workflow Run resumed";
  if (kind === "activity.attempt-started") return "Activity attempt started";
  if (kind === "activity.result-reused") return "Activity replay reused a durable result";
  if (kind.startsWith("activity.")) return "Activity attempt evidence";
  if (kind.startsWith("clock.")) return "Schedule timing evidence";
  if (kind.startsWith("boundary.")) return "Execution boundary evidence";
  if (kind.startsWith("child.")) return "Child Workflow Run relationship evidence";
  if (kind.startsWith("deferred.")) return "Workflow Deferred evidence";
  if (kind.startsWith("artifact.")) return "Artifact evidence";
  return kind.replaceAll(".", " ");
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
    const reloadAuthoritative = () =>
      Effect.tryPromise({
        try: () => (props.loadTrace ?? readTrace)(selection),
        catch: () => new Error("Execution Trace reload failed."),
      }).pipe(
        Effect.flatMap((page) =>
          page === undefined
            ? Effect.fail(new Error("Execution Trace reload failed."))
            : Effect.sync(() => {
                setLiveTrace(page);
                return page;
              }),
        ),
      );
    const consume = <E,>(updates: Stream.Stream<ControlSubscriptionUpdate, E>) => {
      let sawResync = false;
      return Stream.runForEach(updates, (update) => {
        const reloadBeforeAcknowledging =
          update.kind === "resync-required" &&
          "runId" in update &&
          update.identity === selection.identity &&
          update.runId === selection.runId;
        if (reloadBeforeAcknowledging) sawResync = true;
        const processed = reloadBeforeAcknowledging
          ? reloadAuthoritative().pipe(Effect.asVoid)
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
      }).pipe(Effect.as(sawResync));
    };
    const follow = Effect.gen(function* () {
      let afterSequence = history.highWaterSequence;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const updates =
          props.followTrace === undefined
            ? yield* Effect.map(VisualizerApiClient, (client) =>
                client.SubscribeControl({
                  projects: [selection.identity],
                  topics: ["traces"],
                  traces: [
                    {
                      identity: selection.identity,
                      runId: selection.runId,
                      afterSequence,
                    },
                  ],
                }),
              )
            : props.followTrace(selection, afterSequence);
        const exit = yield* Effect.exit(consume(updates));
        if (Exit.isFailure(exit)) {
          // Transport loss is not a successful delivery. Reload durable state
          // before the bounded reconnect so the next subscription resumes
          // from a real high-water sequence and cannot duplicate events.
          const reloaded = yield* Effect.exit(reloadAuthoritative());
          if (Exit.isSuccess(reloaded)) {
            afterSequence = reloaded.value.highWaterSequence;
          }
        } else if (exit.value) {
          // A resync terminal closes its stream by design. The authoritative
          // reload happened before its notice was acknowledged; reopen from
          // that page's durable high-water sequence.
          const reloaded = yield* Effect.exit(reloadAuthoritative());
          if (Exit.isSuccess(reloaded)) {
            afterSequence = reloaded.value.highWaterSequence;
          }
        } else {
          return;
        }
        yield* Effect.sleep(`${Math.min(attempt + 1, 4) * 50} millis`);
      }
    });
    const fiber = visualizerApiRuntime.runFork(follow);
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
                      <li
                        data-event-sequence={event.sequence}
                        data-event-family={event.kind.split(".")[0]}
                        data-run-id={event.runId}
                        aria-label={`Event ${event.sequence}: ${eventEvidenceLabel(event.kind)}`}
                      >
                        <span class="text-muted-foreground">{event.sequence}</span>{" "}
                        <span class="text-primary">{eventEvidenceLabel(event.kind)}</span>{" "}
                        <span class="text-muted-foreground">
                          ({event.kind}@{event.kindVersion})
                        </span>{" "}
                        <time
                          class="text-muted-foreground"
                          dateTime={new Date(event.recordedAtMs).toISOString()}
                        >
                          {new Date(event.recordedAtMs).toLocaleTimeString()}
                        </time>
                        <Show when={event.compatibility !== "supported"}>
                          <span class="text-amber-600"> · {event.compatibility}</span>
                        </Show>
                        <Show when={event.kind !== "artifact.unavailable"}>
                          <For each={artifactIdsFromPayload(event.payload)}>
                            {(artifactId) => (
                              <a
                                aria-label={`Download Artifact ${artifactId}`}
                                class="ml-2 text-primary underline"
                                download=""
                                href={artifactDownloadHref(selection(), artifactId)}
                              >
                                Download Artifact
                              </a>
                            )}
                          </For>
                        </Show>
                        <Show when={event.kind === "artifact.unavailable"}>
                          <span class="text-amber-600">
                            {" "}
                            · bytes unavailable; no inline content rendered
                          </span>
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
