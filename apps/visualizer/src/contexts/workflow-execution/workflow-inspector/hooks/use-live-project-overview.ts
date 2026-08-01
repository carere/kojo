import type {
  ControlSubscriptionDelivery,
  ControlSubscriptionUpdate,
  HostOverview as HostOverviewSnapshot,
  ProjectIdentity,
} from "@kojo/control";
import { Effect, Exit, Fiber, Stream } from "effect";
import { type Accessor, createEffect, on, onCleanup } from "solid-js";
import { VisualizerApiClient, visualizerApiRuntime } from "../../../shared/services/client";

interface UseLiveProjectOverviewProps {
  readonly identity: Accessor<ProjectIdentity | undefined>;
  readonly overview: Accessor<HostOverviewSnapshot | undefined>;
  readonly refetch: (info?: unknown) => unknown | Promise<unknown> | null | undefined;
  readonly production: boolean;
  readonly acknowledge:
    | ((delivery: ControlSubscriptionDelivery) => Effect.Effect<void>)
    | undefined;
}

/** Keeps the selected Project snapshot Host-authoritative across resource updates and reconnects. */
export function useLiveProjectOverview(props: UseLiveProjectOverviewProps) {
  createEffect(
    on(
      props.identity,
      (identity) => {
        if (
          identity === undefined ||
          !props.production ||
          !props.overview()?.host.capabilities.includes("control:subscribe")
        )
          return;

        const reload = () =>
          Effect.tryPromise({
            try: async () => {
              await props.refetch();
            },
            catch: () => new Error("Overview reload failed."),
          }).pipe(Effect.asVoid);
        const acknowledge = (delivery: ControlSubscriptionDelivery) =>
          props.acknowledge === undefined
            ? Effect.flatMap(VisualizerApiClient, (client) =>
                client.AcknowledgeControlSubscription(delivery),
              ).pipe(Effect.asVoid)
            : props.acknowledge(delivery);
        const consume = (updates: Stream.Stream<ControlSubscriptionUpdate, unknown>) => {
          let sawResync = false;
          return Stream.runForEach(updates, (update) => {
            if (update.identity !== identity) return Effect.void;
            const reloadRequired =
              update.kind === "resource-changed" || update.kind === "resync-required";
            if (update.kind === "resync-required") sawResync = true;
            return reloadRequired
              ? reload().pipe(Effect.andThen(acknowledge(update)))
              : acknowledge(update);
          }).pipe(Effect.as(sawResync));
        };
        const follow = Effect.gen(function* () {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const updates = yield* Effect.map(VisualizerApiClient, (client) =>
              client.SubscribeControl({
                projects: [identity],
                topics: ["readiness", "schedules", "runs"],
                traces: [],
              }),
            );
            const exit = yield* Effect.exit(consume(updates));
            if (Exit.isFailure(exit) || exit.value) {
              const reloaded = yield* Effect.exit(reload());
              if (Exit.isFailure(reloaded)) {
                yield* Effect.sleep(`${Math.min(attempt + 1, 4) * 50} millis`);
                continue;
              }
              yield* Effect.sleep(`${Math.min(attempt + 1, 4) * 50} millis`);
              continue;
            }
            return;
          }
        });
        const fiber = visualizerApiRuntime.runFork(follow);
        onCleanup(() => void visualizerApiRuntime.runPromise(Fiber.interrupt(fiber)));
      },
      { defer: true },
    ),
  );
}
