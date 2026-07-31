import { randomUUID } from "node:crypto";
import {
  type ControlSubscriptionAcknowledgement,
  type ControlSubscriptionDelivery,
  ControlSubscriptionId,
} from "@kojo/control";
import { Context, Effect, Layer, Schema } from "effect";

/**
 * This is deliberately a small, Host-owned, in-memory window. Delivery
 * sequence values are not persisted and are meaningful only while one
 * subscription is attached to this Host.
 */
export const CONTROL_SUBSCRIPTION_MAX_UNACKNOWLEDGED = 16;

export interface ControlSubscriptionDeliverySession {
  /** Returns false when Host shutdown already closed this session. */
  readonly attachDetach: (detach: Effect.Effect<void>) => Effect.Effect<boolean>;
  readonly close: Effect.Effect<void>;
  readonly next: Effect.Effect<
    | { readonly kind: "delivered"; readonly delivery: ControlSubscriptionDelivery }
    | { readonly kind: "resync-required"; readonly delivery: ControlSubscriptionDelivery }
  >;
}

export interface ControlSubscriptionDeliveryWindowShape {
  readonly acknowledge: (
    delivery: ControlSubscriptionDelivery,
  ) => Effect.Effect<ControlSubscriptionAcknowledgement>;
  readonly open: Effect.Effect<ControlSubscriptionDeliverySession>;
  /** Ends every active advisory stream before the Host closes its socket server. */
  readonly shutdown: Effect.Effect<void>;
}

export class ControlSubscriptionDeliveryWindow extends Context.Service<
  ControlSubscriptionDeliveryWindow,
  ControlSubscriptionDeliveryWindowShape
>()("kojo/host/ControlSubscriptionDeliveryWindow") {}

interface DeliveryState {
  acknowledgedSequence: number;
  detach: Effect.Effect<void> | undefined;
  deliveredSequence: number;
  closed: boolean;
  terminal: boolean;
}

const subscriptionId = () => Schema.decodeUnknownSync(ControlSubscriptionId)(randomUUID());

/**
 * Creates the window inside the Host layer, so subscriptions from different
 * servers and Host lifetimes cannot share acknowledgement state.
 */
export const makeControlSubscriptionDeliveryWindow = (
  maximumUnacknowledged = CONTROL_SUBSCRIPTION_MAX_UNACKNOWLEDGED,
): ControlSubscriptionDeliveryWindowShape => {
  const subscriptions = new Map<ControlSubscriptionId, DeliveryState>();
  const limit = Math.max(1, maximumUnacknowledged);
  let shuttingDown = false;

  const acknowledge = (
    delivery: ControlSubscriptionDelivery,
  ): Effect.Effect<ControlSubscriptionAcknowledgement> =>
    Effect.sync(() => {
      const state = subscriptions.get(delivery.subscriptionId);
      if (
        state === undefined ||
        state.closed ||
        delivery.deliverySequence > state.deliveredSequence
      ) {
        return { acknowledged: false };
      }
      state.acknowledgedSequence = Math.max(state.acknowledgedSequence, delivery.deliverySequence);
      return { acknowledged: true };
    });

  const open: Effect.Effect<ControlSubscriptionDeliverySession> = Effect.sync(() => {
    const id = subscriptionId();
    const state: DeliveryState = {
      acknowledgedSequence: 0,
      closed: shuttingDown,
      detach: undefined,
      deliveredSequence: 0,
      terminal: shuttingDown,
    };
    if (!shuttingDown) subscriptions.set(id, state);
    const next: ControlSubscriptionDeliverySession["next"] = Effect.sync(() => {
      const delivery: ControlSubscriptionDelivery = {
        deliverySequence: ++state.deliveredSequence,
        subscriptionId: id,
      };
      if (
        state.closed ||
        state.terminal ||
        state.deliveredSequence - state.acknowledgedSequence > limit
      ) {
        state.terminal = true;
        return { kind: "resync-required" as const, delivery };
      }
      return { kind: "delivered" as const, delivery };
    });
    return {
      attachDetach: (detach) =>
        Effect.suspend(() => {
          state.detach = detach;
          // Both registration and the shutdown flag are changed only in
          // synchronous Effects. If shutdown won the race, run this newly
          // registered detach immediately instead of leaving a stream behind.
          return shuttingDown || state.closed
            ? detach.pipe(Effect.as(false))
            : Effect.succeed(true);
        }),
      close: Effect.sync(() => {
        state.closed = true;
        subscriptions.delete(id);
      }),
      next,
    };
  });

  const shutdown = Effect.gen(function* () {
    const detaches = yield* Effect.sync(() => {
      if (shuttingDown) return [];
      // Flip this synchronously before taking the snapshot. Sessions opened
      // later are born closed; sessions that attach later execute their
      // detach from attachDetach rather than escaping this snapshot.
      shuttingDown = true;
      const active = [...subscriptions.values()].flatMap((state) => {
        state.closed = true;
        return state.detach === undefined ? [] : [state.detach];
      });
      subscriptions.clear();
      return active;
    });
    yield* Effect.forEach(detaches, (detach) => detach, { concurrency: "unbounded" });
  });

  return { acknowledge, open, shutdown };
};

export const ControlSubscriptionDeliveryWindowLive = Layer.sync(
  ControlSubscriptionDeliveryWindow,
  makeControlSubscriptionDeliveryWindow,
);
