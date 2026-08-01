import type { HostOverview as HostOverviewSnapshot } from "@kojo/control";
import { expect, it } from "vitest";
import { HostOverviewError } from "../../../../../../src/contexts/shared/models/contracts";
import {
  makeHostOverviewCoordinator,
  productionHostOverviewPolicy,
} from "../../../../../../src/contexts/workflow-execution/workflow-inspector/hooks/host-overview-coordinator";

const snapshot = (projects: HostOverviewSnapshot["projects"]): HostOverviewSnapshot =>
  ({ projects }) as HostOverviewSnapshot;

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

it("coalesces concurrent action and delivery refreshes into one trailing load", async () => {
  const pending: Array<ReturnType<typeof deferred<HostOverviewSnapshot>>> = [];
  const coordinator = makeHostOverviewCoordinator({
    load: () => {
      const request = deferred<HostOverviewSnapshot>();
      pending.push(request);
      return request.promise;
    },
    policy: { attemptTimeoutMs: 100, maxAttempts: 1, maxElapsedMs: 100, retryDelaysMs: [0] },
  });

  const initial = coordinator.refresh();
  const fromAction = coordinator.refresh();
  const fromDelivery = coordinator.refresh();

  expect(pending).toHaveLength(1);
  pending[0]?.resolve(snapshot([]));
  await initial;
  await Promise.resolve();
  expect(pending).toHaveLength(2);

  const refreshed = snapshot([{ identity: "project-a", path: "/project-a" } as never]);
  pending[1]?.resolve(refreshed);
  await expect(Promise.all([fromAction, fromDelivery])).resolves.toEqual([refreshed, refreshed]);
  expect(pending).toHaveLength(2);
  expect(coordinator.overview()).toBe(refreshed);
  coordinator.dispose();
});

it("uses the finite production policy to recover a transient HostOverview failure", async () => {
  let attempts = 0;
  const empty = snapshot([]);
  const coordinator = makeHostOverviewCoordinator({
    load: async () => {
      attempts += 1;
      if (attempts === 1)
        throw new HostOverviewError({
          code: "host-unavailable",
          message: "Host is starting.",
          next: "Retry the Host request.",
        });
      return empty;
    },
    policy: productionHostOverviewPolicy,
  });

  await coordinator.refresh();
  expect(attempts).toBe(2);
  expect(coordinator.overview()).toBe(empty);
  expect(coordinator.error()).toBeUndefined();
  coordinator.dispose();
});

it("keeps the last good snapshot on refresh failure and distinguishes empty success", async () => {
  let attempts = 0;
  const first = snapshot([{ identity: "project-a", path: "/project-a" } as never]);
  const coordinator = makeHostOverviewCoordinator({
    load: async () => {
      attempts += 1;
      if (attempts === 1) return first;
      throw new Error("Host transport unavailable");
    },
    policy: { attemptTimeoutMs: 100, maxAttempts: 1, maxElapsedMs: 100, retryDelaysMs: [0] },
  });

  await coordinator.refresh();
  await expect(coordinator.refresh()).rejects.toThrow("Host overview was not available");
  expect(coordinator.overview()).toBe(first);
  expect(coordinator.error()).toBeInstanceOf(Error);

  const emptyCoordinator = makeHostOverviewCoordinator({
    load: async () => snapshot([]),
    policy: { attemptTimeoutMs: 100, maxAttempts: 1, maxElapsedMs: 100, retryDelaysMs: [0] },
  });
  await emptyCoordinator.refresh();
  expect(emptyCoordinator.overview()?.projects).toEqual([]);
  expect(emptyCoordinator.error()).toBeUndefined();
  coordinator.dispose();
  emptyCoordinator.dispose();
});

it("does not commit a late result after disposal", async () => {
  const request = deferred<HostOverviewSnapshot>();
  const coordinator = makeHostOverviewCoordinator({
    load: () => request.promise,
    policy: { attemptTimeoutMs: 100, maxAttempts: 1, maxElapsedMs: 100, retryDelaysMs: [0] },
  });

  const loading = coordinator.refresh();
  coordinator.dispose();
  request.resolve(snapshot([{ identity: "late", path: "/late" } as never]));
  await loading;
  expect(coordinator.overview()).toBeUndefined();
});

it("recovers after finite bootstrap exhaustion without turning Connecting into a permanent state", async () => {
  let attempts = 0;
  const recovered = snapshot([]);
  const coordinator = makeHostOverviewCoordinator({
    load: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Host is still starting");
      return recovered;
    },
    policy: { attemptTimeoutMs: 100, maxAttempts: 1, maxElapsedMs: 100, retryDelaysMs: [0] },
    recoveryDelaysMs: [0],
  });

  coordinator.start();
  await expect.poll(() => coordinator.overview(), { timeout: 1_000 }).toBe(recovered);
  expect(attempts).toBe(3);
  expect(coordinator.error()).toBeUndefined();
  coordinator.dispose();
});

it("discovers Projects after an empty index with one cancellable backoff loop", async () => {
  let loads = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  const project = { identity: "project-a", path: "/project-a" } as never;
  const coordinator = makeHostOverviewCoordinator({
    load: async () => {
      loads += 1;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return loads < 3 ? snapshot([]) : snapshot([project]);
    },
    policy: { attemptTimeoutMs: 100, maxAttempts: 1, maxElapsedMs: 100, retryDelaysMs: [0] },
    discoveryDelaysMs: [0],
  });

  coordinator.start();
  coordinator.start();
  await expect.poll(() => coordinator.overview()?.projects.length, { timeout: 1_000 }).toBe(1);
  expect(loads).toBe(3);
  expect(maximumInFlight).toBe(1);

  const loadsBeforeDispose = loads;
  coordinator.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(loads).toBe(loadsBeforeDispose);
});
