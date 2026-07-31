import {
  type ControlSubscriptionInput,
  type ControlSubscriptionUpdate,
  EMPTY_EXECUTION_TRACE_FILTERS,
  type ExecutionTraceQueryResult,
  type ExecutionTraceReadInput,
  type ProjectIdentity,
} from "@kojo/control";
import { Effect, Queue, Stream } from "effect";
import type { ControlSubscriptionDeliveryWindowShape } from "../services/control-subscription-delivery-window";
import type { ControlResourceTopic } from "../services/control-subscription-reader";

type ResourceTopic = ControlResourceTopic;

export interface ControlSubscriptionReader<R> {
  readonly readResourceFingerprint: (
    identity: ProjectIdentity,
    topic: ResourceTopic,
  ) => Effect.Effect<string, never, R>;
  readonly readTrace: (
    input: ExecutionTraceReadInput,
  ) => Effect.Effect<ExecutionTraceQueryResult, never, R>;
}

interface TraceCursor {
  highWaterSequence: number;
  resyncRequired: boolean;
  sequence: number;
}

const traceKey = (identity: ProjectIdentity, runId: string) => `${identity}:${runId}`;
type ControlSubscriptionUpdateContent = ControlSubscriptionUpdate extends infer Update
  ? Update extends unknown
    ? Omit<Update, "deliverySequence" | "subscriptionId">
    : never
  : never;

/**
 * Owns subscription selection, polling, durable continuation, and bounded
 * slow-client recovery. Transport adapters only expose this Stream.
 */
export const followControlSubscription =
  <R>(
    reader: ControlSubscriptionReader<R>,
    deliveryWindow: ControlSubscriptionDeliveryWindowShape,
  ) =>
  (input: ControlSubscriptionInput): Stream.Stream<ControlSubscriptionUpdate, never, R> => {
    const selectedProjects = new Set(input.projects);
    const traces = input.topics.includes("traces")
      ? input.traces.filter((trace) => selectedProjects.has(trace.identity))
      : [];
    const resourceTopics = input.topics.filter(
      (topic): topic is ResourceTopic => topic !== "traces",
    );
    const traceCursors = new Map<string, TraceCursor>(
      traces.map((trace) => [
        traceKey(trace.identity, trace.runId),
        {
          highWaterSequence: trace.afterSequence,
          resyncRequired: false,
          sequence: trace.afterSequence,
        },
      ]),
    );
    const resourceFingerprints = new Map<string, string>();

    return Stream.unwrap(
      Effect.map(deliveryWindow.open, (session) =>
        Stream.callback(
          (queue) => {
            const offer = (
              update: ControlSubscriptionUpdateContent,
            ): Effect.Effect<boolean, never, R> =>
              Effect.gen(function* () {
                const outcome = yield* session.next;
                const terminalUpdate: ControlSubscriptionUpdateContent =
                  outcome.kind === "resync-required" && update.kind === "trace-event"
                    ? {
                        kind: "resync-required",
                        identity: update.identity,
                        runId: update.runId,
                        highWaterSequence: update.sequence,
                      }
                    : outcome.kind === "resync-required" && update.kind === "resource-changed"
                      ? {
                          kind: "resync-required",
                          identity: update.identity,
                          topic: update.topic,
                        }
                      : update;
                const delivered = yield* Queue.offer(queue, {
                  ...terminalUpdate,
                  ...outcome.delivery,
                } as ControlSubscriptionUpdate);
                if (!delivered || outcome.kind === "resync-required") {
                  // The terminal notice is advisory; never wait for either an
                  // RPC receiver or an acknowledgement before detaching.
                  // `end` preserves the terminal resync notice for the
                  // transport consumer, unlike `shutdown`, which discards it.
                  yield* Queue.end(queue);
                  return false;
                }
                return true;
              });
            const poll = Effect.gen(function* () {
              for (const identity of input.projects) {
                for (const topic of resourceTopics) {
                  const key = `${identity}:${topic}`;
                  const fingerprint = yield* reader.readResourceFingerprint(identity, topic);
                  const previous = resourceFingerprints.get(key);
                  if (previous === undefined) {
                    resourceFingerprints.set(key, fingerprint);
                    continue;
                  }
                  if (previous === fingerprint) continue;
                  const delivered = yield* offer({
                    kind: "resource-changed" as const,
                    identity,
                    topic,
                  });
                  if (!delivered) return false;
                  // A dropped advisory notice remains pending until its bounded
                  // queue has room; clients then reload an authoritative snapshot.
                  if (delivered) resourceFingerprints.set(key, fingerprint);
                }
              }

              for (const trace of traces) {
                const key = traceKey(trace.identity, trace.runId);
                const cursor = traceCursors.get(key);
                if (cursor === undefined) continue;
                const result = yield* reader.readTrace({
                  identity: trace.identity,
                  runId: trace.runId,
                  afterSequence: cursor.sequence,
                  filters: EMPTY_EXECUTION_TRACE_FILTERS,
                  limit: 100,
                });
                if (!result.ok) continue;
                cursor.highWaterSequence = result.page.highWaterSequence;

                if (cursor.resyncRequired || result.page.hasMore) {
                  const delivered = yield* offer({
                    kind: "resync-required" as const,
                    identity: trace.identity,
                    runId: trace.runId,
                    highWaterSequence: cursor.highWaterSequence,
                  });
                  if (!delivered) return false;
                  if (delivered) {
                    cursor.resyncRequired = false;
                    cursor.sequence = cursor.highWaterSequence;
                  } else {
                    cursor.resyncRequired = true;
                  }
                  continue;
                }

                for (const event of result.page.events) {
                  const delivered = yield* offer({
                    kind: "trace-event" as const,
                    identity: trace.identity,
                    runId: trace.runId,
                    sequence: event.sequence,
                    event,
                  });
                  if (!delivered) {
                    return false;
                  }
                  cursor.sequence = event.sequence;
                }
              }
              return true;
            });

            return Effect.gen(function* () {
              const attached = yield* session.attachDetach(Queue.end(queue).pipe(Effect.asVoid));
              if (!attached) return yield* Effect.forkScoped(Effect.void);
              return yield* Effect.forkScoped(
                Effect.gen(function* () {
                  while (yield* poll) yield* Effect.sleep("100 millis");
                }),
              );
            });
          },
          { bufferSize: 16, strategy: "dropping" },
        ).pipe(Stream.ensuring(session.close)),
      ),
    ) as Stream.Stream<ControlSubscriptionUpdate, never, R>;
  };
