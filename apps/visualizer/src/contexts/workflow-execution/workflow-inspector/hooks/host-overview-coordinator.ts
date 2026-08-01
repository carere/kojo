import type {
  HostOverview as HostOverviewSnapshot,
  ProjectIdentity,
  WorkflowRunSnapshot,
} from "@kojo/control";
import { type Accessor, createSignal } from "solid-js";
import {
  type CancellableOverviewLoader,
  type LoadWithBoundedRetryOptions,
  loadWithBoundedRetry,
} from "./load-host-overview";

const defaultRecoveryDelaysMs = [250, 500, 1_000, 2_000, 5_000] as const;
const defaultDiscoveryDelaysMs = [250, 500, 1_000, 2_000, 5_000] as const;

/** One finite composite HostOverview policy; recovery owns later backoff. */
export const productionHostOverviewPolicy = {
  attemptTimeoutMs: 10_000,
  maxAttempts: 2,
  maxElapsedMs: 20_000,
  retryDelaysMs: [250],
} as const;

export interface HostOverviewCoordinator {
  readonly overview: Accessor<HostOverviewSnapshot | undefined>;
  readonly error: Accessor<unknown>;
  readonly loading: Accessor<boolean>;
  /** Starts finite bootstrap and, after exhaustion, long-lived bounded recovery. */
  readonly start: () => void;
  /** Requests one authoritative refresh, coalescing overlapping requests behind one trailing load. */
  readonly refresh: () => Promise<HostOverviewSnapshot>;
  /** Commits a Host mutation receipt until the next composite overview includes it. */
  readonly acceptRun: (identity: ProjectIdentity, run: WorkflowRunSnapshot) => void;
  /** Aborts the owned request and prevents late results from committing. */
  readonly dispose: () => void;
}

export interface HostOverviewCoordinatorOptions {
  readonly load: CancellableOverviewLoader<HostOverviewSnapshot>;
  readonly policy?: Omit<LoadWithBoundedRetryOptions, "signal">;
  readonly recoveryDelaysMs?: ReadonlyArray<number>;
  /** Backoff for discovering Projects after a valid empty global index. */
  readonly discoveryDelaysMs?: ReadonlyArray<number>;
}

/**
 * Owns every HostOverview load for one inspector instance.
 *
 * Action refreshes and subscription deliveries share this coordinator. A
 * refresh requested while another is active becomes one trailing refresh, so
 * there is never more than one HostOverview RPC in flight and a mutating
 * action cannot bypass the resource's generation guard.
 */
export const makeHostOverviewCoordinator = (
  options: HostOverviewCoordinatorOptions,
): HostOverviewCoordinator => {
  const [overview, setOverview] = createSignal<HostOverviewSnapshot>();
  const [error, setError] = createSignal<unknown>();
  const [loading, setLoading] = createSignal(false);
  let active: Promise<HostOverviewSnapshot> | undefined;
  let trailingRequested = false;
  let trailingWaiters: Array<{
    readonly resolve: (snapshot: HostOverviewSnapshot) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  let requestGeneration = 0;
  let disposed = false;
  let activeController: AbortController | undefined;
  let recoveryRunning = false;
  let discoveryRunning = false;
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  let finishDelayWait: ((continueWaiting: boolean) => void) | undefined;
  let beginEmptyDiscovery: () => void = () => undefined;
  const acceptedRuns = new Map<
    string,
    { readonly identity: ProjectIdentity; readonly run: WorkflowRunSnapshot }
  >();

  const runKey = (identity: ProjectIdentity, runId: string) => `${identity}:${runId}`;
  const containsRun = (snapshot: HostOverviewSnapshot, identity: ProjectIdentity, runId: string) =>
    snapshot.workflowRuns.some(
      (projectRuns) =>
        projectRuns.project.identity === identity &&
        projectRuns.runs.some((run) => run.runId === runId),
    );
  const mergeAcceptedRun = (
    snapshot: HostOverviewSnapshot,
    identity: ProjectIdentity,
    run: WorkflowRunSnapshot,
  ): HostOverviewSnapshot => {
    const project = snapshot.projects.find((candidate) => candidate.identity === identity);
    if (project === undefined) return snapshot;
    const existing = snapshot.workflowRuns.find(
      (projectRuns) => projectRuns.project.identity === identity,
    );
    const runs = [
      run,
      ...(existing?.runs ?? []).filter((candidate) => candidate.runId !== run.runId),
    ];
    return {
      ...snapshot,
      workflowRuns:
        existing === undefined
          ? [...snapshot.workflowRuns, { project, runs }]
          : snapshot.workflowRuns.map((projectRuns) =>
              projectRuns.project.identity === identity ? { ...projectRuns, runs } : projectRuns,
            ),
    };
  };
  const applyAcceptedRuns = (snapshot: HostOverviewSnapshot) => {
    let current = snapshot;
    for (const [key, accepted] of acceptedRuns) {
      if (containsRun(current, accepted.identity, accepted.run.runId)) {
        acceptedRuns.delete(key);
        continue;
      }
      current = mergeAcceptedRun(current, accepted.identity, accepted.run);
    }
    return current;
  };

  const execute = async () => {
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeController = controller;
    setLoading(true);
    try {
      const snapshot = await loadWithBoundedRetry(options.load, {
        ...options.policy,
        signal: controller.signal,
      });
      if (snapshot === undefined) throw new Error("Kojo Host overview is unavailable.");
      const authoritativeSnapshot = applyAcceptedRuns(snapshot);
      if (!disposed && generation === requestGeneration) {
        setOverview(authoritativeSnapshot);
        setError(undefined);
      }
      if (!disposed && authoritativeSnapshot.projects.length === 0) beginEmptyDiscovery();
      return authoritativeSnapshot;
    } catch (cause) {
      if (!disposed && generation === requestGeneration) setError(cause);
      throw cause;
    } finally {
      if (activeController === controller) activeController = undefined;
      controller.abort();
      if (!disposed && generation === requestGeneration) setLoading(false);
    }
  };

  const startRequest = () => {
    const request = execute();
    active = request;
    void request.then(
      () => {
        finishRequest(request);
      },
      () => {
        finishRequest(request);
      },
    );
    return request;
  };

  const finishRequest = (request: Promise<HostOverviewSnapshot>) => {
    if (active !== request) return;
    active = undefined;
    if (!trailingRequested || disposed) {
      const waiters = trailingWaiters;
      trailingWaiters = [];
      for (const waiter of waiters)
        waiter.reject(new Error("Host overview coordinator was disposed."));
      return;
    }
    trailingRequested = false;
    const waiters = trailingWaiters;
    trailingWaiters = [];
    const next = startRequest();
    next.then(
      (snapshot) => {
        for (const waiter of waiters) waiter.resolve(snapshot);
      },
      (cause) => {
        for (const waiter of waiters) waiter.reject(cause);
      },
    );
  };

  const isFatalProtocolError = (cause: unknown) =>
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown; readonly code?: unknown })._tag === "HostOverviewError" &&
    (cause as { readonly code?: unknown }).code === "incompatible-protocol";

  const waitForDelay = (delayMs: number) =>
    new Promise<boolean>((resolve) => {
      if (disposed) {
        resolve(false);
        return;
      }
      finishDelayWait = resolve;
      delayTimer = setTimeout(
        () => {
          delayTimer = undefined;
          finishDelayWait = undefined;
          resolve(true);
        },
        Math.max(0, delayMs),
      );
    });

  const recoverUntilReady = async () => {
    const delays = options.recoveryDelaysMs ?? defaultRecoveryDelaysMs;
    for (let attempt = 0; !disposed && overview() === undefined; attempt += 1) {
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      if (!(await waitForDelay(delay))) break;
      if (overview() !== undefined) break;
      try {
        await refresh();
        break;
      } catch (cause) {
        if (isFatalProtocolError(cause)) break;
      }
    }
    recoveryRunning = false;
  };

  const discoverProjects = async () => {
    const delays = options.discoveryDelaysMs ?? defaultDiscoveryDelaysMs;
    try {
      for (let attempt = 0; !disposed && overview()?.projects.length === 0; attempt += 1) {
        const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
        if (!(await waitForDelay(delay))) break;
        if (disposed || overview()?.projects.length !== 0) break;
        try {
          const snapshot = await refresh();
          if (snapshot.projects.length !== 0) break;
        } catch (cause) {
          if (isFatalProtocolError(cause)) break;
        }
      }
    } finally {
      discoveryRunning = false;
    }
  };

  beginEmptyDiscovery = () => {
    if (disposed || discoveryRunning || overview()?.projects.length !== 0) return;
    discoveryRunning = true;
    void discoverProjects();
  };

  const start = () => {
    if (disposed || recoveryRunning || overview() !== undefined) return;
    recoveryRunning = true;
    void startRequest().then(
      () => {
        recoveryRunning = false;
      },
      (cause) => {
        if (isFatalProtocolError(cause)) {
          recoveryRunning = false;
          return;
        }
        void recoverUntilReady();
      },
    );
  };

  const refresh = () => {
    if (disposed) return Promise.reject(new Error("Host overview coordinator was disposed."));
    if (active === undefined) return startRequest();
    trailingRequested = true;
    return new Promise<HostOverviewSnapshot>((resolve, reject) => {
      trailingWaiters.push({ resolve, reject });
    });
  };

  const acceptRun = (identity: ProjectIdentity, run: WorkflowRunSnapshot) => {
    if (disposed) return;
    acceptedRuns.set(runKey(identity, run.runId), { identity, run });
    const current = overview();
    if (current !== undefined) setOverview(mergeAcceptedRun(current, identity, run));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    requestGeneration += 1;
    activeController?.abort();
    if (delayTimer !== undefined) clearTimeout(delayTimer);
    delayTimer = undefined;
    finishDelayWait?.(false);
    finishDelayWait = undefined;
    recoveryRunning = false;
    discoveryRunning = false;
    acceptedRuns.clear();
    const waiters = trailingWaiters;
    trailingWaiters = [];
    for (const waiter of waiters)
      waiter.reject(new Error("Host overview coordinator was disposed."));
  };

  return { overview, error, loading, refresh, acceptRun, start, dispose };
};
