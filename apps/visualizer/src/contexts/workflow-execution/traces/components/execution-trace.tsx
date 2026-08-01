import {
  type ControlSubscriptionDelivery,
  type ControlSubscriptionUpdate,
  EMPTY_EXECUTION_TRACE_FILTERS,
  type ExecutionTracePage,
  type ProjectIdentity,
  type WorkflowRunId,
  type WorkflowRunState,
} from "@kojo/control";
import { Effect, Exit, Fiber, Stream } from "effect";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { makeSequencedLifecycle } from "../../../shared/lib/sequenced-lifecycle";
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
    signal?: AbortSignal,
  ) => Promise<ExecutionTracePage | undefined>;
  readonly refreshIntervalMs?: number;
  readonly selection: ExecutionTraceSelection | undefined;
}

const interruptWhenAborted = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const onAbort = () => resume(Effect.interrupt);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const initialTraceRetryDelaysMs = [50, 100, 250, 500] as const;

const traceAbortError = () => {
  const error = new Error("Execution Trace load interrupted.");
  error.name = "AbortError";
  return error;
};

const waitForTraceRetry = (delayMs: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(traceAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(traceAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const readTrace = async (
  selection: ExecutionTraceSelection,
  signal: AbortSignal,
): Promise<ExecutionTracePage | undefined> => {
  const events: Array<ExecutionTracePage["events"][number]> = [];
  let cursor: string | undefined;
  let latest: ExecutionTracePage | undefined;
  do {
    if (signal.aborted) throw traceAbortError();
    const request = Effect.flatMap(VisualizerApiClient, (client) =>
      client.ReadExecutionTrace({
        identity: selection.identity,
        runId: selection.runId,
        ...(cursor === undefined ? {} : { cursor }),
        filters: EMPTY_EXECUTION_TRACE_FILTERS,
        limit: 500,
      }),
    );
    const result = await visualizerApiRuntime.runPromise(
      Effect.raceFirst(request, interruptWhenAborted(signal)),
    );
    if (!result.ok) throw result.error;
    events.push(...result.page.events);
    latest = result.page;
    cursor = result.page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return latest === undefined ? undefined : { ...latest, events };
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

export const terminalTraceState = (kind: string): WorkflowRunState | undefined => {
  if (kind === "run.completed") return "completed";
  if (kind === "run.failed") return "failed";
  if (kind === "run.stopped") return "stopped";
  return undefined;
};

const normalizeTracePage = (page: ExecutionTracePage): ExecutionTracePage => {
  const terminalState = [...page.events]
    .reverse()
    .map((event) => terminalTraceState(event.kind))
    .find((state): state is WorkflowRunState => state !== undefined);
  return terminalState === undefined ? page : { ...page, runState: terminalState, final: true };
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
  const [trace, setTrace] = createSignal<ExecutionTracePage | undefined>();
  const [traceError, setTraceError] = createSignal<unknown>();
  const [retryGeneration, setRetryGeneration] = createSignal(0);
  type TraceFiber = ReturnType<typeof visualizerApiRuntime.runFork>;
  const lifecycle = makeSequencedLifecycle<TraceFiber>((fiber) =>
    visualizerApiRuntime.runPromise(Fiber.interrupt(fiber)),
  );
  let selectionGeneration = 0;
  let disposed = false;
  let activeTraceLoadController: AbortController | undefined;
  const sameSelection = (
    left: ExecutionTraceSelection | undefined,
    right: ExecutionTraceSelection | undefined,
  ) => left?.identity === right?.identity && left?.runId === right?.runId;

  const load = (selection: ExecutionTraceSelection, signal: AbortSignal) =>
    (props.loadTrace ?? readTrace)(selection, signal);

  const loadInitialTrace = async (
    selection: ExecutionTraceSelection,
    generation: number,
    signal: AbortSignal,
  ) => {
    let lastError: unknown;
    for (let attempt = 0; ; attempt += 1) {
      if (!currentSelection(selection, generation) || signal.aborted) throw traceAbortError();
      try {
        const page = await load(selection, signal);
        if (page !== undefined) return normalizeTracePage(page);
        lastError = new Error("Execution Trace returned no authoritative page.");
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
      const delay = initialTraceRetryDelaysMs[attempt];
      if (delay === undefined) {
        throw lastError ?? new Error("Execution Trace is unavailable.");
      }
      await waitForTraceRetry(delay, signal);
    }
  };

  const currentSelection = (selection: ExecutionTraceSelection, generation: number) =>
    !disposed && generation === selectionGeneration && sameSelection(props.selection, selection);

  onCleanup(() => {
    disposed = true;
    selectionGeneration += 1;
    activeTraceLoadController?.abort();
    void lifecycle.dispose();
  });

  createEffect(() => {
    const selection = props.selection;
    retryGeneration();
    const generation = ++selectionGeneration;
    activeTraceLoadController?.abort();
    setLiveTrace(undefined);
    setTrace(undefined);
    setTraceError(undefined);
    if (selection === undefined) {
      void lifecycle.replace(() => undefined);
      return;
    }

    const start = async () => {
      const loadController = new AbortController();
      activeTraceLoadController = loadController;
      // Replacement is awaited before the new snapshot is loaded. This keeps
      // an old Project's high-water cursor and stream detached before the new
      // Project can contribute any evidence.
      await lifecycle.replace(() => undefined);
      if (!currentSelection(selection, generation)) return;
      let history: ExecutionTracePage;
      try {
        history = await loadInitialTrace(selection, generation, loadController.signal);
      } catch (error) {
        if (currentSelection(selection, generation) && !loadController.signal.aborted)
          setTraceError(error);
        return;
      } finally {
        if (activeTraceLoadController === loadController) activeTraceLoadController = undefined;
      }
      if (!currentSelection(selection, generation)) return;
      setTraceError(undefined);
      setTrace(history);
      if (props.followTrace === undefined && props.loadTrace !== undefined) return;

      const acknowledge = (delivery: ControlSubscriptionDelivery) =>
        props.acknowledgeTrace === undefined
          ? Effect.flatMap(VisualizerApiClient, (client) =>
              client.AcknowledgeControlSubscription(delivery).pipe(Effect.asVoid),
            )
          : props.acknowledgeTrace(delivery);
      const reloadAuthoritative = () =>
        (() => {
          const controller = new AbortController();
          return Effect.ensuring(
            Effect.tryPromise({
              try: () => load(selection, controller.signal),
              catch: () => new Error("Execution Trace reload failed."),
            }),
            Effect.sync(() => controller.abort()),
          );
        })().pipe(
          Effect.flatMap((page) =>
            !currentSelection(selection, generation) || page === undefined
              ? Effect.fail(new Error("Execution Trace reload failed."))
              : Effect.sync(() => {
                  const normalized = normalizeTracePage(page);
                  setLiveTrace(normalized);
                  return normalized;
                }),
          ),
        );
      const consume = <E,>(updates: Stream.Stream<ControlSubscriptionUpdate, E>) => {
        let resyncPage: ExecutionTracePage | undefined;
        let reloadFailed = false;
        return Stream.runForEach(updates, (update) => {
          const reloadBeforeAcknowledging =
            update.kind === "resync-required" &&
            "runId" in update &&
            update.identity === selection.identity &&
            update.runId === selection.runId;
          const processed = reloadBeforeAcknowledging
            ? reloadAuthoritative().pipe(
                Effect.map((page) => {
                  resyncPage = page;
                  return true;
                }),
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    reloadFailed = true;
                    return false;
                  }),
                ),
              )
            : Effect.sync(() => {
                if (
                  update.kind !== "trace-event" ||
                  update.identity !== selection.identity ||
                  update.runId !== selection.runId
                ) {
                  return true;
                }
                setLiveTrace((current) => {
                  const base = current ?? history;
                  const terminalState = terminalTraceState(update.event.kind);
                  if (update.sequence <= base.highWaterSequence) {
                    return terminalState === undefined
                      ? base
                      : { ...base, runState: terminalState, final: true };
                  }
                  const events = [...base.events, update.event];
                  return {
                    ...base,
                    events,
                    firstSequence: events[0]?.sequence ?? null,
                    hasMore: false,
                    highWaterSequence: update.sequence,
                    lastSequence: update.sequence,
                    nextCursor: null,
                    ...(terminalState === undefined
                      ? {}
                      : { runState: terminalState, final: true }),
                  };
                });
                return true;
              });
          // A failed browser reload intentionally leaves the delivery
          // unacknowledged. The Host can then send a bounded resync instead of
          // treating unavailable browser state as processed.
          return processed.pipe(
            Effect.flatMap((shouldAcknowledge) =>
              shouldAcknowledge ? acknowledge(update) : Effect.void,
            ),
          );
        }).pipe(Effect.map(() => ({ reloadFailed, resyncPage })));
      };
      const follow = Effect.gen(function* () {
        let afterSequence = history.highWaterSequence;
        let attempt = 0;
        while (true) {
          const subscriptionEffect =
            props.followTrace === undefined
              ? Effect.map(VisualizerApiClient, (client) =>
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
              : Effect.sync(() => {
                  const followTrace = props.followTrace;
                  if (followTrace === undefined) throw new Error("Trace subscription unavailable.");
                  return followTrace(selection, afterSequence);
                });
          const subscribed = yield* Effect.exit(subscriptionEffect);
          if (Exit.isFailure(subscribed)) {
            const reloaded = yield* Effect.exit(reloadAuthoritative());
            if (Exit.isSuccess(reloaded)) afterSequence = reloaded.value.highWaterSequence;
            yield* Effect.sleep(`${Math.min(attempt + 1, 4) * 50} millis`);
            attempt += 1;
            continue;
          }
          const exit = yield* Effect.exit(consume(subscribed.value));
          if (Exit.isFailure(exit)) {
            // Transport loss is not a successful delivery. Reload durable state
            // before the bounded reconnect so the next subscription resumes
            // from a real high-water sequence and cannot duplicate events.
            const reloaded = yield* Effect.exit(reloadAuthoritative());
            if (Exit.isSuccess(reloaded)) afterSequence = reloaded.value.highWaterSequence;
          } else if (exit.value.reloadFailed) {
            // The failed reload deliberately left its delivery unacknowledged.
            // Retry the authoritative read once at this termination boundary;
            // reconnecting is still required so the Host can resend its bounded
            // resync if the read remains unavailable.
            const reloaded = yield* Effect.exit(reloadAuthoritative());
            if (Exit.isSuccess(reloaded)) afterSequence = reloaded.value.highWaterSequence;
          } else if (exit.value.resyncPage !== undefined) {
            // A resync terminal closes its stream by design. The authoritative
            // reload happened before its notice was acknowledged; reopen from
            // that page's durable high-water sequence.
            afterSequence = exit.value.resyncPage.highWaterSequence;
          } else {
            // Clean completion is also a reconnect boundary. Refresh durable
            // state before opening the replacement subscription.
            const reloaded = yield* Effect.exit(reloadAuthoritative());
            if (Exit.isSuccess(reloaded)) afterSequence = reloaded.value.highWaterSequence;
          }
          yield* Effect.sleep(`${Math.min(attempt + 1, 4) * 50} millis`);
          attempt += 1;
        }
      });
      if (!currentSelection(selection, generation)) return;
      await lifecycle.replace(() => visualizerApiRuntime.runFork(follow));
    };
    void start().catch((error) => {
      if (currentSelection(selection, generation)) setTraceError(error);
    });
  });
  // Test or embedded loaders are a one-way page seam, not the production
  // follow transport. Keep their explicit refresh contract for browser tests.
  onMount(() => {
    if (props.loadTrace === undefined || props.followTrace !== undefined) return;
    let inFlight = false;
    let pollingController: AbortController | undefined;
    const timer = setInterval(() => {
      if (inFlight) return;
      const selection = props.selection;
      const generation = selectionGeneration;
      if (selection === undefined) return;
      inFlight = true;
      const controller = new AbortController();
      pollingController = controller;
      void load(selection, controller.signal)
        .then((page) => {
          if (!currentSelection(selection, generation) || page === undefined) return;
          setTrace(normalizeTracePage(page));
        })
        .finally(() => {
          inFlight = false;
          if (pollingController === controller) pollingController = undefined;
        });
    }, props.refreshIntervalMs ?? 250);
    onCleanup(() => {
      clearInterval(timer);
      pollingController?.abort();
    });
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
            fallback={
              <Show
                when={traceError()}
                fallback={<p class="text-muted-foreground text-xs">Loading trace…</p>}
              >
                {(error) => (
                  <div class="space-y-2 text-muted-foreground text-xs" role="alert">
                    <p>Execution Trace is temporarily unavailable. {traceErrorMessage(error())}</p>
                    <button
                      class="rounded border border-muted px-2 py-1 text-foreground"
                      type="button"
                      onClick={() => setRetryGeneration((value) => value + 1)}
                    >
                      Retry Execution Trace
                    </button>
                  </div>
                )}
              </Show>
            }
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

const traceErrorMessage = (error: unknown) =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : "The Host did not return an authoritative trace page.";
