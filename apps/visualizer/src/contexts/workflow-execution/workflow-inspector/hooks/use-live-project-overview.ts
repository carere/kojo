import type {
  ControlSubscriptionDelivery,
  ControlSubscriptionUpdate,
  HostOverview as HostOverviewSnapshot,
  ProjectIdentity,
} from "@kojo/control";
import { Effect, Exit, Fiber, Stream } from "effect";
import { type Accessor, createEffect, on, onCleanup } from "solid-js";
import { makeSequencedLifecycle } from "../../../shared/lib/sequenced-lifecycle";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";

export interface ProjectOverviewLivePort<Requirements = never> {
  readonly subscribe: () => Effect.Effect<
    Stream.Stream<ControlSubscriptionUpdate, unknown>,
    unknown,
    Requirements
  >;
  readonly reload: () => Effect.Effect<HostOverviewSnapshot, unknown, Requirements>;
  readonly acknowledge: (
    delivery: ControlSubscriptionDelivery,
  ) => Effect.Effect<void, unknown, Requirements>;
}

interface ConsumedOverviewUpdates {
  readonly sawResync: boolean;
}

const consumeOverviewUpdates = <Requirements>(
  identity: ProjectIdentity,
  updates: Stream.Stream<ControlSubscriptionUpdate, unknown>,
  reload: () => Effect.Effect<HostOverviewSnapshot, unknown, Requirements>,
  acknowledge: (
    delivery: ControlSubscriptionDelivery,
  ) => Effect.Effect<void, unknown, Requirements>,
) => {
  let sawResync = false;
  return Stream.runForEach(updates, (update) => {
    if (update.identity !== identity) return Effect.void;
    const reloadRequired = update.kind === "resource-changed" || update.kind === "resync-required";
    if (update.kind === "resync-required") sawResync = true;
    return reloadRequired
      ? reload().pipe(Effect.andThen(acknowledge(update)))
      : acknowledge(update);
  }).pipe(Effect.map((): ConsumedOverviewUpdates => ({ sawResync })));
};

/** Reconnects until its owning component interrupts the fiber. */
export const followProjectOverview = <Requirements>(
  identity: ProjectIdentity,
  port: ProjectOverviewLivePort<Requirements>,
) =>
  Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const subscribed = yield* Effect.exit(port.subscribe());
      if (Exit.isFailure(subscribed)) {
        yield* Effect.exit(port.reload());
      } else {
        const consumed = yield* Effect.exit(
          consumeOverviewUpdates<Requirements>(
            identity,
            subscribed.value,
            port.reload,
            port.acknowledge,
          ),
        );
        if (Exit.isFailure(consumed)) {
          // A failed authoritative reload leaves the delivery unacknowledged. Try
          // once more before reconnecting, but never turn that failure into an ack.
          yield* Effect.exit(port.reload());
        } else if (consumed.value.sawResync) {
          // The resync flag is read after stream consumption. A terminal resync
          // stream is still a reconnect boundary, but it should not inherit a
          // growing transport backoff after authoritative recovery.
          attempt = 0;
        } else {
          // A clean stream completion is also a reconnect boundary. Refresh the
          // authoritative snapshot before resubscribing so no terminal delivery
          // can leave controls behind a stale overview.
          yield* Effect.exit(port.reload());
        }
      }
      yield* Effect.sleep(`${Math.min(attempt + 1, 4) * 50} millis`);
      attempt += 1;
    }
  });

interface UseLiveProjectOverviewProps {
  readonly identity: Accessor<ProjectIdentity | undefined>;
  readonly overview: Accessor<HostOverviewSnapshot | undefined>;
  readonly refetch: () =>
    | HostOverviewSnapshot
    | null
    | undefined
    | Promise<HostOverviewSnapshot | null | undefined>;
  readonly production: boolean;
  readonly acknowledge:
    | ((delivery: ControlSubscriptionDelivery) => Effect.Effect<void, unknown, never>)
    | undefined;
}

/** Keeps the selected Project snapshot Host-authoritative across resource updates and reconnects. */
export function useLiveProjectOverview(props: UseLiveProjectOverviewProps) {
  type OverviewFiber = ReturnType<typeof visualizerApiRuntime.runFork>;
  const lifecycle = makeSequencedLifecycle<OverviewFiber>((fiber) =>
    visualizerApiRuntime.runPromise(Fiber.interrupt(fiber)),
  );
  onCleanup(() => void lifecycle.dispose());

  createEffect(
    on(
      props.identity,
      (identity) => {
        if (
          identity === undefined ||
          !props.production ||
          !props.overview()?.host.capabilities.includes("control:subscribe")
        ) {
          void lifecycle.replace(() => undefined);
          return;
        }

        const reload = () =>
          Effect.tryPromise({
            try: async () => {
              const snapshot = await props.refetch();
              if (snapshot == null) throw new Error("Host overview is unavailable.");
              return snapshot;
            },
            catch: () => new Error("Overview reload failed."),
          });
        const acknowledge = (delivery: ControlSubscriptionDelivery) =>
          props.acknowledge === undefined
            ? Effect.flatMap(VisualizerApiClient, (client) =>
                client.AcknowledgeControlSubscription(delivery),
              ).pipe(Effect.asVoid)
            : props.acknowledge(delivery);
        const follow = followProjectOverview<VisualizerApiClient>(identity, {
          subscribe: () =>
            Effect.map(VisualizerApiClient, (client) =>
              client.SubscribeControl({
                projects: [identity],
                topics: ["readiness", "schedules", "runs"],
                traces: [],
              }),
            ),
          reload,
          acknowledge,
        });
        void lifecycle.replace(() => visualizerApiRuntime.runFork(follow));
      },
      { defer: true },
    ),
  );
}
