import { expect, it } from "@effect/vitest";
import { type HostOverview as HostOverviewSnapshot, ProjectIdentity } from "@kojo/control";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  followProjectOverview,
  type ProjectOverviewLivePort,
} from "../../../../../../src/contexts/workflow-execution/workflow-inspector/hooks/use-live-project-overview";

const identity = ProjectIdentity.make("00000000-0000-7000-8000-000000000101");
const overview = {} as HostOverviewSnapshot;

const waitForSecondSubscription = (subscriptions: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(subscriptions);
  });

it.effect("reconnects after terminal resource resync without duplicate acknowledgements", () =>
  Effect.gen(function* () {
    const secondSubscription = yield* Deferred.make<void>();
    const resync: Parameters<NonNullable<ProjectOverviewLivePort["acknowledge"]>>[0] &
      Record<string, unknown> = {
      deliverySequence: 1,
      subscriptionId: "overview-resync" as never,
      kind: "resync-required",
      identity,
      topic: "runs",
    };
    let subscriptions = 0;
    let reloads = 0;
    const acknowledgements: Array<number> = [];
    const port: ProjectOverviewLivePort = {
      subscribe: () =>
        Effect.gen(function* () {
          subscriptions += 1;
          if (subscriptions === 2) yield* Deferred.succeed(secondSubscription, undefined);
          return subscriptions === 1 ? Stream.make(resync as never) : Stream.never;
        }),
      reload: () =>
        Effect.sync(() => {
          reloads += 1;
          return overview;
        }),
      acknowledge: (delivery) =>
        Effect.sync(() => {
          acknowledgements.push(delivery.deliverySequence);
        }),
    };

    const fiber = yield* followProjectOverview(identity, port).pipe(Effect.forkChild);
    yield* waitForSecondSubscription(secondSubscription);
    yield* Fiber.interrupt(fiber);

    expect(subscriptions).toBe(2);
    expect(reloads).toBe(1);
    expect(acknowledgements).toEqual([1]);
  }),
);

it.effect("reconnects after clean stream completion and stops on cleanup", () =>
  Effect.gen(function* () {
    const secondSubscription = yield* Deferred.make<void>();
    let subscriptions = 0;
    let reloads = 0;
    const port: ProjectOverviewLivePort = {
      subscribe: () =>
        Effect.gen(function* () {
          subscriptions += 1;
          if (subscriptions === 2) yield* Deferred.succeed(secondSubscription, undefined);
          return subscriptions === 1 ? Stream.empty : Stream.never;
        }),
      reload: () =>
        Effect.sync(() => {
          reloads += 1;
          return overview;
        }),
      acknowledge: () => Effect.void,
    };

    const fiber = yield* followProjectOverview(identity, port).pipe(Effect.forkChild);
    yield* waitForSecondSubscription(secondSubscription);
    yield* Fiber.interrupt(fiber);

    expect(subscriptions).toBe(2);
    expect(reloads).toBe(1);
  }),
);

it.effect("does not acknowledge a resync when authoritative reload fails", () =>
  Effect.gen(function* () {
    const secondSubscription = yield* Deferred.make<void>();
    const resync = {
      deliverySequence: 1,
      subscriptionId: "overview-reload-failure" as never,
      kind: "resync-required" as const,
      identity,
      topic: "runs" as const,
    };
    let subscriptions = 0;
    let reloads = 0;
    const acknowledgements: Array<number> = [];
    const port: ProjectOverviewLivePort = {
      subscribe: () =>
        Effect.gen(function* () {
          subscriptions += 1;
          if (subscriptions === 2) yield* Deferred.succeed(secondSubscription, undefined);
          return subscriptions === 1 ? Stream.make(resync) : Stream.never;
        }),
      reload: () => {
        reloads += 1;
        return reloads === 1
          ? Effect.fail(new Error("overview unavailable"))
          : Effect.succeed(overview);
      },
      acknowledge: (delivery) =>
        Effect.sync(() => {
          acknowledgements.push(delivery.deliverySequence);
        }),
    };

    const fiber = yield* followProjectOverview(identity, port).pipe(Effect.forkChild);
    yield* waitForSecondSubscription(secondSubscription);
    yield* Fiber.interrupt(fiber);

    expect(subscriptions).toBe(2);
    expect(reloads).toBe(2);
    expect(acknowledgements).toEqual([]);
  }),
);
